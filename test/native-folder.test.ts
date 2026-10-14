/**
 * @fileoverview Switchboard T7: Windows folder dialog result -> WSL path (pure half).
 * The authorization half (realpath, roots, blocklist) is in test/routes/native-folder-routes.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_FOLDER_MAX_PATH,
  parseWindowsFolderInput,
  posixToWindowsPath,
  runWslpath,
  toPosixPath,
} from '../src/web/native-folder.js';

const parse = (raw: unknown, distro: string | undefined = 'Ubuntu') => parseWindowsFolderInput(raw, distro);

describe('parseWindowsFolderInput', () => {
  it('accepts drive paths in both slash styles, trimmed', () => {
    expect(parse('D:\\dev\\eclipse-workspace')).toEqual({
      ok: true,
      kind: 'drive',
      value: 'D:\\dev\\eclipse-workspace',
    });
    expect(parse('  d:/dev/x  ')).toEqual({ ok: true, kind: 'drive', value: 'd:/dev/x' });
    expect(parse('D:\\')).toMatchObject({ ok: true, kind: 'drive' });
    expect(parse('D:')).toMatchObject({ ok: true, kind: 'drive' });
  });

  it('turns \\\\wsl.localhost and \\\\wsl$ shares of THIS distro into POSIX paths', () => {
    expect(parse('\\\\wsl.localhost\\Ubuntu\\home\\dhkang\\proj')).toEqual({
      ok: true,
      kind: 'wsl',
      value: '/home/dhkang/proj',
    });
    expect(parse('\\\\wsl$\\Ubuntu\\home\\dhkang')).toEqual({ ok: true, kind: 'wsl', value: '/home/dhkang' });
    expect(parse('\\\\wsl.localhost\\Ubuntu')).toEqual({ ok: true, kind: 'wsl', value: '/' });
    // distro names are case-insensitive on Windows; the host part too
    expect(parse('\\\\WSL.LOCALHOST\\ubuntu\\tmp')).toEqual({ ok: true, kind: 'wsl', value: '/tmp' });
    // forward-slash spelling of the same share
    expect(parse('//wsl.localhost/Ubuntu/home/x')).toEqual({ ok: true, kind: 'wsl', value: '/home/x' });
  });

  it('refuses another distribution, and any share when the distro is unknown', () => {
    expect(parse('\\\\wsl.localhost\\Debian\\home\\x')).toEqual({ ok: false, reason: 'other_distro' });
    expect(parse('\\\\wsl$\\Ubuntu-22.04\\home\\x')).toEqual({ ok: false, reason: 'other_distro' });
    expect(parseWindowsFolderInput('\\\\wsl.localhost\\Ubuntu\\home', undefined)).toEqual({
      ok: false,
      reason: 'other_distro',
    });
    expect(parse('\\\\wsl.localhost\\')).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('refuses network locations in every spelling', () => {
    for (const p of [
      '\\\\server\\share',
      '\\\\server\\share\\dir',
      '//server/share',
      '\\\\192.168.0.5\\c$',
      '\\\\?\\UNC\\server\\share',
      '\\\\.\\UNC\\server\\share',
      '\\\\wsl.localhost.evil.com\\Ubuntu\\x',
    ]) {
      expect(parse(p), p).toEqual({ ok: false, reason: 'network_path' });
    }
  });

  it('reads an extended-length drive path as the plain drive path', () => {
    expect(parse('\\\\?\\D:\\dev')).toEqual({ ok: true, kind: 'drive', value: 'D:\\dev' });
  });

  it('refuses option-looking, control-character and malformed input before anything runs', () => {
    const bad: unknown[] = [
      '',
      '   ',
      '-rf',
      '--help',
      '-u D:\\x',
      'D:\\a\nb',
      'D:\\a\rb',
      'D:\\a\tb',
      'D:\\a\u0000b',
      'D:\\a\u2028b',
      'relative\\path',
      '/home/x',
      'dev',
      'D\\x',
      '1:\\x',
      'D:x',
      'x'.repeat(NATIVE_FOLDER_MAX_PATH + 1),
      null,
      undefined,
      42,
      { path: 'D:\\x' },
    ];
    for (const p of bad) expect(parse(p), String(p)).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('toPosixPath', () => {
  it('asks wslpath only for drive paths, and passes the string through untouched', async () => {
    const seen: string[] = [];
    const convert = async (p: string) => (seen.push(p), '/mnt/d/dev');
    expect(await toPosixPath(parse('D:\\dev'), convert)).toBe('/mnt/d/dev');
    expect(seen).toEqual(['D:\\dev']);
    expect(await toPosixPath(parse('\\\\wsl.localhost\\Ubuntu\\tmp'), convert)).toBe('/tmp');
    expect(seen).toHaveLength(1);
  });

  it('is null when the input was refused or the converter failed', async () => {
    expect(await toPosixPath(parse('\\\\server\\share'), async () => '/x')).toBeNull();
    expect(await toPosixPath(parse('D:\\dev'), async () => null)).toBeNull();
  });
});

describe('posixToWindowsPath', () => {
  it('spells /mnt/<drive> as a drive path', () => {
    expect(posixToWindowsPath('/mnt/d/dev/eclipse-workspace', 'Ubuntu')).toBe('D:\\dev\\eclipse-workspace');
    expect(posixToWindowsPath('/mnt/d', 'Ubuntu')).toBe('D:\\');
    expect(posixToWindowsPath('/mnt/c/Users/bob', undefined)).toBe('C:\\Users\\bob');
  });

  it('reaches everything else through the distribution share', () => {
    expect(posixToWindowsPath('/home/dhkang/proj', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dhkang\\proj');
    expect(posixToWindowsPath('/', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu');
    expect(posixToWindowsPath('/home/x', undefined)).toBeNull();
  });

  it('does not mistake a lookalike for a drive mount', () => {
    expect(posixToWindowsPath('/mnt/dd/x', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\mnt\\dd\\x');
    expect(posixToWindowsPath('/mnt', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\mnt');
  });
});

// The real wslpath: only where it exists (WSL). Proves the argv-array call and that nothing is run through a shell.
const hasWslpath = (() => {
  try {
    execFileSync('wslpath', ['-u', 'C:\\'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasWslpath)('runWslpath (real wslpath)', () => {
  it('converts a drive path', async () => {
    expect(await runWslpath('D:\\dev')).toBe('/mnt/d/dev');
    expect(await runWslpath('C:\\')).toMatch(/^\/mnt\/c\/?$/);
  });

  it('never runs a shell: injection text is only ever a path component', async () => {
    const marker = '/tmp/sb-native-folder-injection-marker';
    rmSync(marker, { force: true });
    for (const evil of [
      `D:\\x"; touch ${marker}; "`,
      `D:\\$(touch ${marker})`,
      `D:\\\`touch ${marker}\``,
      `D:\\x' ; touch ${marker} #`,
      'D:\\x | touch ' + marker,
    ]) {
      const out = await runWslpath(evil);
      expect(out === null || out.startsWith('/')).toBe(true);
    }
    expect(existsSync(marker)).toBe(false);
  });
});
