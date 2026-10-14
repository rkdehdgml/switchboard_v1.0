/**
 * @fileoverview Usage dashboard data (Switchboard T4): reads Claude Code's own
 * conversation logs (`~/.claude/projects/<project>/<session>.jsonl`) and turns them
 * into the numbers the home tab shows.
 *
 * The JSONL format is private and may change, so every reader here is defensive:
 * unknown fields are ignored, a line missing a required field is skipped, and one
 * unreadable file never fails the whole summary.
 *
 * Findings this module is built on (verified against real logs, see the spec's
 * "T4 데이터 출처 조사 결과"):
 *  - `cost-state` lines are written by Claude Code, not Codeman. They are CUMULATIVE
 *    snapshots with no timestamp, so only the LAST one in a file counts.
 *  - A session that is still running (or ended abnormally) has none.
 *  - Per-message `usage` is repeated once per content block, so it is de-duplicated
 *    by `message.id`. Those tokens cover only the main thread (sub-agent and side
 *    calls are in the `cost-state` total but not in the file), so message tokens are
 *    used ONLY as weights to spread a known session total over the days it ran.
 *
 * @module usage-dashboard
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Anthropic's published price structure is the same across models: output costs 5x input, cache read 0.1x, cache write 1.25x. */
const WEIGHT = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

const DENIAL_TEXT = "The user doesn't want to proceed with this tool use";

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface DayBucket {
  /** model id -> tokens summed from the file's de-duplicated messages */
  models: Record<string, Tokens>;
  tools: Record<string, number>;
  errors: number;
  denials: number;
}

/** Everything one JSONL file contributes, cached by mtime+size. */
export interface FileDigest {
  sessionId: string;
  project: string;
  /** Local date (YYYY-MM-DD) of the file's last activity. */
  lastDay: string | null;
  costState: {
    totalCostUSD: number;
    unknownCost: boolean;
    models: Record<string, Tokens & { costUSD: number }>;
  } | null;
  days: Record<string, DayBucket>;
}

const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Local calendar day of an ISO timestamp, or null when it is not a date. */
export function localDay(ts: unknown): string | null {
  if (typeof ts !== 'string') return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return dayKey(d);
}

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bucket(digest: FileDigest, day: string): DayBucket {
  return (digest.days[day] ??= { models: {}, tools: {}, errors: 0, denials: 0 });
}

function countOf(line: string, needle: string): number {
  let n = 0;
  for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + needle.length)) n++;
  return n;
}

function toolKey(name: unknown, input: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (name === 'Skill') {
    const skill = (input as { skill?: unknown } | null)?.skill;
    return typeof skill === 'string' && skill ? `skill:${skill.slice(0, 80)}` : null;
  }
  const mcp = /^mcp__([^_].*?)__/.exec(name);
  return mcp ? `mcp:${mcp[1].slice(0, 80)}` : null;
}

/** Fold ONE log line into the digest. Never throws. */
export function ingestLine(
  digest: FileDigest,
  line: string,
  seen: Map<string, { day: string; model: string; t: Tokens }>
): void {
  // Cheap checks first: big tool-result lines are counted without being parsed.
  if (line.includes('"tool_result"')) {
    const errors = countOf(line, '"is_error":true');
    if (errors > 0) {
      const day = localDay(/"timestamp":"([^"]+)"/.exec(line)?.[1]);
      if (day) {
        const denials = Math.min(errors, countOf(line, DENIAL_TEXT));
        const b = bucket(digest, day);
        b.errors += errors - denials;
        b.denials += denials;
        digest.lastDay = !digest.lastDay || day > digest.lastDay ? day : digest.lastDay;
      }
    }
    return;
  }
  const isCost = line.includes('"cost-state"');
  if (!isCost && !line.includes('"usage"')) return;

  // Private, unversioned format: every field is type-checked before it is used.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || typeof o !== 'object') return;

  if (o.type === 'cost-state') {
    if (typeof o.totalCostUSD !== 'number' || !Number.isFinite(o.totalCostUSD)) return;
    const models: Record<string, Tokens & { costUSD: number }> = {};
    if (o.modelUsage && typeof o.modelUsage === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const [id, u] of Object.entries<any>(o.modelUsage)) {
        if (!u || typeof u !== 'object') continue;
        models[id] = {
          input: num(u.inputTokens),
          output: num(u.outputTokens),
          cacheRead: num(u.cacheReadInputTokens),
          cacheWrite: num(u.cacheCreationInputTokens),
          costUSD: num(u.costUSD),
        };
      }
    }
    // Last snapshot wins: they are cumulative, never summed.
    digest.costState = { totalCostUSD: o.totalCostUSD, unknownCost: o.hasUnknownModelCost === true, models };
    return;
  }

  if (o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return;
  const day = localDay(o.timestamp);
  if (!day) return;
  digest.lastDay = !digest.lastDay || day > digest.lastDay ? day : digest.lastDay;
  if (!digest.sessionId && typeof o.sessionId === 'string') digest.sessionId = o.sessionId;
  if (digest.project === '' && typeof o.cwd === 'string' && o.cwd)
    digest.project = basename(o.cwd.replace(/[\\/]+$/, ''));

  const msg = o.message;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const b = bucket(digest, day);
  // A message repeats once per content block: count its tools only on first sight.
  const id = typeof msg.id === 'string' ? msg.id : null;
  if (!id || !seen.has(id)) {
    for (const c of content) {
      if (c?.type !== 'tool_use') continue;
      const key = toolKey(c.name, c.input);
      if (key) b.tools[key] = (b.tools[key] ?? 0) + 1;
    }
  }
  const u = msg.usage;
  if (!id || !u || typeof u !== 'object' || typeof msg.model !== 'string') return;
  const t: Tokens = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
  // Streaming repeats carry the same (or a fuller) usage: replace, don't add.
  const prev = seen.get(id);
  if (prev) {
    const pm = digest.days[prev.day].models[prev.model];
    pm.input -= prev.t.input;
    pm.output -= prev.t.output;
    pm.cacheRead -= prev.t.cacheRead;
    pm.cacheWrite -= prev.t.cacheWrite;
  }
  const m = (b.models[msg.model] ??= emptyTokens());
  m.input += t.input;
  m.output += t.output;
  m.cacheRead += t.cacheRead;
  m.cacheWrite += t.cacheWrite;
  seen.set(id, { day, model: msg.model, t });
}

