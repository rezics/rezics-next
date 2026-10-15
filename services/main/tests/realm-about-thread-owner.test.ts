import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { appendContentEvent, ContentCore, ContentConflict, contentDraftIntentDigest, type SaveDraftCommand } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { AdmissionDenied, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { RealmAboutPostCommand, type RealmAboutPostInput } from '../src/modules/realm-reply/about-command.ts';
import { RealmAboutThreadStore } from '../src/modules/realm-reply/about-store.ts';
import { RealmReplyContentStore, RealmReplyConflict, RealmReplyDenied, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable,
  type ReplyIdentityInput } from '../src/modules/realm-reply/content-store.ts';
import { readReplyGraphReceipt, replyReceiptIri, type ReplyGraphReceipt } from '../src/modules/realm-reply/graph.ts';
import { realmReplyDigest } from '../src/modules/realm-reply/store.ts';
import { WorkReadMissing, WorkReadMoved } from '../src/modules/work/read-session.ts';
import { TargetUnavailable } from '../src/modules/target/resolve.ts';
import { RV } from '../src/modules/work/activate.ts';
import { realmReplyRoutes } from '../src/routes/realm-replies.ts';

const nativeId = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const refusal = { kind: 'reply-denied' as const, message: 'Realm policy requires moderator approval' };
type Operation = Awaited<ReturnType<RealmAboutThreadStore['reserve']>>;
let cluster: PostgresCluster | undefined;
let pool: Pool;
let about: RealmAboutThreadStore;
let identities: RealmReplyContentStore;
let content: ContentCore;
let legacyRefusal: Operation;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 8, connectionTimeoutMillis: 1000 });
  about = new RealmAboutThreadStore(pool);
  identities = new RealmReplyContentStore(pool);
  content = new ContentCore(pool);
  const migrationRoot = resolve(import.meta.dir, '../../content/migrations');
  const scratchRoot = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(scratchRoot, { recursive: true });
  const legacyMigrations = mkdtempSync(resolve(scratchRoot, 'discussion-legacy-migrations-'));
  try {
    for (const name of readdirSync(migrationRoot).filter(name => name.endsWith('.sql')
      && name !== '2141_realm_about_refusal_outcome.sql')) {
      copyFileSync(resolve(migrationRoot, name), resolve(legacyMigrations, name));
    }
    await migrateContent(pool, legacyMigrations);
    legacyRefusal = await about.reserve(intent());
    // Reproduce the previous owner's definite refusal before upgrading: its
    // immutable operation survives the released canonical reservation.
    await pool.query('UPDATE content.realm_about_post_operation SET terminal_refusal=true WHERE id=$1', [legacyRefusal.id]);
    await pool.query('DELETE FROM content.realm_about_thread WHERE realm=$1 AND about=$2',
      [legacyRefusal.realm, legacyRefusal.about]);
    await migrateContent(pool);
  } finally { rmSync(legacyMigrations, { recursive: true, force: true }); }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

function intent(overrides: Partial<Parameters<RealmAboutThreadStore['reserve']>[0]> = {}) {
  return { realm: nativeId(), about: nativeId(), actor: nativeId(), intentKey: randomUUID(),
    intentDigest: digest(randomUUID()), rootRevision: nativeId(), ...overrides };
}

test('migration retains the legacy refused response after its canonical reservation was released', async () => {
  const outcome = await about.refuseBeforeDispatch(legacyRefusal.id, refusal);
  expect(outcome).toMatchObject({ kind: 'refused', operation: { id: legacyRefusal.id,
    terminalOutcome: { kind: 'reply-stale', message: 'Discussion intent was refused before placement' } } });
  expect(await about.readThread(legacyRefusal.realm, legacyRefusal.about)).toBeNull();
});

function admission(operation: Operation, action: string, scope: string): RegisteredAdmission {
  return { id: randomUUID(), principalId: randomUUID(), actingSubject: operation.actor,
    action, scope, idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()),
    authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: false };
}

async function draft(operation: Operation, options: { body?: string; language?: string;
  expectedHead?: string; deleted?: boolean; spoiler?: boolean } = {}) {
  const admitted = randomUUID();
  const command: SaveDraftCommand = { operationId: `content-draft:${admitted}`,
    variant: { id: operation.variantId, resourceId: operation.reply,
      language: { kind: 'tag', tag: options.language ?? 'en', originalTag: options.language ?? 'en' },
      direction: 'ltr' }, expectedHead: options.expectedHead ?? null,
    model: 'member-reply-v1', sourceRevision: operation.rootRevision, provenance: {},
    serializedJson: JSON.stringify({ body: options.deleted ? '' : options.body ?? 'A title\nAn independent contribution',
      deleted: options.deleted ?? false, rootTarget: operation.about, rootRevision: operation.rootRevision,
      originRealm: operation.realm, ...(options.spoiler === undefined ? {} : { spoiler: options.spoiler }) }) };
  command.provenance = { kind: 'admitted-original-contribution-v1', author: operation.actor,
    admissionId: admitted, authorityEpoch: '1', scope: `content:draft:${operation.reply}`,
    requestDigest: contentDraftIntentDigest(command, operation.actor), expectedHead: command.expectedHead,
    rightsBasis: 'original-contribution' };
  const saved = await content.saveDraft(command);
  expect(saved.outcome).toBe('succeeded');
  expect(saved.revisionId).not.toBeNull();
  return { operationId: command.operationId, revisionId: saved.revisionId!,
    revisionDigest: digest(command.serializedJson) };
}

function identity(operation: Operation): ReplyIdentityInput {
  if (!operation.revisionId) throw new Error('test operation needs a recorded draft');
  return { reply: operation.reply, variantId: operation.variantId, revisionId: operation.revisionId,
    author: operation.actor, rootTarget: operation.about, rootRevision: operation.rootRevision,
    parentReply: operation.parentReply, parentRevision: operation.parentRevision,
    contextRevision: null, originRealm: operation.realm };
}

async function identify(operation: Operation, options: Parameters<typeof draft>[1] = {}) {
  const saved = await draft(operation, options);
  await about.recordDraft(operation.id, saved.operationId);
  const drafted = await about.resume(operation.id);
  const permit = admission(drafted, 'reply.create', `reply:create:${operation.about}`);
  await identities.createReply(permit, identity(drafted));
  return { saved, permit, operation: await about.resume(operation.id) };
}

