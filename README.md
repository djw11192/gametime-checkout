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
(Ex: `http://192.168.x.x:3000`) rather than `localhost`. The handoff QR encodes whichever host served the
page, so it then points at something the phone can reach. `PUBLIC_ORIGIN` in `apps/web/.env.local`
overrides that if you need a different address.

### The 60-second tour

1. **Raise the price $20.** Both surfaces show the drift banner within a second, both buy buttons
   disable, and neither will complete until the fan explicitly accepts.
2. **Set payment to "Slow", then press Complete on both surfaces at once.** One order is created.
   The other says *"Completing on your other device."*
3. **Sell out the listing.** Both surfaces reach a recovery state; the API refuses the purchase.
4. **Expire now.** Both flip to a recovery screen offering the same seats at the current price.

Nothing reloads — every change arrives over SSE. Each beat is also asserted headlessly in [`checkout.integration.test.ts`](apps/api/src/routes/checkout.integration.test.ts).

**NOTE**: Demo mode will never update inventory of a listing. This is so we can test purchasing scenarios easily without needing to restart the server.

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

The API pushes live updates over **SSE (Server-Sent Events)** — a one-way HTTP stream. It beats
WebSockets here: updates only flow server → client, it needs no upgrade handling or sticky
sessions, and the browser's `EventSource` reconnects on its own. If it can't connect at all, the
client falls back to polling and shows that it's doing so.

**Catching up after a disconnect.** Each session buffers its last 50 events. On reconnect, the
client sends the last event id it saw (`Last-Event-ID`), and the server resends only what it
missed.

**Picking the newest update.** A reconnect can resend things the client already has, so it needs a
rule for "is this actually new?":

```ts
incoming.session.version !== cached.session.version
  ? (incoming.session.version > cached.session.version ? incoming : cached)  // a write happened
  : (incoming.serverTime > cached.serverTime ? incoming : cached)            // nothing was written
```

Every write bumps `session.version`, so a higher version always wins. A price change moves the
*listing*, not the session, so it doesn't bump the version — then the later `serverTime` wins
instead. Version alone would miss every price change; timestamp alone could let a resent update
walk a *completed* checkout back to `active`. Both are pinned in
[`merge-session-view.test.ts`](apps/web/hooks/merge-session-view.test.ts) — and only work because
there's one server; multiple servers would need a real sequence number instead of a clock.

---

## Stale inventory, price changes, duplicate completion

### Duplicate orders — four guards

The ordering in [`completeSession`](apps/api/src/services/checkout-service.ts) is the answer. Each
guard catches a case the others can't:

1. **`Idempotency-Key`** — the same device retrying. Claimed *before* the work starts, so a retry
   landing mid-payment-call finds the in-flight record instead of starting a second charge.
2. **The already-completed check** — a request arriving after the order exists returns `200` with
   that order, since the retry did succeed.
3. **The version check on the write into `completing`** — two devices racing. The loser gets `409
   COMPLETION_IN_PROGRESS` carrying `startedBySurface`, so the UI can say *"completing on your
   phone"* instead of showing an error.
4. **`UNIQUE (session_id)` on orders** — the only guard a caller can't bypass, and the backstop if a
   future refactor drops the other three.

**Where the `await` sits is the critical detail.** Node's single thread doesn't make this safe by
itself — a handler that reads a session, `await`s a payment call, then writes it back leaves a gap
for a second request to slip in. Safety comes from taking the lock (version check + write, no
`await` between them) **strictly before** calling the payment provider. `putIfVersion` maps
directly onto a small Redis Lua script.

### Price changes

Every quote carries a `hash` over the priced fields, so comparing hashes answers "is this still the same price?" Completion requires **two** things: the hash the fan clicked with must be the live one, *and* the session must already have that hash **acknowledged**. A client can satisfy the first just by refreshing; only the second makes *"we never charge an unseen price"* a server guarantee rather than a frontend promise. Price drops work the same way, in both directions.

### Stale inventory

**There is deliberately no hard hold.** Gametime is a secondary marketplace — listings are
third-party inventory that can sell on another channel at any moment. Locking seats like a primary
vendor would misrepresent the domain and hide the exact failure continuity has to handle: the
tickets a fan is looking at can stop existing while they're away.

Inventory is checked three times, each catching something different: on read (for the banner), when
the completion lock is taken (the last point to refuse *before spending money*), and after
authorization but before the order is written (the only authoritative check).

**No hold means someone has to pay for the failure — here, that's releasing the charge.** Two fans
can both be authorized for the last pair of seats, and the loser has a live hold on their card by
the time we find out. `finalizeOrder` guarantees *any exit that doesn't produce an order releases
that hold*, via one `finally` over the whole body so a future exit path can't silently skip it.

### Expiration

Checked two ways, because either alone is a bug: **on read**, so a refreshing fan never sees a
live-looking session whose clock ran out; and **a 1-second sweeper**, so an idle fan's open tabs
still get told (reading alone sends them no event). The countdown runs off an absolute `expiresAt`,
corrected for a wrong device clock, so a phone twenty minutes fast never shows an expired checkout.

