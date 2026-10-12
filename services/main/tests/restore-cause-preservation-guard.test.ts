import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommandOutcomeUnknown } from '../src/infrastructure/fuseki.ts';
import { DRIVER_TRANSPORT_FAILURES } from '../src/infrastructure/owner-failure.ts';
import { ErasureRestoreHold } from '../src/modules/erasure/reconcile.ts';
import { isRelayTransientFailure } from '../src/modules/outbox/relay.ts';
import { isRestoreTransientFailure, RestoreLineageConflict } from '../src/modules/work/restore-lineage.ts';

const root = resolve(import.meta.dir, '../../..');

// Release and released-comparison readers share this closure. Keep the list
// explicit so moving an owner reader requires reviewing its failure boundary.
const restoreClosureFiles = [
  'services/main/src/infrastructure/owner-failure.ts',
  'services/main/src/infrastructure/fuseki.ts',
  'services/main/src/modules/owner/operations.ts',
  'services/main/src/modules/owner/restore-release-binding.ts',
  'services/main/src/modules/owner/object-coverage.ts',
  'services/main/src/modules/access/erasure-recovery.ts',
  'services/main/src/modules/erasure/reconcile.ts',
  'services/main/src/modules/erasure/authority.ts',
  'services/main/src/modules/erasure/custody.ts',
  'services/main/src/modules/erasure/replay-graph.ts',
  'services/main/src/modules/erasure/replay-objects.ts',
  'services/main/src/modules/erasure/graph.ts',
  // Completion rereads the journal, Content tombstones/sources, supersessions,
  // erased credentials and the complete journal digest before final settlement.
  'services/main/src/modules/erasure/journal.ts',
  'services/main/src/modules/erasure/content.ts',
  'services/main/src/modules/erasure/replay-supersessions.ts',
  'services/main/src/modules/erasure/account.ts',
  'services/main/src/modules/erasure/core-journal-coverage.ts',
  'services/main/src/modules/outbox/relay.ts',
  'services/main/src/modules/outbox/account-deletion-journal.ts',
  'services/main/src/modules/outbox/receipt-custody.ts',
  'services/main/src/modules/work/restore-lineage.ts',
  'services/main/src/modules/work/history.ts',
  'services/main/src/modules/work/access-recovery-coverage.ts',
  'services/main/src/modules/work/pg-recovery-frontier.ts',
  'services/main/src/modules/work/content-recovery-coverage.ts',
  'services/main/src/modules/semantic/model-custody.ts',
  'services/main/src/infrastructure/immutable-objects.ts',
  // Operator completion observes release, prepares membership, then commits
  // owner LOGIN and confirms it. The API owner does not enable database roles.
  'services/main/src/modules/structure/membership-normalize.ts',
  'scripts/ops/restore.ts',
] as const;

// These modules also contain unrelated publication/authoring wrappers. Audit
// the completion reader's actual AST range, rather than changing that ownership.
const scopedRestoreClosure = [
  {
    file: 'services/main/src/modules/outbox/recovery-coverage-head.ts',
    functions: ['assertCurrentRecoveryCoverageHead'],
  },
  {
    file: 'services/content/src/comments.ts',
    functions: ['revisionsWithOpenCommentSource'],
  },
] as const;

interface AstMatch {
  file: string;
  text: string;
  range: { byteOffset: { start: number; end: number }; start: { line: number } };
  metaVariables?: { multi?: { ARGS?: { text: string }[] } };
}

