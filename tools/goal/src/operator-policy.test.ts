import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief, pathsOverlap, validatePath } from './briefs.ts';
import { readDerivedFiles } from './config.ts';
import { prepareOwnerDecisionPrompt } from './owner-decisions.ts';
import { defaultPolicy, readControlPolicy } from './policy.ts';
import type { Task } from './types.ts';
import { saveSmokeEvidence, smokeRunSuffix } from '../scripts/launch-smoke.ts';

function temporary<T>(run: (path: string) => T): T {
  const root = join(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'operator-policy-'));
  try {
    return run(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

test('brief limits admit exact UTF-8 bytes and paths while bounding wildcard work', () => {
  const markdown =
    '---\ngoal: fixture\nkind: implementation\npaths: [a]\nriskAreas: []\ncriticalPath: false\nwaiting: []\n---\né';
  const policy = readControlPolicy({ brief: { bytes: Buffer.byteLength(markdown), pathCharacters: 1 } });
  expect(parseBrief(markdown, { version: 1, areas: {} }, policy.brief).paths).toEqual(['a']);
  expect(() => parseBrief(markdown + 'é', { version: 1, areas: {} }, policy.brief)).toThrow('brief is');
  expect(() => validatePath('ab', policy.brief)).toThrow('under 1 characters');
  expect(() => readDerivedFiles([{ path: 'ab', stage: 'integration', command: ['bun'] }], policy.brief)).toThrow(
    'under 1',
  );
  expect(pathsOverlap('a/**', 'a/b')).toBe(true);
  expect(() => pathsOverlap('a/**', 'a/b', readControlPolicy({ brief: { pathMatchStates: 1 } }).brief)).toThrow(
    'supported bound',
  );
  expect(() => readControlPolicy({ brief: { pathMatchStates: 0 } })).toThrow('policy.brief.pathMatchStates');
});

test('owner decisions use the caller message, input and total prompt limits', () => {
  const summary = 'x'.repeat(defaultPolicy.inbox.managerMessageCharacters + 1);
  const task = { id: 'task', currentAttempt: 1, worktree: '/missing', brief: { manager: 'owner' } } as Task;
  const body = JSON.stringify({
    managerId: 'owner',
    senderSessionId: 'session',
    taskId: 'task',
    attempt: 1,
    decisionId: 'id',
    summary,
  });
  const store = {
    ownerDecisionEvents: () => [
      {
        task_id: 'task',
        attempt: 1,
        sequence: 1,
        at: new Date(0).toISOString(),
        kind: 'owner-contract-decision-accepted',
        body,
      },
    ],
  };
  const prepare = (policy = defaultPolicy) =>
    prepareOwnerDecisionPrompt(store, task, { taskId: 'task', attempt: 1 }, 'Continue.', policy);
  expect(prepare().delivery).toBeUndefined();
  const overrides = { inbox: { managerMessageCharacters: summary.length } };
  const accepted = prepare(readControlPolicy(overrides));
  expect(accepted.prompt).toContain(summary);
  const characters = accepted.prompt.length;
  expect(prepare(readControlPolicy({ ...overrides, workerPrompt: { characters } })).delivery?.summaryDelivered).toBe(
    true,
  );
  expect(() => prepare(readControlPolicy({ ...overrides, workerPrompt: { characters: characters - 1 } }))).toThrow(
    'total prompt input limit',
  );
  expect(
    prepare(readControlPolicy({ ...overrides, brief: { bytes: Buffer.byteLength(body) - 1 } })).delivery,
  ).toBeUndefined();
});

test('smoke evidence overrides bound redacted content, serialized size and current-run suffixes', () =>
  temporary((path) => {
    const policy = readControlPolicy({
      launchSmoke: {
        evidenceStringBytes: 24,
        evidenceArrayItems: 1,
        evidenceObjectEntries: 2,
        evidenceKeyCharacters: 2,
        logEvents: 1,
      },
    }).launchSmoke;
    const evidence = join(path, 'evidence.json');
    saveSmokeEvidence(evidence, { values: ['é'.repeat(100), 'omitted'], password: 'private', ignored: true }, policy);
    const result = JSON.parse(readFileSync(evidence, 'utf8'));
    expect(Object.keys(result)).toEqual(['va', 'pa']);
    expect(result.va).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(result.va[0]))).toBeLessThanOrEqual(24);
    expect(result.pa).toBe('<redacted>');
    expect(() => saveSmokeEvidence(evidence, { value: 'too long' }, { ...policy, evidenceBytes: 1 })).toThrow(
      'size bound',
    );
    const log = join(path, 'run.jsonl');
    const events = [1, 2, 3].map((exit_code) => JSON.stringify({ type: 'item.completed', item: { exit_code } }) + '\n');
    writeFileSync(log, events.join(''));
    expect(
      smokeRunSuffix(log, Buffer.byteLength(events[0]!), {
        ...policy,
        logTailBytes: Buffer.byteLength(events[2]!) + 1,
      }),
    ).toMatchObject([{ exitCode: 3 }]);
    expect(() => readControlPolicy({ launchSmoke: { pollMs: 0 } })).toThrow('policy.launchSmoke.pollMs');
  }));
