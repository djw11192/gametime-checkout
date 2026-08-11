/**
 * Every expiry rule reads the time from here rather than calling `Date.now()`
 * directly. That is what lets the tests exercise a ten-minute deadline by
 * advancing a fake clock, instead of actually sleeping.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now() {
    return new Date();
  }
  nowMs() {
    return Date.now();
  }
  nowIso() {
    return new Date().toISOString();
  }
}

export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = "2026-01-15T18:00:00.000Z") {
    this.current = new Date(start).getTime();
  }

  now() {
    return new Date(this.current);
  }
  nowMs() {
    return this.current;
  }
  nowIso() {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
