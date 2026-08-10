import { createApp } from "./app.js";
import { createContainer } from "./container.js";

const PORT = Number(process.env.PORT ?? 4000);

const container = createContainer();
const app = createApp(container);
const stopSweeper = container.startSweeper();

const server = app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
  console.log(`[api] expiry sweeper running`);
});

// SSE connections are long-lived by design, so an unclean shutdown leaves the
// port held. Close them explicitly rather than waiting on a 10-minute timeout.
function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  stopSweeper();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
