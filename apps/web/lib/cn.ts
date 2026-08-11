/** Minimal class combiner — the whole of `clsx` that this app actually uses. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
