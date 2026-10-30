import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, AccessWorkAccounting, type AccessWork } from '../../src/access/work.ts';
import {
  prepareAnonymousEligibility,
  type ResourceEligibilityPrepareContext,
  type ResourceEligibilityVerifyContext,
} from '../../src/access/eligibility.ts';
import { readResource, ContentNotFoundError } from '../../src/content/reads.ts';
import { createReadEligibilityWork } from '../../src/content/read-eligibility-access-work.ts';
import read from '../../src/content/read-chain.sql';
import currentBan from '../../src/community/ban-current.sql';
import type { AccessClient, Actor } from '../../src/request/access.ts';

type Row = Parameters<typeof readResource>[0];
const id = '019a1b2c-3d4e-7f00-8a00-123400000001';
const person = '019a1b2c-3d4e-7f00-8a00-123400000002';
const principal = '019a1b2c-3d4e-7f00-8a00-123400000003';
const realm = '019a1b2c-3d4e-7f00-8a00-123400000004';
const at = '2026-10-31T00:00:00.000Z';
const anonymous: Actor = { kind: 'anonymous' };
const account: Actor = {
  kind: 'account',
  accountId: person,
  clientId: 'content-read-work',
  authnEpoch: 1,
  requestedBy: `urn:rezics:request:${principal}:${id}`,
  scopes: ['board:read', 'thread:read', 'post:read'],
};
// Preparation must return captured evidence without touching this pool.
const pool = {
  connect() {
    throw new Error('Unexpected content preparation checkout');
  },
} as unknown as Pool;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const sum = (values: AccessWork[]): AccessWork =>
  Object.fromEntries(
    ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((total, value) => total + value[axis], 0)]),
  ) as AccessWork;

/** The actual read-chain.sql column set; no body or digest on these branches. */
function row(kind: 'board' | 'thread' | 'post', overrides: Partial<Row> = {}): Row {
  const base: Row = {
    kind,
    id,
    thread_id: null,
    board_id: null,
    parent_id: null,
    author_id: null,
    head_id: null,
    first_post_id: null,
    title: null,
    visibility: 'published',
    security_revision: '1',
    availability: 'available',
    created_at: new Date(at),
    licence: null as unknown as string,
    subject_ids: null as unknown as string[],
    media_ids: null as unknown as string[],
    body: null,
    sha256: null,
    revised_at: null,
    thread_kind: null,
    board_purpose: null,
    vote_citation: null,
    realm_id: null,
    deleted_at: null,
    restorable: false,
    decision_id: null,
  };
  if (kind === 'board') Object.assign(base, { title: 'Board', board_purpose: 'discussion' });
  if (kind === 'thread')
    Object.assign(base, {
      thread_id: id,
      board_id: realm,
      author_id: person,
      first_post_id: principal,
      title: 'Thread',
      thread_kind: 'discussion',
    });
  if (kind === 'post')
    Object.assign(base, {
      thread_id: realm,
      author_id: person,
      head_id: principal,
      restorable: true,
    });
  return { ...base, ...overrides };
}

async function attempt(
  observed: Row,
  actor: Actor = anonymous,
  options: { refuse?: boolean; tombstone?: boolean; placeholder?: boolean; withheld?: boolean } = {},
) {
  const admitted: AccessWork[] = [],
    settled: AccessWork[] = [];
  const work = new AccessWorkAccounting(
    {
      reserve(_operation, bound) {
        if (options.refuse && bound.rows > 0) return null;
        admitted.push(bound);
        return {
          settle(actual) {
            settled.push(actual);
          },
        };
      },
    },
    Date.now() + 10_000,
  );
  const resource = readResource(observed, {}, options.tombstone, options.placeholder, options.withheld);
  const verify = await prepareAnonymousEligibility(
    {
      actor,
      resource,
      action: `${observed.kind}:read`,
      deadline: work.deadline,
    },
    { pool, work, deadline: work.deadline },
  );
  expect(work.usage()).toEqual(EMPTY_ACCESS_WORK);
  const calls: { sql: string; parameters: readonly unknown[] }[] = [];
  let current: Row | null = observed;
  let bannedAccount: string | undefined;
  let failure: Error | undefined;
  const client = {
    async query(sql: string, parameters: readonly unknown[]) {
      // The enclosing owner bound is already charged at every native dispatch.
      expect(work.usage().rows).toBeGreaterThan(0);
      calls.push({ sql, parameters });
      if (failure) throw failure;
      if (sql === read.sql) return { rows: current ? [current] : [], rowCount: 987654 };
      expect(sql).toBe(currentBan.sql);
      const accountIndex = currentBan.params.indexOf('account_id');
      return { rows: parameters[accountIndex] === bannedAccount ? [{ banned: true }] : [], rowCount: 987654 };
    },
  } as unknown as AccessClient;
  return {
    work,
    admitted,
    settled,
    calls,
    verify: () => verify!(client, at),
    current(value: Row | null) {
      current = value;
    },
    ban(value: string) {
      bannedAccount = value;
    },
    fail(error: Error) {
      failure = error;
    },
  };
}

