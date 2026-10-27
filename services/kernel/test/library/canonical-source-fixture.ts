import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { mintReadTime } from '../../src/command/command.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import * as store from '../../src/library/canonical-source-store.ts';
import type {
  CanonicalAllowance,
  CanonicalWork,
  CanonicalRepair,
  CanonicalBasis,
  CanonicalGroupProgress,
  CanonicalSourceAfter,
} from '../../src/library/canonical-source-store.ts';
import type { ListingStamp } from '../../src/library/listing-freshness-contract.ts';
import { accessCheck, accessCommandAuthorization, type Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { moderateSubject } from '../../src/semantic/moderation.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import readSubjectStatement from '../../src/semantic/read-subject.sql';
import { createRealAccess } from '../semantic/real-access.ts';
import type { GrowthDatabase } from '../support/growth.ts';
import type { DynamicCollectionsDriver } from '../../../../specs/dynamic-collections-driver.ts';

export const NIL = '00000000-0000-0000-0000-000000000000';
export const deadline = () => Date.now() + 30_000;
export const resource = (id: string) => ({ route: routeOf(id)!, id });
export function allowance(rawKeys = 100): CanonicalAllowance {
  return {
    reservationId: randomUUID(),
    rawKeys,
    nativePoints: 8192 * 4 + 400,
    emptySeeks: 100,
    statements: 8192 * 8 + 800,
    bytes: 16 * 1024 * 1024,
    identityMetadataRows: 8192 * 4,
  };
}
export function ownerAllowance(rawKeys = 100) {
  return {
    reservationId: randomUUID(),
    remaining: {
      candidateKeys: rawKeys,
      identityMetadataRows: 8192 * 4,
      emptySeeks: 100,
      nativePoints: 8192 * 4 + 400,
      witnessKeys: 400,
      statements: 8192 * 8 + 800,
      bytes: 16 * 1024 * 1024,
    },
  };
}
type OwnerWork = { reservationId: string; used: ReturnType<typeof ownerAllowance>['remaining'] };
function ownerReceipt(work: OwnerWork, reserved: ReturnType<typeof ownerAllowance>) {
  expect(work.reservationId).toBe(reserved.reservationId);
  for (const dimension of Object.keys(reserved.remaining) as (keyof OwnerWork['used'])[]) {
    expect(Number.isSafeInteger(work.used[dimension])).toBe(true);
    expect(work.used[dimension]).toBeGreaterThanOrEqual(0);
    expect(work.used[dimension]).toBeLessThanOrEqual(reserved.remaining[dimension]);
  }
  expect(work.used.candidateKeys).toBeLessThanOrEqual(100);
}
export function charged(work: CanonicalWork) {
  return work.candidateKeys + work.aliasKeys + work.duplicateKeys + work.lookaheadKeys + work.internalDriverKeys;
}
export function receipt(work: CanonicalWork, reserved: CanonicalAllowance) {
  expect(work.reservationId).toBe(reserved.reservationId);
  for (const value of Object.values(work).filter((value) => typeof value === 'number')) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(charged(work)).toBeLessThanOrEqual(reserved.rawKeys);
  for (const dimension of ['nativePoints', 'emptySeeks', 'statements', 'bytes', 'identityMetadataRows'] as const)
    expect(work[dimension]).toBeLessThanOrEqual(reserved[dimension]);
}

/** Prospective DDL, NOT executed by these tests and NOT a production migration. */
export const schemaExpectation = `
ALTER TABLE library.collection ADD COLUMN source_generation bigint NOT NULL DEFAULT 0;
CREATE TABLE library.canonical_source_state (
  route integer NOT NULL, collection_id uuid NOT NULL,
  ready_generation uuid, ready_basis text,
  working_generation uuid, working_basis text,
  after_subject_id uuid, after_driver text COLLATE "C", after_fact_id uuid,
  source_exhausted boolean NOT NULL DEFAULT false,
  pending_mapping boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, collection_id),
  FOREIGN KEY (route, collection_id) REFERENCES library.collection(route,collection_id) ON DELETE CASCADE,
  CHECK ((ready_generation IS NULL) = (ready_basis IS NULL)),
  CHECK ((working_generation IS NULL) = (working_basis IS NULL)),
  CHECK ((after_subject_id IS NULL) = (after_fact_id IS NULL)),
  CHECK ((after_subject_id IS NULL) = (after_driver IS NULL))
);
CREATE TABLE library.canonical_source_fact (
  route integer NOT NULL, collection_id uuid NOT NULL, generation uuid NOT NULL,
  basis_digest text NOT NULL, canonical_subject_id uuid NOT NULL,
  stored_subject_id uuid NOT NULL, driver text COLLATE "C" NOT NULL, fact_id uuid NOT NULL,
  FOREIGN KEY (route, collection_id) REFERENCES library.collection(route,collection_id) ON DELETE CASCADE,
  PRIMARY KEY (route, collection_id, generation, basis_digest,
               canonical_subject_id, stored_subject_id, driver, fact_id)
);
CREATE INDEX collection_member_canonical_repair ON library.collection_member
  (route, collection_id, subject_id, member_id);
`;

/** Native source fence must be held while checkpoint or publication commits; deleted rows never admit a build. */
export const sourceFenceSQL = `SELECT source_generation, state, visibility FROM library.collection
WHERE route=$1 AND collection_id=$2 FOR UPDATE`;
/** Same transaction as derived-row inserts, after locking source and matching actual source/identity basis. */
export const checkpointSQL = `UPDATE library.canonical_source_state
SET after_subject_id=$8, after_driver=$9, after_fact_id=$10, source_exhausted=$11, pending_mapping=$12
WHERE route=$1 AND collection_id=$2 AND working_generation=$3 AND working_basis=$4
  AND ROW(after_subject_id,after_driver,after_fact_id) IS NOT DISTINCT FROM ROW($5::uuid,$6::text,$7::uuid)
RETURNING after_subject_id,after_driver,after_fact_id`;

/** $1..$4 are equality prefix; no residual, dedup, aggregate, OFFSET or optional-key OR ahead of LIMIT. */
export const candidateSQL = `SELECT canonical_subject_id
FROM library.canonical_source_fact
WHERE route=$1 AND collection_id=$2 AND generation=$3 AND basis_digest=$4
  AND canonical_subject_id > $5::uuid
ORDER BY canonical_subject_id, stored_subject_id, driver, fact_id LIMIT 1`;
export const groupSQL = `SELECT canonical_subject_id, stored_subject_id, driver, fact_id
FROM library.canonical_source_fact
WHERE route=$1 AND collection_id=$2 AND generation=$3 AND basis_digest=$4 AND canonical_subject_id=$5
  AND (stored_subject_id, driver, fact_id) > ($6::uuid, $7::text COLLATE "C", $8::uuid)
ORDER BY stored_subject_id, driver, fact_id LIMIT $9`;
/** Raw source limit before pending mapping/residual evaluation. Checkpoint advances for EVERY returned raw key. */
export const repairSQL = `SELECT subject_id, member_id FROM library.collection_member
WHERE route=$1 AND collection_id=$2 AND (subject_id, member_id) > ($3::uuid, $4::uuid)
ORDER BY subject_id, member_id LIMIT $5`;
/**
 * Expected final CAS shape inside native owner transaction holding its current source fence. $5 is the freshly
 * admitted ACTUAL basis commitment, NOT the caller's assertion. Identity digest is independently budgeted/read
 * before CAS and re-admitted by each reader/final use; no cross-home atomicity is claimed by this statement.
 * Checkpoint/rows are CASed together in repair step using the previous exact raw keyset; only complete EOF sets
 * source_exhausted, with pending_mapping=false only after every admitted mapping is proved.
 */
export const publicationSQL = `UPDATE library.canonical_source_state
SET ready_generation=working_generation, ready_basis=working_basis,
    working_generation=NULL, working_basis=NULL
WHERE route=$1 AND collection_id=$2 AND working_generation=$3 AND working_basis=$4
  AND working_basis=$5 AND source_exhausted AND NOT pending_mapping
RETURNING ready_generation`;

/**
 * Native source prerequisites, not alternate backends: entry PK supplies strict (route,account,subject) raw repair;
 * copy/session repair require (route,account,subject,copy_id/session_id), without timestamp between seek keys.
 * Existing timestamp indexes cannot bound a fact-id suffix seek. Independent-label authority and accepted nullable
 * state/profile pins are absent at this base; their owner must supply native subject/fact indexes, no label cache.
 * Activated/frozen output needs its actual (route,Collection,complete generation,subject,output fact) authority.
 */
export const sourceIndexExpectations = {
  member: 'collection_member_canonical_repair(route,collection_id,subject_id,member_id)',
  entry: 'entry primary key(route,account_id,subject_id)',
  copy: 'copy canonical repair(route,account_id,subject_id,copy_id)',
  session: 'progress_session canonical repair(route,account_id,subject_id,session_id)',
  label: 'independent label owner: (route,account_id,subject_id,label fact id); missing native owner',
  output: 'activated/frozen owner: (route,collection_id,complete generation,subject_id,output fact id)',
};

export async function canonicalFixture(db: GrowthDatabase) {
  const accounts = { editor: newId(0x6b10), reader: newId(0x6b20) };
  const actions = [
    'subject:create',
    'subject:read',
    'subject:merge',
    'moderation:hide',
    'moderation:restore',
    'moderation:takedown',
    'collection:create',
    'collection:read',
    'collection:update',
    'collection:delete',
  ];
  const real = await createRealAccess(db.admin, accounts, actions);
  // Large native fixtures span many requests. Mint fresh real signed credentials per request rather than reusing
  // a request-bound actor after its deadline, extending a deadline, freezing authentication time, or faking Access.
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'canonical-native', alg: 'ES256' };
  const nativeAccess = createAccess({
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/canonical-jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: action === 'subject:read' || action === 'collection:read',
          ...(action === 'collection:create' ? { 'x-resource-types': ['library.collection'] } : {}),
        },
      ]),
    ),
  });
  const access = deriveAccess(nativeAccess, {
    async authorize(client, actor, action, target, evidence, time) {
      const check = {
        persona: actor.kind === 'account' && actor.accountId === accounts.editor ? 'editor' : 'reader',
        action,
        resource: { route: target.route, id: target.id },
      };
      (action.endsWith(':read') ? real.readChecks : real.checks).push(check);
      return nativeAccess.authorize(client, actor, action, target, evidence, time);
    },
  });
  async function authenticate(persona: keyof typeof accounts) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      client_id: 'web',
      scope: actions.join(' '),
      authn_epoch: 1,
      auth_time: now,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'canonical-native', typ: 'at+jwt' })
      .setIssuer('https://auth.example.test')
      .setAudience('https://api.rezics.test')
      .setSubject(accounts[persona])
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signing.privateKey);
    return access.authenticate(token, { pool: db.pool, deadline: deadline() });
  }
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of [
    'subject:create',
    'subject:merge',
    'moderation:hide',
    'moderation:restore',
    'moderation:takedown',
  ])
    await real.grant(global, 'editor', action);
  await bootstrapRelease(db.pool, bundledRelease);
  let editor = await authenticate('editor');
  let reader = await authenticate('reader');
  async function refresh() {
    editor = await authenticate('editor');
    reader = await authenticate('reader');
  }
  const commands = createCollectionCommands({ pool: db.pool, access });
  const reads = createCollectionReads({
    pool: db.pool,
    access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(45)]]) },
  });
  const release = { digest: bundledDigest, release: bundledRelease };
  async function authorization(action: string) {
    return accessCommandAuthorization(
      access,
      editor,
      action,
      global,
      { pool: db.pool, deadline: deadline() },
      () => new Error(`Denied ${action}`),
    );
  }
  let subjectReadWarmup: Promise<void> | undefined;
  async function subject(route = 0x6b30) {
    await refresh();
    const key = randomUUID();
    const id = (
      await createSubject(db.pool, {
        actor: editor,
        target: { route, id: newId(route) },
        idempotencyKey: key,
        digest: createHash('sha256').update(key).digest(),
        item: { type: 'schema:Book', labels: { en: 'Canonical source native fixture' } },
        release,
        authorization: await authorization('subject:create'),
      })
    ).subject.id;
    // Cold SQL analysis is setup, before a short-lived permission proof. Inspect the real native row without
    // claiming a product allow; add/readable below still use actual Access. Never prepare inside a held read.
    subjectReadWarmup ??= (async () => {
      const rows = await readSubjectStatement.run(db.pool, { route, subject_id: id });
      expect(rows[0]?.id).toBe(id);
    })();
    await subjectReadWarmup;
    return id;
  }
  async function collection(visibility: 'private' | 'public' | 'unlisted' = 'private') {
    await refresh();
    const row = (
      await commands.createCollection(editor, { title: 'Canonical native source', visibility }, randomUUID())
    ).value;
    // Native creation owns grant initialization; reader only uses actual installed Collection policy.
    expect((await reads.readCollection(editor, row.id)).id).toBe(row.id);
    return row;
  }
  async function add(collectionId: string, subjectId: string, note: string | null = null) {
    // Run the existing native consumer before minting addMember's short-lived Access evidence. With no relay
    // running in an isolated database, readSubject would otherwise wait for links while that evidence expires.
    // This is fixture setup, not fabricated checkpoint/readiness data or an alternate production scheduler.
    const links = linkProjection(db.pool);
    for (;;) {
      const batch = await links.run(partitionOf(routeOf(subjectId)!));
      if (batch.status !== 'read') throw new Error(`Native links fixture consumer: ${batch.status}`);
      if (batch.envelopes === 0) break;
    }
    await refresh();
    const row = (await commands.addMember(editor, collectionId, { subjectId, note }, randomUUID())).value;
    expect(row.subjectId).toBe(subjectId);
    return row;
  }
  async function merge(original: string, terminal: string, settle = true) {
    await refresh();
    const key = randomUUID();
    await mergeSubjects(db.pool, {
      subjects: [original, terminal],
      survivor: terminal,
      actor: editor,
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      release,
      authorization: await authorization('subject:merge'),
      deadline: deadline(),
    });
    if (!settle) return;
    for (let step = 0; step < 100; step++) if (!(await moveMergePage(db.pool, original, terminal))) return;
    throw new Error('Native merge maintenance did not finish');
  }
  async function hide(id: string, action: 'hide' | 'restore' = 'hide') {
    await refresh();
    const key = randomUUID();
    await moderateSubject(db.pool, {
      actor: editor,
      subject: id,
      action,
      body: { reason: 'Native source test' },
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      authorization: await authorization(`moderation:${action}`),
      deadline: deadline(),
    });
  }
  async function readable(id: string, actor?: Actor) {
    await refresh();
    const target = resource(id);
    const check = await accessCheck(
      access,
      actor ?? reader,
      'subject:read',
      { ...target, eligibility: subjectReadEligibility(target) },
      { pool: db.pool, deadline: deadline() },
    );
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const at = await mintReadTime(client);
      const result = await check(client, at);
      await client.query('COMMIT');
      return result;
    } finally {
      client.release();
    }
  }
  async function aliases(count: number) {
    const c = await collection('public');
    const terminal = await subject(0x6b00);
    const originals: string[] = [];
    for (let n = 0; n < count; n++) originals.push(await subject());
    originals.sort();
    for (const id of originals) {
      await add(c.id, id);
      await merge(id, terminal);
    }
    for (const id of originals.slice(0, -1)) await hide(id);
    expect(await readable(terminal)).toBe(true);
    expect(await readable(originals[0]!)).toBe(false);
    expect(await readable(originals.at(-1)!)).toBe(true);
    return { c, terminal, originals };
  }
  async function facts(collectionId: string) {
    return (
      await db.pool.query(
        `SELECT member_id, subject_id, ordinal_key, note FROM library.collection_member
      WHERE route=$1 AND collection_id=$2 ORDER BY ordinal_key,member_id`,
        [routeOf(collectionId), collectionId],
      )
    ).rows;
  }
  function call(collectionId: string, reserved = allowance()) {
    return { ...resource(collectionId), collectionId, allowance: reserved, deadline: deadline() };
  }
  async function build(collectionId: string, quota = 100) {
    const observed = await store.observeCanonicalSource(db.pool, call(collectionId));
    expect(observed.state).toBe('admitted');
    if (observed.state !== 'admitted') throw new Error('Native source/identity authority is not admitted');
    const started = await store.beginCanonicalSourceRepair(db.pool, { ...call(collectionId), basis: observed.basis });
    expect(started.state).toBe('working');
    if (started.state !== 'working') throw new Error('Native repair did not start');
    let repair = started.repair;
    for (let steps = 0; steps < 10000; steps++) {
      const reserved = allowance(quota);
      const next = await store.repairCanonicalSourceStep(db.pool, {
        ...call(collectionId, reserved),
        basis: observed.basis,
        repair,
      });
      receipt(next.work, reserved);
      if (next.state === 'not_ready' || next.state === 'basis_changed')
        throw new Error('Native repair did not converge at quiescence');
      expect(charged(next.work)).toBeGreaterThanOrEqual(next.examined.length);
      expect(next.examined.length).toBeLessThanOrEqual(quota);
      if (next.state !== 'complete') expect(next.repair.after).not.toEqual(repair.after);
      repair = next.repair;
      if (next.state === 'complete') {
        expect(repair.sourceExhausted).toBe(true);
        const published = await store.publishCanonicalSourceRepair(db.pool, {
          ...call(collectionId),
          basis: observed.basis,
          repair,
        });
        expect(published.state).toBe('published');
        return { basis: observed.basis, generation: repair.generation };
      }
    }
    throw new Error('Native repair failed finite quiescent convergence');
  }
  return {
    db,
    real,
    access,
    get editor() {
      return editor;
    },
    get reader() {
      return reader;
    },
    refresh,
    commands,
    reads,
    subject,
    collection,
    add,
    merge,
    hide,
    readable,
    aliases,
    facts,
    call,
    build,
  };
}
export type CanonicalFixture = Awaited<ReturnType<typeof canonicalFixture>>;

