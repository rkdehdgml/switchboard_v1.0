/**
 * @fileoverview Switchboard T9-1 desktop mode: per-launch token, exact Host/Origin,
 * loopback-only bind, no tunnel. Unit tests for the pure helpers plus one real
 * server (port 3270, test mode) driven through node:http so the Host header can be
 * forged, which fetch() does not allow.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { TunnelManager } from '../src/tunnel-manager.js';
import { getHookSecret, HOOK_SECRET_HEADER } from '../src/config/hook-secret.js';
import {
  configureDesktopMode,
  desktopTokenMatches,
  getDesktopMode,
  isDesktopHostAllowed,
  isDesktopOriginAllowed,
  readDesktopToken,
} from '../src/web/desktop-mode.js';
import { buildHostPolicy, isAllowedRequestHost, isAllowedRequestOrigin } from '../src/web/network-auth-policy.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const PORT = 3270;
const TOKEN = 'a'.repeat(63) + 'b';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  path: string,
  opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: opts.method ?? 'GET',
        agent: false,
        headers: { Host: opts.host ?? `127.0.0.1:${PORT}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('desktop-mode helpers', () => {
  it('compares tokens in constant time and rejects non-strings and empties', () => {
    expect(desktopTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(desktopTokenMatches(TOKEN + 'x', TOKEN)).toBe(false);
    expect(desktopTokenMatches('', TOKEN)).toBe(false);
    expect(desktopTokenMatches(undefined, TOKEN)).toBe(false);
    expect(desktopTokenMatches(['a'], TOKEN)).toBe(false);
  });

  it('pins Host to loopback name/address WITH the port', () => {
    expect(isDesktopHostAllowed('127.0.0.1:3100', 3100)).toBe(true);
    expect(isDesktopHostAllowed('LOCALHOST:3100', 3100)).toBe(true);
    expect(isDesktopHostAllowed('127.0.0.1', 3100)).toBe(false);
    expect(isDesktopHostAllowed('127.0.0.1:3101', 3100)).toBe(false);
    expect(isDesktopHostAllowed('192.168.0.5:3100', 3100)).toBe(false);
    expect(isDesktopHostAllowed('[::1]:3100', 3100)).toBe(false);
    expect(isDesktopHostAllowed('evil.example.com:3100', 3100)).toBe(false);
    expect(isDesktopHostAllowed('foo.ts.net:3100', 3100)).toBe(false);
    expect(isDesktopHostAllowed(undefined, 3100)).toBe(false);
  });

  it('pins Origin exactly, and a WebSocket may not omit it', () => {
    expect(isDesktopOriginAllowed('http://127.0.0.1:3100', 3100, true)).toBe(true);
    expect(isDesktopOriginAllowed('http://localhost:3100', 3100, true)).toBe(true);
    expect(isDesktopOriginAllowed('http://127.0.0.1:8080', 3100, false)).toBe(false);
    expect(isDesktopOriginAllowed('https://127.0.0.1:3100', 3100, false)).toBe(false);
    expect(isDesktopOriginAllowed('null', 3100, false)).toBe(false);
    expect(isDesktopOriginAllowed(undefined, 3100, false)).toBe(true);
    expect(isDesktopOriginAllowed(undefined, 3100, true)).toBe(false);
    expect(isDesktopOriginAllowed('', 3100, true)).toBe(false);
  });

  it('turns every looser branch of the shared policy off when desktopPort is set', () => {
    const policy = buildHostPolicy('127.0.0.1', 'https://x.trycloudflare.com', 3100);
    expect(isAllowedRequestHost('192.168.1.50:3100', policy)).toBe(false);
    expect(isAllowedRequestHost('host.docker.internal:3100', policy)).toBe(false);
    expect(isAllowedRequestHost('x.trycloudflare.com', policy)).toBe(false);
    expect(isAllowedRequestHost('127.0.0.1:3100', policy)).toBe(true);
    expect(isAllowedRequestOrigin(undefined, policy, true)).toBe(false);
    // the non-desktop policy is unchanged
    const normal = buildHostPolicy('127.0.0.1', null);
    expect(isAllowedRequestHost('192.168.1.50:3100', normal)).toBe(true);
    expect(isAllowedRequestOrigin(undefined, normal, true)).toBe(true);
  });

  it('refuses a weak token or a bad port', () => {
    expect(() => configureDesktopMode({ token: 'short', port: 3100 })).toThrow();
    expect(() => configureDesktopMode({ token: TOKEN, port: 0 })).toThrow();
    expect(getDesktopMode()).toBeNull();
  });

  describe('readDesktopToken', () => {
    it('reads the env var and deletes it so child processes never inherit it', async () => {
      const env: NodeJS.ProcessEnv = { CODEMAN_DESKTOP_TOKEN: ` ${TOKEN} ` };
      await expect(readDesktopToken(env, new PassThrough())).resolves.toBe(TOKEN);
      expect(env.CODEMAN_DESKTOP_TOKEN).toBeUndefined();
    });

    it('falls back to the first stdin line', async () => {
      const stdin = new PassThrough();
      const pending = readDesktopToken({}, stdin);
      stdin.write(`${TOKEN}\nignored\n`);
      await expect(pending).resolves.toBe(TOKEN);
    });

    it('rejects a short token, a closed stdin and a silent stdin without echoing the token', async () => {
      await expect(readDesktopToken({ CODEMAN_DESKTOP_TOKEN: 'tooshort' }, new PassThrough())).rejects.toThrow(
        /shorter/
      );
      const closed = new PassThrough();
      closed.end();
      await expect(readDesktopToken({}, closed)).rejects.toThrow(/shorter/);
      await expect(readDesktopToken({}, new PassThrough(), 50)).rejects.toThrow(/Timed out/);
      try {
        await readDesktopToken({ CODEMAN_DESKTOP_TOKEN: 'secret-but-short' }, new PassThrough());
      } catch (err) {
        expect(String((err as Error).message)).not.toContain('secret-but-short');
      }
    });
  });
});

describe('desktop mode server', () => {
  let server: WebServer;

  beforeAll(async () => {
    configureDesktopMode({ token: TOKEN, port: PORT });
    server = new WebServer(PORT, false, true);
    await server.start();
  });

  afterAll(async () => {
    // Pre-existing (reproduced with plain Basic auth, no desktop mode): once a WebSocket
    // upgrade has been refused with 401, WebServer.stop() never resolves. The CLI force-exits
    // after 10s, so production is unaffected; here we just stop waiting after 3s.
    await Promise.race([server.stop(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    configureDesktopMode(null);
  });

  it('answers 401 to every route without the token, static assets included', async () => {
    for (const path of ['/', '/api/status', '/api/sessions', '/index.html', '/q/abcdef', '/api/tunnel/status']) {
      expect((await request(path)).status, path).toBe(401);
    }
    expect((await request('/api/sessions', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('marks its 401 so the shell can tell a leftover Switchboard from another program', async () => {
    const res = await request('/api/status');
    expect(res.status).toBe(401);
    expect(res.headers['x-switchboard-desktop']).toBe('1');
    expect(res.body).toBe('Unauthorized');
  });

  it('rejects a wrong token, even in the right place', async () => {
    expect((await request('/api/status', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await request('/api/status', { headers: { Cookie: 'sb_desktop=wrong' } })).status).toBe(401);
    expect((await request('/__sb/enter?t=wrong')).status).toBe(401);
    expect((await request('/__sb/enter')).status).toBe(401);
  });

  it('accepts the token as a bearer header (the shell health probe)', async () => {
    expect((await request('/api/status', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('trades ?t= for an HttpOnly SameSite=Strict cookie and moves on to a clean URL without a redirect', async () => {
    const res = await request(`/__sb/enter?t=${TOKEN}`);
    // 200 + meta refresh, not 302: a redirect would inherit the shell's cross-site initiator and
    // the Strict cookie would not be sent on the target (found in the real app, 2026-10-07).
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain('http-equiv="refresh"');
    expect(res.body).toContain('url=/"');
    expect(res.body).not.toContain(TOKEN);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`sb_desktop=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const next = await request('/api/status', { headers: { Cookie: `sb_desktop=${TOKEN}` } });
    expect(next.status).toBe(200);
    expect((await request('/', { headers: { Cookie: `sb_desktop=${TOKEN}` } })).status).toBe(200);
  });

  it('rejects a foreign Host before auth, with or without the token', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const host of [`localhost`, `127.0.0.1:${PORT + 1}`, `192.168.1.5:${PORT}`, `attacker.example.com:${PORT}`]) {
      expect((await request('/api/status', { host, headers: auth })).status, host).toBe(403);
    }
    expect((await request('/api/status', { host: `localhost:${PORT}`, headers: auth })).status).toBe(200);
  });

  it('rejects a cross-site Origin on a state-changing request, and sends no CORS headers', async () => {
    const res = await request('/api/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'http://127.0.0.1:8080',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const get = await request('/api/status', {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://127.0.0.1:8080' },
    });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps the hook route behind loopback + hook secret, not the token', async () => {
    const bad = await request('/api/hook-event', { method: 'POST', body: '{}' });
    expect(bad.status).toBe(401);
    const ok = await request('/api/hook-event', {
      method: 'POST',
      headers: { [HOOK_SECRET_HEADER]: getHookSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'stop', sessionId: 'does-not-exist' }),
    });
    expect(ok.status).not.toBe(401);
    expect(ok.status).not.toBe(403);
  });

  it('refuses a WebSocket without the cookie, with a foreign Origin, or without an Origin', async () => {
    const { WebSocket } = await import('ws');
    // Resolves with how the connection ENDED: an HTTP status when the upgrade was
    // refused, else the close code the route handler used.
    const outcome = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/nope/terminal`, { headers });
        ws.on('unexpected-response', (req, res) => {
          // ws leaves a refused upgrade's socket open; an open socket stalls server.stop().
          res.resume();
          req.destroy();
          resolve(res.statusCode ?? 0);
        });
        ws.on('close', (code) => resolve(code));
        ws.on('error', () => undefined);
      });
    const origin = `http://127.0.0.1:${PORT}`;
    expect(await outcome({ Origin: origin })).toBe(401);
    expect(await outcome({ Cookie: 'sb_desktop=wrong', Origin: origin })).toBe(401);
    expect(await outcome({ Cookie: `sb_desktop=${TOKEN}`, Origin: 'http://127.0.0.1:8080' })).toBe(4003);
    expect(await outcome({ Cookie: `sb_desktop=${TOKEN}` })).toBe(4003);
    // right cookie + right origin gets past both gates (no such session -> 4004)
    expect(await outcome({ Cookie: `sb_desktop=${TOKEN}`, Origin: origin })).toBe(4004);
  });

  it('never starts a tunnel', () => {
    const tunnel = new TunnelManager();
    tunnel.start(PORT, false);
    expect(tunnel.isRunning()).toBe(false);
  });

  it('refuses to listen anywhere but 127.0.0.1', async () => {
    const wide = new WebServer(PORT + 1, false, true, '0.0.0.0');
    await expect(wide.start()).rejects.toThrow(/only binds 127\.0\.0\.1/);
    await wide.stop().catch(() => undefined);
  });
});
