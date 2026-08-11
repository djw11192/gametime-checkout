import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  COMPLETION_GRACE_MS,
  SESSION_TTL_MS,
  TERMINAL_RETENTION_MS,
  type CheckoutSessionView,
} from "@gametime/contracts";
import { createApp } from "../app";
import { createContainer, type Container } from "../container";
import { InMemoryAnalyticsSink } from "../ports/analytics";
import { FakeClock } from "../ports/clock";

/**
 * End to end over real HTTP, with a fake clock. Deadlines are exercised by
 * advancing that clock rather than sleeping. The payment provider is only made
 * slow where a test needs a real window for two requests to race inside.
 */

const LISTING = "lst_warriors_lower_112";

let container: Container;
let app: Express;
let clock: FakeClock;
let analytics: InMemoryAnalyticsSink;

beforeEach(async () => {
  clock = new FakeClock();
  analytics = new InMemoryAnalyticsSink();
  container = createContainer({ clock, analytics });
  app = createApp(container);
});

/* ── helpers ──────────────────────────────────────────────────────────────── */

async function createSession(surface: "web" | "mobile" = "web", quantity = 2) {
  const res = await request(app)
    .post("/api/checkout/sessions")
    .send({ listingId: LISTING, quantity, surface, clientId: `${surface}-client` })
    .expect(201);
  return res.body.session as CheckoutSessionView;
}

async function readSession(id: string, surface?: "web" | "mobile") {
  const query = surface ? `?surface=${surface}&clientId=${surface}-client` : "";
  const res = await request(app).get(`/api/checkout/sessions/${id}${query}`).expect(200);
  return res.body.session as CheckoutSessionView;
}

function complete(id: string, opts: { hash: string; key: string; surface?: "web" | "mobile"; clientId?: string }) {
  return request(app)
    .post(`/api/checkout/sessions/${id}/complete`)
    .set("Idempotency-Key", opts.key)
    .send({
      quoteHash: opts.hash,
      surface: opts.surface ?? "web",
      clientId: opts.clientId ?? "web-client",
    });
}

const setPrice = (deltaCents: number) =>
  request(app).post("/api/_scenario/price").send({ listingId: LISTING, deltaCents }).expect(200);

const setInventory = (availableQuantity: number) =>
  request(app).post("/api/_scenario/inventory").send({ listingId: LISTING, availableQuantity }).expect(200);

const setPaymentMode = (mode: string, latencyMs?: number) =>
  request(app).post("/api/_scenario/payment-mode").send({ mode, latencyMs }).expect(200);

/* ── cross-surface handoff ────────────────────────────────────────────────── */

describe("cross-surface continuity", () => {
  it("creates on web, resumes on mobile, and completes from mobile", async () => {
    const created = await createSession("web");
    expect(created.session.surfacesSeen).toEqual(["web"]);

    // The fan puts the laptop down and picks up their phone four minutes later.
    clock.advance(4 * 60 * 1000);
    const resumed = await readSession(created.session.id, "mobile");

    expect(resumed.session.surfacesSeen).toEqual(["web", "mobile"]);
    expect(resumed.session.status).toBe("active");
    expect(resumed.canComplete).toBe(true);
    // Same deadline as when it was created — resuming does not buy more time.
    expect(resumed.session.expiresAt).toBe(created.session.expiresAt);
    expect(resumed.remainingMs).toBe(SESSION_TTL_MS - 4 * 60 * 1000);

    const done = await complete(created.session.id, {
      hash: resumed.liveQuote!.hash,
      key: "key-mobile",
      surface: "mobile",
      clientId: "phone",
    }).expect(201);

    expect(done.body.session.session.status).toBe("completed");
    expect(done.body.order.sessionId).toBe(created.session.id);
    expect(done.body.order.placedFromSurface).toBe("mobile");
    expect(container.orders.count()).toBe(1);

    // The handoff has to be measured, not just survive. Without these two
    // events there is no way to compare device-switchers to everyone else.
    expect(analytics.events()).toEqual([
      {
        type: "session.resumed",
        sessionId: created.session.id,
        fromSurface: "web",
        toSurface: "mobile",
        gapSeconds: 240,
        viaDeepLink: false,
      },
      { type: "checkout.completed", sessionId: created.session.id, surfaceCount: 2 },
    ]);
  });

  it("does not churn the version when a surface merely refreshes", async () => {
    // A bumped version would 409 other in-flight requests on the same session.
    const created = await createSession("web");
    clock.advance(2_000);
    await readSession(created.session.id, "web");

    expect((await readSession(created.session.id)).session.version).toBe(0);
  });
});