async function post(operation: Operation, options: Parameters<typeof draft>[1] = {}) {
  const identified = await identify(operation, options);
  const permit = admission(operation, 'reply.place', `reply:place:${operation.realm}`);
  await identities.preparePlacement(permit, { realm: operation.realm, reply: operation.reply,
    revisionId: identified.saved.revisionId, revisionDigest: identified.saved.revisionDigest,
    reviewDecisionId: null, expectedHead: null }, nativeId());
  const receipt = nativeId();
  await about.recordPosted(operation.id, permit.id, receipt);
  return { ...identified, placement: permit, receipt, operation: await about.resume(operation.id) };
}

test('concurrent first intents durably choose one opener and preserve both independent identities', async () => {
  const first = intent();
  const second = intent({ realm: first.realm, about: first.about, rootRevision: first.rootRevision });
  const operations = await Promise.all([about.reserve(first), about.reserve(second)]);
  const roots = operations.filter(operation => operation.parentReply === null);
  expect(roots).toHaveLength(1);
  const opener = roots[0]!;
  const child = operations.find(operation => operation.parentReply !== null)!;
  expect(child.parentReply).toBe(opener.reply);
  expect(child.openerReply).toBe(opener.reply);
  expect(child.parentRevision).toBeNull();
  expect(child.pending).toBe(true);
  expect(child.actor).not.toBe(opener.actor);
  expect(child.reply).not.toBe(opener.reply);
  expect(child.variantId).not.toBe(opener.variantId);
  expect(operations.every(operation => operation.phase === 'selected')).toBe(true);
  expect(await about.readThread(first.realm, first.about)).toMatchObject({
    openerReply: opener.reply, rootRevision: first.rootRevision, revisionId: null, state: 'reserved' });
  expect((await pool.query('SELECT id FROM content.reply WHERE id = ANY($1::text[])',
    [operations.map(operation => operation.reply)])).rows).toHaveLength(0);
  expect((await pool.query('SELECT id FROM content.variant WHERE id = ANY($1::text[])',
    [operations.map(operation => operation.variantId)])).rows).toHaveLength(0);

  await post(opener);
  const resumed = await about.resume(child.id);
  expect(resumed.pending).toBe(false);
  expect(resumed.parentRevision).toBe((await about.resume(opener.id)).revisionId);
  const postedChild = await post(resumed, { body: '独立的回复', language: 'zh-Hans', spoiler: false });
  expect(postedChild.operation.phase).toBe('posted');
  expect(await identities.readReply(child.reply)).toMatchObject({ author: child.actor,
    parentReply: opener.reply, rootRevision: first.rootRevision, originRealm: first.realm });
  expect((await pool.query(`SELECT v.language_tag, r.body FROM content.variant v
    JOIN content.revision r ON r.id = v.draft_head WHERE v.id = $1`, [child.variantId])).rows[0])
    .toMatchObject({ language_tag: 'zh-Hans', body: { body: '独立的回复', spoiler: false } });
  const openerBody = (await pool.query<{ language_tag: string; body: Record<string, unknown> }>(
    `SELECT v.language_tag, r.body FROM content.variant v
    JOIN content.revision r ON r.id = v.draft_head WHERE v.id = $1`, [opener.variantId])).rows[0]!;
  expect(openerBody.language_tag).toBe('en');
  expect(openerBody.body.body).toBe('A title\nAn independent contribution');
  expect(openerBody.body).not.toHaveProperty('spoiler');
});

test('concurrent replay allocates one identity and changed input under an existing intent conflicts', async () => {
  const input = intent();
  const [first, retry] = await Promise.all([about.reserve(input), about.reserve(input)]);
  expect(retry.id).toBe(first.id);
  expect(retry.reply).toBe(first.reply);
  expect(retry.variantId).toBe(first.variantId);
  expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
  await expect(about.reserve({ ...input, intentDigest: digest('changed body or language') }))
    .rejects.toBeInstanceOf(RealmReplyConflict);
  await expect(about.reserve({ ...input, rootRevision: nativeId() })).rejects.toBeInstanceOf(RealmReplyConflict);
  await expect(about.reserve({ ...input, about: nativeId() })).rejects.toBeInstanceOf(RealmReplyConflict);
  await expect(about.reserve({ ...input, realm: nativeId() })).rejects.toBeInstanceOf(RealmReplyConflict);
  const resumed = await about.reserve(input);
  expect(resumed.id).toBe(first.id);
  expect(resumed.replayed).toBe(true);
});

test('terminal opener cancellation releases only the reservation and fences its retained pending selections', async () => {
  const input = intent(), opener = await about.reserve(input);
  const childInput = intent({ realm: input.realm, about: input.about, rootRevision: input.rootRevision });
  const child = await about.reserve(childInput);
  const identified = await identify(opener);
  const placement = admission(opener, 'reply.place', `reply:place:${opener.realm}`);
  await about.recordDispatch(opener.id, placement.id, {
    zone: nativeId(), zoneRevision: nativeId(), routeRevision: nativeId(),
  });
  const terminal: ReplyGraphReceipt = { outcome: 'cancelled', admissionId: placement.id,
    requestDigest: placement.requestDigest, authorityEpoch: placement.authorityEpoch,
    scope: placement.scope, receipt: nativeId(), dataEpoch: randomUUID(), sequence: '1' };
  await expect(about.releaseReservation(opener, { ...terminal, outcome: 'succeeded' })).rejects.toBeInstanceOf(RealmReplyStale);
  expect(await about.releaseReservation(opener, { ...terminal, admissionId: randomUUID() })).toBe(false);
  expect(await about.releaseReservation(opener, terminal)).toBe(true);
  expect(await about.releaseReservation(opener, terminal)).toBe(false);
  expect(await about.readThread(input.realm, input.about)).toBeNull();
  expect((await pool.query('SELECT reply,opener_reply,parent_reply,phase FROM content.realm_about_post_operation WHERE id=$1',
    [opener.id])).rows).toEqual([{ reply: opener.reply, opener_reply: opener.reply, parent_reply: null, phase: 'identified' }]);
  expect(await identities.readReply(opener.reply)).toMatchObject({ revisionId: identified.saved.revisionId });
  await expect(about.reserve(input)).rejects.toBeInstanceOf(RealmReplyStale);
  await expect(about.reserve(childInput)).rejects.toBeInstanceOf(RealmReplyStale);
  await expect(about.resume(child.id)).rejects.toBeInstanceOf(RealmReplyStale);
  const fresh = await about.reserve(intent({ realm: input.realm, about: input.about }));
  expect(fresh.parentReply).toBeNull();
  expect(fresh.reply).not.toBe(opener.reply);
  const winner = await post(fresh);
  expect(await about.releaseReservation(fresh, terminal)).toBe(false);
  expect(await about.readThread(input.realm, input.about)).toMatchObject({ state: 'active', openerReply: fresh.reply,
    rootRevision: fresh.rootRevision, revisionId: winner.saved.revisionId });
});

