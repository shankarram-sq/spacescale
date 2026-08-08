export type ErrorCode =
  | "BAD_REQUEST"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "TEMPORARILY_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "TURNSTILE_REQUIRED"
  | "TURNSTILE_FAILED"
  | "STALE_ACL"
  | "STALE_BOARD";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode | string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known ? error.message : "The request could not be completed.";
  const details = known ? error.details : undefined;
  return Response.json(
    {
      error: {
        code,
        message,
        requestId,
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(500, "INTERNAL_ERROR", "The request could not be completed.");
}
