"use client";

import { useEffect, useMemo, useState } from "react";
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
 * The single source of live checkout state on the client. `initialData` is the
 * view the Server Component already rendered, so there is no fetch on mount;
 * updates arrive over SSE and are folded in with `mergeSessionView`; polling
 * starts only once `EventSource` has genuinely given up.
 *
 * URLs are relative so they resolve against whatever origin served the page,
 * which is what lets the same code work over a tunnel or a LAN IP.
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
  const queryKey = useMemo(() => ["checkout", sessionId], [sessionId]);

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
  }, [sessionId, queryClient, queryKey]);

  return { view: query.data ?? initialView, streamState };
}
