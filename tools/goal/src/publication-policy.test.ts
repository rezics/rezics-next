import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkSettings } from './config.ts';
import { openDb } from './db.ts';
import { parseFrozenFiles } from './frozen.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { runBoundedProcess } from './lifecycle-fixture.ts';
import { integrationChecksForFiles, landingAffectedChecks } from './merge-train.ts';
import { defaultPolicy, readControlPolicy } from './policy.ts';
import { PublicationLegacyReconciliation } from './publication-legacy.ts';
import { publicationCommands, publicationInventoryFresh, publicationWorkflowCommand } from './publication-policy.ts';
import { temporaryDirectory } from './test-support.ts';
import { main as smokeMain } from '../scripts/launch-smoke.ts';

test('publication deadlines and inventory windows use validated local settings at their boundaries', () => {
  const temporary = temporaryDirectory();
  try {
    const file = join(temporary.path, 'local.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        pools: [],
        policy: {
          publication: {
            workflowDeadlineSeconds: 3600,
            workflowGraceSeconds: 60,
            inventoryMaxAgeMs: 600000,
            observationClockSkewMs: 60000,
          },
        },
      }),
    );
    const root = resolve(import.meta.dir, '../../..');
    const policy = checkSettings({ cwd: root, localFile: file, env: { GOAL_MAIN_CHECKOUT: root } }).policy!.publication;
    expect(publicationWorkflowCommand('/pinned/bun', policy)).toEqual([
      'timeout',
      '--signal=TERM',
      '--kill-after=60s',
      '3600s',
      '/pinned/bun',
      'run',
      'storybook:deploy',
      '--force',
    ]);
    expect(publicationWorkflowCommand('/pinned/bun').slice(0, 4)).toEqual([
      'timeout',
      '--signal=TERM',
      '--kill-after=30s',
      '1800s',
    ]);
    const now = 1000000;
    for (const age of [policy.inventoryMaxAgeMs, -policy.observationClockSkewMs])
      expect(publicationInventoryFresh(now - age, now, policy)).toBe(true);
    for (const age of [policy.inventoryMaxAgeMs + 1, -policy.observationClockSkewMs - 1, NaN])
      expect(publicationInventoryFresh(now - age, now, policy)).toBe(false);
    expect(publicationInventoryFresh(now - policy.inventoryMaxAgeMs, now)).toBe(false);
    expect(() => readControlPolicy({ publication: { workflowDeadlineSeconds: 0 } })).toThrow('workflowDeadlineSeconds');
  } finally {
    temporary.close();
  }
});

test('publication helpers apply caller buffers and deadlines without a second default bound', () => {
  const bytes = defaultPolicy.publication.commandBufferBytes + 1;
  const commands = publicationCommands(readControlPolicy({ publication: { commandBufferBytes: bytes } }).publication);
  const result = commands.runSync(
    process.execPath,
    ['-e', `process.stdout.write('x'.repeat(${bytes}))`],
    process.cwd(),
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout.length).toBe(bytes);
  const timed = publicationCommands(readControlPolicy({ publication: { commandTimeoutMs: 20 } }).publication).runSync(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1000)'],
    process.cwd(),
  );
  expect(timed.error).toContain('ETIMEDOUT');
});

