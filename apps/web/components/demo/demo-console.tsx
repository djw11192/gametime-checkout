"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { buttonClass } from "@/components/ui";

/**
 * Two surfaces on the same session, side by side, with the levers that move the
 * world underneath them. The interesting behaviour here is multi-device and
 * time-dependent, and nobody has two phones and ten minutes to wait for a TTL.
 */
export function DemoConsole({
  sessionId,
  listingId,
}: {
  sessionId: string;
  listingId: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * Fire the lever and nothing else — no iframe reload. The surfaces update
   * because the push reached them, which is the claim this console exists to
   * demonstrate. If a panel stops updating here, that is a real failure and it
   * should be visible.
   */
  const run = useCallback(async (name: string, path: string, body: unknown) => {
    setBusy(name);
    try {
      await fetch(`/api/_scenario/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <main className="mx-auto max-w-[1400px] px-5 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Checkout continuity — demo console</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            One session, two surfaces, live over SSE.
          </p>
        </div>
        <Link href="/demo" className={buttonClass("secondary", "text-xs")}>
          New session
        </Link>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr_260px]">
        <Surface title="Desktop web" path="/checkout/[id]">
          <iframe
            src={`/checkout/${sessionId}`}
            title="Desktop checkout surface"
            className="h-[760px] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-800"
          />
        </Surface>

        <Surface title="Mobile app" path="/m/checkout/[id] · deep link">
          <iframe
            src={`/m/checkout/${sessionId}?src=deeplink`}
            title="Mobile checkout surface"
            className="h-[760px] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-800"
          />
        </Surface>

        <div className="space-y-4">
          <Section title="Move the world">
            <div className="grid grid-cols-2 gap-2">
              <Control label="Price +$20" busy={busy === "up"} onClick={() => run("up", "price", { listingId, deltaCents: 2_000 })} />
              <Control label="Price −$15" busy={busy === "down"} onClick={() => run("down", "price", { listingId, deltaCents: -1_500 })} />
              <Control label="Sell out" tone="danger" busy={busy === "sellout"} onClick={() => run("sellout", "inventory", { listingId, availableQuantity: 0 })} />
              <Control label="Restock" busy={busy === "restock"} onClick={() => run("restock", "inventory", { listingId, availableQuantity: 4 })} />
              <Control label="Expire now" tone="danger" busy={busy === "expire"} onClick={() => run("expire", "expire", { sessionId, inSeconds: 0 })} />
              <Control label="Expire in 20s" busy={busy === "soon"} onClick={() => run("soon", "expire", { sessionId, inSeconds: 20 })} />
            </div>
          </Section>

          <Section title="Payment processor">
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["approve", "Approve"],
                  ["decline", "Decline"],
                  ["pending", "Pending (3DS)"],
                  ["slow", "Slow (4s)"],
                  ["error", "Error"],
                ] as const
              ).map(([mode, label]) => (
                <Control
                  key={mode}
                  label={label}
                  busy={busy === mode}
                  onClick={() => run(mode, "payment-mode", { mode })}
                />
              ))}
              <Control
                label="Settle pending"
                tone="primary"
                busy={busy === "settle"}
                onClick={() => run("settle", "settle-pending", { sessionId, approve: true })}
              />
            </div>
            <p className="mt-3 text-[11px] leading-snug text-slate-500">
              For the duplicate-order guard: set <strong>Slow</strong>, then press Complete on both
              surfaces at once. One order is created; the other says &ldquo;completing on your other
              device&rdquo;.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}

function Surface({
  title,
  path,
  children,
}: {
  title: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <code className="font-mono text-[11px] text-slate-400">{path}</code>
      </header>
      {children}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function Control({
  label,
  onClick,
  busy,
  tone = "secondary",
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  tone?: "secondary" | "danger" | "primary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={buttonClass(tone, "px-2.5 py-2 text-xs")}
    >
      {busy ? "…" : label}
    </button>
  );
}
