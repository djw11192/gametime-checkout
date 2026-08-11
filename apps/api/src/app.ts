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
 * The one error handler. Express 5 forwards rejected promises here on its own,
 * so no route needs its own try/catch.
 *
 * When the error is about a session that exists, the current view is sent
 * alongside it — see `ApiErrorBody`.
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
        /* no session to attach */
      }
    }

    res.status(apiError.httpStatus).json(body);
  };
}