test('legacy receiving honors evidence, fields, references and total records while retaining occupied custody', () => {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const state = join(temporary.path, 'state');
  mkdirSync(join(state, 'owner'), { recursive: true });
  try {
    db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    for (const id of ['operations', 'owner'])
      db.query('INSERT INTO manager_sessions VALUES (?,?)').run(
        id,
        JSON.stringify({ kind: 'managed', status: 'running', threadId: `${id}-session` }),
      );
    const original = JSON.stringify({ note: 'é'.repeat(defaultPolicy.publicationLegacy.evidenceBytes / 2) });
    const evidenceBytes = Buffer.byteLength(original);
    writeFileSync(join(state, 'owner/original.json'), original);
    const sha256 = createHash('sha256').update(original).digest('hex');
    const fieldCharacters = defaultPolicy.publicationLegacy.fieldCharacters + 1;
    const refs = ['one', 'two'].map((name) => {
      const path = `state/owner/${name}.json`;
      writeFileSync(
        join(temporary.path, path),
        JSON.stringify({
          version: 1,
          kind: 'publication-legacy-disposition',
          owner: 'owner',
          controller: 'operations',
          records: [
            {
              surface: 'publisher',
              key: name.repeat(fieldCharacters).slice(0, fieldCharacters),
              evidencePath: 'owner/original.json',
              sha256,
            },
          ],
        }),
      );
      return { path };
    });
    new SqliteManagerInbox(db, state, () => 1000).deliver({
      managerId: 'operations',
      from: 'owner',
      kind: 'decision',
      summary: 'Retain original custody',
      senderSessionId: 'owner-session',
      documentRefs: refs,
    });
    const { id } = db.query('SELECT id FROM manager_inbox').get() as { id: number };
    const limits = { evidenceBytes, fieldCharacters, records: 2, documentReferences: 2 };
    const receive = (publicationLegacy = limits) =>
      new PublicationLegacyReconciliation(
        {
          db,
          mainCheckout: temporary.path,
          stateDirectory: state,
          worktreeRoot: temporary.path,
          integrationBranch: 'dev',
          operationsManager: 'operations',
          now: () => 1000,
          policy: readControlPolicy({ publicationLegacy }),
        },
        () => null,
      ).receive(id, { id: 'operations', sessionId: 'operations-session' });
    expect(() => receive({ ...limits, evidenceBytes: evidenceBytes - 1 })).toThrow('bounded regular file');
    expect(() => receive({ ...limits, fieldCharacters: fieldCharacters - 1 })).toThrow('invalid original key');
    expect(() => receive({ ...limits, documentReferences: 1 })).toThrow('provenance');
    expect(() => receive({ ...limits, records: 1 })).toThrow('too many legacy records');
    expect(receive()).toMatchObject({
      state: 'UNKNOWN OCCUPIED',
      launchReady: false,
      authorityChanged: false,
      workflowInvocations: 0,
    });
  } finally {
    db.close();
    temporary.close();
  }
});

test('remaining check selection and frozen input matching forward the brief state bound', () => {
  const policy = readControlPolicy({ brief: { pathMatchStates: 1 } }).brief;
  const check = { paths: ['a/**'], command: ['bun', 'test'] };
  expect(integrationChecksForFiles(['a/b'], [check])).toEqual([check]);
  expect(() => integrationChecksForFiles(['a/b'], [check], policy)).toThrow('supported bound');
  expect(() => landingAffectedChecks(['a/b'], false, [check], policy)).toThrow('supported bound');
  const markdown = '```ts path=a/b\nretained\n```\n';
  expect(parseFrozenFiles(markdown, ['a/**'])[0]?.content).toBe('retained\n');
  expect(() => parseFrozenFiles(markdown, ['a/**'], policy)).toThrow('supported bound');
});

test('lifecycle capture and CLI errors preserve larger smoke overrides and explicit output precedence', async () => {
  const policy = readControlPolicy({
    launchSmoke: {
      outputBytes: defaultPolicy.launchSmoke.outputBytes + 1,
      diagnosticCharacters: defaultPolicy.launchSmoke.diagnosticCharacters + 1,
    },
  });
  const run = (outputLimit?: number) =>
    runBoundedProcess(process.execPath, ['-e', `process.stdout.write('x'.repeat(${policy.launchSmoke.outputBytes}))`], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      policy: policy.launchSmoke,
      ...(outputLimit ? { outputLimit } : {}),
    });
  expect((await run()).stdout.length).toBe(policy.launchSmoke.outputBytes);
  expect((await run(3)).stdout).toBe('xxx');
  const write = process.stderr.write;
  let output = '';
  process.stderr.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof write;
  try {
    const message = 'x'.repeat(policy.launchSmoke.diagnosticCharacters);
    expect(
      await smokeMain(async () => {
        throw message;
      }, policy),
    ).toBe(1);
    expect(output).toContain(message);
  } finally {
    process.stderr.write = write;
  }
});
