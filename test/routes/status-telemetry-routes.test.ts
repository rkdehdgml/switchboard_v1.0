/**
 * Route tests for POST /api/status-telemetry — the Claude statusline exporter
 * endpoint that feeds the header "Plan Usage Limits" chip.
 *
 * Covers: broadcast on real telemetry + footer print-through, unknown-session
 * skip, per-session change-detection (dedup), rebroadcast on a displayed change,
 * NO rebroadcast on context-only drift, null-tolerance of Claude's undocumented
 * fields (the .nullish() schema — the project's recurring .optional()/null trap),
 * and 400 on a malformed body.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerStatusTelemetryRoutes } from '../../src/web/routes/status-telemetry-routes.js';
import { SessionStatusTelemetry, SessionUpdated } from '../../src/web/sse-events.js';

const SID = 'test-session-1'; // default id created by createMockRouteContext

const REAL = {
  rate_limits: {
    five_hour: { used_percentage: 15, resets_at: 1781409000 },
    seven_day: { used_percentage: 34, resets_at: 1781827200 },
  },
  context_window: { used_percentage: 56, total_input_tokens: 562411, total_output_tokens: 1188 },
  cost: { total_cost_usd: 0.0415 },
  model: { display_name: 'Opus 4.8 (1M context)' },
};

describe('POST /api/status-telemetry', () => {
  let h: RouteTestHarness;

  beforeEach(async () => {
    h = await createRouteTestHarness(registerStatusTelemetryRoutes, { sessionId: SID });
  });

  // The same payload also stores the session's cost and announces it with session:updated.
  const telemetryCalls = () =>
    h.ctx.broadcast.mock.calls.filter(([event]: [string]) => event === SessionStatusTelemetry);

  const post = (body: unknown) => h.app.inject({ method: 'POST', url: '/api/status-telemetry', payload: body });

  it('broadcasts plan-usage telemetry and returns the session-status footer', async () => {
    const res = await post({ sessionId: SID, data: REAL });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('Opus 4.8 (1M context)  in:562,411 out:1,188  ctx:56%');
    expect(telemetryCalls()).toHaveLength(1);
    const [event, payload] = telemetryCalls()[0];
    expect(event).toBe(SessionStatusTelemetry);
    expect(payload).toMatchObject({
      sessionId: SID,
      fiveHour: { usedPercentage: 15 },
      sevenDay: { usedPercentage: 34 },
    });
  });

  it('does not broadcast for an unknown session; returns an EMPTY footer, never a brand word', async () => {
    const res = await post({ sessionId: 'does-not-exist', data: REAL });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(h.ctx.broadcast).not.toHaveBeenCalled();
  });

  it('dedups identical telemetry — rebroadcasts only once', async () => {
    await post({ sessionId: SID, data: REAL });
    await post({ sessionId: SID, data: REAL });
    expect(telemetryCalls()).toHaveLength(1);
  });

  it('rebroadcasts when a displayed window percentage changes', async () => {
    await post({ sessionId: SID, data: REAL });
    const moved = {
      ...REAL,
      rate_limits: { ...REAL.rate_limits, five_hour: { used_percentage: 16, resets_at: 1781409000 } },
    };
    await post({ sessionId: SID, data: moved });
    expect(telemetryCalls()).toHaveLength(2);
  });

  it('does NOT rebroadcast on context-only drift (the chip never shows context %)', async () => {
    await post({ sessionId: SID, data: REAL });
    await post({ sessionId: SID, data: { ...REAL, context_window: { ...REAL.context_window, used_percentage: 91 } } });
    expect(telemetryCalls()).toHaveLength(1);
  });

  it("tolerates null in Claude's undocumented fields (no 400) and ignores them", async () => {
    const res = await post({
      sessionId: SID,
      data: {
        rate_limits: { five_hour: { used_percentage: 20, resets_at: 1781409000 }, seven_day: null },
        cost: { total_cost_usd: null },
        model: { display_name: null },
        context_window: { used_percentage: null, total_input_tokens: null, total_output_tokens: null },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(telemetryCalls()).toHaveLength(1);
    const [, payload] = telemetryCalls()[0];
    expect(payload).toMatchObject({ fiveHour: { usedPercentage: 20 } });
    expect(payload.sevenDay).toBeUndefined();
  });

  it('stores the statusline cost on the session and announces it once per change', async () => {
    await post({ sessionId: SID, data: REAL });
    expect(h.ctx.sessions.get(SID).totalCost).toBe(0.0415);
    const updates = () => h.ctx.broadcast.mock.calls.filter(([event]: [string]) => event === SessionUpdated);
    expect(updates()).toHaveLength(1);
    await post({ sessionId: SID, data: REAL }); // same cost: no new session:updated
    expect(updates()).toHaveLength(1);
    await post({ sessionId: SID, data: { ...REAL, cost: { total_cost_usd: 0.09 } } });
    expect(updates()).toHaveLength(2);
  });

  it('stores cost even when the account has no plan limits (non-subscriber)', async () => {
    await post({ sessionId: SID, data: { cost: { total_cost_usd: 1.5 } } });
    expect(h.ctx.sessions.get(SID).totalCost).toBe(1.5);
    expect(telemetryCalls()).toHaveLength(0);
  });

  it('ignores a negative or non-numeric cost', async () => {
    await post({ sessionId: SID, data: { cost: { total_cost_usd: -3 } } });
    expect(h.ctx.sessions.get(SID).totalCost).toBe(0);
  });

  it('rejects a malformed body (missing sessionId) with 400', async () => {
    const res = await post({ data: REAL });
    expect(res.statusCode).toBe(400);
  });
});
