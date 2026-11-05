import { afterAll, describe, expect, test } from 'bun:test';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import {
  ACCESS_WORK_AXES,
  EMPTY_ACCESS_WORK,
  AccessWorkAccounting,
  AccessWorkUnavailableError,
  accessOwnerWork,
  type AccessWork,
} from '../../src/access/work.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import { coverPreparedAccessWork, type CoverVerifyContext } from '../../src/content/cover-prepared-access-work.ts';
import { mediaEligibilityCallbacks } from '../../src/content/media-eligibility-access-work.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { accessCheck, type AccessCheck, type AccountActor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import subjectExists from '../../src/semantic/subject-exists.sql';
import mediaPoint from '../../src/content/read-download-media-work.sql';

const route = 0x1234;
const identity = { route, id: newId(route) };
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
    Date.now() + 30_000,
  );
  return { work, admitted, settled };
}
const sum = (values: readonly AccessWork[]): AccessWork =>
  Object.fromEntries(
    ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((total, value) => total + value[axis], 0)]),
  ) as AccessWork;
type Context = CoverVerifyContext & Readonly<{ evidence: null }>;
function context(work?: AccessWorkAccounting): Context {
  return {
    client: {
      query: async () => {
        throw new Error('Unexpected IO');
      },
    },
    actor: { kind: 'anonymous' },
    action: 'media:read',
    resource: identity,
    evidence: null,
    at: new Date().toISOString(),
    deadline: work?.deadline ?? Date.now() + 30_000,
    ...(work ? { work } : {}),
  };
}

test('missing native time and unadmitted preparation refuse before nested or media IO', async () => {
  const { work, admitted } = accounting();
  let called = false;
  const subject = async () => {
    called = true;
    return true;
  };
  const bridge = coverPreparedAccessWork(subject, subject, { deadline: work.deadline, work });
  const callbacks = mediaEligibilityCallbacks({
    evidence: null,
    media: { kind: 'download', ...identity, format: 'webp', width: 320 },
    cover: { ...identity, access: bridge },
    async verify() {
      called = true;
      return true;
    },
  });
  const input = context(work);
  const result = await work.capture(() =>
    accessOwnerWork(work, 'cover', callbacks.work!.verify, input, () => callbacks.verify(input)),
  );
  expect(result.state).toBe('unavailable');
  expect(result.usage).toEqual(EMPTY_ACCESS_WORK);
  expect(admitted).toHaveLength(0);
  expect(called).toBe(false);
  await expect(callbacks.verify(input)).rejects.toBeInstanceOf(AccessWorkUnavailableError());
});

test('ordinary prepared actor and anonymous calls retain their callable behavior', async () => {
  for (const shared of [true, false]) {
    const input = context();
    const calls: string[] = [];
    const subject: AccessCheck = async (client, time) => {
      expect(client).toBe(input.client);
      expect(time).toBeUndefined();
      calls.push('actor');
      return true;
    };
    const anonymous: AccessCheck = async () => {
      calls.push('anonymous');
      return false;
    };
    const publicSubject = shared ? subject : anonymous;
    const bridge = coverPreparedAccessWork(subject, publicSubject, { deadline: input.deadline });
    const callbacks = mediaEligibilityCallbacks({
      evidence: null,
      cover: { ...identity, access: bridge },
      media: { kind: 'download', ...identity, format: 'webp', width: 320 },
      async verify(_input, reads) {
        await reads.media(async (bounded) => {
          expect(bounded).toBe(false);
          return null;
        });
        await reads.subject(async (bounded) => {
          expect(bounded).toBe(false);
          return { found: 1 };
        });
        if (!(await reads.prepared(subject))) return false;
        return publicSubject === subject || reads.prepared(publicSubject);
      },
    });
    expect(await callbacks.verify(input)).toBe(shared);
    expect(calls).toEqual(shared ? ['actor'] : ['actor', 'anonymous']);
  }
});

