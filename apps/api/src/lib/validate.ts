import type { z } from "zod";
import { ApiError } from "../domain/errors";

/**
 * Check an incoming request body against the shared schema. This is what makes
 * the types from `@gametime/contracts` actually true on the server, rather than
 * just asserted.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED", "Request body failed validation.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
