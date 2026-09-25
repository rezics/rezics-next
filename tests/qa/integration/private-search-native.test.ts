import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionExpired, AdmissionUnavailable,
  engageAccessRecoveryFence, releaseAccessRecoveryFence, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { editTextContributionDraft, textContributionEditDigest }
  from '../../../services/main/src/modules/contribution/edit.ts';
import { readExactContributionDraft }
  from '../../../services/main/src/modules/contribution/history.ts';
import { privateDraftUnit, PRIVATE_SEARCH_GRAPH }
  from '../../../services/main/src/modules/contribution/private-projection.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { prepareAdmittedPrivateContributionPhrase, PrivateSearchUnavailable }
  from '../../../services/main/src/modules/contribution/search-private.ts';
import { activateMetadataWork, initializeFreshGraph, DATASET, GRAPHS, ID,
  metadataWorkRequestDigest, RV,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 4_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-4000)}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Access test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

class ObservedFuseki extends FusekiClient {
  readonly queries: string[] = [];
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    this.queries.push(sparql);
    return super.query(sparql, maxResponseBytes);
  }
}

test('SEARCH11/SEARCH12: native private field, exact source and durable read receipt', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-pn`;
  const stackOptions = { profile: 'qa' as const, runId, persistent: true };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent'];
  let stackStarted = false;
  const state = join(root, '.temp', `private-native-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  let fuseki!: ObservedFuseki;
  let env!: WorkActivationEnvironment;
  const config = { host: '127.0.0.1', port, user: process.env.USER,
    database: 'postgres', max: 4 };
  const pool = new Pool(config);
  const secondPool = new Pool(config);
  const access = new AccessAdmissionRegistry(pool);
  const second = new AccessAdmissionRegistry(secondPool);
  const actor = ID + randomUUID();
  const principal = { issuer: 'https://qa-private-search.test', subject: randomUUID() };
  const other = { issuer: principal.issuer, subject: randomUUID() };
  const principalId = randomUUID();
  const otherId = randomUUID();
  const visibleTerm = `visible${randomUUID().replaceAll('-', '')}`;
  const hiddenTerm = `hidden${randomUUID().replaceAll('-', '')}`;
  const visibleBody = `${visibleTerm} published body`;
  const hiddenBody = `${hiddenTerm} private body`;

  function admission(scope: string, action: string, digest: string): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId, actingSubject: actor, scope, action,
      idempotencyKey: `private-native-${id}`, requestDigest: digest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }
  async function lease() {
    const row = (await pool.query<{ id: string; state: string; send_started_at: Date | null }>(
      `SELECT id, state, send_started_at FROM access.search_read_lease
       WHERE scope_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [`contribution:read:${privateContribution}`])).rows[0];
    if (!row) throw new Error('private read lease was not recorded');
    return row;
  }
  async function publicPhrase(phrase: string) {
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase, language: 'en' }),
    }));
    expect(response.status).toBe(200);
    return response.json() as Promise<{ total: number; population: number;
      results: Array<{ score: number; contribution: string; revision: string }> }>;
  }
  function receipt(frame: string) {
    const parsed = JSON.parse(frame) as { type: string; leaseId: string;
      receiptChallenge: string; result: { total: number; complete: boolean;
        results: Array<{ matchUnit: string; revision: string; contribution: string }>;
        sourcePosition: { dataEpoch: string; sequence: string }; indexGeneration: string } };
    expect(parsed.type).toBe('private-contribution-result-v1');
    expect(parsed.receiptChallenge).toMatch(/^[0-9a-f]{64}$/);
    return parsed;
  }
  function acknowledge(value: ReturnType<typeof receipt>, challenge = value.receiptChallenge) {
    return JSON.stringify({ type: 'private-contribution-receipt-v1',
      leaseId: value.leaseId, receiptChallenge: challenge });
  }
  let privateContribution = '';
  let app!: ReturnType<typeof createMainApp>;
  try {
    stackStarted = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(join(stackDirectory(root, stackOptions), 'apps.env'));
    fuseki = new ObservedFuseki(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    env = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!,
      routingEpoch: apps.MAIN_ROUTING_EPOCH! }, objectDirectory: join(state, 'objects') };
    await initializeFreshGraph(fuseki, env.lineage);
    app = createMainApp(fuseki, { environment: env,
      account: { verify: async () => principal }, access });
    const migrations = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort()) {
      await pool.query(readFileSync(join(migrations, file), 'utf8'));
    }
    const title = `Private native search ${randomUUID()}`;
    const work = await activateMetadataWork(env, { title, admission:
      admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const publishedInput = { work: work.work, language: 'en', body: visibleBody,
      actingSubject: actor };
    const published = await activateTextContribution(env,
      admission(`contribution:create:${work.work}`, 'contribution.create',
        textContributionDigest(publishedInput)), publishedInput);
    if (!published.contribution || !published.draftRevision) throw new Error('public draft missing');
    const publicationInput = { contribution: published.contribution,
      expectedDraftHead: published.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: actor };
    const publication = await publishTextContribution(env,
      admission(`contribution:publish:${published.contribution}`, 'contribution.publish',
        textPublicationDigest(publicationInput)), publicationInput);
    if (!publication.publicationDecision) throw new Error('public publication missing');
    const selectionInput = { context: { kind: 'main-version-default' as const, id: work.mainVersion },
      work: work.work, contribution: published.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    await selectMainDefault(env,
      admission(`publication:select:${work.mainVersion}`, 'publication.select',
        mainSelectionDigest(selectionInput)), selectionInput);
    const publicBefore = await publicPhrase(visibleTerm);
    expect(publicBefore.total).toBe(1);
    expect(publicBefore.results[0]?.contribution).toBe(published.contribution);

    const privateInput = { work: work.work, language: 'en', body: hiddenBody,
      actingSubject: actor };
    const draft = await activateTextContribution(env,
      admission(`contribution:create:${work.work}`, 'contribution.create',
        textContributionDigest(privateInput)), privateInput);
    if (!draft.contribution || !draft.draftRevision) throw new Error('private draft missing');
    privateContribution = draft.contribution;
    const unit = privateDraftUnit(draft.draftRevision);
    const source = await readExactContributionDraft(env, privateContribution,
      draft.draftRevision, async () => true);
    expect(source).toMatchObject({ contribution: privateContribution,
      revision: draft.draftRevision, work: work.work, author: actor,
      body: hiddenBody, language: 'en',
      sourcePosition: { dataEpoch: env.lineage.dataEpoch } });
    const publicAfter = await publicPhrase(visibleTerm);
    expect(publicAfter.total).toBe(publicBefore.total);
    expect(publicAfter.population).toBe(publicBefore.population);
    // Lucene may rescore the same public hit after another unit is indexed.
    // The private draft must leave the public result identities unchanged.
    const identities = (rows: typeof publicAfter.results) => rows.map(row =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'score')));
    expect(identities(publicAfter.results)).toEqual(identities(publicBefore.results));
    for (const result of [...publicBefore.results, ...publicAfter.results]) {
      expect(result.score).toBeGreaterThan(0);
    }
    const hiddenPublic = await publicPhrase(hiddenTerm);
    expect(hiddenPublic.total).toBe(0);
    expect(hiddenPublic.results).toEqual([]);
    expect(JSON.stringify(hiddenPublic)).not.toContain(hiddenBody);
    expect(JSON.stringify(hiddenPublic)).not.toContain(hiddenTerm);
    expect(hiddenPublic).not.toHaveProperty('snippets');
    expect(hiddenPublic).not.toHaveProperty('facets');
    const rawPublic = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE {
        GRAPH <urn:rezics:search:public> {
          (?unit ?score) text:query (rv:searchBody ${JSON.stringify(`"${hiddenTerm}"`)} 2) .
        } }`);
    expect(rawPublic.results?.bindings).toEqual([]);
    const exact = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?body WHERE {
      GRAPH <${PRIVATE_SEARCH_GRAPH}> { <${unit}> a rv:MatchUnit ;
        rv:contribution <${privateContribution}> ; rv:revision <${draft.draftRevision}> ;
        rv:work <${work.work}> ; rv:field rv:Body ; rv:disclosure rv:Private ;
        rv:privateSearchBody ?body . } }`);
    expect(exact.results?.bindings.map(row => row.body?.value)).toEqual([hiddenBody]);
    const posting = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?literal ?graph ?predicate WHERE { GRAPH <${PRIVATE_SEARCH_GRAPH}> {
        (<${unit}> ?score ?literal ?graph ?predicate)
          text:query (rv:privateSearchBody "privateBody:*" 2) .
      } }`);
    expect(posting.results?.bindings).toMatchObject([{
      literal: { value: hiddenBody, 'xml:lang': 'en' },
      graph: { value: PRIVATE_SEARCH_GRAPH }, predicate: { value: `${RV}privateSearchBody` },
    }]);

    await pool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
    for (const [id, identity] of [[principalId, principal], [otherId, other]] as const) {
      await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, $2, $3)`, [id, identity.issuer, identity.subject]);
      await pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, 'contribution.read', now() + interval '1 hour')`,
      [randomUUID(), id, actor]);
    }
    const scope = `contribution:read:${privateContribution}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [randomUUID(), actor, scope]);

    fuseki.queries.length = 0;
    await expect(prepareAdmittedPrivateContributionPhrase(env, access,
      { ...principal, subject: 'unrepresented' }, actor,
      { contribution: privateContribution, phrase: hiddenTerm }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(fuseki.queries).toEqual([]);
    const session = await prepareAdmittedPrivateContributionPhrase(env, access,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
    const textQueries = fuseki.queries.filter(query => query.includes('text:query'));
    expect(textQueries).toHaveLength(2);
    for (const query of textQueries) {
      expect(query).toContain(`(<${unit}> ?score ?literal ?graph ?predicate)`);
      expect(query).toContain('rv:privateSearchBody');
      expect(query).toContain(`GRAPH <${PRIVATE_SEARCH_GRAPH}>`);
    }
    expect(textQueries[0]).toContain('privateBody:*');
    let frame = '';
    expect(await session.send(value => { frame = value; return Buffer.byteLength(value); }))
      .toBeGreaterThan(0);
    const delivered = receipt(frame);
    expect(delivered.result).toMatchObject({ complete: true, total: 1,
      results: [{ matchUnit: unit, revision: draft.draftRevision,
        contribution: privateContribution }],
      sourcePosition: { dataEpoch: env.lineage.dataEpoch } });
    expect(delivered.result.indexGeneration).toMatch(/^urn:rezics:text-index-generation:/);
    const nativePosition = await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?sequence ?generation WHERE { GRAPH <${GRAPHS.control}> {
        <${DATASET}> rv:sequence ?sequence ; rv:textIndexGeneration ?generation .
      } }`);
    expect(delivered.result.sourcePosition.sequence)
      .toBe(nativePosition.results?.bindings[0]?.sequence?.value);
    expect(delivered.result.indexGeneration)
      .toBe(nativePosition.results?.bindings[0]?.generation?.value);
    expect(JSON.stringify(delivered.result)).not.toMatch(/score|snippet|facet|population/);
    expect((await lease()).send_started_at).toBeTruthy();
    expect(await session.receipt(acknowledge(delivered, '00'.repeat(32)))).toBe(false);
    expect(await session.receipt(JSON.stringify({ type: 'private-contribution-receipt-v1',
      leaseId: randomUUID(), receiptChallenge: delivered.receiptChallenge }))).toBe(false);
    expect((await lease()).state).toBe('delivering');
    expect(await session.receipt(acknowledge(delivered))).toBe(true);
    expect(await session.receipt(acknowledge(delivered))).toBe(false);
    expect((await lease()).state).toBe('delivered');

    const stale = await prepareAdmittedPrivateContributionPhrase(env, second,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
    const editInput = { contribution: privateContribution, expectedHead: draft.draftRevision,
      body: `${hiddenTerm} revised body`, actingSubject: actor };
    const edit = await editTextContributionDraft(env,
      admission(`contribution:edit:${privateContribution}`, 'contribution.edit',
        textContributionEditDigest(editInput)), editInput);
    expect(edit.outcome).toBe('succeeded');
    let offered = false;
    await expect(stale.send(() => { offered = true; return 1; }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
    expect(offered).toBe(false);
    expect((await lease()).state).toBe('aborted');

    const expired = await prepareAdmittedPrivateContributionPhrase(env, access,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
    const expiringId = (await lease()).id;
    await pool.query(`UPDATE access.search_read_lease
      SET created_at = clock_timestamp() - interval '2 seconds',
          expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [expiringId]);
    await expect(expired.send(() => { offered = true; return 1; }))
      .rejects.toBeInstanceOf(AdmissionExpired);
    expect(offered).toBe(false);
    expect((await pool.query<{ state: string }>(
      'SELECT state FROM access.search_read_lease WHERE id = $1', [expiringId])).rows[0]?.state)
      .toBe('aborted');

    const held = await prepareAdmittedPrivateContributionPhrase(env, access,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
    const holdId = (await lease()).id;
    const holdGeneration = await engageAccessRecoveryFence(pool);
    try {
      await expect(held.send(() => { offered = true; return 1; }))
        .rejects.toBeInstanceOf(AdmissionUnavailable);
      expect(offered).toBe(false);
      expect((await pool.query<{ state: string }>(
        'SELECT state FROM access.search_read_lease WHERE id = $1', [holdId])).rows[0]?.state)
        .toBe('aborted');
    } finally {
      await releaseAccessRecoveryFence(pool, holdGeneration);
    }

    const principalSession = await prepareAdmittedPrivateContributionPhrase(env, second,
      other, actor, { contribution: privateContribution, phrase: hiddenTerm });
    const deactivated = await access.strongDeactivatePrincipal(otherId, '0');
    expect(deactivated.pendingReads).toBe(0);
    expect((await lease()).state).toBe('aborted');
    await expect(principalSession.send(() => { offered = true; return 1; }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(offered).toBe(false);

    const unarmed = await prepareAdmittedPrivateContributionPhrase(env, access,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
    expect(await unarmed.disconnect()).toBe('aborted');
    expect((await lease()).state).toBe('aborted');

    const uncertain = await prepareAdmittedPrivateContributionPhrase(env, second,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
    let uncertainFrame = '';
    await uncertain.send(value => { uncertainFrame = value; return 0; });
    const pending = receipt(uncertainFrame);
    expect(await uncertain.disconnect()).toBe('unresolved');
    expect((await lease()).state).toBe('delivering');
    expect((await lease()).send_started_at).toBeTruthy();
    expect((await second.unresolvedContributionSearchDeliveries())
      .some(row => row.id === pending.leaseId && row.sendStartedAt !== null)).toBe(true);

    // Interpose a real Access closure exactly between the native final check
    // and Access's durable send arm. No transport callback may run.
    const armFence = new AccessAdmissionRegistry(secondPool);
    const arm = armFence.armContributionSearchSend.bind(armFence);
    let closurePending = -1;
    armFence.armContributionSearchSend = async (id, token) => {
      closurePending = (await access.strongCloseScope(scope, '0')).pendingReads;
      await arm(id, token);
    };
    const fenced = await prepareAdmittedPrivateContributionPhrase(env, armFence,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
    offered = false;
    await expect(fenced.send(() => { offered = true; return 1; }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(offered).toBe(false);
    expect(closurePending).toBe(2);
    expect((await lease()).state).toBe('aborted');
    await expect(prepareAdmittedPrivateContributionPhrase(env, access,
      principal, actor, { contribution: privateContribution, phrase: hiddenTerm }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect((await access.strongCloseScope(scope, '1')).pendingReads).toBe(1);
    expect((await second.unresolvedContributionSearchDeliveries())
      .some(row => row.id === pending.leaseId && row.sendStartedAt !== null)).toBe(true);

    const queriesBeforeRoute = fuseki.queries.length;
    const leasesBeforeRoute = (await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM access.search_read_lease')).rows[0]?.count;
    const route = await app.handle(new Request('http://main.local/v1/private-queries', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer qa' },
      body: JSON.stringify({ profile: 'private-contribution-phrase-v1',
        contribution: privateContribution, actingSubject: actor, phrase: hiddenTerm }),
    }));
    expect(route.status).toBe(503);
    expect((await route.json()).code).toBe('private_search_unavailable');
    expect(fuseki.queries).toHaveLength(queriesBeforeRoute);
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM access.search_read_lease')).rows[0]?.count)
      .toBe(leasesBeforeRoute);
  } finally {
    await secondPool.end();
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state }); }
    finally {
      rmSync(state, { recursive: true, force: true });
      if (stackStarted) rootCommand(['stack:reset', ...stackArgs], 120_000);
    }
  }
}, 120_000);
