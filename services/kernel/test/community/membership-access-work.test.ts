import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import * as accessModule from '../../src/access/index.ts';
import {
  ACCESS_WORK_AXES,
  AccessWorkAccounting,
  EMPTY_ACCESS_WORK,
  accessOwnerWork,
  type AccessWork,
} from '../../src/access/work.ts';
import * as membershipModule from '../../src/community/membership.ts';
import readRoles from '../../src/community/membership-role.sql';
import readRoleBatch from '../../src/community/membership-role-batch.sql';
import { MEMBERSHIP_LIMIT } from '../../src/access/membership-inverse.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import type { Access, AccessClient, AccessConfig, AccessRealmRoleReader } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = {} as Pool;
const client = {} as AccessClient;
const at = '2030-01-01T00:00:00.000Z';
const input = () => ({ realmId: newId(42), accountId: newId(43), at });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const negative = { role: 'owner' as const, member: false, valid: `["${at}",)` };
function rows(member: boolean, until?: string): { role: 'owner' | 'member'; member: boolean; valid: string }[] {
  return [{ role: 'member', member, valid: member ? '(,)' : `["${at}",${until ? `"${until}"` : ''})` }, negative];
}
function reader() {
  return membershipModule.createRealmMembership({ deadlineNow: () => Date.now(), pool, access: {} as Access })
    .roleReader;
}
function accounting(refuse = false) {
  const admitted: AccessWork[] = [];
  const settled: AccessWork[] = [];
  const work = new AccessWorkAccounting(
    {
      reserve(_operation, bound) {
        if (refuse) return null;
        admitted.push(bound);
        return { settle: (actual) => void settled.push(actual) };
      },
    },
    Date.now() + 10_000,
  );
  return { work, admitted, settled };
}

test('actual single native role dispatch keeps charged rows on positive, gap and absent Realm paths', async () => {
  for (const projection of [rows(true), rows(false, '2031-01-01T00:00:00Z'), rows(false), []]) {
    const native = spyOn(readRoles, 'run');
    try {
      const role = reader();
      const context = input();
      const meter = accounting();
      const bound = role.work!.bound(context)!;
      expect(Object.isFrozen(bound)).toBe(true);
      native.mockImplementation(async (actualClient, parameters) => {
        expect(actualClient).toBe(client);
        expect(parameters).toEqual({
          route: 42,
          realm_id: context.realmId,
          account_id: context.accountId,
          at,
        });
        expect(meter.admitted).toEqual([bound]); // before native IO
        return projection;
      });
      const result = await meter.work.capture(() =>
        accessOwnerWork(meter.work, 'Content AccessRealmRoleReader', role.work, context, () => role(client, context)),
      );
      expect(result.state).toBe('complete');
      expect(native).toHaveBeenCalledTimes(1);
      expect(meter.work.usage().rows).toBe(bound.rows);
      expect(bound.rows).toBeGreaterThan(2);
      expect(meter.work.usage().bytes).toBe(
        bytes({ route: 42, realm_id: context.realmId, account_id: context.accountId, at }) + bytes(projection),
      );
      expect(meter.work.usage().emptySeeks).toBe(
        !projection.length ? 1 : projection[0]!.member ? 0 : projection[0]!.valid.endsWith(',)') ? 2 : 1,
      );
      expect(meter.settled).toEqual([meter.work.usage()]);
      if (result.state === 'complete') {
        if (!projection.length) expect(result.value).toBeNull();
        else expect(result.value?.map((row) => row.role)).toEqual(['owner', 'member']);
      }
    } finally {
      native.mockRestore();
    }
  }
});