/* ── duplicate orders ─────────────────────────────────────────────────────── */

describe("duplicate order prevention", () => {
  it("two devices completing simultaneously produce exactly one order", async () => {
    const created = await createSession("web");
    const hash = created.liveQuote!.hash;

    // A real authorization window for the two requests to race inside.
    await setPaymentMode("slow", 120);

    const [web, mobile] = await Promise.all([
      complete(created.session.id, { hash, key: "key-web", surface: "web", clientId: "desktop" }),
      complete(created.session.id, { hash, key: "key-mobile", surface: "mobile", clientId: "phone" }),
    ]);

    const statuses = [web.status, mobile.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(container.orders.count()).toBe(1);

    // The one that lost is told which surface is finishing, so it can say
    // "completing on your phone" rather than show an error.
    const loser = web.status === 409 ? web : mobile;
    expect(loser.body.error.code).toBe("COMPLETION_IN_PROGRESS");
    expect(loser.body.error.details.startedBySurface).toBeTruthy();
    // The refusal carries the current view, so the client can update from it.
    expect(loser.body.session).toBeTruthy();

    // A guard whose "duplicates blocked" count is always zero is one nobody
    // can tell is working.
    expect(analytics.events()).toContainEqual({
      type: "duplicate.blocked",
      sessionId: created.session.id,
    });
  });

  it("replaying the same Idempotency-Key returns the same order without charging again", async () => {
    const created = await createSession();
    const hash = created.liveQuote!.hash;

    const first = await complete(created.session.id, { hash, key: "key-1" }).expect(201);
    const replay = await complete(created.session.id, { hash, key: "key-1" }).expect(201);

    expect(replay.body.order.id).toBe(first.body.order.id);
    expect(container.orders.count()).toBe(1);
  });

  it("a fresh key against an already-completed session returns the existing order as 200", async () => {
    const created = await createSession();
    const hash = created.liveQuote!.hash;

    const first = await complete(created.session.id, { hash, key: "key-1" }).expect(201);
    const late = await complete(created.session.id, { hash, key: "key-2" }).expect(200);

    expect(late.body.order.id).toBe(first.body.order.id);
    expect(container.orders.count()).toBe(1);
  });

  it("rejects the same key reused for a materially different request", async () => {
    const created = await createSession();
    const other = await createSession();

    await complete(created.session.id, { hash: created.liveQuote!.hash, key: "shared" }).expect(201);
    const res = await complete(other.session.id, { hash: other.liveQuote!.hash, key: "shared" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

});

/* ── price change ─────────────────────────────────────────────────────────── */

describe("price changes while the fan is away", () => {
  it("surfaces drift, blocks the CTA, refuses the stale purchase, then allows it after acknowledgement", async () => {
    const created = await createSession("web");
    const originalHash = created.liveQuote!.hash;
    const originalTotal = created.liveQuote!.totalCents;

    clock.advance(60_000);
    await setPrice(2_000);

    const drifted = await readSession(created.session.id, "mobile");
    expect(drifted.drift).toHaveLength(1);
    expect(drifted.drift[0]).toMatchObject({ type: "price_increased", deltaCents: 4_600 });
    expect(drifted.blockers).toContain("quote_unacknowledged");
    expect(drifted.canComplete).toBe(false);

    // Buying at the price the fan last saw must fail.
    const stale = await complete(created.session.id, { hash: originalHash, key: "key-stale" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("QUOTE_STALE");
    expect(container.orders.count()).toBe(0);

    // Even holding the *live* hash is not enough without an explicit acceptance.
    const unacknowledged = await complete(created.session.id, {
      hash: drifted.liveQuote!.hash,
      key: "key-unack",
    });
    expect(unacknowledged.status).toBe(409);
    expect(unacknowledged.body.error.code).toBe("QUOTE_STALE");

    const acknowledged = await request(app)
      .post(`/api/checkout/sessions/${created.session.id}/acknowledge`)
      .send({ quoteHash: drifted.liveQuote!.hash, surface: "mobile", clientId: "phone" })
      .expect(200);

    expect(acknowledged.body.session.drift).toEqual([]);
    expect(acknowledged.body.session.canComplete).toBe(true);

    const done = await complete(created.session.id, {
      hash: drifted.liveQuote!.hash,
      key: "key-final",
    }).expect(201);

    // Charged the new price, and only the new price.
    expect(done.body.order.totalCents).toBe(originalTotal + 4_600);
  });

  it("reports a price drop as drift too, and still requires acceptance", async () => {
    // Quietly charging the lower price would feel friendlier but is still
    // wrong. The total on the confirmation has to be the total the fan agreed
    // to, whichever way the price moved.
    const created = await createSession();
    await setPrice(-1_000);

    const view = await readSession(created.session.id, "web");
    expect(view.drift[0]).toMatchObject({ type: "price_decreased", deltaCents: 2_300 });
    expect(view.canComplete).toBe(false);
  });
});

/* ── inventory ────────────────────────────────────────────────────────────── */

describe("inventory disappearing", () => {
  it("blocks checkout when the listing sells out elsewhere", async () => {
    const created = await createSession();
    await setInventory(0);

    const view = await readSession(created.session.id, "web");
    expect(view.drift).toEqual([{ type: "inventory_unavailable" }]);
    expect(view.blockers).toContain("inventory_unavailable");
    expect(view.liveQuote).toBeNull();

    const res = await complete(created.session.id, { hash: "anything", key: "key-gone" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVENTORY_UNAVAILABLE");
  });

  it("flags a partial loss of inventory rather than silently reducing the order", async () => {
    const created = await createSession("web", 4);
    await setInventory(2);

    const view = await readSession(created.session.id, "web");
    expect(view.drift).toContainEqual({
      type: "quantity_reduced",
      availableQuantity: 2,
      requestedQuantity: 4,
    });
    expect(view.canComplete).toBe(false);
  });

  it("fails the purchase non-retryably if inventory vanishes during authorization", async () => {
    const created = await createSession();
    const hash = created.liveQuote!.hash;
    await setPaymentMode("slow", 80);

    // Calling `.then()` is what actually sends a supertest request. Just
    // assigning it does nothing, and the "race" would quietly run in sequence.
    const inFlight = complete(created.session.id, { hash, key: "key-race" }).then((r) => r);

    // Wait until the lock is genuinely held rather than guessing with a sleep,
    // so this race always plays out the same way.
    for (let i = 0; i < 200; i++) {
      if ((await container.sessions.get(created.session.id))?.status === "completing") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect((await container.sessions.get(created.session.id))?.status).toBe("completing");

    // The seller's tickets go while we are talking to the payment provider.
    await setInventory(0);

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.body.order).toBeNull();
    expect(res.body.session.session.status).toBe("failed");
    expect(res.body.session.session.completion.failure).toMatchObject({
      code: "inventory_unavailable",
      retryable: false,
    });
    expect(container.orders.count()).toBe(0);
    // And the hold on the card is released. Failing the purchase without doing
    // that leaves money held for someone who got nothing.
    expect(container.payments.voidCount()).toBe(1);
  });

  it("does not authorize at all when the seller is already short", async () => {
    // The cheaper half of the same problem: if we can see the shortfall before
    // calling the processor, no hold should ever exist to release.
    const created = await createSession("web", 2);
    await setInventory(1);

    const res = await complete(created.session.id, {
      hash: created.liveQuote!.hash,
      key: "key-short",
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVENTORY_UNAVAILABLE");
    expect(container.orders.count()).toBe(0);
    expect(container.payments.voidCount()).toBe(0);
  });

  it("two fans racing for the last pair leave exactly one order and no stranded hold", async () => {
    // Two different sessions, so none of the per-session guards apply: the lock
    // is per session, and neither idempotency key has been seen before. What
    // separates them is the inventory commit — and by the time the loser gets
    // there, it already has a hold on a card.
    await setInventory(2);
    const [first, second] = await Promise.all([createSession("web"), createSession("mobile")]);
    await setPaymentMode("slow", 60);

    const results = await Promise.all([
      complete(first.session.id, { hash: first.liveQuote!.hash, key: "key-a" }),
      complete(second.session.id, { hash: second.liveQuote!.hash, key: "key-b" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(container.orders.count()).toBe(1);
    expect(container.inventory.getListing(LISTING)?.availableQuantity).toBe(0);

    const loser = results.find((r) => r.status === 200)!;
    expect(loser.body.order).toBeNull();
    expect(loser.body.session.session.completion.failure.code).toBe("inventory_unavailable");
    expect(container.payments.voidCount()).toBe(1);
  });
});

/* ── expiry ───────────────────────────────────────────────────────────────── */

describe("expiration", () => {
  it("expires lazily on read, without waiting for the sweeper", async () => {
    const created = await createSession();
    clock.advance(SESSION_TTL_MS + 1);

    const view = await readSession(created.session.id, "web");
    expect(view.session.status).toBe("expired");
    expect(view.remainingMs).toBe(0);
    expect(view.canComplete).toBe(false);
  });

  it("expires idle sessions via the sweeper, so open tabs get told", async () => {
    const created = await createSession();
    clock.advance(SESSION_TTL_MS + COMPLETION_GRACE_MS + 1);

    expect(await container.checkout.sweepExpired()).toBe(1);
    expect((await container.sessions.get(created.session.id))?.status).toBe("expired");
  });

  it("leaves a session alone while a submit could still be in flight", async () => {
    // The expiry sweeper runs every second, so it has to respect the grace
    // period too — otherwise it would be a coin flip whether it or the fan's
    // submit landed first.
    const created = await createSession();
    clock.advance(SESSION_TTL_MS + COMPLETION_GRACE_MS - 1);

    expect(await container.checkout.sweepExpired()).toBe(0);
    expect((await container.sessions.get(created.session.id))?.status).toBe("active");
  });

  it("refuses to complete an expired session", async () => {
    const created = await createSession();
    const hash = created.liveQuote!.hash;
    clock.advance(SESSION_TTL_MS + COMPLETION_GRACE_MS + 1);

    const res = await complete(created.session.id, { hash, key: "key-late" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
    expect(container.orders.count()).toBe(0);
  });

  it("completes a purchase that lands a hair after the deadline", async () => {
    // The same rule, now end to end through the route, the service and the
    // sweeper together.
    const created = await createSession();
    const hash = created.liveQuote!.hash;
    clock.advance(SESSION_TTL_MS + COMPLETION_GRACE_MS - 1);

    const res = await complete(created.session.id, { hash, key: "key-photo-finish" });
    expect(res.status).toBe(201);
    expect(container.orders.count()).toBe(1);
  });

  it("still serves an expired session with enough context to offer recovery", async () => {
    // A 404 here would leave a scanned link with nowhere to go. The phone needs
    // the event, the seats and the current price to offer a way to start again.
    const created = await createSession();
    clock.advance(SESSION_TTL_MS + 1);

    const res = await request(app)
      .get(`/api/checkout/sessions/${created.session.id}?surface=mobile&clientId=phone&src=deeplink`)
      .expect(200);

    const view = res.body.session as CheckoutSessionView;
    expect(view.session.status).toBe("expired");
    expect(view.liveQuote).not.toBeNull();
    expect(view.session.listingId).toBe(LISTING);
  });

  it("extends once and refuses a second time", async () => {
    const created = await createSession();
    const body = { surface: "web" as const, clientId: "web-client" };

    const extended = await request(app)
      .post(`/api/checkout/sessions/${created.session.id}/extend`)
      .send(body)
      .expect(200);
    expect(extended.body.session.remainingMs).toBeGreaterThan(SESSION_TTL_MS);

    const second = await request(app)
      .post(`/api/checkout/sessions/${created.session.id}/extend`)
      .send(body);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("EXTENSION_LIMIT_REACHED");
  });
});

/* ── payment states ───────────────────────────────────────────────────────── */

describe("payment outcomes", () => {
  it("a decline returns the session to active so the fan can retry", async () => {
    const created = await createSession();
    const hash = created.liveQuote!.hash;
    await setPaymentMode("decline");

    const declined = await complete(created.session.id, { hash, key: "key-declined" }).expect(200);
    expect(declined.body.order).toBeNull();
    expect(declined.body.session.session.status).toBe("active");
    expect(declined.body.session.canComplete).toBe(true);

    // The same key must work again — the fan swaps card and retries.
    await setPaymentMode("approve");
    const retried = await complete(created.session.id, { hash, key: "key-declined" }).expect(201);
    expect(retried.body.order).toBeTruthy();
    expect(container.orders.count()).toBe(1);
  });

  it("holds the session locked while authorization is pending", async () => {
    const created = await createSession();
    const hash = created.liveQuote!.hash;
    await setPaymentMode("pending");

    const pending = await complete(created.session.id, { hash, key: "key-pending" }).expect(202);
    expect(pending.body.order).toBeNull();
    expect(pending.body.session.session.status).toBe("completing");

    // Nobody else can start a second attempt against a pending authorization.
    const other = await complete(created.session.id, {
      hash,
      key: "key-other",
      surface: "mobile",
      clientId: "phone",
    });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("COMPLETION_IN_PROGRESS");

    // The payment processor's webhook arrives.
    const settled = await request(app)
      .post("/api/_scenario/settle-pending")
      .send({ sessionId: created.session.id, approve: true })
      .expect(200);

    expect(settled.body.session.session.status).toBe("completed");
    expect(container.orders.count()).toBe(1);
  });

  it("a processor error is retryable and creates no order", async () => {
    const created = await createSession();
    await setPaymentMode("error");

    const res = await complete(created.session.id, {
      hash: created.liveQuote!.hash,
      key: "key-err",
    }).expect(200);

    expect(res.body.session.session.status).toBe("active");
    expect(res.body.session.session.completion.failure.code).toBe("payment_error");
    expect(container.orders.count()).toBe(0);
  });
});

/* ── concurrency control ──────────────────────────────────────────────────── */

describe("preconditions are on the thing at risk, not on the session version", () => {
  /**
   * Why there is no `If-Match` header on the session version.
   *
   * Opening the checkout on a second device is itself a write — it records that
   * the device looked. So a version precondition would fail right here, and the
   * fan would be told their checkout "changed on another device" merely because
   * they glanced at their phone.
   */
  it("lets an unrelated read from another surface bump the version without breaking a mutation", async () => {
    const created = await createSession("web");
    await setPrice(1_000);
    const asWebSaw = await readSession(created.session.id, "web");

    await readSession(created.session.id, "mobile");
    const afterMobileLooked = await readSession(created.session.id, "web");
    expect(afterMobileLooked.session.version).toBeGreaterThan(asWebSaw.session.version);

    await request(app)
      .post(`/api/checkout/sessions/${created.session.id}/acknowledge`)
      .send({ quoteHash: asWebSaw.liveQuote!.hash, surface: "web", clientId: "web-client" })
      .expect(200);
  });
});

/* ── losing the version check ─────────────────────────────────────────────── */

describe("losing a compare-and-swap", () => {
  /**
   * Slip another write in between the read and the version check.
   *
   * That gap does not exist against an in-memory `Map`: an async function that
   * never really waits runs straight through, so `applyClient` ends up
   * accidentally safe and the conflict branch is unreachable. Against Redis the
   * gap is a network round-trip wide.
   *
   * This stub puts the gap back, which is the only way to test what the fan is
   * told when a write actually loses.
   */
  function interpose(work: (sessionId: string) => Promise<unknown>) {
    const cas = container.sessions.putIfVersion.bind(container.sessions);
    let fired = false;

    vi.spyOn(container.sessions, "putIfVersion").mockImplementation(async (next, expected) => {
      if (!fired) {
        fired = true;
        // Someone else's write lands first, so the version we are holding is
        // one behind by the time we try to use it.
        await work(next.id);
      }
      return cas(next, expected);
    });
  }

  it("does not fail a purchase because another surface merely looked", async () => {
    // The version moves for reasons the fan did not cause — their phone loading
    // the page is a write. So `applyClient` re-runs the state machine and
    // returns its answer, rather than reporting a version conflict.
    const created = await createSession("web");
    interpose((id) =>
      container.checkout.getSession(id, { surface: "mobile", clientId: "phone" }),
    );

    const res = await complete(created.session.id, {
      hash: created.liveQuote!.hash,
      key: "key-touched",
    });

    expect(res.status).toBe(201);
    expect(container.orders.count()).toBe(1);
  });

  it("still answers a read whose lazy expiry lost to the sweeper", async () => {
    // Both the sweeper and a read can expire a session. If the sweeper writes
    // first, the read's own `EXPIRE` is refused — and a plain GET must not turn
    // that into an error.
    const created = await createSession();
    clock.advance(SESSION_TTL_MS + COMPLETION_GRACE_MS);
    interpose(() => container.checkout.sweepExpired());

    const res = await request(app).get(`/api/checkout/sessions/${created.session.id}`).expect(200);
    expect(res.body.session.session.status).toBe("expired");
  });

  it("reports what actually changed rather than that something did", async () => {
    const created = await createSession("web");
    interpose((id) => container.checkout.cancelSession(id));

    const res = await complete(created.session.id, {
      hash: created.liveQuote!.hash,
      key: "key-cancelled",
    });

    // The state machine's answer, not the store's. `VERSION_CONFLICT` would
    // give the client nothing it could show the fan.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SESSION_TERMINAL");
    expect(container.orders.count()).toBe(0);
  });
});

/* ── retention ────────────────────────────────────────────────────────────── */

describe("forgetting finished checkouts", () => {
  it("keeps a completed session long enough to answer a late retry", async () => {
    const created = await createSession();
    await complete(created.session.id, { hash: created.liveQuote!.hash, key: "key-1" }).expect(201);

    clock.advance(TERMINAL_RETENTION_MS - 1_000);
    expect(await container.checkout.reapTerminal()).toBe(0);

    // Still able to say "here is your order" rather than 404, which is why the
    // session is not deleted the moment it completes.
    const late = await complete(created.session.id, {
      hash: created.liveQuote!.hash,
      key: "key-late",
    }).expect(200);
    expect(late.body.order.id).toBeTruthy();
  });

  it("deletes it once the retention window has passed", async () => {
    const created = await createSession();
    await complete(created.session.id, { hash: created.liveQuote!.hash, key: "key-1" }).expect(201);

    clock.advance(TERMINAL_RETENTION_MS + 1);
    expect(await container.checkout.reapTerminal()).toBe(1);
    expect(await container.sessions.get(created.session.id)).toBeNull();

    await request(app).get(`/api/checkout/sessions/${created.session.id}`).expect(404);
    // The order outlives the session it came from.
    expect(container.orders.count()).toBe(1);
  });
});

describe("error contract", () => {
  it("404s an unknown session and does not invent a view for it", async () => {
    const res = await request(app).get("/api/checkout/sessions/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
    expect(res.body.session).toBeUndefined();
  });

  it("rejects a malformed create with field-level detail", async () => {
    const res = await request(app)
      .post("/api/checkout/sessions")
      .send({ listingId: LISTING, quantity: 0, surface: "web", clientId: "c" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.details.issues[0].path).toBe("quantity");
  });

  it("refuses to create a session for more tickets than exist", async () => {
    const res = await request(app)
      .post("/api/checkout/sessions")
      .send({ listingId: LISTING, quantity: 8, surface: "web", clientId: "c" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVENTORY_UNAVAILABLE");
  });
});