// Native cases are deferred to the original acceptance command. They use the
// original Access producer and genuine database T, never a structural run stub.
describe.skipIf(!process.env.DATABASE_URL)('cover nested prepared native Access', () => {
  const pool = createPool(process.env.DATABASE_URL!);
  afterAll(() => pool.end());

  async function fixture() {
    const subject = { route, id: newId(route) };
    const media = { route, id: newId(route) };
    const accountId = newId(route);
    await pool.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id)
      VALUES ($1,$2,'schema:Book',$2)`,
      [route, subject.id],
    );
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','active',$2)`,
      [route, accountId],
    );
    const account = await readAccount(pool, route, accountId);
    if (!account) throw new Error('Missing native account');
    const actor: AccountActor = {
      kind: 'account',
      accountId,
      clientId: 'cover-native',
      scopes: ['subject:read', 'media:read'],
      requestedBy: null,
      authnEpoch: 1,
    };
    const credit = {
      rightsHolder: 'Artist',
      via: { name: 'Catalogue', url: 'https://example.test/record' },
      license: 'LicenseRef-unknown',
      obligations: [],
    };
    const provenance = {
      source: 'example',
      external_id: 'record',
      field_group: 'cover',
      references: [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test' } }] },
      ],
    };
    await pool.query(
      `INSERT INTO content.media
      (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
       actual_byte_count,sha256,state,key,transaction_id,source_url,credit,provenance,
       width,height,thumbhash,average_color)
      VALUES ($1,$2::uuid,$3,$4,$2::uuid::text,'cover','image/jpeg',256,256,$5,'available',
        'm/'||$2::uuid::text||'/original',$2::uuid,'https://example.test/image',$6,$7,
        320,480,decode('AQID','base64'),'#5a4632')`,
      [route, media.id, subject.id, accountId, 'a'.repeat(64), credit, provenance],
    );
    await pool.query(
      `INSERT INTO content.media_variant
      (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
      VALUES ($1,$2,'webp',320,480,'image/webp',128,$3,'m/'||$2::uuid::text||'/webp-320',$2)`,
      [route, media.id, 'b'.repeat(64)],
    );
    const access = createAccess({
      actions: new Map([
        ['subject:read', { anonymous: true }],
        ['media:read', { anonymous: true }],
      ]),
      accountEvidence: (input) => (input === actor ? account : null),
    });
    return { subject, media, actor, access };
  }

  test('Cover eligibility composes the real prepared subject and anonymous Access work bridge at genuine native time with once-only existing ledger accounting', async () => {
    const f = await fixture();
    for (const shared of [true, false]) {
      const { work, admitted, settled } = accounting();
      const time = await withConnection(pool, (client) => mintReadTime(client));
      try {
        const preparation = { pool, time, work, deadline: work.deadline };
        const resource = { ...f.subject, eligibility: subjectReadEligibility(f.subject) };
        const subject = await accessCheck(
          f.access,
          shared ? { kind: 'anonymous' } : f.actor,
          'subject:read',
          resource,
          preparation,
        );
        const anonymous = shared
          ? subject
          : await accessCheck(f.access, { kind: 'anonymous' }, 'subject:read', resource, preparation);
        const bridge = coverPreparedAccessWork(subject, anonymous, preparation);
        const before = admitted.length;
        await withConnection(pool, async (client) => {
          const input: Context = {
            ...context(work),
            resource: f.media,
            client,
            time,
            at: authoritativeTimeValue(time),
          };
          const parameters = {
            route,
            media_id: f.media.id,
            format: 'webp',
            width: 320,
            credit_bytes: 8192,
            provenance_bytes: 65536,
          };
          type Row = NonNullable<Awaited<ReturnType<typeof mediaPoint.run>>>;
          const callbacks = mediaEligibilityCallbacks({
            evidence: null,
            media: { kind: 'download', ...f.media, format: 'webp', width: 320 },
            cover: { ...f.subject, access: bridge },
            async verify(_input, reads) {
              const current = await reads.media(async (bounded) => {
                expect(bounded).toBe(true);
                return (
                  (
                    await client.query<Row>(
                      mediaPoint.sql,
                      mediaPoint.params.map((key) => parameters[key as keyof typeof parameters]),
                    )
                  ).rows[0] ?? null
                );
              });
              expect(current?.container_id).toBe(f.subject.id);
              const exists = await reads.subject(
                async () =>
                  (
                    await client.query<{ found: number }>(
                      subjectExists.sql,
                      subjectExists.params.map((key) => ({ route, subject_id: f.subject.id })[key]),
                    )
                  ).rows[0] ?? null,
              );
              if (!exists || !(await reads.prepared(subject))) return false;
              // Calling the same check again must reuse its exact invocation.
              expect(await reads.prepared(subject)).toBe(true);
              return reads.prepared(anonymous);
            },
          });
          const result = await work.capture(() =>
            accessOwnerWork(work, 'cover', callbacks.work!.verify, input, () => callbacks.verify(input)),
          );
          expect(result.state).toBe('complete');
          if (result.state !== 'complete') throw new Error('Native cover composition failed');
          expect(result.value).toBe(true);
          expect(admitted.slice(before).map((item) => item.operation)).toEqual(['cover']);
          // A full native subject formula/owner footprint, not just its point read.
          expect(admitted[before]!.bound.rows).toBeGreaterThan(8);
          expect(result.usage).toEqual(sum(settled));
          expect(callbacks.work!.verify.actual(input, true)).toBeUndefined();
          expect(bridge.actual({ ...input })).toBeUndefined();
        });
      } finally {
        releaseOperationalTime(time);
      }
    }
  });

  test('false native decisions settle dispatched work while failed receipts retain the full admission', async () => {
    for (const missingReceipt of [false, true]) {
      const f = await fixture();
      const { work, admitted, settled } = accounting();
      const time = await withConnection(pool, (client) => mintReadTime(client));
      try {
        const preparation = { pool, time, work, deadline: work.deadline };
        const subject = await accessCheck(
          f.access,
          { kind: 'anonymous' },
          'subject:read',
          { ...f.subject, eligibility: subjectReadEligibility(f.subject) },
          preparation,
        );
        // Change the live source after preparation: the actual Semantic verifier
        // must produce false, with its dispatched native point still accounted.
        await pool.query(
          "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
          [route, f.subject.id],
        );
        const bridge = coverPreparedAccessWork(subject, subject, preparation);
        await withConnection(pool, async (client) => {
          const input = { ...context(work), client, time, at: authoritativeTimeValue(time) };
          const before = admitted.length;
          const producer = {
            bound: bridge.bound,
            actual: (input: CoverVerifyContext, _result: boolean) =>
              missingReceipt ? undefined : bridge.actual(input),
          };
          const result = await work.capture(() =>
            accessOwnerWork(work, 'cover', producer, input, () => bridge.run(input, subject)),
          );
          expect(result.state).toBe(missingReceipt ? 'unavailable' : 'complete');
          expect(admitted.slice(before)).toHaveLength(1);
          expect(work.usage()).toEqual(sum(settled));
          if (result.state === 'complete') {
            expect(result.value).toBe(false);
            expect(settled.at(-1)!.rows).toBeGreaterThanOrEqual(1);
          } else {
            expect(settled.at(-1)).toEqual(admitted.at(-1)!.bound);
          }
        });
      } finally {
        releaseOperationalTime(time);
      }
    }
  });

  test('unknown producers and unadmitted earlier native preparation refuse before IO on the held target', async () => {
    const f = await fixture();
    const time = await withConnection(pool, (client) => mintReadTime(client));
    try {
      const { work } = accounting();
      const preparation = { pool, time, work, deadline: work.deadline };
      const unadmitted = await accessCheck(
        f.access,
        { kind: 'anonymous' },
        'subject:read',
        { ...f.subject, eligibility: subjectReadEligibility(f.subject) },
        { pool, deadline: work.deadline },
      );
      let called = false;
      const bare = async () => {
        called = true;
        return true;
      };
      const runOnly = Object.assign(bare, { work: { run: bare } });
      const unknown = Object.assign(
        async () => {
          called = true;
          return true;
        },
        {
          work: { bound: () => undefined, run: bare, actual: () => undefined },
        },
      );
      await withConnection(pool, async (client) => {
        const input = { ...context(work), resource: f.media, client, time, at: authoritativeTimeValue(time) };
        for (const check of [
          async () => {
            called = true;
            return true;
          },
          runOnly,
          unknown,
          unadmitted,
        ]) {
          const bridge = coverPreparedAccessWork(check, check, preparation);
          expect(bridge.bound(input)).toBeUndefined();
          await expect(bridge.run(input, check)).rejects.toBeInstanceOf(AccessWorkUnavailableError());
        }
        expect(called).toBe(false);
      });
    } finally {
      releaseOperationalTime(time);
    }
  });
});