export async function digestFile(path: string, fallbackProject: string): Promise<FileDigest> {
  const digest: FileDigest = {
    sessionId: basename(path, '.jsonl'),
    project: '',
    lastDay: null,
    costState: null,
    days: {},
  };
  const seen = new Map<string, { day: string; model: string; t: Tokens }>();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) ingestLine(digest, line, seen);
  if (digest.project === '') digest.project = fallbackProject;
  return digest;
}

// ── Scanning with an mtime+size cache ───────────────────────────────────────

const cache = new Map<string, { mtimeMs: number; size: number; digest: FileDigest }>();

/** `-mnt-d-dev-foo` -> `foo`: lossy (dashes are ambiguous), only a fallback label. */
function projectFromDir(dir: string): string {
  return dir.replace(/^-+/, '').split('-').filter(Boolean).pop() ?? dir;
}

export async function scanDigests(root = join(homedir(), '.claude', 'projects')): Promise<FileDigest[]> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  const alive = new Set<string>();
  const out: FileDigest[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = (await readdir(join(root, dir))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(root, dir, f);
      alive.add(path);
      try {
        const st = await stat(path);
        const hit = cache.get(path);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          out.push(hit.digest);
          continue;
        }
        // ponytail: a changed file is re-read whole (active sessions are a few MB). Offset-based appends if that ever hurts.
        const digest = await digestFile(path, projectFromDir(dir));
        cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, digest });
        out.push(digest);
      } catch {
        // unreadable file: skip, never fail the dashboard
      }
    }
  }
  for (const k of cache.keys()) if (!alive.has(k)) cache.delete(k);
  return out;
}

// ── Summary ─────────────────────────────────────────────────────────────────

export interface LiveSessionCost {
  /** Claude conversation id, which names the JSONL file. */
  claudeSessionId: string;
  costUsd: number;
}

export interface UsageSummary {
  generatedAt: number;
  today: string;
  weekStart: string;
  /** false when no log file exists at all, so the UI shows "no records yet" instead of zeros. */
  hasData: boolean;
  costToday: number;
  costWeek: number;
  /** Sessions active in the window whose cost is unknown (still running with no telemetry, or ended abnormally). */
  unrecordedWeek: number;
  unknownCostWeek: number;
  cacheHitRate: number | null;
  models: Array<{ model: string; costUsd: number } & Tokens>;
  projects: Array<{ project: string; costUsd: number }>;
  tools: {
    skills: Array<{ name: string; count: number }>;
    mcp: Array<{ name: string; count: number }>;
    errors: number;
    denials: number;
  };
}

const weightOf = (t: Tokens) =>
  t.input * WEIGHT.input + t.output * WEIGHT.output + t.cacheRead * WEIGHT.cacheRead + t.cacheWrite * WEIGHT.cacheWrite;

/** Monday of the local week containing `d`, as a day key. */
function weekStartOf(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return dayKey(x);
}

/**
 * Spread each session's known cost over the days it ran, in proportion to its
 * weighted tokens. Totals are exact; only the split of a multi-day session between
 * its days is an estimate (labelled as such in the UI).
 */
