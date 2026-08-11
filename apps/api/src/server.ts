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

// The update streams are meant to stay open for a long time, so on shutdown
// they have to be closed explicitly. Otherwise the process hangs on to the port
// until they time out on their own.
function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  stopSweeper();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
