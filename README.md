# Checkout Continuity

A fan starts buying tickets on their laptop, gets interrupted, and finishes on their phone — without
duplicate orders, stale holds, or a price that quietly changed underneath them.

```bash
pnpm install
pnpm dev      # API on :4000, web on :3000
pnpm test     # 67 tests, ~1s, zero sleeps
```

Open **http://localhost:3000/demo** — one session on two surfaces, with the levers to move the price,
pull the inventory, break the payment processor, and run the clock out.

For a real phone: put the phone on the same Wi-Fi and open the app at your machine's network address
(`http://192.168.x.x:3000`) rather than `localhost`. The handoff QR encodes whichever host served the
page, so it then points at something the phone can reach. `PUBLIC_ORIGIN` in `apps/web/.env.local`
overrides that if you need a different address.

### The 60-second tour

1. **Raise the price $20.** Both surfaces show the drift banner within a second, both buy buttons
   disable, and neither will complete until the fan explicitly accepts.
2. **Set payment to "Slow", then press Complete on both surfaces at once.** One order is created.
   The other says *"Completing on your other device."*
3. **Sell out the listing.** Both surfaces reach a recovery state; the API refuses the purchase.
4. **Expire now.** Both flip to a recovery screen offering the same seats at the current price.

Nothing reloads — every change arrives over SSE. Each beat is also asserted headlessly in
[`checkout.integration.test.ts`](apps/api/src/routes/checkout.integration.test.ts).

---

## What's here

```
apps/api            Express 5 — source of truth, in-memory stores, SSE
apps/web            Next.js 15 App Router — desktop + mobile surfaces, demo console
packages/contracts  Zod schemas shared by both ends
```

---

## The checkout session state model

A checkout session moves through a small set of states:

```
active ──begin completion──▶ completing ──payment succeeds──▶ completed
  │                              │
  │                              ├─ payment fails, retryable, time left ────▶ active
  │                              ├─ payment fails, retryable, no time left ─▶ expired
  │                              └─ payment fails, not retryable ───────────▶ failed
  │
  ├─ deadline passes ──▶ expired
  └─ fan cancels ──▶ canceled
```

- **`active`** — the fan is shopping: reading the listing, watching the price, extending the deadline.
- **`completing`** — one payment attempt is in flight. The session is locked to whichever surface
  started it; every other request is told to wait rather than shown an error. More in "Duplicate
  orders" below.
- **`completed` / `expired` / `canceled` / `failed`** — terminal. Nothing more can happen to the
  session itself, though it stays readable for a while — see "Retention" below.

The one non-obvious edge is `completing → active`: a declined card doesn't end the checkout, just
that attempt, so a retryable failure sends the fan back to `active` to try another card — as long as
the original deadline hasn't actually passed. If it has, they land on `expired` instead; if the
failure isn't retryable at all (a processor error, say), they land on `failed`.

`status` only tracks where the checkout itself is. What the current payment attempt is doing is
tracked separately, on `session.completion.status` (`pending` / `succeeded` / `failed`) — keeping the
two apart is what stops the machine from needing values like `active_but_payment_pending`.

The whole thing is a pure function — [`checkout-machine.ts`](apps/api/src/domain/checkout-machine.ts)
— and every transition is pinned as a data-driven matrix in
[`checkout-machine.test.ts`](apps/api/src/domain/checkout-machine.test.ts).

---

## How web and mobile resume the same session

```
Desktop   /checkout/{id}
Mobile    /m/checkout/{id}
Deep link /link/{id}  →  307 to the mobile surface with ?src=deeplink
```

