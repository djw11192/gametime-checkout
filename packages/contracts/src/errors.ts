import { z } from "zod";

/** One closed set of codes. Clients switch on `code`, never on the HTTP status alone. */
export const ApiErrorCodeSchema = z.enum([
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "SESSION_TERMINAL",
  "VERSION_CONFLICT",
  /** The quote the fan acted on is no longer the live price. */
  "QUOTE_STALE",
  "INVENTORY_UNAVAILABLE",
  /** Another surface holds the single-flight completion lock. */
  "COMPLETION_IN_PROGRESS",
  "PAYMENT_DECLINED",
  "PAYMENT_ERROR",
  "EXTENSION_LIMIT_REACHED",
  "VALIDATION_FAILED",
  "IDEMPOTENCY_KEY_REUSED",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * Every 4xx about an existing session carries the current view alongside the
 * error, so a client hitting a 409 reconciles from the same response instead of
 * racing a follow-up GET that may itself be stale on arrival.
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
  SESSION_NOT_FOUND: 404,
  SESSION_EXPIRED: 409,
  SESSION_TERMINAL: 409,
  VERSION_CONFLICT: 409,
  QUOTE_STALE: 409,
  INVENTORY_UNAVAILABLE: 409,
  COMPLETION_IN_PROGRESS: 409,
  PAYMENT_DECLINED: 402,
  PAYMENT_ERROR: 502,
  EXTENSION_LIMIT_REACHED: 409,
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  INTERNAL_ERROR: 500,
};

export const RETRYABLE_BY_CODE: Record<ApiErrorCode, boolean> = {
  SESSION_NOT_FOUND: false,
  SESSION_EXPIRED: false,
  SESSION_TERMINAL: false,
  VERSION_CONFLICT: true,
  QUOTE_STALE: true,
  INVENTORY_UNAVAILABLE: false,
  COMPLETION_IN_PROGRESS: true,
  PAYMENT_DECLINED: true,
  PAYMENT_ERROR: true,
  EXTENSION_LIMIT_REACHED: false,
  VALIDATION_FAILED: false,
  IDEMPOTENCY_KEY_REUSED: false,
  INTERNAL_ERROR: true,
};