test('native batch receipts include mixed missing anchors and the empty batch dispatches no SQL', async () => {
  const native = spyOn(readRoleBatch, 'run');
  try {
    for (const state of ['positive', 'partial', 'missing', 'empty']) {
      const role = reader();
      const first = input();
      const second = { ...input(), accountId: first.accountId };
      const pairs = state === 'empty' ? [] : [first, second].map(({ realmId, accountId }) => ({ realmId, accountId }));
      const context = { at, pairs };
      const projection =
        state === 'missing' || state === 'empty'
          ? []
          : (state === 'partial' ? [first] : [first, second]).flatMap(({ realmId, accountId }) =>
              rows(false).map((row) => ({ realmId, accountId, ...row })),
            );
      native.mockReset();
      native.mockResolvedValue(projection);
      const meter = accounting();
      const bound = role.batchWork!.bound(context)!;
      const result = await meter.work.capture(() =>
        accessOwnerWork(meter.work, 'Content AccessRealmRoleReader.batch', role.batchWork, context, () =>
          role.batch!(client, context),
        ),
      );
      expect(result.state).toBe('complete');
      expect(native).toHaveBeenCalledTimes(state === 'empty' ? 0 : 1);
      expect(meter.work.usage().rows).toBe(bound.rows);
      expect(meter.work.usage().emptySeeks).toBe(
        state === 'empty' ? 0 : state === 'missing' ? 2 : state === 'partial' ? 3 : 4,
      );
      expect(meter.settled).toEqual([meter.work.usage()]);
      if (result.state === 'complete') {
        expect(result.value).toEqual(state === 'partial' || state === 'missing' ? null : projection);
      }
      if (state === 'empty') expect(meter.work.usage()).toEqual(EMPTY_ACCESS_WORK);
      else {
        expect(meter.work.usage().bytes).toBe(
          bytes({
            at,
            pairs: pairs.map(({ realmId, accountId }) => ({
              route: routeOf(realmId),
              realm_id: realmId,
              account_id: accountId,
            })),
          }) + bytes(projection),
        );
      }
    }
  } finally {
    native.mockRestore();
  }
});

test('unknown native shapes and refused parent budgets stop before role callbacks', async () => {
  const native = spyOn(readRoles, 'run');
  const batch = spyOn(readRoleBatch, 'run');
  try {
    const role = reader();
    for (const context of [{ ...input(), at: 'infinity' }, { ...input(), realmId: 'invalid' }, input()]) {
      const meter = accounting(context.at === at && context.realmId !== 'invalid');
      let called = false;
      const result = await meter.work.capture(() =>
        accessOwnerWork(meter.work, 'Content AccessRealmRoleReader', role.work, context, () => {
          called = true;
          return role(client, context);
        }),
      );
      expect(result).toEqual({
        state: 'unavailable',
        dependency: 'Content AccessRealmRoleReader',
        usage: EMPTY_ACCESS_WORK,
      });
      expect(called).toBe(false);
    }
    const first = input();
    const pair = { realmId: first.realmId, accountId: first.accountId };
    const unsupported = [
      [pair, pair],
      Array.from({ length: MEMBERSHIP_LIMIT + 1 }, () => ({ realmId: newId(42), accountId: pair.accountId })),
      Array.from({ length: 3 }, () => ({ realmId: newId(42), accountId: newId(43) })),
    ];
    for (const pairs of unsupported) {
      const meter = accounting();
      const context = { pairs, at };
      const result = await meter.work.capture(() =>
        accessOwnerWork(meter.work, 'Content AccessRealmRoleReader.batch', role.batchWork, context, () =>
          role.batch!(client, context),
        ),
      );
      expect(result.state).toBe('unavailable');
      expect(meter.admitted).toEqual([]);
    }
    const supported = {
      at,
      pairs: [newId(43), newId(44)].flatMap((accountId) =>
        Array.from({ length: MEMBERSHIP_LIMIT }, () => ({ realmId: newId(42), accountId })),
      ),
    };
    expect(role.batchWork!.bound(supported)).toBeDefined();
    expect(native).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
    batch.mockRestore();
  }
});

