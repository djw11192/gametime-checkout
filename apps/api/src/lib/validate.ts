import type { z } from "zod";
import { ApiError } from "../domain/errors";

/**
 * Parse an inbound body against the shared contract schema. The types in
 * `@gametime/contracts` are only trustworthy on the server because this runs.
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
