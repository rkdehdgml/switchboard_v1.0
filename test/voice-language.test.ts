/**
 * @fileoverview Voice language picker: Korean is offered, and the chosen language reaches
 * every speech engine (Web Speech used to be pinned to en-US).
 *
 * Port: N/A (no server start)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeVoiceLanguage, buildVoiceStreamUrl } from '../src/web/voice-stream.js';

const read = (p: string) => readFileSync(resolve('src/web/public', p), 'utf8');
const voiceSource = read('voice-input.js');
const indexHtml = read('index.html');

// Pull the real method out of the source so the test cannot drift from it.
const body = /_webSpeechLang\(language\) \{([\s\S]*?)\n  \},/.exec(voiceSource)![1];
const webSpeechLang = (language: string | undefined, browser = 'en-US'): string =>
  new Function('language', 'navigator', body)(language, { language: browser });

describe('voice language', () => {
  it('the picker offers Korean', () => {
    expect(indexHtml).toMatch(
      /<select id="voiceLanguage"[\s\S]*?<option value="ko">Korean<\/option>[\s\S]*?<\/select>/
    );
  });

  it('the Claude and Deepgram routes accept ko', () => {
    expect(normalizeVoiceLanguage('ko')).toBe('ko');
    expect(new URL(buildVoiceStreamUrl({ language: 'ko' }, {})).searchParams.get('language')).toBe('ko');
  });

  it('Web Speech gets a full tag for every picker value', () => {
    expect(webSpeechLang('ko')).toBe('ko-KR');
    expect(webSpeechLang('ja')).toBe('ja-JP');
    expect(webSpeechLang('es')).toBe('es-ES');
    expect(webSpeechLang('fr')).toBe('fr-FR');
    expect(webSpeechLang('de')).toBe('de-DE');
    expect(webSpeechLang('en-GB')).toBe('en-GB');
    expect(webSpeechLang('en-US')).toBe('en-US');
  });

  it('auto-detect and a missing setting fall back to the browser language', () => {
    expect(webSpeechLang('multi', 'ko-KR')).toBe('ko-KR');
    expect(webSpeechLang(undefined, 'de-DE')).toBe('de-DE');
  });

  it('Web Speech applies the setting at start instead of the old fixed en-US', () => {
    const start = /_startWebSpeech\(\) \{[\s\S]*?this\.recognition\.start\(\)/.exec(voiceSource)![0];
    expect(start).toMatch(/this\.recognition\.lang = this\._webSpeechLang\(/);
  });
});