describe('Content resource eligibility native work', () => {
  test('Content board thread post read eligibility declares actual native work without weakening disclosure', async () => {
    for (const kind of ['board', 'thread', 'post'] as const) {
      const observed = row(kind);
      const run = await attempt(observed);
      const result = await run.work.capture(run.verify);
      expect(result.state).toBe('complete');
      if (result.state === 'complete') expect(result.value).toBe(true);
      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]!.sql).toBe(read.sql);
      expect(run.calls[0]!.parameters[read.params.indexOf('include_body')]).toBe(false);
      expect(result.usage).toEqual({
        keys: kind === 'post' ? 3 : 1,
        points: kind === 'post' ? 4 : 2,
        witnesses: 0,
        rows: kind === 'post' ? 7 : 4,
        bytes: bytes(run.calls[0]!.parameters) + bytes([observed]),
        emptySeeks: 0,
      });
      expect(result.usage).toEqual(sum(run.settled));
      expect(result.usage.bytes).toBeLessThanOrEqual(run.admitted.at(-1)!.bytes);
    }
  });

  test('protected Realm board checks the current actor and principal keys at the supplied T', async () => {
    const observed = row('board', { visibility: 'protected', realm_id: realm });
    const run = await attempt(observed, account);
    expect(await run.verify()).toBe(false); // Independent grants still belong to Access.
    expect(run.calls).toHaveLength(3);
    expect(run.calls.slice(1).map((call) => call.parameters[currentBan.params.indexOf('account_id')])).toEqual([
      person,
      principal,
    ]);
    for (const call of run.calls.slice(1)) expect(call.parameters[currentBan.params.indexOf('at')]).toBe(at);
    expect(run.work.usage()).toEqual({
      keys: 3,
      points: 4,
      witnesses: 0,
      rows: 6,
      emptySeeks: 2,
      bytes: run.calls.reduce((n, call, index) => n + bytes(call.parameters) + bytes(index ? [] : [observed]), 0),
    });
    // An open principal ban fails the whole domain check, including grant paths.
    const denied = await attempt(observed, account);
    denied.ban(principal);
    await expect(denied.verify()).rejects.toBeInstanceOf(ContentNotFoundError);
    expect(denied.work.usage()).toEqual(sum(denied.admitted));
    expect(denied.work.usage()).toEqual(sum(denied.settled));
    for (const candidate of [row('board', { realm_id: realm }), row('board', { visibility: 'protected' })]) {
      const ordinary = await attempt(candidate, account);
      await ordinary.verify();
      expect(ordinary.calls).toHaveLength(1);
      expect(ordinary.work.usage().rows).toBe(4);
    }
  });

  test('current signature, erased scope, withheld reference and draft restrictions remain native', async () => {
    const observed = row('post');
    for (const current of [null, { ...observed, security_revision: '2' }, { ...observed, head_id: id }]) {
      const run = await attempt(observed);
      run.current(current);
      await expect(run.verify()).rejects.toBeInstanceOf(ContentNotFoundError);
      expect(run.work.usage()).toEqual(sum(run.admitted));
    }
    const erased = row('post', { availability: 'erased', restorable: false });
    const scoped = await attempt(erased, { ...account, scopes: [] }, { tombstone: true, placeholder: true });
    expect(await scoped.verify()).toBe(false);
    expect(scoped.work.usage().rows).toBe(7);
    const placeholder = await attempt(erased, anonymous, { tombstone: true, placeholder: true });
    expect(await placeholder.verify()).toBe(true);
    const withheld = row('post', { visibility: 'taken_down', decision_id: principal });
    const exact = await attempt(withheld, anonymous, { tombstone: true, placeholder: true, withheld: true });
    expect(await exact.verify()).toBe(true);
    const ordinary = await attempt(withheld);
    await expect(ordinary.verify()).rejects.toBeInstanceOf(ContentNotFoundError);
    const draft = await attempt(row('post', { visibility: 'draft' }));
    await expect(draft.verify()).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  test('unproved projection and insufficient parent budget refuse before native IO', async () => {
    const revision = await attempt({ ...row('post'), kind: 'revision' });
    const unproved = await revision.work.capture(revision.verify);
    expect(unproved).toEqual({
      state: 'unavailable',
      dependency: 'Content read eligibility revision projection native work producer',
      usage: EMPTY_ACCESS_WORK,
    });
    expect(revision.calls).toHaveLength(0);
    const refused = await attempt(row('thread'), anonymous, { refuse: true });
    const result = await refused.work.capture(refused.verify);
    expect(result).toEqual({
      state: 'unavailable',
      dependency: 'Content resource eligibility.verify',
      usage: EMPTY_ACCESS_WORK,
    });
    expect(refused.calls).toHaveLength(0);
  });

  test('failed dispatch retains its full bound and same-window checks reread the current row', async () => {
    const failed = await attempt(row('board', { visibility: 'protected', realm_id: realm }), account);
    failed.fail(Object.assign(new Error('connection lost'), { code: '08006' }));
    const result = await failed.work.capture(failed.verify);
    expect(result.state).toBe('failed');
    expect(failed.calls).toHaveLength(1);
    expect(result.usage).toEqual(sum(failed.admitted));
    expect(result.usage).toEqual(sum(failed.settled));
    const observed = row('post');
    const run = await attempt(observed);
    expect(await run.verify()).toBe(true);
    const first = run.work.usage();
    expect(await run.verify()).toBe(true);
    expect(run.calls).toHaveLength(2);
    expect(run.work.usage()).toEqual(sum([first, first]));
    run.current({ ...observed, security_revision: '2' });
    await expect(run.verify()).rejects.toBeInstanceOf(ContentNotFoundError);
    expect(run.calls).toHaveLength(3);
    expect(run.work.usage()).toEqual(sum(run.settled));
  });

  test('receipts require the exact callback context and result and are consumed once', async () => {
    const observed = row('post');
    const evidence = {};
    const native = createReadEligibilityWork(observed, 0x1234, evidence);
    const resource = { route: 0x1234, id };
    const prepare: ResourceEligibilityPrepareContext = {
      actor: anonymous,
      resource,
      action: 'post:read',
      pool,
      deadline: Date.now() + 10_000,
    };
    native.work.prepare.bound(prepare);
    expect(native.prepare(prepare)).toBe(evidence);
    expect(native.work.prepare.actual({ ...prepare }, evidence)).toBeUndefined();
    expect(native.work.prepare.actual(prepare, {})).toBeUndefined();
    native.work.prepare.bound(prepare);
    native.prepare(prepare);
    expect(native.work.prepare.actual(prepare, evidence)).toEqual(EMPTY_ACCESS_WORK);
    expect(native.work.prepare.actual(prepare, evidence)).toBeUndefined();
    const verify: ResourceEligibilityVerifyContext<object> = {
      actor: anonymous,
      resource,
      action: 'post:read',
      client: {} as AccessClient,
      evidence,
      at,
      deadline: prepare.deadline,
    };
    native.work.verify.bound(verify);
    await native.point(verify, async () => observed);
    native.complete(verify, true);
    expect(native.work.verify.actual({ ...verify }, true)).toBeUndefined();
    expect(native.work.verify.actual(verify, false)).toBeUndefined();
    expect(native.work.verify.actual(verify, true)).toBeUndefined();
    native.work.verify.bound(verify);
    await native.point(verify, async () => null);
    native.complete(verify, false);
    const receipt = native.work.verify.actual(verify, false)!;
    expect(receipt.rows).toBe(7); // Empty probes retain dispatched plan work.
    expect(receipt.emptySeeks).toBe(1);
    expect(native.work.verify.actual(verify, false)).toBeUndefined();
  });
});
