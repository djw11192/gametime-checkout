import { Router } from "express";
import type { Container } from "../container";

export function analyticsRouter(container: Container): Router {
  const router = Router();

  /**
   * The conversion question, answered with data rather than prose. The two
   * rates that matter sit side by side: fans who stayed on one surface, and
   * fans who moved between two.
   */
  router.get("/funnel", (_req, res) => {
    res.json({ funnel: container.analytics.funnel() });
  });

  return router;
}
