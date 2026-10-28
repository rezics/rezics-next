import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../../src/database/pool.ts';
import { accessCommandAuthorization } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createSubject } from '../../../src/semantic/subject.ts';
import { mergeSubjects } from '../../../src/semantic/merges.ts';
import type { IdentityEpochStore, IdentityEpochStep } from '../../../src/semantic/identity-epoch-contract.ts';
import { createRealAccess } from '../real-access.ts';

export const release = { digest: bundledDigest, release: bundledRelease };
export const globalResource = { route: 0, id: GLOBAL_CONTEXT };
export const digest = (key: string) => createHash('sha256').update(key).digest();

export async function epochFixture() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = createPool(url);
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  const accounts = { editor: newId(0x5c10), outsider: newId(0x5c20) };
  const actions = ['subject:create', 'subject:merge', 'subject:read', 'follow:create', 'follow:delete'];
  const real = await createRealAccess(admin, accounts, actions);
  const access = real.access({
    actions: new Map(actions.map((action) => [action, { anonymous: action === 'subject:read' }])),
  });
  await bootstrapRelease(pool, bundledRelease);
  for (const action of ['subject:create', 'subject:merge']) await real.grant(globalResource, 'editor', action);
  async function actor(persona: keyof typeof accounts = 'editor') {
    return access.authenticate(real.bearer(persona), { pool, deadline: Date.now() + 5000 });
  }
  async function authorization(action: string, persona: keyof typeof accounts = 'editor') {
    return accessCommandAuthorization(
      access,
      await actor(persona),
      action,
      globalResource,
      { pool, deadline: Date.now() + 5000 },
      () => new Error(`Denied ${action}`),
    );
  }
  async function create(label = 'Duplicate catalogue record', route = 0x5d10) {
    const key = randomUUID();
    return createSubject(pool, {
      actor: await actor(),
      target: { route, id: newId(route) },
      item: { type: 'schema:Person', labels: { en: label } },
      idempotencyKey: key,
      digest: digest(key),
      release,
      authorization: await authorization('subject:create'),
    });
  }
  async function merge(
    redirected: string,
    survivor: string,
    key = randomUUID(),
    persona: keyof typeof accounts = 'editor',
  ) {
    return mergeSubjects(pool, {
      subjects: [redirected, survivor],
      survivor,
      actor: await actor(persona),
      idempotencyKey: key,
      digest: digest(key),
      release,
      authorization: await authorization('subject:merge', persona),
    });
  }
  async function snapshot(ids: string[]) {
    const result = await admin.query(
      `SELECT
      md5(coalesce((SELECT jsonb_agg(s ORDER BY s.subject_id) FROM semantic.subject s WHERE subject_id=ANY($1::uuid[]))::text,'null')) subjects,
      md5(coalesce((SELECT jsonb_agg(r ORDER BY r.subject_id,r.revision) FROM semantic.revision r WHERE subject_id=ANY($1::uuid[]))::text,'null')) revisions,
      md5(coalesce((SELECT jsonb_agg(r ORDER BY r.subject_id,r.sequence) FROM semantic.redirect r WHERE subject_id=ANY($1::uuid[]))::text,'null')) redirects,
      md5(coalesce((SELECT jsonb_agg(m ORDER BY m.subject_id,m.member_id) FROM semantic.merge_member m
       WHERE subject_id=ANY($1::uuid[]) OR member_id=ANY($1::uuid[]))::text,'null')) members,
      (SELECT count(*)::text FROM core.receipt) receipts,
      (SELECT count(*)::text FROM core.outbox) outbox`,
      [ids],
    );
    return result.rows[0];
  }
  return {
    pool,
    admin,
    accounts,
    real,
    access,
    actor,
    authorization,
    create,
    merge,
    snapshot,
    async close() {
      await pool.end();
      await admin.end();
    },
  };
}
export type EpochFixture = Awaited<ReturnType<typeof epochFixture>>;

/** Native migrated legacy population for admission/bootstrap, not a completion certificate.
 * Roots are actual createSubject results. All members, revision history and direct redirects exist.
 * The STORE owner must cover this population during its real bootstrap before permitting admission.
 */
export async function seedLegacyGroup(f: EpochFixture, root: string, members: number) {
  const ids = Array.from({ length: members }, () => newId(routeOf(root)!)).sort();
  const route = routeOf(root)!;
  const tx = await f.admin.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      `INSERT INTO semantic.subject
      (route,subject_id,type,recorded_transaction_id,current_facts,current_release)
      SELECT $1,id,'schema:Person',$3,0,$4 FROM unnest($2::uuid[]) id`,
      [route, ids, randomUUID(), bundledDigest],
    );
    await tx.query(
      `INSERT INTO semantic.revision
      (route,subject_id,revision,kind,release,recorded_transaction_id)
      SELECT $1,id,v.revision,v.kind,$3,$4 FROM unnest($2::uuid[]) id
      CROSS JOIN (VALUES (1,'create'),(2,'merge')) v(revision,kind)`,
      [route, ids, bundledDigest, randomUUID()],
    );
    await tx.query(
      `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
      SELECT $1,id,1,$3,$4 FROM unnest($2::uuid[]) id`,
      [route, ids, root, randomUUID()],
    );
    await tx.query(
      `INSERT INTO semantic.merge_member(route,subject_id,member_id,phase,cursor)
      SELECT $1,$3,id,'done','[]'::jsonb FROM unnest($2::uuid[]) id`,
      [route, ids, root],
    );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  expect(ids.length + 1).toBe(members + 1);
  return ids;
}

/** Load the real future producer only. No fake adapter, default metadata or old identity ABI. */
export async function nativeEpochStore(): Promise<IdentityEpochStore> {
  const path = new URL('../../../src/semantic/identity-epoch-store.ts', import.meta.url);
  expect(await Bun.file(path).exists(), 'MISSING semantic/identity-epoch-store.ts: native epoch STORE producer').toBe(
    true,
  );
  const module = await import(path.href);
  expect(module.identityEpochStore).toBeDefined();
  return module.identityEpochStore as IdentityEpochStore;
}
export async function nativeMappingStep(): Promise<IdentityEpochStep> {
  const path = new URL('../../../src/semantic/identity-epoch-mapping.ts', import.meta.url);
  expect(
    await Bun.file(path).exists(),
    'MISSING semantic/identity-epoch-mapping.ts: bounded native mapping producer',
  ).toBe(true);
  const module = await import(path.href);
  expect(module.stepIdentityEpochMapping).toBeFunction();
  return module.stepIdentityEpochMapping as IdentityEpochStep;
}
export const home = (id: string) => partitionOf(routeOf(id)!);
