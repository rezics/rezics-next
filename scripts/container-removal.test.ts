import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

type Leak = { line: number };

function hasFlag(tokens: string[], flag: string): boolean {
  return tokens.includes(flag);
}

function stringTokens(source: string): string[] {
  return [...source.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]!);
}

function closingBracket(source: string, start: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return index;
  }
  return source.length;
}

function findContainerRemovalLeaks(source: string): Leak[] {
  const leaks: Leak[] = [];
  const arrayCall = /(?:\bdocker\s*\(\s*|\bspawn(?:Sync)?\(\s*['"]docker['"]\s*,\s*)\[/g;
  for (const match of source.matchAll(arrayCall)) {
    const start = match.index! + match[0].length - 1;
    const end = closingBracket(source, start);
    const tokens = stringTokens(source.slice(start, end + 1));
    const command = tokens[0] === 'container' && tokens[1] === 'rm' ? tokens.slice(0, 2) : tokens.slice(0, 1);
    if ((command[0] === 'rm' || command[1] === 'rm') && hasFlag(tokens, '-f') && !hasFlag(tokens, '-v')) {
      leaks.push({ line: source.slice(0, start).split('\n').length });
    }
  }

  const shellRemoval = /\bdocker\s+(?:container\s+)?rm\b(?:\\\r?\n|[^\r\n;|&])*/g;
  for (const match of source.matchAll(shellRemoval)) {
    const lineStart = source.lastIndexOf('\n', match.index!) + 1;
    if (/^\s*(?:\/\/|#)/.test(source.slice(lineStart, match.index!))) continue;
    const tokens = match[0].match(/(?:^|\s)(-[^\s]+)(?=\s|$)/g)?.map((token) => token.trim()) ?? [];
    if (hasFlag(tokens, '-f') && !hasFlag(tokens, '-v')) {
      leaks.push({ line: source.slice(0, match.index!).split('\n').length });
    }
  }

  return leaks;
}

function trackedSources(): string[] {
  const root = resolve(import.meta.dir, '..');
  const listed = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--', 'scripts', 'tools', 'services/*/scripts', 'apps/*/scripts'],
    { encoding: 'utf8' },
  );
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);

  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .filter((file) => /\.(?:[cm]?tsx?|sh|bash|zsh)$/.test(file))
    .filter((file) => !/(?:^|\/)(?:test|tests)(?:\/|$)/.test(file) && !/\.test\.[^.]+$/.test(file));
}

describe('Docker container removal volume cleanup', () => {
  test('every tracked script and tool removal also removes anonymous volumes', () => {
    const leaks = trackedSources().flatMap((file) =>
      findContainerRemovalLeaks(readFileSync(file, 'utf8')).map(({ line }) => `${file}:${line}`),
    );
    expect(leaks).toEqual([]);
  });

  test('recognizes rm -f leaks and -v cleanup in argument arrays and shell commands', () => {
    const sources = [
      { source: "docker(['rm', '-f', 'id']);", leaking: true },
      { source: "docker(['rm', '-f', '-v', 'id']);", leaking: false },
      { source: "docker(['container', 'rm', '-f', 'id']);", leaking: true },
      { source: "docker(['container', 'rm', '-f', '-v', 'id']);", leaking: false },
      { source: 'run("docker rm -f \\\"$id\\\"");', leaking: true },
      { source: 'run("docker container rm -f -v \\\"$id\\\"");', leaking: false },
    ];
    for (const { source, leaking } of sources) {
      expect(findContainerRemovalLeaks(source).length > 0).toBe(leaking);
    }
  });
});