export function summarize(digests: FileDigest[], live: LiveSessionCost[] = [], now = new Date()): UsageSummary {
  const today = dayKey(now);
  const weekStart = weekStartOf(now);
  const liveCost = new Map(live.map((l) => [l.claudeSessionId, l.costUsd]));
  const inWeek = (day: string) => day >= weekStart && day <= today;

  const s: UsageSummary = {
    generatedAt: now.getTime(),
    today,
    weekStart,
    hasData: digests.length > 0,
    costToday: 0,
    costWeek: 0,
    unrecordedWeek: 0,
    unknownCostWeek: 0,
    cacheHitRate: null,
    models: [],
    projects: [],
    tools: { skills: [], mcp: [], errors: 0, denials: 0 },
  };
  const models = new Map<string, Tokens & { costUsd: number }>();
  const projects = new Map<string, number>();
  const tools = new Map<string, number>();
  const cacheTok = emptyTokens();

  for (const d of digests) {
    const dayList = Object.keys(d.days).sort();
    const weekDays = dayList.filter(inWeek);
    if (weekDays.length === 0) continue;

    for (const day of weekDays) {
      const b = d.days[day];
      s.tools.errors += b.errors;
      s.tools.denials += b.denials;
      for (const [k, n] of Object.entries(b.tools)) tools.set(k, (tools.get(k) ?? 0) + n);
      for (const t of Object.values(b.models)) {
        cacheTok.input += t.input;
        cacheTok.cacheRead += t.cacheRead;
        cacheTok.cacheWrite += t.cacheWrite;
      }
    }

    const cs = d.costState;
    const total = cs ? cs.totalCostUSD : liveCost.get(d.sessionId);
    if (total === undefined || (cs && cs.unknownCost)) {
      if (cs) s.unknownCostWeek++;
      else s.unrecordedWeek++;
      continue;
    }

    // Per (model, day) weights over the WHOLE file, so a session that began last week
    // contributes only the share that fell in this week.
    const perModel = new Map<string, Map<string, number>>();
    let all = 0;
    for (const day of dayList) {
      for (const [m, t] of Object.entries(d.days[day].models)) {
        const w = weightOf(t);
        if (w <= 0) continue;
        if (!perModel.has(m)) perModel.set(m, new Map());
        perModel.get(m)!.set(day, w);
        all += w;
      }
    }
    // [model, cost, tokens] shares to distribute. With a cost-state they are exact per model;
    // a live session only knows its total, so it is split by overall weight.
    const shares: Array<{ model: string; cost: number; tokens: Tokens | null }> = cs
      ? Object.entries(cs.models).map(([model, u]) => ({ model, cost: u.costUSD, tokens: u }))
      : [...perModel.entries()].map(([model, dm]) => ({
          model,
          cost: all > 0 ? (total * [...dm.values()].reduce((a, b) => a + b, 0)) / all : 0,
          tokens: null,
        }));
    // A cost-state total can exceed the per-model sum (rounding, unknown models): keep the residue on the last day.
    const residue = cs ? Math.max(0, total - shares.reduce((a, x) => a + x.cost, 0)) : 0;

    for (const { model, cost, tokens } of shares) {
      const dm = perModel.get(model);
      const sum = dm ? [...dm.values()].reduce((a, b) => a + b, 0) : 0;
      // No per-day data for this model (a side call): attribute it to the session's last day.
      const split: Array<[string, number]> =
        dm && sum > 0
          ? [...dm.entries()].map(([day, w]) => [day, w / sum])
          : [[d.lastDay ?? dayList[dayList.length - 1], 1]];
      for (const [day, frac] of split) {
        if (!inWeek(day)) continue;
        const c = cost * frac;
        s.costWeek += c;
        if (day === today) s.costToday += c;
        projects.set(d.project, (projects.get(d.project) ?? 0) + c);
        const m = models.get(model) ?? { ...emptyTokens(), costUsd: 0 };
        m.costUsd += c;
        if (tokens) {
          m.input += tokens.input * frac;
          m.output += tokens.output * frac;
          m.cacheRead += tokens.cacheRead * frac;
          m.cacheWrite += tokens.cacheWrite * frac;
        }
        models.set(model, m);
      }
    }
    if (residue > 0) {
      const day = d.lastDay ?? dayList[dayList.length - 1];
      if (inWeek(day)) {
        s.costWeek += residue;
        if (day === today) s.costToday += residue;
        projects.set(d.project, (projects.get(d.project) ?? 0) + residue);
      }
    }
  }

  const denom = cacheTok.input + cacheTok.cacheRead + cacheTok.cacheWrite;
  s.cacheHitRate = denom > 0 ? cacheTok.cacheRead / denom : null;
  s.models = [...models.entries()].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.costUsd - a.costUsd);
  s.projects = [...projects.entries()]
    .map(([project, costUsd]) => ({ project, costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5);
  const byCount = (prefix: string) =>
    [...tools.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, count]) => ({ name: k.slice(prefix.length), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  s.tools.skills = byCount('skill:');
  s.tools.mcp = byCount('mcp:');
  return s;
}