/**
 * Thin test-side argument mapper to the ONE createCollectionSource ABI. Store progress is converted ONLY to
 * CollectionAliasProgress {subjectId,basisDigest,aliasAfter,sourceAfter}; owner-returned progress passes unchanged.
 * finalUse requests a fresh real containsSubject call, never a test-side membership or permission decision.
 * Actual optional positiveEvidence is forwarded unchanged for the owner's own current witness revalidation.
 * Owner receipt.used.candidateKeys is the sum of this DAO's five disjoint raw-key categories, not rows disclosed.
 * Independently reserve fixed-home metadata before dispatch; nativePoints includes its point reads, not free work.
 */
export interface NativeOwner {
  prepare(
    input: object,
  ): Promise<{ source: { observation: { basis: { digest: string }; stamp: ListingStamp } }; work: OwnerWork }>;
  prefix(input: object): Promise<{
    candidates: { subjectId: string }[];
    coveredThrough: string | null;
    exhausted: boolean;
    work: OwnerWork;
  }>;
  containsSubject(
    input: object,
  ): Promise<{ result: boolean | 'not_proven'; progress?: unknown; positiveEvidence?: unknown; work: OwnerWork }>;
}

/** Lossless field conversion only: no new frontier, computed basis, native alias window or allow is invented. */
export function ownerProgress(progress: CanonicalGroupProgress, ownerBasisDigest: string) {
  if (progress.basis.digest !== ownerBasisDigest) throw new Error('Store progress does not match current owner basis');
  const drivers = { member: 0, entry: 1, label: 2, session: 3, copy: 4, output: 5 } as const;
  let sourceAfter: CanonicalSourceAfter | null = null;
  if (progress.after) {
    const key = progress.after;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuid.test(key.storedSubjectId) || !uuid.test(key.factId)) throw new Error('Invalid native source key');
    sourceAfter = `1:${drivers[key.driver]}:${key.storedSubjectId}:${key.factId}`;
    expect(Buffer.byteLength(sourceAfter)).toBe(77);
  }
  return {
    subjectId: progress.pendingSubjectId,
    basisDigest: progress.basis.digest,
    aliasAfter: progress.aliasAfter ?? null,
    sourceAfter,
  };
}
export async function owner(f: CanonicalFixture, collectionId: string, actor?: Actor) {
  await f.refresh();
  // Only called after native Collection/Semantic writes and baseline Access assertions, never a route 404 fixture.
  const path = new URL('../../src/library/collection-source.ts', import.meta.url);
  expect(
    await Bun.file(path).exists(),
    'Native collection-source owner implementation is required after valid baseline',
  ).toBe(true);
  const module = await import(path.href);
  expect(module.createCollectionSource).toBeFunction();
  const native = module.createCollectionSource({ pool: f.db.pool, access: f.access }) as NativeOwner;
  const client = await f.db.pool.connect();
  let at;
  try {
    at = await mintReadTime(client);
  } finally {
    client.release();
  }
  const context = { actor: actor ?? f.reader, at, deadline: deadline(), allowance: ownerAllowance() };
  const prepared = await native.prepare({ ...context, collectionId });
  ownerReceipt(prepared.work, context.allowance);
  const api: NativeOwner = {
    prepare: (input) => native.prepare(input),
    async prefix(input) {
      const result = await native.prefix(input);
      ownerReceipt(result.work, (input as { allowance: ReturnType<typeof ownerAllowance> }).allowance);
      return result;
    },
    async containsSubject(input) {
      const { finalUse: _finalUse, progress, ...call } = input as Record<string, unknown>;
      const mapped =
        progress && typeof progress === 'object' && 'pendingSubjectId' in progress
          ? ownerProgress(progress as CanonicalGroupProgress, prepared.source.observation.basis.digest)
          : progress;
      const result = await native.containsSubject({ ...call, ...(mapped === undefined ? {} : { progress: mapped }) });
      ownerReceipt(result.work, (input as { allowance: ReturnType<typeof ownerAllowance> }).allowance);
      return result;
    },
  };
  return { api, context, source: prepared.source };
}