test('definite pre-dispatch refusals release selected drafted and identified openers without erasing owner effects', async () => {
  for (const phase of ['selected', 'drafted', 'identified'] as const) {
    const input = intent(), selected = await about.reserve(input);
    const pendingInput = intent({ realm: input.realm, about: input.about });
    const pending = await about.reserve(pendingInput);
    if (phase === 'drafted') {
      const saved = await draft(selected);
      await about.recordDraft(selected.id, saved.operationId);
    } else if (phase === 'identified') await identify(selected);
    const before = await about.resume(selected.id);
    expect(before.phase).toBe(phase);
    expect(await about.refuseBeforeDispatch(selected.id, refusal)).toMatchObject({ kind: 'refused', operation: { terminalOutcome: refusal } });
    expect(await about.refuseBeforeDispatch(selected.id, refusal)).toMatchObject({ kind: 'refused', operation: { terminalOutcome: refusal } });
    expect(await about.readThread(input.realm, input.about)).toBeNull();
    const retained = (await pool.query(`SELECT phase,terminal_refusal,draft_operation_id,identity_operation_id
      FROM content.realm_about_post_operation WHERE id=$1`, [selected.id])).rows[0];
    expect(retained).toEqual({ phase, terminal_refusal: true,
      draft_operation_id: before.draftOperationId, identity_operation_id: before.identityOperationId });
    await expect(about.reserve(input)).rejects.toBeInstanceOf(RealmReplyStale);
    await expect(about.resume(selected.id)).rejects.toBeInstanceOf(RealmReplyStale);
    await expect(about.resume(pending.id)).rejects.toBeInstanceOf(RealmReplyStale);
    await expect(pool.query('UPDATE content.realm_about_post_operation SET terminal_refusal=false WHERE id=$1',
      [selected.id])).rejects.toThrow();
    if (phase === 'drafted') {
      await expect(identities.createReply(admission(before, 'reply.create', `reply:create:${before.about}`),
        identity(before))).rejects.toThrow();
      expect(await identities.readReply(selected.reply)).toBeNull();
    }
    if (phase === 'identified') expect(await identities.readReply(selected.reply)).not.toBeNull();
    const fresh = await about.reserve(intent({ realm: input.realm, about: input.about }));
    expect(fresh.parentReply).toBeNull();
    expect(fresh.reply).not.toBe(selected.reply);
  }
});

test('pre-dispatch refusal serializes with dispatch and fences an admission whose register response was lost', async () => {
  const basis = { zone: nativeId(), zoneRevision: nativeId(), routeRevision: nativeId() };
  const refused = (await identify(await about.reserve(intent()))).operation;
  const lostAdmission = admission(refused, 'reply.place', `reply:place:${refused.realm}`);
  expect(await about.refuseBeforeDispatch(refused.id, refusal)).toMatchObject({ kind: 'refused', operation: { terminalOutcome: refusal } });
  expect(await about.recordDispatch(refused.id, lostAdmission.id, basis)).toMatchObject({
    terminalOutcome: refusal, placementAdmissionId: null, dispatchBasis: null });
  const dispatched = (await identify(await about.reserve(intent()))).operation;
  const dispatchAdmission = admission(dispatched, 'reply.place', `reply:place:${dispatched.realm}`);
  await about.recordDispatch(dispatched.id, dispatchAdmission.id, basis);
  expect(await about.refuseBeforeDispatch(dispatched.id, refusal)).toMatchObject({ kind: 'recoverable' });
  expect(await about.readThread(dispatched.realm, dispatched.about)).toMatchObject({ openerReply: dispatched.reply });
  const racing = (await identify(await about.reserve(intent()))).operation;
  const racingAdmission = admission(racing, 'reply.place', `reply:place:${racing.realm}`);
  const [release, dispatch] = await Promise.allSettled([
    about.refuseBeforeDispatch(racing.id, refusal), about.recordDispatch(racing.id, racingAdmission.id, basis),
  ]);
  expect(release.status).toBe('fulfilled');
  if (release.status !== 'fulfilled') throw release.reason;
  const row = (await pool.query(`SELECT terminal_refusal,placement_admission_id
    FROM content.realm_about_post_operation WHERE id=$1`, [racing.id])).rows[0];
  if (release.value.kind === 'refused') {
    expect(dispatch.status).toBe('fulfilled');
    if (dispatch.status === 'fulfilled') expect(dispatch.value).toMatchObject({
      terminalOutcome: refusal, placementAdmissionId: null, dispatchBasis: null });
    expect(row).toEqual({ terminal_refusal: true, placement_admission_id: null });
    expect(await about.readThread(racing.realm, racing.about)).toBeNull();
  } else {
    expect(dispatch.status).toBe('fulfilled');
    expect(row).toEqual({ terminal_refusal: false, placement_admission_id: racingAdmission.id });
    expect(await about.readThread(racing.realm, racing.about)).not.toBeNull();
  }
});