test('native failures retain the entire bound and receipts cannot move between invocations', async () => {
  const native = spyOn(readRoles, 'run');
  try {
    const role = reader();
    const context = input();
    const bound = role.work!.bound(context)!;
    const meter = accounting();
    const failure = new Error('native dispatch failed');
    native.mockRejectedValueOnce(failure);
    const failed = await meter.work.capture(() =>
      accessOwnerWork(meter.work, 'Content AccessRealmRoleReader', role.work, context, () => role(client, context)),
    );
    expect(failed).toEqual({ state: 'failed', error: failure, usage: bound });
    expect(meter.settled).toEqual([bound]);
    expect(role.work!.actual(context, null)).toBeUndefined();

    native.mockResolvedValue(rows(true));
    const other = input();
    expect(role.work!.actual(other, [])).toBeUndefined();
    const result = await role(client, other);
    expect(role.work!.actual({ ...other }, result)).toBeUndefined();
    expect(role.work!.actual(other, result && [...result])).toBeUndefined();
    // A bad identity attempt consumes the observation, too.
    expect(role.work!.actual(other, result)).toBeUndefined();
    const current = input();
    const value = await role(client, current);
    expect(role.work!.actual(current, value)).toBeDefined();
    expect(role.work!.actual(current, value)).toBeUndefined();
    expect(role.work!.bound(current)).toBeUndefined();
    // An ordinary caller may still reuse its object; it gets the same behavior.
    expect(await role(client, current)).toEqual(value);
    expect(role.work!.actual(current, value)).toBeUndefined();
  } finally {
    native.mockRestore();
  }
});

test('one live window accounts each fresh native invocation without reusing a role result', async () => {
  const native = spyOn(readRoles, 'run');
  try {
    const role = reader();
    const first = input();
    const meter = accounting();
    native.mockResolvedValueOnce(rows(true)).mockResolvedValueOnce(rows(false));
    for (const context of [first, { ...first }]) {
      await accessOwnerWork(meter.work, 'Content AccessRealmRoleReader', role.work, context, () =>
        role(client, context),
      );
    }
    expect(native).toHaveBeenCalledTimes(2);
    for (const axis of ACCESS_WORK_AXES)
      expect(meter.work.usage()[axis]).toBe(meter.settled.reduce((sum, receipt) => sum + receipt[axis], 0));
    expect(meter.work.usage().rows).toBe(meter.admitted.reduce((sum, bound) => sum + bound.rows, 0));
  } finally {
    native.mockRestore();
  }
});

test('production worker lazily forwards the original native producers and callback identities', async () => {
  const factory = accessModule.createAccess;
  const membership = membershipModule.createRealmMembership;
  let config: AccessConfig | undefined;
  let nativeRole: AccessRealmRoleReader | undefined;
  const observedMembership = spyOn(membershipModule, 'createRealmMembership').mockImplementation((dependencies) => {
    const value = membership(dependencies);
    nativeRole = value.roleReader;
    return value;
  });
  const observedAccess = spyOn(accessModule, 'createAccess').mockImplementation((options) => {
    config = options;
    // A factory that inspects metadata must not touch uninitialized Access.
    expect(options.realmRoleReader?.work).toBeUndefined();
    expect(options.realmRoleReader?.batchWork).toBeUndefined();
    return factory(options);
  });
  const one = spyOn(readRoles, 'run').mockResolvedValue(rows(true));
  const batch = spyOn(readRoleBatch, 'run').mockResolvedValue([]);
  try {
    const clock = () => new Date(at);
    const access = createContentWorkAccess(clock, pool);
    expect(access).toBeDefined();
    expect(config!.clock).toBe(clock);
    expect(config!.actions.has('post:read')).toBe(true);
    expect(config!.actions.has('realm:join')).toBe(true);
    expect(observedMembership).not.toHaveBeenCalled();
    const wrapper = config!.realmRoleReader!;
    expect(wrapper.work).toBeDefined();
    expect(observedMembership).toHaveBeenCalledTimes(1);
    expect(observedMembership.mock.calls[0]![0].access).toBe(access);
    expect(wrapper.work).toBe(nativeRole!.work);
    expect(wrapper.batchWork).toBe(nativeRole!.batchWork);
    const context = input();
    wrapper.work!.bound(context);
    const value = await wrapper(client, context);
    expect(nativeRole!.work!.actual(context, value)).toBeDefined();
    const batchContext = { pairs: [], at };
    const values = await wrapper.batch!(client, batchContext);
    expect(nativeRole!.batchWork!.actual(batchContext, values)).toEqual(EMPTY_ACCESS_WORK);
    expect(batch).not.toHaveBeenCalled();
    createContentWorkAccess(clock);
    expect(config!.realmRoleReader).toBeUndefined();
    expect(observedMembership).toHaveBeenCalledTimes(1);
  } finally {
    one.mockRestore();
    batch.mockRestore();
    observedAccess.mockRestore();
    observedMembership.mockRestore();
  }
});
