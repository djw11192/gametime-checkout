"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function Providers({ children }: { children: ReactNode }) {
  // Created in state rather than at the top of the file. A module-level client
  // would be shared by every request on the server, leaking one user's checkout
  // into another user's page.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Checkout updates are pushed to us. Refetching in the background
            // would compete with the stream and could replace what is on screen
            // with an older view.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