test('a refused child and posted intent retain the activated canonical key', async () => {
  const opener = await about.reserve(intent()), winner = await post(opener);
  expect(await about.refuseBeforeDispatch(opener.id, refusal)).toMatchObject({ kind: 'posted' });
  const child = await about.reserve(intent({ realm: opener.realm, about: opener.about }));
  expect(await about.refuseBeforeDispatch(child.id, refusal)).toMatchObject({ kind: 'refused', operation: { terminalOutcome: refusal } });
  await expect(about.resume(child.id)).rejects.toBeInstanceOf(RealmReplyStale);
  expect(await about.readThread(opener.realm, opener.about)).toMatchObject({ state: 'active',
    openerReply: opener.reply, revisionId: winner.saved.revisionId });
  const fresh = await about.reserve(intent({ realm: opener.realm, about: opener.about }));
  expect(fresh.parentReply).toBe(opener.reply);
});

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

function commandFixture() {
  const principal = { issuer: 'discussion-owner-test', subject: randomUUID() };
  const principalKey = JSON.stringify([principal.issuer, principal.subject]);
  const realm = nativeId(), key = randomUUID();
  const input: RealmAboutPostInput = { profile: 'realm-about-post-v1', about: nativeId(),
    targetRevision: nativeId(), zone: nativeId(), path: '/', routeRevision: nativeId(),
    actingSubject: nativeId(), body: 'An independent contribution', language: 'en', direction: 'ltr' };
  const basis = { zone: input.zone, zoneRevision: nativeId(), routeRevision: input.routeRevision };
  const selection = { realm, about: input.about, actor: input.actingSubject, intentKey: key,
    intentDigest: realmReplyDigest({ realm, input }), rootRevision: input.targetRevision };
  let graphOutcome: { operation: Operation; permit: RegisteredAdmission; outcome: 'succeeded' | 'cancelled' } | undefined;
  const work = { realmReplyThreads: { rankingContent: pool }, contentAuthoring: {},
    access: { assertAuthority: async () => {} }, realmReplies: {},
    environment: { fuseki: { query: async () => {
      if (!graphOutcome) return { results: { bindings: [] } };
      const { operation, permit, outcome } = graphOutcome;
      const values = { outcome: `${RV}${outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`,
        digest: permit.requestDigest, id: permit.id, epoch: permit.authorityEpoch,
        scope: permit.scope, dataEpoch: randomUUID(), sequence: '1',
        ...(outcome === 'succeeded' ? { placement: nativeId(), revision: `urn:rezics:content:revision:${operation.revisionId}`,
          realm, reply: operation.reply } : {}) };
      return { results: { bindings: [Object.fromEntries(Object.entries(values).map(([name, value]) =>
        [name, { type: 'literal', value }]))] } };
    } } } } as unknown as MainWorkDependencies;
  const command = new RealmAboutPostCommand(work);
  // Replace the external read cut only; durable selection and ordering use the
  // real Content owner and its SQL locks below.
  Object.defineProperty(command, 'basis', { value: async () => basis, configurable: true });
  return { principal, principalKey, realm, key, input, selection, basis, work, command,
    graph: (operation: Operation, permit: RegisteredAdmission, outcome: 'succeeded' | 'cancelled' = 'succeeded') => {
      graphOutcome = { operation, permit, outcome };
    }, post: () => command.post(new Request('http://main.local'), principal, realm, input, key) };
}

async function prepare(operation: Operation, permit: RegisteredAdmission) {
  const saved = await about.savedDraft(operation);
  if (!saved) throw new Error('expected durable draft');
  await identities.preparePlacement(permit, { realm: operation.realm, reply: operation.reply,
    revisionId: saved.revisionId, revisionDigest: saved.revisionDigest,
    reviewDecisionId: null, expectedHead: null }, nativeId());
}

test('locked intent outcomes supersede stale basis disclosure and admission refusals at every winning boundary', async () => {
  for (const initial of ['selected', 'absent'] as const) {
    for (const failure of ['stale', 'disclosure', 'policy', 'admission'] as const) {
      if (initial === 'absent' && failure === 'admission') continue;
      for (const progress of ['dispatched', 'graph', 'posted'] as const) {
        const f = commandFixture(), entered = barrier(), resume = barrier();
        let operation = initial === 'selected'
          ? (await identify(await about.reserve(f.selection, f.principalKey))).operation : undefined;
        const error = failure === 'stale' ? new WorkReadMoved('Zone discussion basis changed')
          : failure === 'disclosure' ? new WorkReadMissing('Realm is unavailable')
          : failure === 'policy' ? new RealmReplyDenied(refusal.message) : new AdmissionDenied('Authority changed');
        const refuse = async () => { entered.release(); await resume.reached; throw error; };
        if (failure === 'admission') f.work.access.register = refuse;
        else Object.defineProperty(f.command, 'basis', { value: refuse });
        const response = f.post().then(value => value, reason => reason);
        await entered.reached;
        operation ??= (await identify(await about.reserve(f.selection, f.principalKey))).operation;
        const permit = admission(operation, 'reply.place', `reply:place:${f.realm}`);
        await about.recordDispatch(operation.id, permit.id, f.basis);
        if (progress !== 'dispatched') {
          await prepare(operation, permit);
          f.graph(operation, permit);
        }
        if (progress === 'posted') await about.recordPosted(operation.id, permit.id, replyReceiptIri(permit));
        resume.release();
        const result = await response;
        if (progress === 'posted') expect(result).toMatchObject({ status: 200, body: { reply: operation.reply } });
        else expect(result).toBeInstanceOf(RealmReplyUnavailable);
        const retained = await about.readIntent(f.principalKey, f.key, f.selection.intentDigest);
        expect(retained).toMatchObject({ id: operation.id, terminalRefusal: false, terminalOutcome: null,
          placementAdmissionId: permit.id });
        expect((await pool.query('SELECT id FROM content.realm_about_post_operation WHERE realm=$1 AND about=$2',
          [f.realm, f.input.about])).rows).toHaveLength(1);
        expect((await pool.query('SELECT id FROM content.reply WHERE root_target=$1', [f.input.about])).rows).toHaveLength(1);
      }
    }
  }
}, 30_000);

