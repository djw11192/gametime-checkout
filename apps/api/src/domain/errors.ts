import { HTTP_STATUS_BY_CODE, RETRYABLE_BY_CODE, type ApiErrorCode } from "@gametime/contracts";

/**
 * Status and retryability are derived from the code rather than passed in, so
 * the same condition can never be a 409 on one route and a 400 on another.
 */
export class ApiError extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.retryable = RETRYABLE_BY_CODE[code];
  }
}

export interface DomainError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export const domainError = (
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DomainError => (details ? { code, message, details } : { code, message });

export const toApiError = (error: DomainError) =>
  new ApiError(error.code, error.message, error.details);