A plain `expiresAt <= now` gets the boundary wrong twice, each costing the fan a checkout they
should have had:

- **The click that beat the clock.** Submitting before the deadline and being *evaluated* before it
  aren't the same instant, so `BEGIN_COMPLETION` alone gets `COMPLETION_GRACE_MS` of extra time — a
  fan acting on an already-dead screen (extend, cancel) gets none. The grace is invisible (the
  countdown still hits 0:00 at `expiresAt`), and the sweeper honors the same margin so it isn't a
  coin flip which one fires first.
- **The deadline that kept running during payment.** Before the lock, the clock measures shopping
  time; after it, the fan has committed and the remaining time is ours. So `BEGIN_COMPLETION` pushes
  `expiresAt` out by `COMPLETION_WINDOW_MS` in the same write — otherwise a submit at 9:58 whose
  card declines at 10:01 sends them back to square one instead of letting them try another card.

### Retention

Nothing is deleted at completion, on purpose: guard 2 needs the completed session to turn a late
retry into `200 { order }`, and the fan's other device needs it to show a confirmation it hasn't
seen yet. Finishing a checkout only marks it done — the sweeper deletes it a retention period
later. In Redis that would be an `EXPIRE` set the moment the session finished, not a scan.

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


## Tradeoffs

- **In-memory stores, not Postgres/Redis** — fast to build and test; the race-condition guards
  (`putIfVersion`, idempotency claims) are written to map directly onto what Redis gives for free
  (`EXPIRE`, Lua scripts) — see *What I'd do differently* → Data storage.
- **NextJS over React + Vite** - chose NextJS to address the prompt more closely at expense of faster dev/builds and simpler mental model.
- **SSE, not WebSockets** — the right call for one-way updates today, but it caps this at a single
  server; scaling out needs a pub/sub fan-out layer (see *The live channel*).
- **No hard hold on inventory** — matches how a secondary marketplace actually behaves, at the cost
  of needing release-on-failure logic for holds that lose the race (see *Stale inventory*).
- **Timestamp tiebreak assumes one server clock** — multiple servers would need a
  real sequence number instead (see *Picking the newest update*).
- **Short retention window, not permanent storage** — keeps memory bounded, but a completed
  session is only viewable for a limited time afterward (see *Retention*).
- **Checkout id in the URL is the entire resume mechanism** — no auth, so anyone with the link can
  open the session; intentional for a prototype (see *What I'd do differently* → Auth).

---


## Analytics

**Product analytics (Mixpanel, PostHog)** answers exploratory questions fast — no pipeline, no
engineer required for a new funnel. But a client-side library loses events to ad blockers and
Safari's tracking protection, disproportionately from the fans this feature is for. Worse here
specifically: web plus a native app means two client libraries and a vendor *guessing* which device
is which person — exactly the thing continuity is supposed to measure.

**A server-side capture endpoint → Pub/Sub → BigQuery** avoids both problems: nothing is blocked,
and the session id already links devices, so there's no guessing. It also lands in the same
warehouse as orders and listings, making "did multi-surface sessions convert better" one SQL join.

**Where I'd land:** both, split by whether the number has to agree with money. Product analytics
for exploratory funnels, where speed beats completeness. The warehouse stream for anything that has
to match the orders table exactly — conversion rate, duplicates blocked, drift accepted.

---


## Out of scope & what I'd do differently

Left out on purpose, to keep this a focused slice rather than a shallow checkout clone — this
doubles as the "with more time" list:

- **Payment** — stubbed behind a `PaymentProvider` interface with approve / decline / pending /
  error modes. No forms, no real processor.
- **Auth** — a tokenized version of the checkout id. Unauthenticated, that's enough to load the
  session while excluding user-specific data (name, address, billing). Authenticated, the second
  device sends our JWT in a header and the backend validates the session belongs to that user.
- **Message broker** — pub/sub or Kafka to offload audit logs, warehouse writes, and notifications
  (order confirmation) to other processes instead of doing them inline.
- **Analytics aggregation** — the events are in the codebase as an example. In practice: a
  third-party tool (PostHog/Mixpanel) for frontend behavior, plus pub/sub → BigQuery for metrics
  that need to match the orders table (see *Analytics* above).
- **Data storage** — Postgres as the primary database, Redis for checkout sessions; with
  real indexing, TTLs, and Redis as a cache layer.
- **Event search** — something like Elasticsearch for the events page, once it needs real querying
  and search rather than a simple list.
- **Multiple servers** — horizontally scaling the API means one device can be on server A while the
  other is on server B; SSE needs pub/sub to broadcast across both.
- **Accessibility** — a proper audit, likely with third-party tooling.
- **Time zones and device clocks** — handling both correctly across surfaces.
- **More testing** - I kept tests simple and tried focusing on some of the key scenarios. I could be more thorough and write e2e tests


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


