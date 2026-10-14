/** @fileoverview Usage dashboard summary (Switchboard T4): read-only, built from Claude Code's own logs. */
import type { FastifyInstance } from 'fastify';
import { scanDigests, summarize } from '../../usage-dashboard.js';
import type { SessionPort } from '../ports/index.js';

export function registerUsageRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get('/api/usage/summary', async () => {
    // A running session has no `cost-state` yet; its statusline cost, kept on the session, stands in.
    const live = [...ctx.sessions.values()].flatMap((s) =>
      s.claudeSessionId && s.totalCost > 0 ? [{ claudeSessionId: s.claudeSessionId, costUsd: s.totalCost }] : []
    );
    return { success: true, data: summarize(await scanDigests(), live) };
  });
}