test('same-admission dispatch retains its first Zone cut and replays graph success before recordPosted', async () => {
  for (const progress of ['dispatched', 'graph', 'posted'] as const) {
    const f = commandFixture();
    const operation = (await identify(await about.reserve(f.selection, f.principalKey))).operation;
    const permit = admission(operation, 'reply.place', `reply:place:${f.realm}`);
    const registering = barrier(), resume = barrier();
    const laterBasis = { ...f.basis, zoneRevision: nativeId() };
    Object.defineProperty(f.command, 'basis', { value: async () => laterBasis });
    f.work.access.register = async () => { registering.release(); await resume.reached; return permit; };
    let placements = 0;
    f.work.realmReplies!.place = async (...args) => {
      placements++;
      expect(args[5]).toEqual(f.basis);
      if (progress === 'dispatched') throw new Error('placement response lost');
      return { placement: nativeId(), realm: f.realm, reply: operation.reply, revisionId: operation.revisionId!,
        reviewDecisionId: randomUUID(), reviewGeneration: '1', replayed: true };
    };
    const response = f.post().then(value => value, reason => reason);
    await registering.reached;
    await about.recordDispatch(operation.id, permit.id, f.basis);
    if (progress !== 'dispatched') {
      await prepare(operation, permit);
      f.graph(operation, permit);
      if (progress === 'posted') await about.recordPosted(operation.id, permit.id, replyReceiptIri(permit));
    }
    resume.release();
    const result = await response;
    if (progress !== 'dispatched') expect(result).toMatchObject({ status: 200, body: { reply: operation.reply } });
    else expect(result).toBeInstanceOf(RealmReplyUnavailable);
    expect(placements).toBe(progress === 'posted' ? 0 : 1);
    expect(await about.readIntent(f.principalKey, f.key, f.selection.intentDigest)).toMatchObject({ dispatchBasis: f.basis,
      terminalRefusal: false, terminalOutcome: null });
    await expect(about.recordDispatch(operation.id, randomUUID(), laterBasis)).rejects.toBeInstanceOf(RealmReplyUnavailable);
  }
});

test('an authority refusal with no allocated intent stays recoverable alongside a same-key winner', async () => {
  const f = commandFixture(), probed = barrier(), resume = barrier();
  const owner = Reflect.get(f.command, 'store') as RealmAboutThreadStore;
  const read = owner.readThread.bind(owner), reserve = owner.reserve.bind(owner);
  let pause = true, denied = false, probes = 0;
  f.work.access.assertAuthority = async () => { probes++; if (denied) throw new AdmissionDenied('Authority changed'); };
  owner.readThread = async (...args) => {
    if (pause) { pause = false; probed.release(); await resume.reached; }
    return read(...args);
  };
  owner.reserve = async (...args) => (await identify(await reserve(...args))).operation;
  let permit: RegisteredAdmission;
  f.work.access.register = async () => {
    const selected = await about.readIntent(f.principalKey, f.key, f.selection.intentDigest);
    if (!selected) throw new Error('expected allocated intent');
    permit = admission(selected, 'reply.place', `reply:place:${f.realm}`);
    return permit;
  };
  f.work.realmReplies!.place = async () => {
    const selected = await about.readIntent(f.principalKey, f.key, f.selection.intentDigest);
    if (!selected) throw new Error('expected dispatched intent');
    await prepare(selected, permit);
    f.graph(selected, permit);
    return { placement: nativeId(), realm: f.realm, reply: selected.reply, revisionId: selected.revisionId!,
      reviewDecisionId: randomUUID(), reviewGeneration: '1', replayed: false };
  };
  const winner = f.post();
  await probed.reached;
  expect(probes).toBe(3);
  denied = true;
  await expect(f.post()).rejects.toBeInstanceOf(AdmissionDenied);
  expect(await about.readIntent(f.principalKey, f.key, f.selection.intentDigest)).toBeNull();
  denied = false;
  resume.release();
  expect(await winner).toMatchObject({ status: 201 });
  expect((await f.post()).status).toBe(200);
  expect((await pool.query('SELECT id FROM content.reply WHERE root_target=$1', [f.input.about])).rows).toHaveLength(1);
});

test('a replaced undispatched child retains terminal stale despite a newer target refusal', async () => {
  const f = commandFixture();
  const opener = await about.reserve(intent({ realm: f.realm, about: f.input.about }));
  const child = await about.reserve(f.selection, f.principalKey);
  expect(child.pending).toBe(true);
  await about.refuseBeforeDispatch(opener.id, refusal);
  const replacement = await about.reserve(intent({ realm: f.realm, about: f.input.about }));
  Object.defineProperty(f.command, 'basis', { value: async () => { throw new WorkReadMoved('Discussion target changed'); } });
  const initial = await f.post().catch(error => error);
  expect(initial).toBeInstanceOf(RealmReplyStale);
  expect(initial.message).toBe('Discussion reservation was released');
  Object.defineProperty(f.command, 'basis', { value: async () => { throw new RealmReplyDenied('Policy changed'); } });
  const replay = await f.post().catch(error => error);
  expect(replay.constructor).toBe(initial.constructor);
  expect(replay.message).toBe(initial.message);
  expect(await about.readIntent(f.principalKey, f.key, f.selection.intentDigest)).toMatchObject({ terminalRefusal: true,
    terminalOutcome: { kind: 'reply-stale', message: initial.message }, placementAdmissionId: null });
  expect(await about.readThread(f.realm, f.input.about)).toMatchObject({ openerReply: replacement.reply });
});

test('exact HTTP 404 replay retains resource_unavailable through the real reply adapter', async () => {
  const f = commandFixture();
  await about.reserve(f.selection, f.principalKey);
  const original = Object.getOwnPropertyDescriptor(RealmAboutPostCommand.prototype, 'basis')!;
  Object.defineProperty(RealmAboutPostCommand.prototype, 'basis', { configurable: true,
    value: async () => { throw new TargetUnavailable(); } });
  try {
    const work = { ...f.work, account: { verify: async () => f.principal } } as MainWorkDependencies;
    // The authored Request/Response adapter owns problem status/code/body.
    // Exercise it with the real durable owner; routing/schema admission has
    // separate native HTTP coverage in the integration suite.
    const route = realmReplyRoutes(work).routes.find(route =>
      route.method === 'POST' && route.path === '/v1/realms/:realm/about-posts');
    if (!route || typeof route.handler !== 'function') throw new Error('expected native reply adapter');
    const handle = route.handler as unknown as (context: {
      request: Request; params: { realm: string }; body: RealmAboutPostInput;
    }) => Promise<Response>;
    const realm = f.realm.split('/').at(-1)!;
    const call = () => handle({ params: { realm }, body: f.input,
      request: new Request(`http://localhost/v1/realms/${realm}/about-posts`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': f.key },
        body: JSON.stringify(f.input),
      }) });
    const initial = await call();
    expect(initial.status).toBe(404);
    const body = await initial.json();
    expect(body).toMatchObject({ code: 'resource_unavailable' });
    await post(await about.reserve(intent({ realm: f.realm, about: f.input.about })));
    Object.defineProperty(RealmAboutPostCommand.prototype, 'basis', { configurable: true,
      value: async () => { throw new WorkReadMissing('New policy hides the target'); } });
    const replay = await call();
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual(body);
  } finally { Object.defineProperty(RealmAboutPostCommand.prototype, 'basis', original); }
});

