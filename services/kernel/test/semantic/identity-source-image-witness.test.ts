import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { routeOf } from '../../src/route/route.ts';
import { currentNativeIdentitySourceImages } from '../../src/semantic/identity-epoch-bootstrap-native-source.ts';
import { cancelIdentityEpochAdmission, stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import type { IdentityJobRef } from '../../src/semantic/identity-epoch-contract.ts';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import { identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { home, release } from './support/identity-epoch.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';

type Fixture = Awaited<ReturnType<typeof createIdentityMappingFixture>>;
type Head = {
  unit: number;
  frontier: { after: (string | number | null)[] };
  change: { original: string; previousTerminal: string; terminal: string } | null;
};
type Image = {
  unit: number;
  transaction_id: string;
  frame_xid: string;
  version: number | null;
  digest: string | null;
  current: boolean;
  same_native_transaction: boolean;
  payload_retained: boolean;
  erasure_key: string;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function head(f: Fixture, job: IdentityJobRef) {
  return (await f.admin.query<Head>(
    'SELECT unit,frontier,change FROM semantic.identity_epoch_mapping_head WHERE partition_no=$1 AND job_id=$2',
    [identityJobPartition(job), job.jobId],
  )).rows[0];
}

async function beforeSource(f: Fixture, job: IdentityJobRef, original: string) {
  for (let unit = 0; unit < 512; unit++) {
    const current = await head(f, job);
    if (current?.change?.original === original && current.frontier.after[1] === 'source') return current;
    const progress = await stepIdentityEpochMapping(f.pool, job);
    if (progress.state === 'complete') throw new Error('Native mapping completed without the requested source unit');
  }
  throw new Error('Native mapping did not reach its bounded source unit');
}

async function image(f: Fixture, job: IdentityJobRef, original: string, unit: number): Promise<Image> {
  const row = (await f.admin.query<Image>(
    `SELECT e.unit,e.transaction_id::text,e.xmin::text AS frame_xid,e.source_image_version AS version,
       encode(e.source_image_digest,'hex') AS digest,
       (e.source_image_version=1 AND e.source_image_digest IS NOT NULL AND
         e.source_image_digest=semantic.identity_epoch_source_image_v1(e.partition_no,$4,e.transaction_id)) IS TRUE AS current,
       c.xmin=e.xmin AS same_native_transaction,p.unit IS NOT NULL AS payload_retained,e.erasure_key::text
     FROM semantic.identity_epoch_mapping_effect e
     JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id)
       AND c.purpose='mapping'
     LEFT JOIN semantic.identity_epoch_mapping_payload p
       ON (p.partition_no,p.job_id,p.unit)=(e.partition_no,e.job_id,e.unit)
     WHERE e.partition_no=$1 AND e.job_id=$2 AND e.unit=$3 AND e.job_epoch=$5`,
    [home(original), job.jobId, unit, original, job.epoch.toString()],
  )).rows[0];
  if (!row) throw new Error('Actual source mapping effect has no retained native frame');
  return row;
}

async function current(f: Fixture, original: string) {
  return withReadTransaction(f.pool, async (tx) => {
    const rows = (await tx.query<{
      route: number; original: string; terminal: string; source_revision: string; present: boolean;
    }>(
      `SELECT s.route,s.subject_id::text AS original,coalesce(redirect.target,s.subject_id)::text AS terminal,
         coalesce(d.revision,0)::text AS source_revision,true AS present
       FROM semantic.subject s LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.subject_id)
       LEFT JOIN LATERAL (
         SELECT target FROM semantic.redirect WHERE route=s.route AND subject_id=s.subject_id
         ORDER BY sequence DESC LIMIT 1
       ) redirect ON true
       WHERE s.route=$1 AND s.subject_id=$2`,
      [routeOf(original), original],
    )).rows;
    return (await currentNativeIdentitySourceImages(tx, home(original), rows)).has(original);
  });
}

/** Lose an actual native command before its SQL executes; retain every other driver overload and result. */
async function loseControlWrite<T>(
  f: Fixture,
  job: IdentityJobRef,
  unit: number,
  statement: 'plan' | 'head',
  operation: () => Promise<T>,
) {
  const saved = new Map<PoolClient, PoolClient['query']>();
  const lost = new Error(`Lost native mapping ${statement} command`);
  let fired = false;
  const acquire = (client: PoolClient) => {
    if (saved.has(client)) return;
    const original = client.query;
    saved.set(client, original);
    client.query = new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const input = args[0];
        const sql = typeof input === 'string' ? input : record(input) && typeof input.text === 'string' ? input.text : '';
        const values = typeof input === 'string' ? args[1] : record(input) ? input.values : undefined;
        const matches = statement === 'plan'
          ? sql.includes('INSERT INTO semantic.identity_epoch_mapping_plan(')
          : sql.includes('UPDATE semantic.identity_epoch_mapping_head SET unit=');
        if (!fired && matches && Array.isArray(values) && values[1] === job.jobId && values[2] === unit) {
          fired = true;
          return Promise.reject(lost);
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  };
  f.pool.on('acquire', acquire);
  try {
    await expect(operation()).rejects.toThrow(lost.message);
    expect(fired, 'the real native control SQL must reach the fault boundary').toBe(true);
  } finally {
    f.pool.off('acquire', acquire);
    for (const [client, query] of saved) client.query = query;
  }
}

for (const source of ['changed-redirect', 'gate-only'] as const) {
  test(`native ${source} image survives a lost acknowledgement and payload cleanup before output`, async () => {
    const f = await createIdentityMappingFixture({ poolMax: 1 });
    try {
      const admitted = await f.admitMerge();
      const original = source === 'gate-only' ? admitted.survivor : admitted.redirectedOriginals[0];
      if (!original) throw new Error('Native merge did not retain its redirected original');
      const before = await beforeSource(f, admitted.job, original);
      expect(before.change).toMatchObject({ original });
      expect(before.change?.previousTerminal === before.change?.terminal).toBe(source === 'gate-only');
      const unit = before.unit + 1;
      await loseControlWrite(f, admitted.job, unit, 'head', () => stepIdentityEpochMapping(f.pool, admitted.job));
      const committed = await image(f, admitted.job, original, unit);
      expect(committed).toMatchObject({ version: 1, current: true, same_native_transaction: true, payload_retained: true });
      expect(committed.digest).toMatch(/^[0-9a-f]{64}$/);
      expect((await head(f, admitted.job))?.unit).toBe(before.unit);
      expect(await current(f, original)).toBe(true);
      expect(await f.nativeDirectRedirect(original)).toBe(source === 'gate-only' ? null : admitted.survivor);

      await stepIdentityEpochMapping(f.pool, admitted.job);
      expect(await image(f, admitted.job, original, unit)).toEqual(committed);
      await loseControlWrite(f, admitted.job, unit + 1, 'plan', () => stepIdentityEpochMapping(f.pool, admitted.job));
      const retained = await image(f, admitted.job, original, unit);
      expect(retained).toEqual({ ...committed, payload_retained: false });
      expect(await current(f, original)).toBe(true);
      expect((await head(f, admitted.job))?.unit).toBe(unit);
      if (source === 'gate-only') expect((await head(f, admitted.job))?.frontier.after[1]).toBe('output');

      // Real later mapping units replace the gate frame. Equal terminal values cannot revive an older image.
      await f.drainMapping(admitted.job, 512);
      const advanced = await image(f, admitted.job, original, unit);
      expect(advanced.current).toBe(false);
      expect(advanced.digest).toBe(committed.digest);
      expect(advanced.transaction_id).toBe(committed.transaction_id);
      expect(advanced.frame_xid).toBe(committed.frame_xid);
      const mapped = (await f.admin.query<{ terminal: string }>(
        'SELECT terminal::text FROM semantic.identity_epoch_mapping WHERE route=$1 AND original=$2',
        [routeOf(original), original],
      )).rows[0];
      expect(mapped).toEqual({ terminal: admitted.survivor });
      if (source === 'gate-only') expect(await f.nativeDirectRedirect(original)).toBeNull();
    } finally {
      await f.close();
    }
  }, 180_000);
}

test('native cancellation and closed admission holds supply no source-image authority', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const redirected = (await f.create('Cancelled source image original', 0x7310)).id;
    const survivor = (await f.create('Cancelled source image survivor', 0x7320)).id;
    const job = await f.prepare({ kind: 'merge', redirected, survivor, release: release.digest });
    let held = false;
    for (let step = 0; step < 64; step++) {
      const rows = (await f.admin.query<{ original: string }>(
        'SELECT original::text FROM semantic.identity_epoch_admission_source_hold WHERE job_id=$1 AND job_epoch=$2 AND NOT closed',
        [job.jobId, job.epoch.toString()],
      )).rows;
      if (rows.length) {
        held = true;
        break;
      }
      expect((await stepIdentityEpochAdmission(f.pool, job)).state).toBe('preparing');
    }
    expect(held, 'cancellation must retire an actual admitted source hold').toBe(true);
    await cancelIdentityEpochAdmission(f.pool, job);
    let cancelled = false;
    for (let step = 0; step < 128; step++) {
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'cancelled') {
        cancelled = true;
        break;
      }
    }
    expect(cancelled).toBe(true);
    const holds = (await f.admin.query<{ closed: boolean }>(
      'SELECT closed FROM semantic.identity_epoch_admission_source_hold WHERE job_id=$1 AND job_epoch=$2',
      [job.jobId, job.epoch.toString()],
    )).rows;
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every(({ closed }) => closed)).toBe(true);
    expect((await f.admin.query(
      'SELECT unit FROM semantic.identity_epoch_mapping_effect WHERE job_id=$1 AND source_image_digest IS NOT NULL',
      [job.jobId],
    )).rows).toEqual([]);
    expect(await current(f, redirected)).toBe(false);
    expect(await current(f, survivor)).toBe(false);
  } finally {
    await f.close();
  }
}, 180_000);

