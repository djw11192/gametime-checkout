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
 * The one source of live checkout state in the browser.
 *
 * It starts from the view the server already rendered, so there is no fetch
 * when the page loads. Updates then arrive on the event stream and are merged
 * in by `mergeSessionView`. Polling only kicks in once the stream has genuinely
 * given up.
 *
 * The URLs are relative on purpose, so they resolve against whatever address
 * served the page. That is what lets the same code work unchanged when the
 * phone loads it from the laptop's network address instead of localhost.
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

  const query = useQuery({
    queryKey: ["checkout", sessionId],
    queryFn: async () => {
      const response = await fetch(
        `/api/checkout/sessions/${sessionId}?surface=${surface}&clientId=${encodeURIComponent(clientId)}`,
        { cache: "no-store" },
      );
      return CheckoutSessionViewSchema.parse((await response.json()).session);
    },
    initialData: initialView,
    // The server just rendered this, so refetching on mount would ask again
    // for data already on the page.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: streamState === "polling" ? POLL_FALLBACK_INTERVAL_MS : false,
  });

  /**
   * Fold each new server render back into the cache.
   *
   * `initialData` only seeds an empty cache entry, so without this every view
   * produced by a Server Action's `revalidatePath` is dropped on the floor —
   * accepting a new price would succeed on the server while the banner stayed
   * up. It goes through the same merge as a pushed update, so a server render
   * that raced an SSE message cannot walk the session backwards.
   */
  useEffect(() => {
    queryClient.setQueryData<CheckoutSessionView>(["checkout", sessionId], (cached) =>
      mergeSessionView(cached, initialView),
    );
  }, [queryClient, sessionId, initialView]);

  useEffect(() => {
    const source = new EventSource(`/api/checkout/sessions/${sessionId}/events`);

    const apply = (event: MessageEvent<string>) => {
      try {
        const incoming = CheckoutSessionViewSchema.parse(JSON.parse(event.data).view);
        queryClient.setQueryData<CheckoutSessionView>(["checkout", sessionId], (cached) =>
          mergeSessionView(cached, incoming),
        );
      } catch {
        // One malformed message must not tear down a working stream.
      }
    };

    source.onopen = () => setStreamState("live");
    for (const type of SSE_EVENTS) source.addEventListener(type, apply as EventListener);

    // EventSource reconnects by itself and catches up on what it missed, so an
    // error here is usually temporary. Only a CLOSED connection means it has
    // stopped trying — that is when we fall back to polling.
    source.onerror = () =>
      setStreamState(source.readyState === EventSource.CLOSED ? "polling" : "reconnecting");

    return () => source.close();
  }, [sessionId, queryClient]);

  return { view: query.data ?? initialView, streamState };
}