test('terminal owner errors replay exactly across new policy target cuts and canonical replacement', async () => {
  for (const error of [new RealmReplyDenied(refusal.message), new WorkReadMissing('Realm is unavailable'),
    new WorkReadMoved('Discussion target changed')]) {
    const f = commandFixture();
    const operation = await about.reserve(f.selection, f.principalKey);
    Object.defineProperty(f.command, 'basis', { value: async () => { throw error; } });
    const initial = await f.post().catch(reason => reason);
    expect(initial.constructor).toBe(error.constructor);
    expect(initial.message).toBe(error.message);
    expect(await about.readThread(f.realm, f.input.about)).toBeNull();
    const winner = await post(await about.reserve(intent({ realm: f.realm, about: f.input.about })));
    let basisCalls = 0;
    Object.defineProperty(f.command, 'basis', { value: async () => { basisCalls++; return { ...f.basis, zoneRevision: nativeId() }; } });
    const replay = await f.post().catch(reason => reason);
    expect(replay.constructor).toBe(initial.constructor);
    expect(replay.message).toBe(initial.message);
    expect(basisCalls).toBe(0);
    expect(await about.readThread(f.realm, f.input.about)).toMatchObject({ openerReply: winner.operation.reply });
    await expect(pool.query(`UPDATE content.realm_about_post_operation
      SET terminal_outcome=$2 WHERE id=$1`, [operation.id, { kind: 'read-moved', message: 'changed' }])).rejects.toThrow();
  }
});

test('native cancelled placement keeps its initial refusal instead of a generic stale replay', async () => {
  const f = commandFixture();
  const operation = (await identify(await about.reserve(f.selection, f.principalKey))).operation;
  const permit = admission(operation, 'reply.place', `reply:place:${f.realm}`);
  f.work.access.register = async () => permit;
  f.work.realmReplies!.place = async () => { f.graph(operation, permit, 'cancelled'); throw new RealmReplyDenied(refusal.message); };
  const initial = await f.post().catch(reason => reason);
  expect(initial).toBeInstanceOf(RealmReplyDenied);
  expect(await about.readThread(f.realm, f.input.about)).toBeNull();
  await about.reserve(intent({ realm: f.realm, about: f.input.about }));
  const replay = await f.post().catch(reason => reason);
  expect(replay.constructor).toBe(initial.constructor);
  expect(replay.message).toBe(initial.message);
  expect(await about.readIntent(f.principalKey, f.key, f.selection.intentDigest)).toMatchObject({ terminalRefusal: false,
    terminalOutcome: refusal, placementAdmissionId: permit.id });
});

test('cancelled graph with ContentConflict keeps native cleanup recoverable on the same key', async () => {
  const f = commandFixture();
  const operation = (await identify(await about.reserve(f.selection, f.principalKey))).operation;
  const permit = admission(operation, 'reply.place', `reply:place:${f.realm}`);
  f.work.access.register = async () => permit;
  let cleanupCalls = 0;
  f.work.realmReplies!.place = async () => {
    cleanupCalls++;
    f.graph(operation, permit, 'cancelled');
    if (cleanupCalls === 1) throw new ContentConflict('Rejected settlement conflict');
    throw new RealmReplyStale('Realm reply placement was cancelled');
  };
  await expect(f.post()).rejects.toBeInstanceOf(RealmReplyUnavailable);
  expect(await about.readIntent(f.principalKey, f.key, f.selection.intentDigest)).toMatchObject({ terminalRefusal: false,
    terminalOutcome: null, placementAdmissionId: permit.id });
  expect(await about.readThread(f.realm, f.input.about)).toMatchObject({ openerReply: operation.reply });
  const receipt = await readReplyGraphReceipt(f.work.environment, permit);
  if (!receipt) throw new Error('expected cancelled owner receipt');
  await about.releaseReservation(operation, receipt);
  const replacement = await about.reserve(intent({ realm: f.realm, about: f.input.about }));
  await expect(f.post()).rejects.toBeInstanceOf(RealmReplyStale);
  expect(cleanupCalls).toBe(2);
  expect(await about.readThread(f.realm, f.input.about)).toMatchObject({ openerReply: replacement.reply });
  expect(await about.readIntent(f.principalKey, f.key, f.selection.intentDigest)).toMatchObject({
    terminalOutcome: { kind: 'reply-stale', message: 'Realm reply placement was cancelled' } });
});

test('draft cancellation proof binds the exact owner admission and digest and never treats absence as refusal', async () => {
  const admissionId = randomUUID(), requestDigest = digest(randomUUID());
  expect(await about.draftWasCancelled(admissionId, requestDigest)).toBe(false);
  await content.cancelDraft(admissionId, requestDigest);
  expect(await about.draftWasCancelled(admissionId, requestDigest)).toBe(true);
  expect(await about.draftWasCancelled(admissionId, digest('another request'))).toBe(false);
  const selected = await about.reserve(intent()), saved = await draft(selected);
  expect(await about.draftWasCancelled(saved.operationId.slice('content-draft:'.length), requestDigest)).toBe(false);
});

