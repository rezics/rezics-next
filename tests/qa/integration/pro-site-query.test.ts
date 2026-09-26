import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { SUBSCRIBE_ACTION } from '../../../services/main/src/modules/commerce/store.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { FixedSiteStore } from '../../../services/main/src/modules/pro-site/store.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest } from '../../../services/main/src/modules/work/select-realm.ts';
import type { CommerceRouteDependencies } from '../../../services/main/src/routes/commerce.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

// SUB07 on the real graph and Access owner. Graph state is seeded through the
// native command modules with synthetic claimed admissions, as the public
// selection oracle does; the fixed-site route and its site owner are real.
const root = resolve(import.meta.dir, '../../..');
const issuer = 'https://account.rezics.test';
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); }, 60_000);

test('SUB07: a fixed site with sparse Realm candidates never falls back to general content or leaks counts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `pro-site-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const pool = new Pool({ connectionString: databases.urls.access });
  cleanups.push(async () => { await pool.end(); await databases.close(); });
  const actor = ID + randomUUID();
  const otherAuthor = ID + randomUUID();
  const marker = `prositebeacon${randomUUID().replaceAll('-', '')}`;
  const env: WorkActivationEnvironment = {
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects'),
  };
  const deps = {
    environment: env,
    account: { verify: async (request: Request, scopes: readonly string[]) => {
      const [subject, granted] = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '').split('|');
      if (!subject || !scopes.every(scope => (granted ?? '').split(',').includes(scope))) {
        throw new AccountAssertionDenied('fixture bearer lacks scope');
      }
      return { issuer, subject };
    } },
    access: new AccessAdmissionRegistry(pool),
    sites: new FixedSiteStore(pool),
  } satisfies MainWorkDependencies & CommerceRouteDependencies;
  const app = createMainApp(env.fuseki, deps);

  function admission(scope: string, action: string, requestDigest: string, actingSubject = actor): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject, scope, action,
      idempotencyKey: `pro-site-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }
  async function realm(name: string) {
    const input = { name, actingSubject: actor };
    const result = await createRealmSpace(env,
      admission('space:create:root', 'space.create', spaceCreationDigest(input)), input);
    if (result.outcome !== 'succeeded' || !result.realm) throw new Error('Realm creation failed');
    return result.realm;
  }
  async function draft(work: string, body: string, author = actor) {
    const input = { work, language: 'en', body, actingSubject: author };
    const result = await activateTextContribution(env, admission(`contribution:create:${work}`,
      'contribution.create', textContributionDigest(input), author), input);
    if (result.outcome !== 'succeeded' || !result.contribution || !result.draftRevision) {
      throw new Error('Contribution draft failed');
    }
    return { contribution: result.contribution, draftRevision: result.draftRevision };
  }
  async function published(work: string, body: string, author = actor) {
    const created = await draft(work, body, author);
    const input = { contribution: created.contribution, expectedDraftHead: created.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: author };
    const result = await publishTextContribution(env, admission(`contribution:publish:${created.contribution}`,
      'contribution.publish', textPublicationDigest(input), author), input);
    if (result.outcome !== 'succeeded' || !result.publicationDecision) throw new Error('publication failed');
    return { contribution: created.contribution, decision: result.publicationDecision };
  }
  async function generalWork(name: string) {
    const title = `Pro site ${name} ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const publication = await published(created.work, `${marker} general ${name}`);
    const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: publication.contribution, publicationDecision: publication.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const result = await selectMainDefault(env, admission(`publication:select:${created.mainVersion}`,
      'publication.select', mainSelectionDigest(input)), input);
    if (result.outcome !== 'succeeded') throw new Error('Main selection failed');
    return created;
  }

  const proRealm = await realm(`Pro ${marker}`);
  const emptyRealm = await realm(`Empty ${marker}`);
  const general = [await generalWork('one'), await generalWork('two'), await generalWork('three')];
  // The only local candidate: another author's version adopted by the Pro Realm.
  const alternative = await published(general[0]!.work, `${marker} pro reviewed edition`, otherAuthor);
  const adoption = { context: { kind: 'realm-local' as const, id: proRealm }, work: general[0]!.work,
    mainVersion: general[0]!.mainVersion, contribution: alternative.contribution,
    publicationDecision: alternative.decision, expectedSelectionHead: null,
    selectionBasis: 'realm-manager-review' as const, actingSubject: actor };
  const adopted = await selectRealmLocal(env, admission(`publication:adopt:${proRealm}`, 'publication.adopt',
    realmSelectionDigest(adoption)), adoption);
  if (adopted.outcome !== 'succeeded' || !adopted.selection || !adopted.matchUnit) throw new Error('adoption failed');

  const hosts = { pro: `pro-${randomUUID().slice(0, 8)}.rezics.test`, empty: `empty-${randomUUID().slice(0, 8)}.rezics.test`,
    retired: `retired-${randomUUID().slice(0, 8)}.rezics.test`, gated: `gated-${randomUUID().slice(0, 8)}.rezics.test` };
  async function site(host: string, realmId: string, lifecycle: 'active' | 'retired', requiredBenefit: string | null) {
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO site.definition (id, host, head_revision) VALUES ($1, $2, 1)', [id, host]);
      await client.query(`INSERT INTO site.definition_revision (site_id, revision, kind, realm, lifecycle,
        presentation_profile, required_benefit) VALUES ($1, 1, 'fixed-realm', $2, $3, 'pro', $4)`,
      [id, realmId, lifecycle, requiredBenefit]);
      await client.query('COMMIT');
    } finally { client.release(); }
    return id;
  }
  const proSite = await site(hosts.pro, proRealm, 'active', null);
  await site(hosts.empty, emptyRealm, 'active', null);
  await site(hosts.retired, proRealm, 'retired', null);
  await site(hosts.gated, proRealm, 'active', 'pro.read');

  async function query(body: Record<string, unknown>, bearer?: string) {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (bearer) headers.set('authorization', bearer);
    const response = await app.handle(new Request('http://main.local/v1/pro-sites/queries', { method: 'POST',
      headers, body: JSON.stringify({ profile: 'fixed-site-phrase-v1', phrase: marker, language: 'en', ...body }) }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  // The general Realm view of the same Realm includes Main-default fallback rows.
  const generalView = await app.handle(new Request('http://main.local/v1/queries', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'public-realm-phrase-v1',
      context: { kind: 'realm-local', id: proRealm }, phrase: marker, language: 'en' }) }));
  const generalRows = (await generalView.json() as { results: { reason: string }[] }).results;
  expect(generalRows.map(row => row.reason).sort()).toEqual(['main-fallback', 'main-fallback', 'realm-adoption']);

  const pro = await query({ site: hosts.pro });
  const selectedRows = (result: typeof pro) => result.body.results.map((row: Record<string, unknown>) => {
    const { score: _score, ...selection } = row;
    return selection;
  });
  expect(pro.status).toBe(200);
  expect(Object.keys(pro.body).sort()).toEqual(['complete', 'indexGeneration', 'profile', 'results', 'site',
    'sourcePosition', 'total']);
  expect(pro.body.site).toEqual({ id: proSite, host: hosts.pro, revision: '1', realm: proRealm });
  expect(pro.body).toMatchObject({ complete: true, total: 1 });
  expect(pro.body.results.map((row: Record<string, unknown>) => [row.work, row.contribution, row.selection,
    row.matchUnit])).toEqual([[general[0]!.work, alternative.contribution, adopted.selection, adopted.matchUnit]]);
  expect(pro.body.results[0]).not.toHaveProperty('reason');

  // An empty Realm is an empty complete result, never general content.
  const empty = await query({ site: hosts.empty });
  expect(empty.body).toMatchObject({ complete: true, total: 0, results: [] });

  // A new private draft and another general publication change neither result nor count.
  await draft(general[1]!.work, `${marker} private unpublished draft`);
  await generalWork('four');
  const again = await query({ site: hosts.pro });
  // Text scores may change when unrelated documents alter corpus statistics.
  expect([again.body.total, selectedRows(again)]).toEqual([pro.body.total, selectedRows(pro)]);
  expect((await query({ site: hosts.empty })).body).toMatchObject({ total: 0, results: [] });

  // The host fixes the boundary: no body field can name another context.
  const widened = await query({ site: hosts.pro, context: { kind: 'realm-local', id: emptyRealm } });
  expect(widened.status).toBe(400);
  expect((await query({ site: 'unknown.rezics.test' })).status).toBe(404);
  expect((await query({ site: hosts.retired })).status).toBe(404);

  // A gated site admits a reader only through a current commerce benefit.
  expect((await query({ site: hosts.gated })).status).toBe(401);
  const principalId = randomUUID();
  const reader = ID + randomUUID();
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
    [principalId, issuer, `reader-${principalId}`]);
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [reader]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principalId, reader, SUBSCRIBE_ACTION]);
  const bearer = `Bearer reader-${principalId}|work:read`;
  const denied = await query({ site: hosts.gated, reader }, bearer);
  expect([denied.status, denied.body.code]).toEqual([403, 'site_benefit_required']);
  const offering = randomUUID();
  const awardIssuer = ID + randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'institution')`, [awardIssuer]);
    await client.query(`INSERT INTO commerce.offering (id, seller, beneficiary_kind, head_revision)
      VALUES ($1, $2, 'person', 1)`, [offering, proRealm]);
    await client.query(`INSERT INTO commerce.offering_revision (offering_id, revision, lifecycle, definition_digest)
      VALUES ($1, 1, 'open', repeat('a', 64))`, [offering]);
    await client.query(`INSERT INTO commerce.plan_group (offering_id, group_key, semantics) VALUES ($1, 'pro', 'replaceable')`, [offering]);
    await client.query(`INSERT INTO commerce.plan (offering_id, offering_revision, plan_key, group_key, rank)
      VALUES ($1, 1, 'basic', 'pro', 1)`, [offering]);
    await client.query(`INSERT INTO commerce.plan_benefit (offering_id, offering_revision, plan_key, benefit_key, level)
      VALUES ($1, 1, 'basic', 'pro.read', 1)`, [offering]);
    const entitlement = randomUUID();
    await client.query(`INSERT INTO commerce.entitlement (id, beneficiary, source, offering_id, offering_revision,
        plan_key, award_issuer, award_reason, valid_from, valid_until, state, generation)
      VALUES ($1, $2, 'gift', $3, 1, 'basic', $4, 'fixture', now() - interval '1 minute', now() + interval '1 day', 'active', 1)`,
    [entitlement, reader, offering, awardIssuer]);
    await client.query(`INSERT INTO commerce.entitlement_event (entitlement_id, generation, action, state, valid_until)
      SELECT id, 1, 'grant', 'active', valid_until FROM commerce.entitlement WHERE id = $1`, [entitlement]);
    await client.query('COMMIT');
  } finally { client.release(); }
  const admitted = await query({ site: hosts.gated, reader }, bearer);
  expect(admitted.status).toBe(200);
  expect([admitted.body.total, selectedRows(admitted)]).toEqual([pro.body.total, selectedRows(pro)]);
  await pool.query('UPDATE access.recovery_fence SET open = false, generation = generation + 1');
  try {
    const held = await query({ site: hosts.gated, reader }, bearer);
    expect([held.status, held.body.code]).toEqual([503, 'site_unavailable']);
  } finally {
    await pool.query('UPDATE access.recovery_fence SET open = true, generation = generation + 1');
  }
  expect((await query({ site: hosts.gated, reader }, bearer)).status).toBe(200);
}, 180_000);
