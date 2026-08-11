import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Countdown } from "./countdown";

/**
 * What the fan sees before any JavaScript runs.
 *
 * These deliberately assert against `renderToString`. The thing worth testing
 * is not that the clock ticks — any implementation manages that eventually —
 * but that the server-rendered HTML already contains a real number.
 */

const inTenMinutes = new Date(Date.now() + 10 * 60 * 1000).toISOString();

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
   * The first render uses `serverRemainingMs`, never the device's own clock.
   *
   * These fixtures look contradictory on purpose: by the device's reckoning the
   * deadline passed an hour ago, while the server says five minutes remain.
   * That is a phone set badly fast, and the server has to win — correcting for
   * a wrong device clock only happens later, once the page is running.
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