test('about-post language syntax and operation length bounds refuse before any canonical reservation', async () => {
  const input = intent();
  // Invalid input never reaches another owner. The real Content pool proves
  // that direct command callers cannot bypass the HTTP language constraint.
  const command = new RealmAboutPostCommand({ realmReplyThreads: { rankingContent: pool },
    realmReplies: {}, contentAuthoring: {} } as unknown as MainWorkDependencies);
  const tooLong = `en-x-${['abcdefgh', 'abcdefgh', 'abcdefgh', 'abcdefgh'].join('-')}`;
  for (const language of ['en-a-foo-a-bar', 'en-1901-1901', 'en-', ' en', tooLong]) {
    await expect(command.post(new Request('http://main.local'), { issuer: 'test', subject: 'test' }, input.realm, {
      profile: 'realm-about-post-v1', about: input.about, targetRevision: input.rootRevision,
      zone: nativeId(), path: '/', routeRevision: nativeId(), actingSubject: input.actor,
      body: 'Kept words', language, direction: 'ltr',
    }, randomUUID())).rejects.toBeInstanceOf(RealmReplyInvalid);
  }
  expect(await about.readThread(input.realm, input.about)).toBeNull();
  expect((await pool.query('SELECT id FROM content.realm_about_post_operation WHERE realm=$1 AND about=$2',
    [input.realm, input.about])).rows).toHaveLength(0);
});

test('Realm and resource keys select independent openers', async () => {
  const input = intent();
  const operations = await Promise.all([about.reserve(input),
    about.reserve(intent({ realm: input.realm })), about.reserve(intent({ about: input.about }))]);
  expect(operations.every(operation => operation.parentReply === null)).toBe(true);
  expect(new Set(operations.map(operation => operation.reply)).size).toBe(3);
  expect(await about.readThread(nativeId(), input.about)).toBeNull();
});

test('a pending reservation is visible after restart and prevents premature child identity insertion', async () => {
  const input = intent();
  const opener = await about.reserve(input);
  const restarted = new RealmAboutThreadStore(pool);
  const child = await restarted.reserve(intent({ realm: input.realm, about: input.about,
    rootRevision: nativeId() }));
  expect(child).toMatchObject({ openerReply: opener.reply, parentReply: opener.reply,
    parentRevision: null, rootRevision: input.rootRevision, pending: true });
  const saved = await draft(child);
  await expect(restarted.recordDraft(child.id, saved.operationId)).rejects.toThrow();
  await expect(identities.createReply(admission(child, 'reply.create', `reply:create:${child.about}`),
    { ...identity({ ...child, revisionId: saved.revisionId }), parentReply: null })).rejects.toThrow();
  expect(await identities.readReply(child.reply)).toBeNull();
  expect((await restarted.resume(child.id)).phase).toBe('selected');
  expect(await restarted.readThread(input.realm, input.about)).toMatchObject({ state: 'reserved',
    openerReply: opener.reply, revisionId: null });
});

test('draft recording requires the exact admitted reply receipt and keeps its first result on replay', async () => {
  const operation = await about.reserve(intent());
  await expect(about.recordDraft(operation.id, randomUUID())).rejects.toThrow();
  expect((await about.resume(operation.id)).phase).toBe('selected');
  const other = await about.reserve(intent());
  const foreign = await draft(other);
  await expect(about.recordDraft(operation.id, foreign.operationId)).rejects.toThrow();
  const saved = await draft(operation);
  await about.recordDraft(operation.id, saved.operationId);
  await about.recordDraft(operation.id, saved.operationId);
  expect(await about.resume(operation.id)).toMatchObject({ phase: 'drafted',
    revisionId: saved.revisionId, draftOperationId: saved.operationId });
  const edited = await draft(operation, { expectedHead: saved.revisionId, body: 'Edited after recording' });
  await expect(about.recordDraft(operation.id, edited.operationId)).rejects.toBeInstanceOf(RealmReplyConflict);
  expect((await about.resume(operation.id)).revisionId).toBe(saved.revisionId);
});

test('identity insertion must match durable root selection and records identity progress atomically', async () => {
  const operation = await about.reserve(intent());
  const saved = await draft(operation);
  await about.recordDraft(operation.id, saved.operationId);
  const drafted = await about.resume(operation.id);
  const permit = admission(operation, 'reply.create', `reply:create:${operation.about}`);
  await expect(identities.createReply(permit, { ...identity(drafted), rootRevision: nativeId() }))
    .rejects.toThrow();
  expect(await identities.readReply(operation.reply)).toBeNull();
  expect((await about.resume(operation.id)).phase).toBe('drafted');
  await identities.createReply(permit, identity(drafted));
  expect(await about.resume(operation.id)).toMatchObject({ phase: 'identified',
    identityOperationId: permit.id });
  expect((await identities.createReply(permit, identity(drafted))).replayed).toBe(true);
  await expect(identities.createReply(permit, { ...identity(drafted), rootRevision: nativeId() }))
    .rejects.toThrow();
  expect((await pool.query('SELECT id FROM content.reply WHERE id = $1', [operation.reply])).rows)
    .toHaveLength(1);
});

test('posting requires matching identity and SQL preparation and replays only the exact terminal result', async () => {
  const operation = await about.reserve(intent());
  await expect(about.recordPosted(operation.id, randomUUID(), nativeId())).rejects.toThrow();
  const identified = await identify(operation);
  await expect(about.recordPosted(operation.id, identified.permit.id, nativeId())).rejects.toThrow();
  const foreign = await post(await about.reserve(intent()));
  await expect(about.recordPosted(operation.id, foreign.placement.id, foreign.receipt)).rejects.toThrow();
  expect((await about.resume(operation.id)).phase).toBe('identified');
  expect((await about.readThread(operation.realm, operation.about))?.state).toBe('reserved');
  const placement = admission(operation, 'reply.place', `reply:place:${operation.realm}`);
  await identities.preparePlacement(placement, { realm: operation.realm, reply: operation.reply,
    revisionId: identified.saved.revisionId, revisionDigest: identified.saved.revisionDigest,
    reviewDecisionId: null, expectedHead: null }, nativeId());
  const receipt = nativeId();
  await about.recordPosted(operation.id, placement.id, receipt);
  await about.recordPosted(operation.id, placement.id, receipt);
  expect(await about.resume(operation.id)).toMatchObject({ phase: 'posted',
    placementOperationId: placement.id, placementReceipt: receipt });
  await expect(about.recordPosted(operation.id, placement.id, nativeId()))
    .rejects.toBeInstanceOf(RealmReplyConflict);
  expect(await about.readThread(operation.realm, operation.about)).toMatchObject({ state: 'active',
    revisionId: identified.saved.revisionId });
});

