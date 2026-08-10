import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Countdown } from "./countdown";

/**
 * What the fan sees before hydration.
 *
 * These assert against `renderToString` on purpose. The countdown is the one
 * piece of the checkout that a `useState` + `useEffect` implementation would
 * render as `--:--` until JavaScript has loaded, parsed and hydrated — and on a
 * checkout page the timer *is* the pressure. So the property worth a test is
 * not "the clock ticks", which any implementation gets right eventually; it is
 * "the very first byte of HTML already carries a real number".
 */

const inTenMinutes = new Date(Date.now() + 10 * 60 * 1000).toISOString();

/** The text a fan reads, with the markup stripped off. */
const displayed = (html: string) => html.replace(/<[^>]*>/g, "");

describe("Countdown, server-rendered", () => {
  it("puts a real duration in the HTML, not a placeholder", () => {
    const html = renderToString(
      <Countdown
        expiresAt={inTenMinutes}
        serverRemainingMs={9 * 60 * 1000 + 58 * 1000}
        serverTime={new Date().toISOString()}
      />,
    );

    expect(displayed(html)).toBe("9:58");
  });

  /**
   * The first paint comes from `serverRemainingMs`, never from a local clock.
   * Here the deadline has already passed by the device's reckoning while the
   * server says five minutes remain — a phone set badly fast. The server wins,
   * because at this point in the lifecycle there is no device clock to trust
   * and correcting for skew is `getSnapshot`'s job, after hydration.
   */
  it("uses the server's remaining time even when the deadline looks elapsed locally", () => {
    const html = renderToString(
      <Countdown
        expiresAt={new Date(Date.now() - 60 * 60 * 1000).toISOString()}
        serverRemainingMs={5 * 60 * 1000}
        serverTime={new Date().toISOString()}
      />,
    );

    expect(displayed(html)).toBe("5:00");
  });

  it("announces the last minute and stays quiet before it", () => {
    const urgent = renderToString(
      <Countdown
        expiresAt={inTenMinutes}
        serverRemainingMs={45 * 1000}
        serverTime={new Date().toISOString()}
      />,
    );
    const calm = renderToString(
      <Countdown
        expiresAt={inTenMinutes}
        serverRemainingMs={5 * 60 * 1000}
        serverTime={new Date().toISOString()}
      />,
    );

    expect(urgent).toContain('aria-live="polite"');
    expect(calm).toContain('aria-live="off"');
  });

  it("clamps to 0:00 rather than counting into negative time", () => {
    const html = renderToString(
      <Countdown
        expiresAt={new Date(Date.now() - 60 * 1000).toISOString()}
        serverRemainingMs={-30_000}
        serverTime={new Date().toISOString()}
      />,
    );

    expect(displayed(html)).toBe("0:00");
  });
});