The session/checkout id is the resume mechanism, and it is in the URL. `/link/{id}` mimics a deep link but for prototype purposes always redirects to the mobile view because we have no app. In real life, this should open the app and load the checkout session (although we need to handle if the app isn't installed and an authenticated user vs unauthenticated).

### The live channel

The API pushes live updates to the browser over **SSE (Server-Sent Events)** — a one-way stream
built on plain HTTP. It was chosen over WebSockets for three reasons: updates only ever flow
server → client, so a two-way connection isn't needed; it's plain HTTP, so no special upgrade
handling or sticky sessions; and the browser's built-in `EventSource` API reconnects on its own if
the connection drops. If it can't connect at all, the client falls back to polling and shows that
it's doing so.

**Catching up after a disconnect.** If a fan's phone locks and reconnects a minute later, it would
normally miss every update sent while it was asleep. To prevent that, each session keeps a buffer
of its last 50 events. On reconnect, the client tells the server the last event id it saw (SSE's
built-in `Last-Event-ID` header), and the server resends only what was missed.

**Picking the newest update.** Because a reconnect can resend things the client already has, the
client needs a rule for "is this actually new?" It checks two things, in order:

```ts
incoming.session.version !== cached.session.version
  ? (incoming.session.version > cached.session.version ? incoming : cached)  // a write happened
  : (incoming.serverTime > cached.serverTime ? incoming : cached)            // nothing was written
```

1. **Did the session get written to?** Every write bumps `session.version`. A higher version is
   always newer.
2. **If the version is unchanged, did anything else about the view change?** A price change is the
   listing changing, not the session — so it doesn't bump the version. In that case, whichever
   update has the later `serverTime` wins.

Both checks are necessary: version alone would ignore every price change, since they all arrive at
the same version; timestamp alone could let a resent update walk a *completed* checkout back to
`active`, turning a confirmation screen back into a buy button. Both are pinned in
[`merge-session-view.test.ts`](apps/web/hooks/merge-session-view.test.ts). This timestamp
comparison only works because there's one server; across several servers the tiebreak would need a
real sequence number instead of a clock.

---

## Stale inventory, price changes, duplicate completion

### Duplicate orders — four guards

The ordering in [`completeSession`](apps/api/src/services/checkout-service.ts) is the answer. Each
guard catches a case the others cannot:

1. **`Idempotency-Key`** — the same device retrying. Claimed *before* the work starts, so a retry
   landing during a slow payment call finds the in-flight record instead of starting a second charge.
2. **The already-completed check** — a request arriving after the order exists returns `200` with
   that order, because the retry did in fact succeed.
3. **The version check on the write into `completing`** — two devices racing. The one that loses gets
   `409 COMPLETION_IN_PROGRESS` carrying `startedBySurface`, so the UI can say *"completing on your
   phone"* rather than show an error.
4. **`UNIQUE (session_id)` on orders** — the only guard a caller cannot bypass. It holds even if a
   future refactor forgets the other three exist.

**The critical detail is where the `await` sits.** Node being single-threaded does not make this
safe on its own: a handler that reads a session, `await`s a payment call, then writes it back has let
other work run in between, and a second request slips in exactly there. What makes it safe is that
the version check and the write happen with no `await` between them, and that the lock is taken
**strictly before** the payment provider is called. `putIfVersion` maps directly onto a small Redis
Lua script.

### Price changes

Every quote carries a `hash` over the priced fields, so comparing two hashes answers "is this still
the same price?" — the same idea as an HTTP `ETag`. Completion requires
**two** things: the hash the fan clicked with must be the live one, *and* the session must already
have that hash **acknowledged**. Only the first is satisfiable by a client refreshing — the second is
what makes *"we never charge an unseen price"* a property of the server rather than a promise about
the frontend. Price drops work identically: the confirmation total must be the total the fan agreed
to, in both directions.

### Stale inventory

**There is deliberately no hard hold.** Gametime is a secondary marketplace — listings are
third-party inventory that can sell on another channel at any moment. Locking seats the way a primary
vendor does would misrepresent the domain and hide the failure a continuity feature has to handle:
the tickets a fan is looking at stop existing while they are away.

So inventory is checked three times, each catching something different — on read for the banner, when
the completion lock is taken (the last point we can refuse *before spending money*), and after
authorization but before the order is written (the only authoritative one).

**No hold means someone has to pay for the failure, and here that means releasing the charge.** Two
fans can both be authorized for the last pair of seats, and the one who loses has a live hold on
their card by the time we find out. `finalizeOrder` guarantees that *any exit that does not produce
an order releases that hold*, using one `finally` over the whole body so a new exit added later
cannot silently skip it.

### Expiration

Both mechanisms, because either alone is a bug: **on read**, so a fan refreshing never sees a
live-looking session whose clock has run out; and **a 1-second sweeper**, because an idle fan's open
tabs still need telling, and expiring only on read sends them no event at all. The countdown runs off
an absolute `expiresAt`, corrected for a device clock that is set wrong, so a phone twenty minutes
fast does not show an expired checkout.

A deadline enforced with `expiresAt <= now` gets the boundary wrong twice, and both cost the fan a
checkout they should have had:

- **The click that beat the clock.** Submitting before the deadline and being *evaluated* before it
  are not the same instant, so `BEGIN_COMPLETION` alone gets `COMPLETION_GRACE_MS` of extra time.
  Extend and cancel get none — those are a fan acting on a dead screen, not a request that was
  already on its way. The extra time is never visible (the countdown still hits 0:00 at `expiresAt`),
  and the sweeper respects the same margin, or it would be a coin flip which landed first.
- **The deadline that kept running during payment.** Until the lock is taken, the clock measures how
  long the fan may shop; after it, they have committed and the remaining time is ours. So
  `BEGIN_COMPLETION` pushes `expiresAt` out by `COMPLETION_WINDOW_MS` in the same write. Otherwise a
  submit at 9:58 whose card declines at 10:01 sends them back to the start instead of letting them
  try another card.

### Retention

Nothing is deleted at completion, and that is the point: guard 2 needs the completed session to turn
a late retry into `200 { order }`, and the fan's other device needs it to show a confirmation it has
not seen yet. Finishing a checkout only marks it done; the sweeper actually deletes it a retention
period later. In Redis that would be an `EXPIRE` set the moment the session finished, not a scan.

---

## API

```
POST   /api/checkout/sessions                  → 201 view
GET    /api/checkout/sessions/:id              → 200 view
POST   /api/checkout/sessions/:id/acknowledge    quoteHash
POST   /api/checkout/sessions/:id/extend
POST   /api/checkout/sessions/:id/complete       quoteHash + Idempotency-Key (required)
POST   /api/checkout/sessions/:id/cancel
GET    /api/checkout/sessions/:id/events         SSE, honors Last-Event-ID
POST   /api/_scenario/*                          dev only
```

---


## Analytics

**Product analytics (Mixpanel, PostHog).** Funnels, retention and cohorts with no pipeline to run,
and a PM can ask a new question without an engineer. But a client-side library loses events to ad
blockers and to Safari's tracking protection, and on a checkout the fans you lose are exactly the
ones you care about — privacy-conscious, Safari, mobile. Worse here specifically: web plus a native
app means two client libraries and a vendor guessing which device is which person, and *that guess
is the exact thing being measured*. Building the continuity number on top of it would measure the
vendor's heuristic as much as the feature.

**Our own capture endpoint → Pub/Sub → BigQuery.** Emitted server-side, so nothing is blocked and
there is no guessing which device belongs to which person — the session id already links them, which
is the point of the whole design. It lands in the same warehouse as orders, listings and payments, so
"did multi-surface sessions convert better" is one SQL join rather than a vendor export.

**Where I'd land:** both, split by whether the number has to agree with money. Product analytics for
exploratory funnels, where being able to ask quickly beats being complete and some loss is
tolerable. The warehouse stream for conversion rate, duplicates blocked and drift accepted — those
have to match the orders table exactly.

---


### Out of scope

Left out on purpose, to keep this a focused slice rather than a shallow checkout clone:

- **Payment** — stubbed behind a `PaymentProvider` interface with approve / decline / pending / error
  modes. No forms, no real payment processor.
- **Auth** — In a real product, we would create a tokenized version of the checkout id. For an unauthenticated user, this works fine for loading the checkout session, but we would exclude any user-specific data (name, address, billing). For an authenticated user, the second device would send our JWT auth token in a header and our backend would validate that the session belongs to that user. 
- **Message broker** — Thinking of things like audit logs, moving data to a data warehouse, and notifications such as order confirmation. We want to use something like pub/sub or Kafka to offload this work to other services or processes.
- **Analytics aggregation** — the events are in the codebase as an example. We'd most likely use a third-party service like Posthog or Mixpanel for detailed frontend user behavior, while still using pub/sub to BigQuery for other metrics. See the ""
- **Data Storage** - In a real product I would use Postgres as my main database and Redis for checkout sessions and transaction locks. We would want to look into proper indexing, using TTLs, redis as a cache layer, etc.
- **Event Search** - For a product at the scale of Gametime, I would want to use something like ElasticSearch for the events page. This assumes I need complex querying and search capability, which I think we would need.
- **Multiple Servers** - If our api service is horizontally scaled, we need to revise how SSE works. One device can be connected to server A while the other is connected to server B. With something like pub/sub, we can ensure both servers are broadcasting SSE to the appropriate connections. 
- **Accessibility** - We would need to do a more thorough review or use third-party tools.
- **Time Issues** - Handling different timezones and device time issues.


## Agent Usage

I took the following steps when using AI to assist me through this project.

1. I conversed with Gemini to discuss high level architecture and brainstorm what technical decisions
   made sense to include in this first version and what to put as out of scope. I also pointed out
   edge cases and went back and forth with it on covering those edge cases.

2. After mentally deciding on an approach, I wrote up my `PLANNING.md` doc with the intention of using
   **Claude Code** to read this for the base setup.

3. In Claude Code plan mode (Opus) I referenced the file and told it to write a plan. It read the
   assignment PDF and my notes, then generated a plan. I went back and forth a bit. As an example, one topic was how ticket resale site like Gametime should handle locking and high traffic a bit differently than primary selling sites like Ticketmaster.

4. Once the plan was final, I executed it with Sonnet. I manually reviewed each part and approved or made changes where necessary.

5. I added a CLAUDE.md file to capture the requirements I wanted in context on every turn — the
   entity model, the SSE and race-condition constraints, and the code quality rules — so I wasn't
   restating them each session or watching them drift out of a compacted context.

6. I reviewed both the base code and the UI. I gathered the bugs in the UI and wrote a plan to fix them. Quickly followed by execution.

7. Despite attempts to avoid AI slop and bloated code, I still had to go back and remove some features that seemed like over engineering, not directly related to the prompt, or UI that was unnecessary.

8. I went deeper into some specific features like idempotency, atomic transactions, SSE, and more. Always thinking about scenarios of many users performing actions at the same time. Also the seller or algorithm randomly making changes to the listing at the exact moment a buyer is attempting an action.

9. I consistently use `/compact` when the context is getting bloated. At times I used git worktrees to work on different features simultaneously. 


