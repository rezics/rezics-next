import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRelayTransientFailure } from '../src/modules/outbox/relay.ts';
import { isRestoreTransientFailure } from '../src/modules/work/restore-lineage.ts';

const root = resolve(import.meta.dir, '../../..');

// Release and released-comparison readers share this closure. Keep the list
// explicit so moving an owner reader requires reviewing its failure boundary.
const restoreClosureFiles = [
  'services/main/src/modules/owner/operations.ts',
  'services/main/src/modules/owner/restore-release-binding.ts',
  'services/main/src/modules/owner/object-coverage.ts',
  'services/main/src/modules/erasure/reconcile.ts',
  'services/main/src/modules/erasure/authority.ts',
  'services/main/src/modules/erasure/custody.ts',
  'services/main/src/modules/erasure/replay-graph.ts',
  'services/main/src/modules/erasure/replay-objects.ts',
  'services/main/src/modules/erasure/graph.ts',
  'services/main/src/modules/outbox/relay.ts',
  'services/main/src/modules/outbox/receipt-custody.ts',
  'services/main/src/modules/work/restore-lineage.ts',
  'services/main/src/modules/work/history.ts',
  'services/main/src/modules/semantic/model-custody.ts',
  'services/main/src/infrastructure/immutable-objects.ts',
] as const;

interface AstMatch {
  file: string;
  text: string;
  range: { byteOffset: { start: number; end: number }; start: { line: number } };
  metaVariables?: { multi?: { ARGS?: { text: string }[] } };
}

function astMatches(selector: string[], input?: string): AstMatch[] {
  const output = execFileSync(
    'task',
    [
      'ast-grep',
      '--',
      'run',
      '--lang',
      'typescript',
      '--json=compact',
      ...selector,
      ...(input === undefined ? restoreClosureFiles : ['--stdin']),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(output) as AstMatch[];
}

function wrapperViolations(catches: AstMatch[], throws: AstMatch[]): string[] {
  const violations: string[] = [];
  for (const thrown of throws) {
    const enclosing = catches
      .filter(
        (caught) =>
          caught.file === thrown.file &&
          caught.range.byteOffset.start < thrown.range.byteOffset.start &&
          caught.range.byteOffset.end >= thrown.range.byteOffset.end,
      )
      .sort((a, b) => b.range.byteOffset.start - a.range.byteOffset.start)[0];
    if (!enclosing) continue;
    const caughtName = /^catch\s*\(\s*([\w$]+)\s*\)/.exec(enclosing.text)?.[1];
    const options =
      thrown.metaVariables?.multi?.ARGS?.filter(
        (argument) => argument.text.startsWith('{') && argument.text.endsWith('}'),
      ) ?? [];
    const preservesCause =
      caughtName !== undefined &&
      options.some((argument) =>
        new RegExp(`\\bcause\\s*:\\s*${caughtName}\\s*[,}]`).test(argument.text),
      );
    if (!preservesCause)
      violations.push(`${thrown.file}:${thrown.range.start.line + 1}: ${thrown.text}`);
  }
  return violations;
}

test('restore closure catch wrappers retain the nearest caught error as cause', () => {
  const catches = astMatches(['--kind', 'catch_clause']);
  const throws = astMatches(['--pattern', 'throw new $TYPE($$$ARGS)']);
  expect(catches.length).toBeGreaterThan(0);
  expect(throws.length).toBeGreaterThan(0);
  expect(wrapperViolations(catches, throws)).toEqual([]);
});

test('the AST guard detects cause loss without matching an outer catch variable', () => {
  const source = `try { operation(); } catch (outer) {
    throw new Error('retained', { cause: outer });
    try { nested(); } catch (inner) {
      throw new Error('lost');
      throw new Error('wrong scope', { cause: outer });
      throw new Error('retained inner', { cause: inner });
    }
  }`;
  const violations = wrapperViolations(
    astMatches(['--kind', 'catch_clause'], source),
    astMatches(['--pattern', 'throw new $TYPE($$$ARGS)'], source),
  );
  expect(violations).toHaveLength(2);
  expect(violations[0]).toContain("throw new Error('lost')");
  expect(violations[1]).toContain("throw new Error('wrong scope'");
});

test('graph proof catches propagate transport failures before returning a conflict', () => {
  const catches = astMatches(['--kind', 'catch_clause']);
  const graphCatches = catches.filter(
    (caught) =>
      /\/erasure\/(?:replay-graph|graph)\.ts$/.test(caught.file) &&
      /\breturn\s+(?:false|['"]conflict['"])\s*;/.test(caught.text),
  );
  expect(graphCatches.length).toBeGreaterThan(0);
  for (const caught of graphCatches) {
    expect(caught.text).toMatch(/if\s*\(isRelayTransientFailure\(error\)\)\s*throw error\s*;/);
    expect(caught.text.indexOf('isRelayTransientFailure(error)')).toBeLessThan(
      caught.text.search(/\breturn\s+(?:false|['"]conflict['"])\s*;/),
    );
  }
});

test('unavailable object fallbacks cannot hide owner transport failures', () => {
  const history = readFileSync(resolve(root, 'services/main/src/modules/work/history.ts'), 'utf8');
  const objects = readFileSync(
    resolve(root, 'services/main/src/modules/owner/object-coverage.ts'),
    'utf8',
  );
  expect(history).toMatch(
    /if\s*\(\s*!\(error instanceof RevisionUnavailable\)\s*\|\|\s*isRelayTransientFailure\(error\)\s*\)\s*throw error\s*;/,
  );
  expect(objects).toMatch(
    /if\s*\(\s*!\(error instanceof ObjectUnavailable\)\s*\|\|\s*isRelayTransientFailure\(error\)\s*\)\s*throw error\s*;/,
  );
});

test('restore and relay use one cycle-safe evidence classifier', () => {
  expect(isRestoreTransientFailure).toBe(isRelayTransientFailure);
  for (const code of ['ECONNRESET', '57P01', '08006']) {
    expect(
      isRelayTransientFailure(
        new Error('owner differs', {
          cause: Object.assign(new Error('transport interrupted'), { code }),
        }),
      ),
    ).toBe(true);
  }
  for (const message of [
    'connection unavailable',
    'network timeout',
    'fetch failed',
    'ECONNRESET',
    'Fuseki query returned 503',
  ]) {
    expect(isRelayTransientFailure(new Error(message))).toBe(false);
  }
  const cycle = new Error('connection timeout');
  cycle.cause = cycle;
  expect(isRelayTransientFailure(cycle)).toBe(false);
  const first = new Error('outer');
  const second = Object.assign(new Error('inner'), { code: '57P01' });
  first.cause = second;
  second.cause = first;
  expect(isRelayTransientFailure(first)).toBe(true);
  const timeout = new Error('timeout exceeded when trying to connect');
  timeout.stack =
    'Error: timeout exceeded when trying to connect\n    at /node_modules/pg-pool/index.js:45:11';
  expect(isRelayTransientFailure(timeout)).toBe(true);
  expect(isRelayTransientFailure(new Error(timeout.message))).toBe(false);
});
