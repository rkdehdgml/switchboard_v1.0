/**
 * @fileoverview Desktop (Switchboard T9-1) server mode.
 *
 * The Tauri shell starts the server with `web --desktop`, piping a per-launch random
 * token on stdin (or `CODEMAN_DESKTOP_TOKEN`). In this mode EVERY request must carry
 * that token, the Host/Origin allowlist is pinned to `127.0.0.1:<port>` /
 * `localhost:<port>`, the server can only bind 127.0.0.1, and the tunnel and the
 * docker-bridge listener never start. State lives in a module singleton (like the env
 * switches it replaces) so the auth hook, the host policy and `start()` read ONE value.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface DesktopConfig {
  /** Per-launch secret, at least {@link MIN_DESKTOP_TOKEN_LENGTH} characters. */
  token: string;
  port: number;
}

/** 32 bytes of entropy as hex is 64 chars; refuse anything clearly weaker. */
export const MIN_DESKTOP_TOKEN_LENGTH = 32;

/** The only interface desktop mode may bind. */
export const DESKTOP_BIND_HOST = '127.0.0.1';

/** Cookie the window receives from `/__sb/enter` (HttpOnly, SameSite=Strict). */
export const DESKTOP_COOKIE_NAME = 'sb_desktop';

/** One-shot entry route: validates `?t=<token>`, sets the cookie, redirects to `/` (no token in the URL). */
export const DESKTOP_ENTER_PATH = '/__sb/enter';

/**
 * Marker on the desktop-mode 401. The shell probes its configured port before starting: a
 * leftover Switchboard server (this header) is stopped and replaced, any other listener is
 * a conflict it reports, never a port it silently moves to. Carries no secret.
 */
export const DESKTOP_IDENTITY_HEADER = 'X-Switchboard-Desktop';

let current: DesktopConfig | null = null;

export function configureDesktopMode(config: DesktopConfig | null): void {
  if (config && config.token.length < MIN_DESKTOP_TOKEN_LENGTH) {
    throw new Error(`Desktop token must be at least ${MIN_DESKTOP_TOKEN_LENGTH} characters`);
  }
  if (config && (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535)) {
    throw new Error(`Invalid desktop port: ${config.port}`);
  }
  current = config;
}

export function getDesktopMode(): DesktopConfig | null {
  return current;
}

/** Constant-time token comparison (hashing equalises the lengths first). */
export function desktopTokenMatches(candidate: unknown, token: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/** Exact `Host` allowlist: loopback name or address, WITH the port. */
export function isDesktopHostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Exact `Origin` allowlist. `requireOrigin` (WebSocket upgrades) rejects a missing
 * header: a browser always sends one there, only a non-browser client omits it.
 */
export function isDesktopOriginAllowed(origin: string | undefined, port: number, requireOrigin: boolean): boolean {
  if (origin === undefined || origin === '') return !requireOrigin;
  const value = origin.trim().toLowerCase();
  return value === `http://127.0.0.1:${port}` || value === `http://localhost:${port}`;
}

/**
 * Pull the launch token from the environment (then delete it so child processes,
 * i.e. the agents' shells, never inherit it) or else from the first stdin line.
 * Never accepted on the command line (`ps` would show it). Rejects with a message
 * that never contains the token.
 */
export async function readDesktopToken(
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
  timeoutMs = 10_000
): Promise<string> {
  const fromEnv = env.CODEMAN_DESKTOP_TOKEN;
  delete env.CODEMAN_DESKTOP_TOKEN;
  const token = fromEnv?.trim() || (await readFirstLine(stdin, timeoutMs));
  if (token.length < MIN_DESKTOP_TOKEN_LENGTH) {
    throw new Error(`Desktop token missing or shorter than ${MIN_DESKTOP_TOKEN_LENGTH} characters`);
  }
  return token;
}

function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const finish = (value: string | Error): void => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (typeof stream.pause === 'function') stream.pause();
      if (value instanceof Error) reject(value);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) finish(buf.slice(0, nl));
      else if (buf.length > 4096) finish(new Error('Desktop token line too long'));
    };
    const onEnd = (): void => finish(buf);
    const onError = (err: Error): void => finish(err);
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the desktop token on stdin')), timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}