test('a page edit retains the canonical root and a hidden opener never allocates a replacement', async () => {
  const input = intent();
  const opener = await about.reserve(input);
  const posted = await post(opener);
  const afterEdit = await about.reserve(intent({ realm: input.realm, about: input.about, rootRevision: nativeId() }));
  expect(afterEdit).toMatchObject({ parentReply: opener.reply, rootRevision: opener.rootRevision,
    parentRevision: posted.saved.revisionId, pending: false });
  await draft(opener, { expectedHead: posted.saved.revisionId, deleted: true });
  const afterHidden = await about.reserve(intent({ realm: input.realm, about: input.about, rootRevision: nativeId() }));
  expect(afterHidden.parentReply).toBe(opener.reply);
  expect(afterHidden.rootRevision).toBe(opener.rootRevision);
  expect(await about.readThread(input.realm, input.about)).toMatchObject({ state: 'active',
    openerReply: opener.reply, revisionId: posted.saved.revisionId });
});

test('SQL guards reject changed selection, premature activation and deletion of a canonical key', async () => {
  const opener = await about.reserve(intent());
  const child = await about.reserve(intent({ realm: opener.realm, about: opener.about }));
  await expect(pool.query('UPDATE content.realm_about_thread SET opener_reply = $1 WHERE realm = $2 AND about = $3',
    [nativeId(), opener.realm, opener.about])).rejects.toThrow();
  await expect(pool.query('UPDATE content.realm_about_thread SET root_revision = $1 WHERE realm = $2 AND about = $3',
    [nativeId(), opener.realm, opener.about])).rejects.toThrow();
  await expect(pool.query("UPDATE content.realm_about_thread SET state = 'active', revision_id = $1 WHERE realm = $2 AND about = $3",
    [randomUUID(), opener.realm, opener.about])).rejects.toThrow();
  await expect(pool.query('UPDATE content.realm_about_post_operation SET parent_reply = NULL WHERE id = $1',
    [child.id])).rejects.toThrow();
  await expect(pool.query('UPDATE content.realm_about_post_operation SET parent_revision = $1 WHERE id = $2',
    [randomUUID(), child.id])).rejects.toThrow();
  await expect(pool.query('UPDATE content.realm_about_post_operation SET intent_digest = $1 WHERE id = $2',
    [digest('rebound input'), opener.id])).rejects.toThrow();
  await expect(pool.query('DELETE FROM content.realm_about_post_operation WHERE id = $1', [child.id])).rejects.toThrow();
  const posted = await post(opener);
  await expect(pool.query('DELETE FROM content.realm_about_thread WHERE realm = $1 AND about = $2',
    [opener.realm, opener.about])).rejects.toThrow();
  await expect(pool.query("UPDATE content.realm_about_thread SET state = 'reserved', revision_id = NULL WHERE realm = $1 AND about = $2",
    [opener.realm, opener.about])).rejects.toThrow();
  await expect(pool.query('UPDATE content.realm_about_thread SET revision_id = $1 WHERE realm = $2 AND about = $3',
    [randomUUID(), opener.realm, opener.about])).rejects.toThrow();
  expect(await about.readThread(opener.realm, opener.about)).toMatchObject({ state: 'active',
    openerReply: opener.reply, revisionId: posted.saved.revisionId });
});

test('direct SQL identity insertion cannot turn a selected child into another opener', async () => {
  const opener = await about.reserve(intent());
  await post(opener);
  const child = await about.reserve(intent({ realm: opener.realm, about: opener.about }));
  const saved = await draft(child);
  await about.recordDraft(child.id, saved.operationId);
  const permit = admission(child, 'reply.create', `reply:create:${child.about}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendContentEvent(client, { operationId: permit.id, requestDigest: permit.requestDigest,
      action: 'reply.create', outcome: 'succeeded', variantId: child.variantId, revisionId: saved.revisionId,
      eventType: 'content.reply.created', recipe: 'realm-reply-v1', payload: { reply: child.reply } });
    await expect(client.query(`INSERT INTO content.reply (id, variant_id, author, root_target,
      root_revision, parent_reply, parent_variant, parent_revision, context_revision, operation_id, origin_realm)
      VALUES ($1,$2,$3,$4,$5,NULL,NULL,NULL,NULL,$6,$7)`,
    [child.reply, child.variantId, child.actor, child.about, child.rootRevision, permit.id, child.realm]))
      .rejects.toThrow();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect(await identities.readReply(child.reply)).toBeNull();
  expect((await about.resume(child.id)).phase).toBe('drafted');
  expect(await identities.hasReceipt(permit.id, 'reply.create', permit.requestDigest)).toBe(false);
});

test('canonical lock waits are bounded while other Realm and resource keys remain independent', async () => {
  const opener = await about.reserve(intent());
  const waitingInput = intent({ realm: opener.realm, about: opener.about });
  const blocker = await pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM content.realm_about_thread WHERE realm = $1 AND about = $2 FOR UPDATE',
      [opener.realm, opener.about]);
    const started = performance.now();
    const waiting = about.reserve(waitingInput);
    const refused = expect(waiting).rejects.toBeInstanceOf(RealmReplyUnavailable);
    const unrelated = await Promise.race([Promise.all([
      about.reserve(intent({ realm: opener.realm })), about.reserve(intent({ about: opener.about })),
    ]), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('unrelated canonical keys waited on another key')), 1500);
    })]);
    clearTimeout(timer);
    expect(unrelated.every(operation => operation.parentReply === null)).toBe(true);
    await refused;
    expect(performance.now() - started).toBeLessThan(4000);
    expect((await pool.query('SELECT id FROM content.realm_about_post_operation WHERE actor = $1 AND intent_key = $2',
      [waitingInput.actor, waitingInput.intentKey])).rows).toHaveLength(0);
  } finally {
    clearTimeout(timer);
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  const retry = await about.reserve(waitingInput);
  expect(retry.parentReply).toBe(opener.reply);
  expect(retry.pending).toBe(true);
}, 10_000);