test('account source-image provenance remains with its native effect when transient payload is cleaned', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const admitted = await f.admitAccountAgentVerify();
    const intent = admitted.source.input.intent;
    if (intent.kind !== 'merge') throw new Error('Native account verification did not retain its merge source');
    const original = intent.redirected;
    const before = await beforeSource(f, admitted.job, original);
    await stepIdentityEpochMapping(f.pool, admitted.job);
    const committed = await image(f, admitted.job, original, before.unit + 1);
    const roles = () => f.admin.query<{ account_id: string; role: string }>(
      `SELECT account_id::text,role FROM semantic.erasure_locator
       WHERE partition_no=$1 AND store='identity_epoch_mapping_effect' AND record_key=$2
       ORDER BY account_id,role`,
      [home(original), committed.erasure_key],
    );
    const provenance = (await roles()).rows;
    expect(provenance).toContainEqual({ account_id: admitted.account, role: 'subject' });
    await loseControlWrite(f, admitted.job, before.unit + 2, 'plan', () => stepIdentityEpochMapping(f.pool, admitted.job));
    expect(await image(f, admitted.job, original, before.unit + 1)).toEqual({ ...committed, payload_retained: false });
    expect((await roles()).rows).toEqual(provenance);
  } finally {
    await f.close();
  }
}, 180_000);
