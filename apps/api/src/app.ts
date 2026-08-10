import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import type { Container } from "./container";
import { ApiError } from "./domain/errors";
import { catalogRouter } from "./routes/catalog";
import { checkoutRouter } from "./routes/checkout";
import { scenarioRouter } from "./routes/scenario";
import { sseRouter } from "./routes/sse";

export function createApp(container: Container): Express {
  const app = express();

  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "64kb" }));
  app.disable("x-powered-by");

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", catalogRouter(container));
  app.use("/api/checkout", checkoutRouter(container));
  app.use("/api/checkout", sseRouter(container));

  if (process.env.NODE_ENV !== "production") {
    app.use("/api/_scenario", scenarioRouter(container));
  }

  app.use(errorHandler(container));
  return app;
}

/**
 * Single error boundary — Express 5 forwards rejected promises here, so no
 * route needs a try/catch.
 *
 * When the failure concerns a session that exists, the current view is
 * serialised alongside the error so a client hitting a 409 reconciles from the
 * same response instead of firing a follow-up GET that may itself be stale.
 */
function errorHandler(container: Container) {
  return async (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);

    const apiError =
      error instanceof ApiError
        ? error
        : new ApiError("INTERNAL_ERROR", "Something went wrong on our end.");

    if (!(error instanceof ApiError)) console.error("[api] unhandled error", error);

    const body: Record<string, unknown> = {
      error: {
        code: apiError.code,
        message: apiError.message,
        retryable: apiError.retryable,
        ...(apiError.details ? { details: apiError.details } : {}),
      },
    };

    // `req.params` is router-scoped and already empty by the time an app-level
    // error handler runs, so the id has to come off the path.
    const sessionId = /\/sessions\/([^/?]+)/.exec(req.path)?.[1];
    if (sessionId && apiError.code !== "SESSION_NOT_FOUND") {
      try {
        body.session = await container.checkout.getSession(sessionId);
      } catch {
        /* genuinely not there — the code already says so */
      }
    }

    res.status(apiError.httpStatus).json(body);
  };
}
