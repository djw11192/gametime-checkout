"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckoutSessionViewSchema,
  POLL_FALLBACK_INTERVAL_MS,
  mergeSessionView,
  type CheckoutSessionView,
  type SseEventType,
  type Surface,
} from "@gametime/contracts";

export type StreamState = "live" | "reconnecting" | "polling";

const SSE_EVENTS: SseEventType[] = [
  "session.updated",
  "session.expired",
  "quote.changed",
  "completion.started",
  "completion.succeeded",
  "completion.failed",
];

/**
 * The single source of live checkout state on the client.
 *
 * 1. `initialData` is the view the Server Component already rendered, so there
 *    is no fetch on mount and no spinner on a page whose HTML already contained
 *    the answer.
 * 2. Updates arrive over SSE and are folded in with `mergeSessionView`, which
 *    drops anything not newer by (`session.version`, `serverTime`) — reconnect
 *    replay deliberately re-sends events the client may already have processed.
 *    Both halves are load-bearing: a price change re-projects the session
 *    without mutating it, so version alone would discard it.
 * 3. Polling is a fallback, not the design: it starts only once EventSource has
 *    genuinely given up, and stops when the stream recovers.
 *
 * URLs are relative so they resolve against whatever origin the page was served
 * from, which is what lets the same code work over a tunnel or a LAN IP.
 */
export function useCheckoutSession(input: {
  sessionId: string;
  initialView: CheckoutSessionView;
  surface: Surface;
  clientId: string;
}): { view: CheckoutSessionView; streamState: StreamState } {
  const { sessionId, initialView, surface, clientId } = input;
  const queryClient = useQueryClient();
  const [streamState, setStreamState] = useState<StreamState>("reconnecting");
  const queryKey = ["checkout", sessionId];

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await fetch(
        `/api/checkout/sessions/${sessionId}?surface=${surface}&clientId=${encodeURIComponent(clientId)}`,
        { cache: "no-store" },
      );
      return CheckoutSessionViewSchema.parse((await response.json()).session);
    },
    initialData: initialView,
    // The server just rendered this; refetching on mount would re-request data
    // already in the DOM.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: streamState === "polling" ? POLL_FALLBACK_INTERVAL_MS : false,
  });

  useEffect(() => {
    const source = new EventSource(`/api/checkout/sessions/${sessionId}/events`);

    const apply = (event: MessageEvent<string>) => {
      try {
        const incoming = CheckoutSessionViewSchema.parse(JSON.parse(event.data).view);
        queryClient.setQueryData<CheckoutSessionView>(queryKey, (cached) =>
          mergeSessionView(cached, incoming),
        );
      } catch {
        // A malformed frame must not tear down an otherwise working stream.
      }
    };

    source.onopen = () => setStreamState("live");
    for (const type of SSE_EVENTS) source.addEventListener(type, apply as EventListener);

    // EventSource reconnects on its own and catches up via Last-Event-ID, so an
    // error is usually transient. Only a CLOSED socket means it has given up.
    source.onerror = () =>
      setStreamState(source.readyState === EventSource.CLOSED ? "polling" : "reconnecting");

    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, queryClient]);

  return { view: query.data ?? initialView, streamState };
}
