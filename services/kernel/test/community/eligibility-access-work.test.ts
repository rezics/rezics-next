import { afterAll, describe, expect, test } from 'bun:test';
import { prepareAnonymousEligibility, type ResourceEligibility } from '../../src/access/eligibility.ts';
import { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, AccessWorkAccounting, type AccessWork } from '../../src/access/work.ts';
import { realmReadEligibility } from '../../src/community/realm.ts';
import { spaceReadEligibility } from '../../src/community/space.ts';
import { realmParticipationAnchor } from '../../src/community/participation.ts';
import { participationEligibilityAccessWork } from '../../src/community/eligibility-access-work.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { mintReadTime, authoritativeTimeValue, releaseOperationalTime } from '../../src/command/command.ts';
import type { Actor, Resource } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
afterAll(() => pool.end());
const anonymous: Actor = { kind: 'anonymous' };
const route = 0x1234;
const target = (): Resource => ({ route, id: newId(route) });

function accounting(refuse = false) {
  const admitted: AccessWork[] = [];
  const settled: AccessWork[] = [];
  const work = new AccessWorkAccounting(
    {
      reserve(_operation, bound, kind) {
        expect(kind).toBe('owner');
        if (refuse) return null;
        admitted.push(bound);
        return {
          settle: (actual) => {
            settled.push(actual);
          },
        };
      },
    },
    Date.now() + 10_000,
  );
  return { work, admitted, settled };
}
function sum(values: readonly AccessWork[]): AccessWork {
  return Object.fromEntries(
    ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((n, item) => n + item[axis], 0)]),
  ) as AccessWork;
}
async function prepare(
  resource: Resource,
  eligibility: ResourceEligibility,
  work: AccessWorkAccounting,
  actor = anonymous,
  action = 'realm:read',
) {
  const verify = await prepareAnonymousEligibility(
    { actor, action, resource: { ...resource, eligibility }, deadline: work.deadline },
    { pool, work, deadline: work.deadline },
  );
  return verify!;
}
async function atCurrentTime<T>(operation: (at: string) => Promise<T>): Promise<T> {
  const time = await withConnection(pool, (client) => mintReadTime(client));
  try {
    return await operation(authoritativeTimeValue(time));
  } finally {
    releaseOperationalTime(time);
  }
}

