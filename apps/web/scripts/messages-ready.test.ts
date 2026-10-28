import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMessagesReady } from './messages-ready.ts';

const wrapperSource = readFileSync(join(import.meta.dir, 'isolated.ts'), 'utf8');

function makeApp(): { directory: string; cleanup: () => void; calls: string; output: string; messages: string } {
  const directory = mkdtempSync(join(tmpdir(), 'web-messages-ready-'));
  const messages = join(directory, 'messages');
  const output = join(directory, 'src/paraglide/messages.js');
  const calls = join(directory, 'generate-calls.log');
  mkdirSync(messages, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { generate: 'bun generate.ts' } }));
  writeFileSync(
    join(directory, 'generate.ts'),
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\n` +
      `import { join } from 'node:path';\n` +
      `const root = process.cwd();\n` +
      `appendFileSync(join(root, 'generate-calls.log'), 'generate\\n');\n` +
      `if ((await import('node:fs')).existsSync(join(root, 'fail-generation'))) process.exit(37);\n` +
      `mkdirSync(join(root, 'src/paraglide'), { recursive: true });\n` +
      `writeFileSync(join(root, 'src/paraglide/messages.js'), 'generated');\n`,
  );
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    calls,
    output,
    messages,
  };
}

function recordCalls(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

function setMtime(file: string, milliseconds: number): void {
  const seconds = milliseconds / 1000;
  utimesSync(file, seconds, seconds);
}

test('missing Paraglide messages are generated once before bun test runs', () => {
  const app = makeApp();
  try {
    writeFileSync(join(app.messages, 'en.json'), '{}');

    expect(ensureMessagesReady(app.directory)).toBe(0);
    expect(existsSync(app.output)).toBe(true);
    expect(recordCalls(app.calls)).toEqual(['generate']);

    expect(ensureMessagesReady(app.directory)).toBe(0);
    expect(recordCalls(app.calls)).toEqual(['generate']);
  } finally {
    app.cleanup();
  }
});

test('fresh output is kept when it is newer than every message file', () => {
  const app = makeApp();
  try {
    const messageFiles = [
      'de.json',
      'en.json',
      'es.json',
      'fr.json',
      'ja.json',
      'ko.json',
      'zh-Hans.json',
      'zh-Hant.json',
    ];
    for (const name of messageFiles) writeFileSync(join(app.messages, name), '{}');
    mkdirSync(join(app.directory, 'src/paraglide'), { recursive: true });
    writeFileSync(app.output, 'fresh');
    const base = Date.now() - 60_000;
    for (const [index, name] of messageFiles.entries()) setMtime(join(app.messages, name), base + index * 1000);
    setMtime(app.output, base + 10_000);

    expect(ensureMessagesReady(app.directory)).toBe(0);
    expect(recordCalls(app.calls)).toEqual([]);
  } finally {
    app.cleanup();
  }
});

test('messages newer than the output cause generation again', () => {
  const app = makeApp();
  try {
    const message = join(app.messages, 'en.json');
    writeFileSync(message, '{}');
    mkdirSync(join(app.directory, 'src/paraglide'), { recursive: true });
    writeFileSync(app.output, 'stale');
    const base = Date.now() - 60_000;
    setMtime(app.output, base);
    setMtime(message, base + 10_000);

    expect(ensureMessagesReady(app.directory)).toBe(0);
    expect(recordCalls(app.calls)).toEqual(['generate']);
  } finally {
    app.cleanup();
  }
});

test('generation failure returns its exit code and prevents tests from starting', () => {
  const app = makeApp();
  try {
    writeFileSync(join(app.messages, 'en.json'), '{}');
    writeFileSync(join(app.directory, 'fail-generation'), '');

    expect(ensureMessagesReady(app.directory)).toBe(37);
    expect(recordCalls(app.calls)).toEqual(['generate']);
    expect(existsSync(app.output)).toBe(false);

    const callbackStart = wrapperSource.indexOf('async (slotEnvironment) => {');
    const readinessCall = wrapperSource.indexOf('ensureMessagesReady(app)');
    const spawn = wrapperSource.indexOf('Bun.spawn(invocation');
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    expect(readinessCall).toBeGreaterThan(callbackStart);
    expect(spawn).toBeGreaterThan(readinessCall);
    expect(wrapperSource.slice(readinessCall, spawn)).toMatch(/if \(messageCode !== 0\) return messageCode;/u);
  } finally {
    app.cleanup();
  }
});

test('isolated wrapper checks readiness only for bun test, inside the local or check-host callback', () => {
  const callbackStart = wrapperSource.indexOf('async (slotEnvironment) => {');
  const readinessCall = wrapperSource.indexOf('ensureMessagesReady(app)');
  const commandCondition = wrapperSource.indexOf("appCommand[0] === 'bun' && appCommand[1] === 'test'");
  const firstRun = wrapperSource.indexOf('for (const run of commands)');
  const spawn = wrapperSource.indexOf('Bun.spawn(invocation');

  expect(wrapperSource).toContain("from './messages-ready.ts'");
  expect(commandCondition).toBeGreaterThan(callbackStart);
  expect(readinessCall).toBeGreaterThan(commandCondition);
  expect(firstRun).toBeGreaterThan(readinessCall);
  expect(spawn).toBeGreaterThan(firstRun);
  expect(wrapperSource).toContain("command: ['bun', 'scripts/isolated.ts', ...command]");
  expect(wrapperSource).toContain("command[0] === 'bun' && command[1] === 'test'");
});
