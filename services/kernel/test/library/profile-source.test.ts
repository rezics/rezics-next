import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { authoritativeTimeValue, runCommand, type AuthoritativeTime } from '../../src/command/command.ts';
import { readLibraryProfileSource, type LibraryProfileSource } from '../../src/library/profile-source.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountToken, authenticateAccount } from '../support/admitted-access.ts';
import { capture, costOf, measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  createProfileEntryFixture,
  entryKey,
  entryTypes,
  type NativeProfileFixture,
} from './support/profile-entry-fixture.ts';

let db: GrowthDatabase;
let native: NativeProfileFixture;
let mergeBearer: string;
beforeAll(async () => {
  db = await openGrowthDatabase();
  native = await createProfileEntryFixture({ pool: db.pool });
  const claims = { ...native.steward.actor, scopes: [...native.steward.actor.scopes, 'subject:merge'] };
  const steward = await authenticateAccount(native.access, { pool: db.pool, deadline: deadlineFor(30_000) }, claims);
  await createGrantCommands({ pool: db.pool, access: native.access, managementAction: 'access:grant' }).create(
    { pool: db.pool, actor: steward, deadline: deadlineFor(30_000) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: steward.accountId },
      actions: ['subject:merge'],
      valid: '(,)',
      key: entryKey(),
    },
  );
  mergeBearer = await accountToken(claims);
}, 120_000);
afterAll(async () => {
  await native?.close();
  await db?.close();
});

// The executor mints T; this envelope intentionally ends in prepare, before any
// command authorization/body/receipt. Every source check still uses real Access.
async function observe(id: string, options: { access?: Access; actor?: Actor; deadline?: number } = {}) {
  const done = new Error('source probe finished');
  let value: LibraryProfileSource | undefined;
  let at: AuthoritativeTime | undefined;
  const deadline = options.deadline ?? deadlineFor(30_000);
  try {
    await runCommand(
      db.pool,
      {
        partition: partitionOf(routeOf(native.owner.actor.accountId)!),
        deadline,
        authorization: {
          action: 'library.profile-source.probe',
          resource: { route: 0, id: GLOBAL_CONTEXT },
          denied: () => done,
          async prepare(attempt) {
            at = attempt.time;
            value = await readLibraryProfileSource(
              {
                pool: db.pool,
                access: options.access ?? native.access,
                actor: options.actor ?? native.owner.actor,
                at,
                deadline,
              },
              id,
            );
            throw done;
          },
          async authorize() {
            throw new Error('Source probe cannot authorize a command');
          },
        },
      },
      async () => {
        throw new Error('Source probe cannot execute a body');
      },
    );
  } catch (error) {
    if (error !== done) throw error;
  }
  expect(at).toBeDefined();
  expect(value).not.toBeUndefined();
  return value!;
}

async function hide(id: string) {
  const response = await native.send('steward', 'POST', `/v1/subjects/${id}:hide`, {
    reason: 'Native source visibility',
  });
  expect(response.status).toBe(200);
}

async function separatePair() {
  const a = await native.createSubject('game');
  let b = await native.createSubject('game');
  while (partitionOf(routeOf(a)!) === partitionOf(routeOf(b)!)) b = await native.createSubject('game');
  return [a, b] as const;
}

async function mergePair(a: string, b: string) {
  const response = await native.send(mergeBearer, 'POST', '/v1/subjects:merge', { subjects: [a, b] });
  expect(response.status).toBe(200);
  return (await response.json()) as { survivor: string; redirected: string };
}

async function mergedPair() {
  const [a, b] = await separatePair();
  return mergePair(a, b);
}

test('native profile source selects the whole primary-type profile and never an unattached legacy or structural base', async () => {
  const id = await native.createSubject('game');
  const source = await observe(id);
  expect(source?.kind).toBe('supported');
  if (source?.kind !== 'supported') throw new Error('Expected supported source');
  expect(source.pin).toEqual({
    provenance: 'profile',
    releaseDigest: native.originalDigest,
    acceptingType: entryTypes.game,
    profileId: 'fixture.game',
  });
  expect(source.profile).toEqual(native.original.libraryProfiles!['fixture.game']!);
  expect(source.profile).not.toEqual(native.original.libraryProfiles!['fixture.root']);
  expect(source.component.partition).toBe(partitionOf(routeOf(id)!));
  expect(typeof source.component.position).toBe('bigint');
  expect(Object.keys(source).sort()).toEqual([
    'component',
    'kind',
    'pin',
    'profile',
    'requestedSubjectId',
    'subjectId',
  ]);
  const person = await native.createSubject('unprofiled');
  expect(native.original.libraryProfiles!['legacy-fixed-v1']).toBeDefined();
  expect(await observe(person)).toMatchObject({
    kind: 'unsupported',
    subjectId: person,
    requestedSubjectId: null,
    acceptingType: entryTypes.unprofiled,
  });
  expect(await observe('invalid')).toBeNull();
  expect(await observe(native.unknownSubject())).toBeNull();
  await hide(id);
  expect(await observe(id)).toBeNull();
  const suspended = await native.identity(['subject:read']);
  await native.suspend(suspended.actor.accountId);
  expect(await observe(person, { actor: suspended.actor })).toBeNull();
});