async function fixture(visibility: 'public' | 'protected' = 'public') {
  const space = target(),
    realm = target(),
    spaceHead = newId(route),
    realmHead = newId(route),
    creator = newId(route);
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
         VALUES ($1,$2,'active',$3,'2026-01-01',$4)`,
        [route, space.id, spaceHead, creator],
      );
      await client.query(
        `INSERT INTO community.space_revision(route,space_id,revision_id,title,summary,created_at,author,address)
         VALUES ($1,$2,$3,$4,$5,'2026-01-01',$6,$7)`,
        [route, space.id, spaceHead, '\u0001'.repeat(1024), '𝄞'.repeat(4096), creator, 'x'.repeat(100_000)],
      );
      await client.query(
        `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
         VALUES ($1,$2,$3,'active',$4,$5,$6,'2026-01-01',$7)`,
        [route, realm.id, space.id, visibility, newId(route), realmHead, creator],
      );
      await client.query(
        `INSERT INTO community.realm_revision(route,realm_id,revision_id,title,summary,visibility,context_id,created_at,author)
         SELECT route,realm_id,$3,$4,$5,visibility,context_id,'2026-01-01',creator
         FROM community.realm WHERE route=$1 AND realm_id=$2`,
        [route, realm.id, realmHead, '\u0001'.repeat(1024), '𝄞'.repeat(4096)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return { realm, space };
}

describe('Native Realm Space and participation eligibility callbacks admit actual bounded work', () => {
  test('public Realm dispatches binding and exact native head work on each verification in the same window', async () => {
    const { realm } = await fixture();
    const actor: Actor = {
      kind: 'account',
      accountId: newId(route),
      requestedBy: null,
      scopes: ['realm:read'],
      clientId: 'eligibility-work',
      authnEpoch: 1,
    };
    const { work, admitted, settled } = accounting();
    const verify = await prepare(realm, realmReadEligibility(realm), work, actor);
    expect(settled[0]!.rows).toBe(7);
    expect(settled[0]!.points).toBe(4); // two seeks, SQL dispatch, pool acquisition
    await atCurrentTime(async (at) => {
      for (let invocation = 0; invocation < 2; invocation++) {
        expect(await withConnection(pool, (client) => verify(client, at))).toBe(true);
        const bound = admitted.at(-1)!,
          actual = settled.at(-1)!;
        expect(bound.rows).toBe(9 + 7 + 4); // includes the possible current-actor ban
        expect(actual.rows).toBe(9 + 7); // that branch was not dispatched
        expect(actual.keys).toBe(3 + 2);
        expect(actual.bytes).toBeLessThanOrEqual(bound.bytes);
      }
    });
    expect(admitted).toHaveLength(3);
    expect(work.usage()).toEqual(sum(settled));
  });

  test('protected Realm checks both fixed accounts; false floors and ban failures retain dispatched work', async () => {
    const { realm } = await fixture('protected');
    const principal = newId(route);
    const actor: Actor = {
      kind: 'account',
      accountId: newId(route),
      requestedBy: `urn:rezics:request:${principal}:${newId(route)}`,
      scopes: ['realm:read'],
      clientId: 'eligibility-work',
      authnEpoch: 1,
    };
    const { work, admitted, settled } = accounting();
    const verify = await prepare(realm, realmReadEligibility(realm), work, actor);
    await atCurrentTime(async (at) => {
      expect(await withConnection(pool, (client) => verify(client, at))).toBe(false);
      expect(settled.at(-1)!.rows).toBe(9 + 7 + 6);
      expect(settled.at(-1)!.emptySeeks).toBe(1); // negative ban lookup still did native work
      for (const accountId of [principal, actor.accountId]) {
        await pool.query(
          `INSERT INTO community.realm_ban(route,realm_id,account_id,valid,reason,actor,transaction_id)
           VALUES ($1,$2,$3,'(,)'::tstzrange,'test',$3,$4)`,
          [route, realm.id, accountId, crypto.randomUUID()],
        );
        const attempt = accounting();
        const checked = await prepare(realm, realmReadEligibility(realm), attempt.work, actor);
        expect((await attempt.work.capture(() => withConnection(pool, (client) => checked(client, at)))).state).toBe(
          'failed',
        );
        expect(attempt.settled.at(-1)).toEqual(attempt.admitted.at(-1));
        await pool.query('DELETE FROM community.realm_ban WHERE route=$1 AND realm_id=$2 AND account_id=$3', [
          route,
          realm.id,
          accountId,
        ]);
      }
    });
    expect(settled.at(-1)!.rows).toBe(admitted.at(-1)!.rows);
    expect(work.usage()).toEqual(sum(settled));
  });

  test('Space uses a closed exact-head projection and still rejects lifecycle changes', async () => {
    const { space } = await fixture();
    const { work, admitted, settled } = accounting();
    const verify = await prepare(space, spaceReadEligibility(space), work, anonymous, 'space:read');
    await atCurrentTime(async (at) => {
      expect(await withConnection(pool, (client) => verify(client, at))).toBe(true);
      expect(settled.map((item) => item.rows)).toEqual([7, 7]);
      expect(settled.every((item, i) => item.bytes <= admitted[i]!.bytes)).toBe(true);
      await pool.query(
        'UPDATE community.space SET lifecycle_version=lifecycle_version+1 WHERE route=$1 AND space_id=$2',
        [route, space.id],
      );
      expect((await work.capture(() => withConnection(pool, (client) => verify(client, at)))).state).toBe('failed');
      expect(settled.at(-1)).toEqual(admitted.at(-1));
    });
  });

  test('participation preparation is pure and verification charges the native Realm plan even on protected floors', async () => {
    for (const visibility of ['public', 'protected'] as const) {
      const { realm } = await fixture(visibility);
      const anchor = realmParticipationAnchor(realm);
      const { work, settled } = accounting();
      const verify = await prepare(realm, anchor.resource.eligibility!, work, anonymous, 'realm:participate');
      expect(settled).toEqual([EMPTY_ACCESS_WORK]);
      await atCurrentTime(async (at) => {
        expect(await withConnection(pool, (client) => verify(client, at))).toBe(visibility === 'public');
      });
      expect(anchor.visibility()).toBe(visibility);
      expect(settled.at(-1)!.rows).toBe(9);
      expect(work.usage()).toEqual(sum(settled));
    }
  });

  test('refused and unknown work never enter the native callback; empty reads retain their full plan', async () => {
    const missing = target();
    const refused = accounting(true);
    const result = await refused.work.capture(() => prepare(missing, realmReadEligibility(missing), refused.work));
    expect(result).toMatchObject({
      state: 'unavailable',
      dependency: 'Content resource eligibility.prepare',
      usage: EMPTY_ACCESS_WORK,
    });
    expect(refused.admitted).toHaveLength(0);
    const unknown = accounting();
    expect(
      (
        await unknown.work.capture(() =>
          prepare({ route, id: 'unknown' }, realmReadEligibility({ route, id: 'unknown' }), unknown.work),
        )
      ).state,
    ).toBe('unavailable');
    expect(unknown.admitted).toHaveLength(0);
    const empty = accounting();
    await prepare(missing, realmReadEligibility(missing), empty.work);
    expect(empty.settled[0]!.rows).toBe(7);
    expect(empty.settled[0]!.emptySeeks).toBe(1);
    expect(empty.settled[0]!.bytes).toBeLessThan(empty.admitted[0]!.bytes);
    const failure = accounting();
    const verify = await prepare(missing, realmReadEligibility(missing), failure.work);
    await atCurrentTime(async (at) => {
      expect((await failure.work.capture(() => withConnection(pool, (client) => verify(client, at)))).state).toBe(
        'failed',
      );
    });
    expect(failure.settled.at(-1)).toEqual(failure.admitted.at(-1));
  });

  test('pure receipts require the exact callback context and result and cannot be consumed twice', async () => {
    const resource = target();
    const native = participationEligibilityAccessWork<Resource>(resource);
    const context = { actor: anonymous, action: 'realm:participate', resource, pool, deadline: Date.now() + 10_000 };
    const result = await native.prepare(context, async () => resource);
    expect(native.work.prepare.actual({ ...context }, result)).toBeUndefined();
    expect(native.work.prepare.actual(context, result)).toEqual(EMPTY_ACCESS_WORK);
    expect(native.work.prepare.actual(context, result)).toBeUndefined();
    const next = { ...context };
    await native.prepare(next, async () => resource);
    expect(native.work.prepare.actual(next, { ...resource })).toBeUndefined();
    expect(native.work.prepare.actual(next, result)).toBeUndefined();
  });
});
