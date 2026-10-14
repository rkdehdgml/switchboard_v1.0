/**
 * @fileoverview Korean coverage for the original screens: every sentence in index.html has a
 * translation (only product names, model names and command examples may stay English), runtime
 * messages with a value inside match by pattern, and dates follow the UI language.
 *
 * Port: N/A (no server start)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (p: string) => readFileSync(resolve('src/web/public', p), 'utf8');

function i18n(language = 'ko') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  for (const f of ['i18n-ko.js', 'i18n.js']) vm.runInContext(read(f), dom.getInternalVMContext(), { filename: f });
  const api = (dom.window as unknown as { CodemanI18n: { configure(o: object): void; t(s: string): string } })
    .CodemanI18n;
  api.configure({ language });
  return { api, dom };
}

/** Everything the page shows as text in index.html: text nodes plus placeholder, title and aria-label. */
function pageStrings(): string[] {
  const doc = new JSDOM(read('index.html')).window.document;
  const out = new Set<string>();
  const walker = doc.createTreeWalker(doc.body, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const tag = n.parentElement!.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    const text = n.nodeValue!.replace(/\s+/g, ' ').trim();
    if (text) out.add(text);
  }
  for (const el of doc.querySelectorAll('[placeholder],[title],[aria-label]')) {
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v) out.add(v.replace(/\s+/g, ' ').trim());
    }
  }
  return [...out];
}

// Names, model ids and command/path examples are not translated on purpose.
const KEEP = new Set([
  'update all the docs and CLAUDE.md',
  'npm run dev',
  'Read My Mind',
  'Deepgram Nova-3',
  'Claude Code',
  'Wake-on-LAN MAC',
  'Wake-on-LAN ·',
  'node scripts/build-agent-image.mjs',
  'e.g. JetBrainsMono Nerd Font',
  'my-cli --flag',
  'codeman, tmux, respawn, subagent',
  'exec codx personal',
  'StrictHostKeyChecking=accept-new ConnectTimeout=10',
]);
const isModelName = (s: string) => /^(Fable|Opus|Sonnet|Haiku)\b/.test(s);

describe('Korean coverage of the original screens', () => {
  it('every multi-word sentence in index.html is translated', () => {
    const { api } = i18n();
    const missing = pageStrings()
      .filter((s) => s.split(' ').length >= 2 && /[A-Za-z]{3}/.test(s))
      .filter((s) => !KEEP.has(s) && !isModelName(s))
      .filter((s) => api.t(s) === s);
    expect(missing).toEqual([]);
  });

  it('a sentence wrapped across lines in the markup still matches', () => {
    const { api } = i18n();
    expect(api.t('Letters, numbers, hyphens,\n          underscores only. Created in ~/codeman-cases/')).toContain(
      '영문자'
    );
  });

  it('messages with a value inside match by pattern; captures with an exact entry are translated', () => {
    const { api } = i18n();
    expect(api.t('Docker export ready: x.tgz (12 MB)')).toBe('Docker 내보내기 준비 완료: x.tgz (12 MB)');
    expect(api.t('Auto-resume on usage limit enabled')).toBe('사용량 한도 시 자동 재개: 켜짐');
    expect(api.t('Task completed')).toBe('작업 완료');
    expect(api.t('Show 44 more')).toBe('44개 더 보기');
    expect(api.t('Status: busy')).toBe('상태: 사용 중');
  });

  it('a message ending in a colon keeps whatever error text follows it', () => {
    const { api } = i18n();
    expect(api.t('Save failed: disk full')).toBe('저장 실패: disk full');
    expect(api.t('Failed to kill subagent: ECONNRESET')).toBe('서브에이전트를 종료하지 못했습니다: ECONNRESET');
  });

  it('a truncated template (opening ${ with no closing brace) is treated as a prefix, not left unmatched', () => {
    const { api } = i18n();
    expect(api.t('Save failed: network down')).toContain('network down');
  });

  it('English and Chinese are untouched by the Korean patterns', () => {
    expect(i18n('en').api.t('Save failed: boom')).toBe('Save failed: boom');
    expect(i18n('zh-CN').api.t('Settings saved')).not.toContain('설정');
  });

  it('dates follow the UI language, with an explicit non-English locale left alone', () => {
    const ko = i18n('ko').dom.window as unknown as { Date: DateConstructor };
    const d = new ko.Date('2026-10-02T14:30:00');
    expect(d.toLocaleDateString('en', { month: 'short', day: 'numeric' })).toBe('10월 2일');
    // Node's ICU spells the day period differently from Chrome's, so compare with ko-KR itself.
    const opts = { hour: '2-digit', minute: '2-digit' } as const;
    expect(d.toLocaleTimeString([], opts)).toBe(new Date('2026-10-02T14:30:00').toLocaleTimeString('ko-KR', opts));
    expect(d.toLocaleTimeString([], opts)).not.toBe(new Date('2026-10-02T14:30:00').toLocaleTimeString('en-US', opts));
    expect(d.toLocaleDateString('de-DE')).toBe('2.10.2026');
    const en = i18n('en').dom.window as unknown as { Date: DateConstructor };
    expect(new en.Date('2026-10-02T14:30:00').toLocaleDateString('en', { month: 'short', day: 'numeric' })).toBe(
      'Oct 2'
    );
  });

  it('a textarea keeps its content untouched but its placeholder is translated', () => {
    const { api, dom } = i18n();
    const doc = dom.window.document;
    doc.body.innerHTML = '<textarea id="t" placeholder="Prompt to send when idle">Prompt to send when idle</textarea>';
    api.configure({ language: 'ko' });
    const el = doc.getElementById('t') as HTMLTextAreaElement;
    expect(el.placeholder).toBe('유휴일 때 보낼 프롬프트');
    expect(el.value).toBe('Prompt to send when idle');
  });

  it('i18n-ko.js loads before i18n.js', () => {
    const html = read('index.html');
    expect(html.indexOf('i18n-ko.js')).toBeGreaterThan(-1);
    expect(html.indexOf('i18n-ko.js')).toBeLessThan(html.indexOf('src="i18n.js"'));
  });
});
