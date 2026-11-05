import { afterAll, describe, expect, test } from 'bun:test';
import {
  AccessWorkAccounting,
  EMPTY_ACCESS_WORK,
  addAccessWork,
  accessNativeDeclaration,
  accessNativeWork,
  accessOwnerWork,
  type AccessWork,
} from '../../src/work/access-work.ts';
import { createAccess } from '../../src/access/index.ts';
import {
  createResourcePublicEligibility,
  type ResourceEligibilityVerifyContext,
} from '../../src/access/eligibility.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import {
  accessCheck,
  type Access,
  type AccessCheck,
  type PreparedAccessCheckInvocation,
} from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { globalReadEligibility, subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

function accounting(refuse = false) {
  const admitted: { operation: string; bound: AccessWork }[] = [];
  const settled: AccessWork[] = [];
  const work = new AccessWorkAccounting(
    {
      reserve(operation, bound) {
        if (refuse) return null;
        admitted.push({ operation, bound });
        return {
          settle(actual) {
            settled.push(actual);
          },
        };
      },
    },
    Date.now() + 10_000,
  );
  return { work, admitted, settled };
}
const input = { native: 'exact point' };
const declaration = accessNativeDeclaration('account-state', input, { targets: 1 });
const point = (work: AccessWorkAccounting) =>
  accessNativeWork(work, 'account-state', input, { targets: 1 }, async () => []);

// These are accounting tests, not native authorization proof.
test('nested frames settle the existing sink once and retain dispatched native rows', async () => {
  const { work, admitted, settled } = accounting();
  const actual = declaration.actual([]);
  const result = await work.capture(() =>
    accessOwnerWork(
      work,
      'parent',
      {
        bound: () => declaration.bound,
        actual: () => actual,
      },
      {},
      () => work.invocation('nested', declaration.bound, () => point(work)),
    ),
  );
  expect(result).toMatchObject({ state: 'complete', usage: actual });
  expect(admitted).toEqual([{ operation: 'parent', bound: declaration.bound }]);
  expect(settled).toEqual([actual]);
  expect(work.usage().rows).toBe(declaration.bound.rows);
});

test('a frame refuses excess child work before IO and burns its admitted envelope', async () => {
  const { work, admitted, settled } = accounting();
  let dispatched = false;
  const result = await work.capture(() =>
    work.invocation('small parent', EMPTY_ACCESS_WORK, () =>
      accessNativeWork(work, 'account-state', input, { targets: 1 }, async () => {
        dispatched = true;
        return [];
      }),
    ),
  );
  expect(result).toMatchObject({ state: 'unavailable', usage: EMPTY_ACCESS_WORK });
  expect(dispatched).toBe(false);
  expect(admitted).toHaveLength(1);
  expect(settled).toEqual([EMPTY_ACCESS_WORK]);
});

test('parallel invocation receipts contain only their admitted child statements', async () => {
  const { work, admitted, settled } = accounting();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = work.invocation('first', declaration.bound, async () => {
    await wait;
    return point(work);
  });
  const second = await work.invocation('second', addAccessWork(declaration.bound, declaration.bound), async () => {
    await point(work);
    return point(work);
  });
  release();
  const firstResult = await first;
  expect(firstResult.usage).toEqual(declaration.actual([]));
  expect(second.usage).toEqual(addAccessWork(declaration.actual([]), declaration.actual([])));
  expect(admitted.map(({ operation }) => operation)).toEqual(['first', 'second']);
  expect(work.usage()).toEqual(addAccessWork(...settled));
});

test('missing and underreported owner receipts burn the full parent and poison reuse', async () => {
  for (const receipt of [undefined, EMPTY_ACCESS_WORK]) {
    const { work, settled } = accounting();
    const result = await work.capture(() =>
      accessOwnerWork(
        work,
        'parent',
        {
          bound: () => declaration.bound,
          actual: () => receipt,
        },
        {},
        () => point(work),
      ),
    );
    expect(result.state).not.toBe('complete');
    expect(result.usage).toEqual(declaration.bound);
    expect(settled).toEqual([declaration.bound]);
    let dispatched = false;
    await work.capture(() =>
      work.invocation('again', declaration.bound, async () => {
        dispatched = true;
      }),
    );
    expect(dispatched).toBe(false);
  }
});

test('a failed in-flight parent seals children once and forbids late dispatch', async () => {
  const { work, settled } = accounting();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dispatched = false;
  const pending = work.invocation('parent', declaration.bound, async () => {
    await wait;
    return accessNativeWork(work, 'account-state', input, { targets: 1 }, async () => {
      dispatched = true;
      return [];
    });
  });
  const error = new Error('attempt expired');
  work.fail(error);
  release();
  await expect(pending).rejects.toBe(error);
  expect(dispatched).toBe(false);
  expect(settled).toEqual([declaration.bound]);
});

test('manual and foreign checks keep the ordinary callable API without native work', async () => {
  const manual: AccessCheck = async () => true;
  expect(manual.work).toBeUndefined();
  const foreign: Access = {
    authenticate: async () => {
      throw new Error('unused');
    },
    authorize: (client) => manual(client),
  };
  // The foreign fixture never touches its pool.
  const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused');
  try {
    const check = await accessCheck(
      foreign,
      { kind: 'anonymous' },
      'subject:read',
      { route: 0, id: GLOBAL_CONTEXT },
      { pool, deadline: Date.now() + 1000 },
    );
    expect(check.work).toBeUndefined();
    expect(await check(pool)).toBe(true);
  } finally {
    await pool.end();
  }
});

describe.skipIf(!process.env.DATABASE_URL)('prepared native Access work at shared time', () => {
  // The original pool guard rejects a nested checkout while the target is held.
  const pool = createPool(process.env.DATABASE_URL!);
  afterAll(() => pool.end());
  const anonymous = { kind: 'anonymous' } as const;
  const action = 'subject:read';
  const access = createAccess({ actions: new Map([[action, { anonymous: true }]]) });

  async function fixture() {
    const resource = { route: 0x1234, id: newId(0x1234) };
    await pool.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id)
      VALUES ($1,$2,'schema:Book',$3)`,
      [resource.route, resource.id, newId(resource.route)],
    );
    return { ...resource, eligibility: subjectReadEligibility(resource) };
  }

  test('A nested prepared native Access check reserves its full existing formula and owner IO footprint before dispatch and returns exact invocation work at genuine shared native T without double charging the existing ledger', async () => {
    const target = await fixture();
    const { work, admitted, settled } = accounting();
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const context = { pool, work, time, deadline: work.deadline };
      const subject = await accessCheck(access, anonymous, action, target, context);
      const global = await accessCheck(
        access,
        anonymous,
        action,
        { route: 0, id: GLOBAL_CONTEXT, eligibility: globalReadEligibility(action) },
        context,
      );
      if (!subject.work || !global.work) throw new Error('Missing native prepared producer');
      const subjectWork = subject.work,
        globalWork = global.work;
      const before = admitted.length;
      const preparationUsage = work.usage();
      const preparationSettled = settled.length;
      await withConnection(pool, async (client) => {
        const subjectInput = { client, time, work };
        const globalInput = { client, time, work };
        const subjectBound = subjectWork.bound(subjectInput),
          globalBound = globalWork.bound(globalInput);
        if (!subjectBound || !globalBound) throw new Error('Native preparation is unsupported');
        // Pure declarations dispatch neither owner points nor the native formula.
        expect(admitted).toHaveLength(before);
        const completeBound = addAccessWork(subjectBound, globalBound);
        let exact: AccessWork | undefined;
        const result = await accessOwnerWork(
          work,
          'cover owner',
          {
            bound: () => completeBound,
            actual: () => exact,
          },
          {},
          async () => {
            expect(admitted.slice(before)).toEqual([{ operation: 'cover owner', bound: completeBound }]);
            expect(work.usage()).toEqual(addAccessWork(preparationUsage, completeBound));
            const allowed = await subjectWork.run(subjectInput);
            const publicAllowed = await globalWork.run(globalInput);
            const subjectActual = subjectWork.actual(subjectInput, allowed);
            const globalActual = globalWork.actual(globalInput, publicAllowed);
            if (!subjectActual || !globalActual) throw new Error('Missing native invocation receipt');
            exact = addAccessWork(subjectActual, globalActual);
            expect(subjectActual.rows).toBe(subjectBound.rows);
            expect(globalActual.rows).toBe(globalBound.rows);
            expect(subjectActual.points).toBeGreaterThan(0);
            expect(subjectWork.actual({ ...subjectInput }, allowed)).toBeUndefined();
            expect(subjectWork.actual(subjectInput, allowed)).toBeUndefined();
            return allowed && publicAllowed;
          },
        );
        expect(result).toBe(true);
        expect(settled.slice(preparationSettled)).toEqual([exact!]);
        expect(work.usage()).toEqual(addAccessWork(preparationUsage, exact!));
        expect(work.usage()).toEqual(addAccessWork(...settled));
      });
    } finally {
      releaseOperationalTime(time);
    }
  });

  test('live verification propagates the same native time and accounting through preparation and verification', async () => {
    const { work } = accounting();
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const resource = { route: 0x1234, id: newId(0x1234) };
      let preparation = false,
        verification = false;
      const target = {
        ...resource,
        eligibility: createResourcePublicEligibility({
          resource,
          action,
          work: {
            prepare: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
            verify: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
          },
          async prepare(context) {
            expect(context.time).toBe(time);
            expect(context.work).toBe(work);
            preparation = true;
            return { revision: 'same original evidence' };
          },
          async verify(context) {
            expect(context.time).toBe(time);
            expect(context.work).toBe(work);
            expect(context.at).toBe(authoritativeTimeValue(time));
            expect(context.evidence).toEqual({ revision: 'same original evidence' });
            verification = true;
            return true;
          },
        }),
      };
      const check = await accessCheck(access, anonymous, action, target, { pool, work, time, deadline: work.deadline });
      if (!check.work) throw new Error('Missing native producer');
      await withConnection(pool, (client) => check.work!.run({ client, time, work }));
      expect(preparation && verification).toBe(true);
    } finally {
      releaseOperationalTime(time);
    }
  });

  test('a changed subject revision denies and still charges its dispatched owner point', async () => {
    const target = await fixture();
    const { work, settled } = accounting();
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const check = await accessCheck(access, anonymous, action, target, { pool, work, time, deadline: work.deadline });
      if (!check.work) throw new Error('Missing native producer');
      const producer = check.work;
      await pool.query(
        'UPDATE semantic.subject SET security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2',
        [target.route, target.id],
      );
      await withConnection(pool, async (client) => {
        const invocation = { client, time, work };
        expect(await producer.run(invocation)).toBe(false);
        const actual = producer.actual(invocation, false);
        expect(actual?.keys).toBe(1);
        expect(actual?.rows).toBe(1);
        expect(actual?.points).toBe(1);
        expect(actual?.bytes).toBeGreaterThan(0);
      });
      expect(work.usage()).toEqual(addAccessWork(...settled));
    } finally {
      releaseOperationalTime(time);
    }
  });

  test('unmetered preparation, a different accounting or native time, and a released native time remain unsupported', async () => {
    const target = await fixture();
    const { work } = accounting();
    const time = await withConnection(pool, (client) => mintReadTime(client));
    const otherTime = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const ordinary = await accessCheck(access, anonymous, action, target, { pool, time, deadline: work.deadline });
      expect(ordinary.work).toBeUndefined();
      const check = await accessCheck(access, anonymous, action, target, { pool, work, time, deadline: work.deadline });
      if (!check.work) throw new Error('Missing native producer');
      expect(check.work.bound({ client: pool, time: otherTime, work })).toBeUndefined();
      expect(check.work.bound({ client: pool, time, work: accounting().work })).toBeUndefined();
      releaseOperationalTime(time);
      expect(check.work.bound({ client: pool, time, work })).toBeUndefined();
    } finally {
      releaseOperationalTime(time);
      releaseOperationalTime(otherTime);
    }
  });

  test('an unsupported nested owner refuses before its verify callback', async () => {
    const { work } = accounting();
    const time = await withConnection(pool, (client) => mintReadTime(client));
    let dispatched = false;
    try {
      const resource = { route: 0x1234, id: newId(0x1234) };
      const eligibility = createResourcePublicEligibility({
        resource,
        action,
        work: {
          prepare: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
          verify: { bound: (_: ResourceEligibilityVerifyContext<boolean>) => undefined, actual: () => undefined },
        },
        prepare: async () => true,
        verify: async () => {
          dispatched = true;
          return true;
        },
      });
      const check = await accessCheck(
        access,
        anonymous,
        action,
        { ...resource, eligibility },
        { pool, work, time, deadline: work.deadline },
      );
      if (!check.work) throw new Error('Missing prepared evidence');
      const invocation: PreparedAccessCheckInvocation = { client: pool, time, work };
      expect(check.work.bound(invocation)).toBeUndefined();
      expect(await work.capture(() => check.work!.run(invocation))).toMatchObject({ state: 'unavailable' });
      expect(dispatched).toBe(false);
    } finally {
      releaseOperationalTime(time);
    }
  });
});
