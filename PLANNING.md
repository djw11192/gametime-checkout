# Planning Doc
This doc is used for the initial planning. These details will be entered when building the original plan with Claude Code.

## Tech Stack

### Frontend
- Next.js + Typescript
- shadcn/ui + Tailwind
- Redux Toolkit
- tanstack/react-query

### Backend
- Node.js + Typescript + Express on the backend
- In-memory storage (No DB)

## Technical Approach

### Key Ideas
I'm not committed to these points, but my initial ideas are:
- Entities include Events, Listings, Tickets, and Checkouts
- When clicking on a listing from an event page, we create a checkout with a new uuid which will be used to persist the checkout across devices
- Use server sent events to notify the client if the price has changed, the tickets were purchased by a different user, etc.
-  Consider race conditions when a user attempts to complete a purchase at the same time as another user or if the seller updates pricing or inventory at the same time an order is placed.
- Need to create, update, and remove checkout sessions appropriately. Upon completing an order, the checkout session should be removed. It also should be removed when it times out.
- Consider checkout timeout by storing an "expires_at" field or some other form of a TTL.
- Need to mimic idempotency in the event of payment failures with retries.


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

