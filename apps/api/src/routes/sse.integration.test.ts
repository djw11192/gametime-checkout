import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { CheckoutSessionView } from "@gametime/contracts";
import { createApp } from "../app";
import { createContainer, type Container } from "../container";
import { FakeClock } from "../ports/clock";

/**
 * The event stream itself, over a real socket.
 *
 * `supertest` buffers a whole response before handing it back, so it can say
 * nothing about a stream that never ends. These tests hold a connection open
 * and read frames as they arrive, which is the only way to check the things
 * that only exist on the wire: which frames carry an `id:`, and what a
 * reconnecting client is sent.
 */

const LISTING = "lst_warriors_lower_112";

let container: Container;
let server: Server;
let port: number;
let open: Array<{ close(): void }> = [];

beforeEach(async () => {
  container = createContainer({ clock: new FakeClock() });
  server = createApp(container).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
  open = [];
});

afterEach(async () => {
  for (const stream of open) stream.close();
  await new Promise((resolve) => server.close(resolve));
});

/* ── a minimal SSE client ─────────────────────────────────────────────────── */

interface Frame {
  /** Absent on the snapshot frame, which is the point of the first test. */
  id?: number;
  type: string;
  data: { view?: CheckoutSessionView; code?: string };
}

/** Returns null for the `retry:` preamble and for `: ping` heartbeats. */
function parseFrame(raw: string): Frame | null {
  let id: number | undefined;
  let type: string | undefined;
  let data = "null";

  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) id = Number(line.slice(4));
    else if (line.startsWith("event: ")) type = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }

  return type ? { id, type, data: JSON.parse(data) } : null;
}

/** Poll rather than sleep, so these never wait longer than they have to. */
async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function connect(sessionId: string, lastEventId?: number) {
  const frames: Frame[] = [];
  let buffered = "";
  let ended = false;

  const req = httpRequest({
    port,
    path: `/api/checkout/sessions/${sessionId}/events`,
    headers: {
      accept: "text/event-stream",
      // What `EventSource` sends by itself after a dropped connection.
      ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }),
    },
  });

  const response = new Promise<IncomingMessage>((resolve) => req.on("response", resolve));

  void response.then((res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffered += chunk;
      // A blank line ends a frame.
      for (let at = buffered.indexOf("\n\n"); at !== -1; at = buffered.indexOf("\n\n")) {
        const frame = parseFrame(buffered.slice(0, at));
        if (frame) frames.push(frame);
        buffered = buffered.slice(at + 2);
      }
    });
    res.on("end", () => {
      ended = true;
    });
  });
  req.end();

  const stream = {
    frames,
    hasEnded: () => ended,
    headers: async () => (await response).headers,
    waitFor: (count: number) => until(() => frames.length >= count, `${count} frame(s)`),
    close: () => req.destroy(),
  };
  open.push(stream);
  return stream;
}

async function createSession() {
  const res = await request(server)
    .post("/api/checkout/sessions")
    .send({ listingId: LISTING, quantity: 2, surface: "web", clientId: "web-client" })
    .expect(201);
  return (res.body.session as CheckoutSessionView).session.id;
}

const setPrice = (deltaCents: number) =>
  request(server).post("/api/_scenario/price").send({ listingId: LISTING, deltaCents }).expect(200);

/* ── tests ────────────────────────────────────────────────────────────────── */

describe("the checkout event stream", () => {
  it("opens with the current state, and gives that frame no id", async () => {
    const sessionId = await createSession();
    const stream = connect(sessionId);

    expect((await stream.headers())["content-type"]).toContain("text/event-stream");
    // Without this a proxy would hold the whole stream until it closed.
    expect((await stream.headers())["x-accel-buffering"]).toBe("no");

    await stream.waitFor(1);
    expect(stream.frames[0]?.type).toBe("session.updated");
    expect(stream.frames[0]?.data.view?.session.id).toBe(sessionId);
    // The snapshot must not move the client's `Last-Event-ID` marker backwards,
    // so it deliberately carries no id. Real events do.
    expect(stream.frames[0]?.id).toBeUndefined();

    await setPrice(1_000);
    await stream.waitFor(2);
    expect(stream.frames[1]?.type).toBe("quote.changed");
    expect(stream.frames[1]?.id).toBe(1);
  });

  it("sends a reconnecting client only what it missed", async () => {
    // The phone's screen goes off after the first price change and comes back
    // during the second.
    const sessionId = await createSession();
    await setPrice(1_000);
    await setPrice(500);

    const stream = connect(sessionId, 1);
    await stream.waitFor(2);

    expect(stream.frames[0]?.id).toBeUndefined();
    expect(stream.frames.slice(1).map((f) => f.id)).toEqual([2]);
  });

  it("closes the stream on a session that does not exist", async () => {
    const stream = connect("does-not-exist");
    await stream.waitFor(1);

    expect(stream.frames[0]).toMatchObject({ type: "error", data: { code: "SESSION_NOT_FOUND" } });
    await until(stream.hasEnded, "the stream to end");
  });

  it("drops the subscriber when the client goes away", async () => {
    // A subscriber left behind on every closed tab is a leak that only shows up
    // under load, which is the worst time to find it.
    const sessionId = await createSession();
    const stream = connect(sessionId);
    await stream.waitFor(1);
    await until(() => container.bus.subscriberCount(sessionId) === 1, "the subscriber to register");

    stream.close();
    await until(() => container.bus.subscriberCount(sessionId) === 0, "the subscriber to be dropped");
  });
});
