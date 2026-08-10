"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function Providers({ children }: { children: ReactNode }) {
  // Created in state, not at module scope: a module-level client would be
  // shared across requests on the server and leak one user's checkout into
  // another's render.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Checkout state arrives by push. Background refetching would fight
            // the SSE stream and occasionally serve an older view than the one
            // already on screen.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
