import {
  SSE_BUFFER_SIZE,
  type CheckoutSessionView,
  type SseEnvelope,
  type SseEventType,
} from "@gametime/contracts";

type Subscriber = (envelope: SseEnvelope) => void;

interface Channel {
  nextId: number;
  buffer: SseEnvelope[];
  subscribers: Set<Subscriber>;
}

/**
 * Per-session pub/sub with a bounded replay buffer. A fan who locks their phone
 * drops the connection; `EventSource` reconnects and sends back the last id it
 * saw, and the buffer is what lets us fill the gap instead of leaving the client
 * silently stale. A client that falls further behind than the buffer still gets
 * a full-state envelope, so it self-heals.
 *
 * In production: Redis pub/sub for fan-out plus `XADD … MAXLEN ~ 50` for replay.
 */
export class SessionEventBus {
  private channels = new Map<string, Channel>();

  private channel(sessionId: string): Channel {
    let existing = this.channels.get(sessionId);
    if (!existing) {
      existing = { nextId: 1, buffer: [], subscribers: new Set() };
      this.channels.set(sessionId, existing);
    }
    return existing;
  }

  publish(sessionId: string, type: SseEventType, view: CheckoutSessionView): SseEnvelope {
    const channel = this.channel(sessionId);
    const envelope: SseEnvelope = { id: channel.nextId++, type, view };

    channel.buffer.push(envelope);
    if (channel.buffer.length > SSE_BUFFER_SIZE) channel.buffer.shift();

    for (const subscriber of channel.subscribers) {
      // One dead connection must not stop the others being notified.
      try {
        subscriber(envelope);
      } catch {
        /* the SSE route cleans up on close */
      }
    }
    return envelope;
  }

  /** Replays everything after `lastEventId` before subscribing. Returns unsubscribe. */
  subscribe(sessionId: string, subscriber: Subscriber, lastEventId?: number): () => void {
    const channel = this.channel(sessionId);

    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      for (const envelope of channel.buffer) {
        if (envelope.id > lastEventId) subscriber(envelope);
      }
    }

    channel.subscribers.add(subscriber);
    return () => channel.subscribers.delete(subscriber);
  }

  subscriberCount(sessionId: string): number {
    return this.channels.get(sessionId)?.subscribers.size ?? 0;
  }

  /**
   * Drop a channel whose session has been reaped. Bounding the buffer is not
   * enough on its own — the map grows by one entry per checkout ever started.
   */
  dropSession(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  clear(): void {
    this.channels.clear();
  }
}