test('native profile source separately authorizes redirect anchors and conceals a hidden source or survivor', async () => {
  const pair = await mergedPair();
  const checked: string[] = [];
  const access = deriveAccess(native.access, {
    async authorize(client, actor, action, resource, evidence, at) {
      if (action === 'subject:read') checked.push(resource.id);
      return native.access.authorize(client, actor, action, resource, evidence, at);
    },
  });
  expect(await observe(pair.redirected, { access })).toMatchObject({
    kind: 'supported',
    subjectId: pair.survivor,
    requestedSubjectId: pair.redirected,
  });
  expect(checked).toContain(pair.redirected);
  expect(checked.filter((id) => id === pair.survivor).length).toBeGreaterThanOrEqual(2);
  await hide(pair.survivor);
  expect(await observe(pair.redirected)).toBeNull();
  const hiddenSource = await mergedPair();
  await hide(hiddenSource.redirected);
  expect(await observe(hiddenSource.redirected)).toBeNull();
});

test('native profile source retries a redirect introduced before the final reference RR through the existing resolver', async () => {
  const ids = await separatePair();
  const [survivor, original] = [...ids].sort() as [string, string];
  let preparations = 0;
  const access = deriveAccess(native.access, {
    async prepare(actor, action, resource, context) {
      preparations++;
      if (preparations === 2) expect(await mergePair(...ids)).toMatchObject({ survivor, redirected: original });
      return native.access.prepare!(actor, action, resource, context);
    },
  });
  const observed = await observe(original, { access });
  expect(observed).toMatchObject({ kind: 'supported', subjectId: survivor, requestedSubjectId: original });
  expect(observed?.component.partition).toBe(partitionOf(routeOf(survivor)!));
  expect(preparations).toBeGreaterThan(2);
});

test('native profile source observes new release pins without rewriting an earlier observation', async () => {
  const id = await native.createSubject('recipe');
  const first = await observe(id);
  await native.activate(native.replacementDigest);
  try {
    const second = await observe(id);
    expect(first?.kind === 'supported' && first.pin.releaseDigest).toBe(native.originalDigest);
    expect(second?.kind === 'supported' && second.pin.releaseDigest).toBe(native.replacementDigest);
    expect(
      second?.kind === 'supported' && second.profile.entryStateSet?.states.some((s) => s.id === 'cooking_again'),
    ).toBe(true);
    const record = await native.createSubject('record');
    expect(await observe(record)).toMatchObject({ kind: 'unsupported', acceptingType: entryTypes.record });
  } finally {
    await native.activate(native.originalDigest);
  }
});

test('native profile type lookup uses the authorized reference RR client and T, with no display hydration and one fixed deadline', async () => {
  const id = await native.createSubject('game');
  const deadline = deadlineFor(30_000);
  const authorizations: { client: unknown; at: AuthoritativeTime | undefined }[] = [];
  const typeReads: unknown[] = [];
  const originals = new Map<PoolClient, PoolClient['query']>();
  const deadlines: number[] = [];
  const access = deriveAccess(native.access, {
    async prepare(actor, action, resource, context) {
      deadlines.push(context.deadline);
      return native.access.prepare!(actor, action, resource, context);
    },
    async authorize(client, actor, action, resource, evidence, at) {
      expect(authoritativeTimeValue(at!)).toMatch(/^\d{4}-/);
      authorizations.push({ client, at });
      if (!originals.has(client as PoolClient)) {
        const original = client.query;
        originals.set(client as PoolClient, original);
        client.query = function (...args: unknown[]) {
          const statement = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
          if (statement.includes('read-item-types.sql')) typeReads.push(client);
          return Reflect.apply(original, client, args);
        } as PoolClient['query'];
      }
      return native.access.authorize(client, actor, action, resource, evidence, at);
    },
  });
  try {
    const measured = await capture(db, () => observe(id, { access, deadline }));
    expect(measured.value?.kind).toBe('supported');
    expect(typeReads).toHaveLength(1);
    expect(typeReads[0]).toBe(authorizations.at(-1)!.client);
    expect(new Set(authorizations.map((call) => call.at)).size).toBe(1);
    expect(deadlines.length).toBeGreaterThanOrEqual(2);
    expect(deadlines.every((observed) => observed === deadline)).toBe(true);
    const sql = measured.capture.statements.join('\n');
    expect(sql).toContain('read-item-types.sql');
    expect(sql).not.toMatch(
      /read-subject-summary|read-labels|semantic\.statement|semantic\.link_projection|semantic\.display/,
    );
    expect(sql).not.toMatch(/INSERT INTO library|UPDATE library/);
  } finally {
    for (const [client, query] of originals) client.query = query;
  }
  const failure = new AccessUnavailableError('overloaded');
  const unavailable = deriveAccess(native.access, {
    async prepare() {
      throw failure;
    },
  });
  await expect(observe(id, { access: unavailable })).rejects.toBe(failure);
  await expect(observe(id, { deadline: Date.now() - 1 })).rejects.toBeDefined();
});

test('native profile source point-read work stays fixed as unrelated real subject population grows', async () => {
  const id = await native.createSubject('game');
  const costs: ReturnType<typeof costOf>[] = [];
  let count = 0;
  for (const scale of [1, 8, 64]) {
    while (count < scale) {
      await native.createSubject('unprofiled');
      count++;
    }
    costs.push((await measure(db, () => observe(id))).cost);
  }
  expect(costs.map((cost) => cost.statements)).toEqual([
    costs[0]!.statements,
    costs[0]!.statements,
    costs[0]!.statements,
  ]);
  expect(costs.map((cost) => cost.rows)).toEqual([costs[0]!.rows, costs[0]!.rows, costs[0]!.rows]);
});
