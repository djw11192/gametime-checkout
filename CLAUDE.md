# Checkout Continuity

Prototype: a fan starts buying tickets on one surface and resumes on another without duplicate
orders, stale holds, or a price that changed silently.


## Layout

- `apps/api` — Express 5, in-memory stores, SSE. Source of truth.
- `apps/web` — Next.js 15 App Router, Tailwind, TanStack Query.
- `packages/contracts` — Zod schemas shared by both. Exists because two independently deployed
  things need the same shapes *at runtime*; importing from `apps/api/src` would couple the client to
  server internals, and duplicating the schemas guarantees drift.


## Code Quality

- Avoid "AI slop"
- keep comments concise and simple
- Follow React and NextJS best practices on frontend.
- Follow NodeJS + Express best practices on the backend.


## Key Considerations
- Entities include Events, Listings, Tickets, and Checkouts
- When clicking on a listing from an event page, we create a checkout with a new uuid which will be used to persist the checkout across devices
- Use server sent events to notify the client if the price has changed, the tickets were purchased by a different user, etc.
-  Consider race conditions when a user attempts to complete a purchase at the same time as another user.
- Need to create, update, and remove checkout sessions appropriately. Upon completing an order, the checkout session should be removed. It also should be removed when it times out.
  - "Removed" means after a short retention window, not at the instant the order is placed. A
    completed session is what turns a late retry into "here is your order" instead of a 404, and
    what the fan's other device loads to render a confirmation it hasn't seen yet. So going terminal
    is the soft delete and the sweeper does the hard one later — `TERMINAL_RETENTION_MS`. Against a
    real store this is an `EXPIRE` on the key rather than a scan.
- Consider checkout timeout by storing an "expires_at" field or some other form of a TTL.
  - Taking the completion lock re-purposes that deadline: it stops measuring the fan's shopping time
    and starts measuring our authorization round-trip, so it is pushed out by
    `COMPLETION_WINDOW_MS`. A separate `COMPLETION_GRACE_MS` honours a submit that was already in
    flight when the clock struck. Neither is visible to the fan — the countdown still reads 0:00 at
    `expires_at`.


## User Stories
As a user, I:
- can view ticket listings for an event.
- click on a ticket listing and proceed to checkout to enter final details.
- can use a link to open a view in a new tab that emulates opening the checkout in a mobile device, with the checkout session persisted.
- complete an order
- see notifications when anything changes to the inventory (ex: price change, availability, etc)
- am alerted when my session expires.
- see proper error messaging if my order submission fails (no longer available, processing issue, etc)


### Out of Scope
- Payment. We do not need any payment related forms.
- Database storage
- Locking ticket listings like on primary ticket vendor sites.
- Message broker for post-processing tasks
- Notifications
- Event/audit logs for replay ability
- Authentication
- Profile views (Ex: My Tickets)