export async function parked(
  f: CanonicalFixture,
  collectionId: string,
): Promise<{ basis: CanonicalBasis; repair: CanonicalRepair }> {
  const admitted = await store.observeCanonicalSource(f.db.pool, f.call(collectionId));
  expect(admitted.state).toBe('admitted');
  if (admitted.state !== 'admitted') throw new Error('Authority not admitted');
  const started = await store.beginCanonicalSourceRepair(f.db.pool, { ...f.call(collectionId), basis: admitted.basis });
  if (started.state !== 'working') throw new Error('Repair not working');
  const step = await store.repairCanonicalSourceStep(f.db.pool, {
    ...f.call(collectionId, allowance(1)),
    basis: admitted.basis,
    repair: started.repair,
  });
  expect(step.state).toBe('working');
  if (step.state !== 'working') throw new Error('Expected parked repair');
  expect(step.examined).toHaveLength(1);
  return { basis: admitted.basis, repair: step.repair };
}

/** Consume the existing native dynamic-owner contract; never implement a builtin/publication backend here. */
export async function nativeDynamicDriver(f: CanonicalFixture): Promise<DynamicCollectionsDriver> {
  const c = await f.collection('public');
  const id = await f.subject();
  await f.add(c.id, id);
  expect(await f.readable(id)).toBe(true);
  const location = process.env.DYNAMIC_COLLECTIONS_DRIVER;
  expect(
    location,
    'Native four-fact builtin and activated/frozen Collection owner driver is required after valid native baseline',
  ).toBeDefined();
  if (!location || !(location.startsWith('/') || location.startsWith('file:')))
    throw new Error('DYNAMIC_COLLECTIONS_DRIVER must name the existing native owner driver by absolute path/file URL');
  const url = location.startsWith('/') ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('DYNAMIC_COLLECTIONS_DRIVER must use a file URL');
  const binding = await import(url.href);
  expect(binding.createDynamicCollectionsDriver).toBeFunction();
  return binding.createDynamicCollectionsDriver();
}