function rawAstMatches(selector: string[], files: readonly string[], input?: string): AstMatch[] {
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
      ...(input === undefined ? files : ['--stdin']),
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

let completionReaderRanges: AstMatch[] | undefined;

function astMatches(selector: string[], input?: string): AstMatch[] {
  if (input !== undefined) return rawAstMatches(selector, [], input);
  const scopedFiles = scopedRestoreClosure.map(({ file }) => file);
  if (!completionReaderRanges) {
    const declarations = rawAstMatches(['--kind', 'function_declaration'], scopedFiles);
    completionReaderRanges = scopedRestoreClosure.flatMap(({ file, functions }) =>
      functions.map((name) => {
        const matches = declarations.filter(
          (declaration) => declaration.file.endsWith(file) &&
            new RegExp(`\\bfunction\\s+${name}\\b`).test(declaration.text),
        );
        expect(matches).toHaveLength(1);
        return matches[0]!;
      }),
    );
  }
  return rawAstMatches(selector, [...restoreClosureFiles, ...scopedFiles]).filter(
    (match) => !scopedFiles.some((file) => match.file.endsWith(file)) ||
      completionReaderRanges!.some((reader) => reader.file === match.file &&
        reader.range.byteOffset.start <= match.range.byteOffset.start &&
        reader.range.byteOffset.end >= match.range.byteOffset.end),
  );
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

test('Fuseki receipt reconciliation keeps the original uncertain command as cause', () => {
  const methods = rawAstMatches(['--kind', 'method_definition'], ['services/main/src/infrastructure/fuseki.ts']);
  const method = methods.find(candidate => /\basync commandWithReceipt\s*\(/.test(candidate.text));
  expect(method).toBeDefined();
  expect(method!.text).toMatch(/let commandFailure:\s*CommandOutcomeUnknown\s*\|\s*undefined/);
  expect(method!.text).toContain('cause: commandFailure');
  const timeout = new CommandOutcomeUnknown('command outcome unknown', { cause: new Error('socket timed out') });
  expect(timeout.cause).toMatchObject({ message: 'socket timed out' });
});

test('one owner completion boundary classifies every phase before permanent settlement', () => {
  const files = ['services/main/src/modules/owner/operations.ts'];
  const methods = rawAstMatches(['--kind', 'method_definition'], files);
  const restore = methods.filter((method) => /\basync\s+reconcileRestore\s*\(/.test(method.text));
  expect(restore).toHaveLength(1);
  const method = restore[0]!;
  const boundaries = rawAstMatches(['--kind', 'try_statement'], files).filter(
    (statement) => statement.range.byteOffset.start >= method.range.byteOffset.start &&
      statement.range.byteOffset.end <= method.range.byteOffset.end &&
      statement.text.includes('this.completeReleasedRestore(') &&
      statement.text.includes('this.settleRestoreOutcome('),
  ).sort((a, b) =>
    (a.range.byteOffset.end - a.range.byteOffset.start) -
    (b.range.byteOffset.end - b.range.byteOffset.start),
  );
  expect(boundaries.length).toBeGreaterThan(0);
  const boundary = boundaries[0]!;
  const handlers = rawAstMatches(['--kind', 'catch_clause'], files).filter(
    (caught) => caught.range.byteOffset.start > boundary.range.byteOffset.start &&
      caught.range.byteOffset.end <= boundary.range.byteOffset.end,
  ).sort((a, b) => b.range.byteOffset.start - a.range.byteOffset.start);
  const handler = handlers.find(caught =>
    caught.text.includes("restoreInterruption(error, 'restore owner completion was interrupted')"));
  expect(handler).toBeDefined();
  const body = Buffer.from(boundary.text).subarray(
    0, handler.range.byteOffset.start - boundary.range.byteOffset.start,
  ).toString('utf8');
  for (const call of [
    'requireQualification(',
    'this.releaseRetainedErasures(',
    'releaseRestoredGraphHold(',
    'this.completeReleasedRestore(',
    'this.settleRestoreOutcome(',
  ]) expect(body).toContain(call);
  // Moving classification to a lower helper leaves another phase unprotected.
  expect(rawAstMatches(['--pattern', 'isRestoreTransientFailure($$$ARGS)'], files)).toHaveLength(1);
  expect(handler.text).toContain("restoreInterruption(error, 'restore owner completion was interrupted')");
  expect(handler.text).toContain('throw new OwnerOperationUnavailable(');
  const classify = handler.text.indexOf('restoreInterruption(error');
  const unavailable = handler.text.indexOf('throw new OwnerOperationUnavailable(');
  const settle = handler.text.indexOf('this.settleRestoreOutcome(');
  expect(classify).toBeLessThan(unavailable);
  expect(unavailable).toBeLessThan(settle);
  for (const name of ['settleRestoreOutcome', 'releaseRetainedErasures', 'completeReleasedRestore']) {
    const method = methods.find(candidate => new RegExp(`\\basync\\s+${name}\\s*\\(`).test(candidate.text));
    expect(method).toBeDefined();
    expect(method!.text).toContain('restoreInterruption(error');
  }
});

test('operator LOGIN readback classifies transport failures through the shared owner policy', () => {
  const catches = rawAstMatches(['--kind', 'catch_clause'], ['scripts/ops/restore.ts']);
  const login = catches.find(caught => caught.text.includes('LOGIN enabled, pg_roles readback failed'));
  expect(login).toBeDefined();
  expect(login!.text).toContain('isOwnerTransientFailure(error)');
  expect(login!.text).toContain('new RestoreInterrupted(message, { cause: error })');
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
    expect(caught.text).toMatch(/if\s*\(isOwnerTransientFailure\(error\)\)\s*throw error\s*;/);
    expect(caught.text.indexOf('isOwnerTransientFailure(error)')).toBeLessThan(
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
    /if\s*\(\s*!\(error instanceof RevisionUnavailable\)\s*\|\|\s*isOwnerTransientFailure\(error\)\s*\)\s*throw error\s*;/,
  );
  expect(objects).toMatch(
    /if\s*\(\s*!\(error instanceof ObjectUnavailable\)\s*\|\|\s*isOwnerTransientFailure\(error\)\s*\)\s*throw error\s*;/,
  );
});

test('restore and relay use one cycle-safe evidence classifier', () => {
  const classifier = readFileSync(resolve(root, 'services/main/src/infrastructure/owner-failure.ts'), 'utf8');
  // This helper is called by low-level readers; importing domain owners here
  // would reintroduce their initialization cycle before a restore can start.
  expect(classifier).not.toMatch(/\bimport\b|\bfrom\s*['"]/);
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
  const unknown = new CommandOutcomeUnknown('receipt absent', { cause: new Error('uncoded command timeout') });
  expect(isRelayTransientFailure(unknown)).toBe(true);
  expect(isRelayTransientFailure(new RestoreLineageConflict('restore interrupted', {
    cause: new Error('owner read failed', { cause: unknown }),
  }))).toBe(true);
});

const transientContractRows: { name: string; failure: () => Error }[] = [
  ...['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'].map(code => ({
    name: code, failure: () => Object.assign(new Error('socket transport failed'), { code }),
  })),
  ...['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_OTHER'].map(code => ({
    name: code, failure: () => Object.assign(new Error('Undici transport failed'), { code }),
  })),
  ...['08000', '08006', '57P01', '57P02', '57P03', '40001', '40P01', '53300', '55P03'].map(code => ({
    name: `SQLSTATE ${code}`, failure: () => Object.assign(new Error('PostgreSQL owner failure'), { code }),
  })),
  { name: 'TimeoutError', failure: () => new DOMException('deadline exceeded', 'TimeoutError') },
  ...[408, 429, 500, 502, 503, 504].map(status => ({
    name: `HTTP ${status}`, failure: () => Object.assign(new Error(`Fuseki returned ${status}`), { status }),
  })),
  { name: 'CommandOutcomeUnknown', failure: () => new CommandOutcomeUnknown('receipt is absent') },
  ...DRIVER_TRANSPORT_FAILURES.map(message => ({ name: `pg message ${message}`, failure: () => new Error(message) })),
];

for (const row of transientContractRows) {
  test(`shared classifier accepts transient contract row: ${row.name}`, () => {
    const failure = row.failure();
    expect(isRestoreTransientFailure(failure)).toBe(true);
    expect(isRestoreTransientFailure(new RestoreLineageConflict('restore hold', { cause: failure }))).toBe(true);
    expect(isRestoreTransientFailure(new ErasureRestoreHold('erasure refusal', { cause: failure }))).toBe(true);
  });
}

const nonTransientContractRows: { name: string; failure: () => Error }[] = [
  ...[400, 401, 403, 404, 409, 422].map(status => ({
    name: `HTTP ${status}`, failure: () => Object.assign(new Error(`Fuseki returned ${status}`), { status }),
  })),
  ...['23505', '42P01'].map(code => ({
    name: `SQLSTATE ${code}`, failure: () => Object.assign(new Error('PostgreSQL statement failed'), { code }),
  })),
  { name: 'plain Error', failure: () => new Error('owner operation failed') },
  { name: 'AbortError without timeout cause', failure: () => {
    const error = new Error('caller cancelled the read'); error.name = 'AbortError'; return error;
  } },
];

for (const row of nonTransientContractRows) {
  test(`shared classifier rejects non-transient contract row: ${row.name}`, () => {
    const failure = row.failure();
    expect(isRestoreTransientFailure(failure)).toBe(false);
    expect(isRestoreTransientFailure(new RestoreLineageConflict('restore hold', { cause: failure }))).toBe(false);
    expect(isRestoreTransientFailure(new ErasureRestoreHold('erasure refusal', { cause: failure }))).toBe(false);
  });
}

test('shared classifier rejects pg message near misses and coded SQL errors', () => {
  for (const message of [
    `${DRIVER_TRANSPORT_FAILURES[0]} after timeout`,
    'Client was closed and is not queryable',
    'Connection terminated',
  ]) {
    expect(isRelayTransientFailure(new Error(message))).toBe(false);
  }
  for (const message of DRIVER_TRANSPORT_FAILURES) {
    expect(isRelayTransientFailure(Object.assign(new Error(message), { code: '23505' }))).toBe(false);
  }
  const renamed = new Error(DRIVER_TRANSPORT_FAILURES[0]);
  renamed.name = 'DriverError';
  expect(isRelayTransientFailure(renamed)).toBe(false);
});
