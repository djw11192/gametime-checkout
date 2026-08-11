import { z } from "zod";

/** One closed set of codes. Clients switch on `code`, never on the HTTP status alone. */
export const ApiErrorCodeSchema = z.enum([
  "NOT_FOUND",
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "SESSION_TERMINAL",
  /** The session changed underneath us and we could not safely retry. Rare. */
  "VERSION_CONFLICT",
  /** The quote the fan acted on is no longer the live price. */
  "QUOTE_STALE",
  "INVENTORY_UNAVAILABLE",
  /** Another surface is already completing this checkout. */
  "COMPLETION_IN_PROGRESS",
  "EXTENSION_LIMIT_REACHED",
  "VALIDATION_FAILED",
  /** The same `Idempotency-Key` was sent with a different request body. */
  "IDEMPOTENCY_KEY_REUSED",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * Every 4xx about a session that exists sends the current view along with the
 * error. That way a client refused with a 409 can update itself from the same
 * response, instead of making a second request whose answer could already be
 * out of date by the time it arrives.
 */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }),
  session: z.unknown().optional(),
});

export const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  SESSION_EXPIRED: 409,
  SESSION_TERMINAL: 409,
  VERSION_CONFLICT: 409,
  QUOTE_STALE: 409,
  INVENTORY_UNAVAILABLE: 409,
  COMPLETION_IN_PROGRESS: 409,
  EXTENSION_LIMIT_REACHED: 409,
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  INTERNAL_ERROR: 500,
};

export const RETRYABLE_BY_CODE: Record<ApiErrorCode, boolean> = {
  NOT_FOUND: false,
  SESSION_NOT_FOUND: false,
  SESSION_EXPIRED: false,
  SESSION_TERMINAL: false,
  VERSION_CONFLICT: true,
  QUOTE_STALE: true,
  INVENTORY_UNAVAILABLE: false,
  COMPLETION_IN_PROGRESS: true,
  EXTENSION_LIMIT_REACHED: false,
  VALIDATION_FAILED: false,
  IDEMPOTENCY_KEY_REUSED: false,
  INTERNAL_ERROR: true,
};
