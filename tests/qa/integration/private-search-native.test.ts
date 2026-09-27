import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionExpired, AdmissionUnavailable,
  engageAccessRecoveryFence, releaseAccessRecoveryFence, type RegisteredAdmission,
  type StrongScopeClosure, type VerifiedPrincipal }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { editTextContributionDraft, textContributionEditDigest }
  from '../../../services/main/src/modules/contribution/edit.ts';
import { readExactContributionDraft }
  from '../../../services/main/src/modules/contribution/history.ts';
import { privateDraftUnit, PRIVATE_SEARCH_GRAPH }
  from '../../../services/main/src/modules/contribution/private-projection.ts';
import { PRIVATE_SEARCH_SEND_WINDOW_MS, PrivateSearchSettlement }
  from '../../../services/main/src/modules/contribution/private-search-settlement.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { PRIVATE_SEARCH_FINAL_FUSEKI_CALLS, PRIVATE_SEARCH_FUSEKI_CALLS,
  prepareAdmittedPrivateContributionPhrase, PrivateSearchUnavailable, type PrivateSearchAccess }
  from '../../../services/main/src/modules/contribution/search-private.ts';
import { activateMetadataWork, initializeFreshGraph, DATASET, GRAPHS, ID,
  metadataWorkRequestDigest, RV,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { searchRoutes, type SearchRouteDependencies }
  from '../../../services/main/src/routes/search.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync(...scriptCommand(args), { cwd: root,
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

/** Counts every Main-to-Fuseki read, including the command-health fence. */
class ObservedFuseki extends FusekiClient {
  readonly queries: string[] = [];
  health = 0;
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    this.queries.push(sparql);
    return super.query(sparql, maxResponseBytes);
  }
  override async commandHealth() {
    this.health++;
    return super.commandHealth();
  }
}

const runId = `${Bun.env.REZICS_QA_RUN_ID}-pn`;
const stackOptions = { profile: 'qa' as const, runId, persistent: true };
const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent'];
const state = join(root, '.temp', `private-native-${randomUUID()}`);
const data = join(state, 'pgdata');
const actor = ID + randomUUID();
const principal: VerifiedPrincipal = { issuer: 'https://qa-private-search.test', subject: randomUUID() };
const other: VerifiedPrincipal = { issuer: principal.issuer, subject: randomUUID() };
const principalId = randomUUID();
const otherId = randomUUID();
let stackStarted = false;
let postgresStarted = false;
let accessConfig!: { host: string; port: number; user: string | undefined; database: string; max: number };
let pool!: Pool;
let secondPool!: Pool;
let access!: AccessAdmissionRegistry;
let second!: AccessAdmissionRegistry;
let settlement!: PrivateSearchSettlement;
let secondSettlement!: PrivateSearchSettlement;
let fuseki!: ObservedFuseki;
let env!: WorkActivationEnvironment;
let app!: ReturnType<typeof createMainApp>;

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  postgresStarted = true;
  // Two pools stand in for two Main replicas sharing the Access owner.
  accessConfig = { host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 4 };
  pool = new Pool(accessConfig);
  secondPool = new Pool(accessConfig);
  access = new AccessAdmissionRegistry(pool);
  second = new AccessAdmissionRegistry(secondPool);
  settlement = new PrivateSearchSettlement(pool);
  secondSettlement = new PrivateSearchSettlement(secondPool);
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
  await pool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
  for (const [id, identity] of [[principalId, principal], [otherId, other]] as const) {
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [id, identity.issuer, identity.subject]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [randomUUID(), id, actor]);
  }
}, 240_000);

afterAll(async () => {
  await secondPool?.end();
  await pool?.end();
  try {
    if (postgresStarted) execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
  } finally {
    rmSync(state, { recursive: true, force: true });
    if (stackStarted) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 180_000);

function admission(scope: string, action: string, digest: string): RegisteredAdmission {
  const id = randomUUID();
  return { id, principalId, actingSubject: actor, scope, action,
    idempotencyKey: `private-native-${id}`, requestDigest: digest, authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: false };
}

async function createWork(title: string) {
  return activateMetadataWork(env, { title, admission:
    admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
}

async function privateDraft(work: string, body: string) {
  const input = { work, language: 'en', body, actingSubject: actor };
  const draft = await activateTextContribution(env,
    admission(`contribution:create:${work}`, 'contribution.create',
      textContributionDigest(input)), input);
  if (!draft.contribution || !draft.draftRevision) throw new Error('private draft missing');
  return { contribution: draft.contribution, revision: draft.draftRevision };
}

async function editDraft(contribution: string, expectedHead: string, body: string) {
  const input = { contribution, expectedHead, body, actingSubject: actor };
  return editTextContributionDraft(env, admission(`contribution:edit:${contribution}`,
    'contribution.edit', textContributionEditDigest(input)), input);
}

/** Opens the exact Contribution read scope and grants it to the acting Agent. */
async function openReadScope(contribution: string, grant = true): Promise<string> {
  const scope = `contribution:read:${contribution}`;
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  if (grant) {
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [randomUUID(), actor, scope]);
  }
  return scope;
}

async function latestLease(scope: string) {
  const row = (await pool.query<{ id: string; state: string; send_started_at: Date | null;
    settled_by: string | null; finished_at: Date | null }>(
    `SELECT id, state, send_started_at, settled_by, finished_at FROM access.search_read_lease
     WHERE scope_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [scope])).rows[0];
  if (!row) throw new Error('private read lease was not recorded');
  return row;
}

/** The server records a deadline settlement just after terminating the socket. */
async function terminalLease(scope: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = await latestLease(scope);
    if (row.state !== 'delivering') return row;
    await Bun.sleep(20);
  }
  throw new Error('private read lease did not settle');
}

type ResultMessage = { type: string; leaseId: string; receiptChallenge: string;
  result: { total: number; complete: boolean;
    results: Array<{ matchUnit: string; revision: string; contribution: string }>;
    sourcePosition: { dataEpoch: string; sequence: string }; indexGeneration: string } };

function receipt(frame: string): ResultMessage {
  const parsed = JSON.parse(frame) as ResultMessage;
  expect(parsed.type).toBe('private-contribution-result-v1');
  expect(parsed.receiptChallenge).toMatch(/^[0-9a-f]{64}$/);
  return parsed;
}

function acknowledge(value: ResultMessage, challenge = value.receiptChallenge) {
  return JSON.stringify({ type: 'private-contribution-receipt-v1',
    leaseId: value.leaseId, receiptChallenge: challenge });
}

/** The claimed search route on a real Bun socket, with the given replica owners. */
function socketServer(owner: PrivateSearchAccess, settle: PrivateSearchSettlement, receiptMs?: number) {
  const server = new Elysia().use(searchRoutes(fuseki, {
    environment: env, access,
    account: { verify: async (request: Request) => {
      const token = request.headers.get('authorization');
      if (token === 'Bearer reader') return principal;
      if (token === 'Bearer other') return other;
      throw new AccountAssertionDenied('unknown QA token');
    } },
    privateSearch: { access: owner, settlement: settle, receiptMs },
  } as unknown as SearchRouteDependencies));
  server.listen({ hostname: '127.0.0.1', port: 0 });
  return { server, port: server.server!.port! };
}

/** One socket query; the client answers the exact receipt challenge when asked. */
async function socketQuery(port: number, contribution: string, phrase: string,
  answer: boolean, token = 'reader') {
  const client = new WebSocket(`ws://127.0.0.1:${port}/v1/private-queries`,
    { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  const messages: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error('private socket did not close')), 20_000);
    client.onclose = event => {
      clearTimeout(timer);
      resolveClose({ code: event.code, reason: event.reason });
    };
  });
  client.onopen = () => client.send(JSON.stringify({ type: 'private-contribution-query-v1',
    profile: 'private-contribution-phrase-v1', contribution, actingSubject: actor, phrase }));
  client.onmessage = event => {
    const text = String(event.data);
    messages.push(text);
    const value = JSON.parse(text) as ResultMessage;
    if (answer && value.type === 'private-contribution-result-v1') client.send(acknowledge(value));
  };
  return { messages, close: await closed };
}

test('SEARCH11/SEARCH12: native private field, exact source and durable read receipt', async () => {
  const visibleTerm = `visible${randomUUID().replaceAll('-', '')}`;
  const hiddenTerm = `hidden${randomUUID().replaceAll('-', '')}`;
  const visibleBody = `${visibleTerm} published body`;
  const hiddenBody = `${hiddenTerm} private body`;
  async function publicPhrase(phrase: string) {
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase, language: 'en' }),
    }));
    if (response.status !== 200) throw new Error(`public phrase ${response.status}: ${await response.text()}`);
    return response.json() as Promise<{ total: number; population: number;
      results: Array<{ score: number; contribution: string; revision: string }> }>;
  }
  const work = await createWork(`Private native search ${randomUUID()}`);
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
  const hiddenBefore = await publicPhrase(hiddenTerm);
  expect(hiddenBefore.total).toBe(0);
  expect(hiddenBefore.results).toEqual([]);

  const draft = await privateDraft(work.work, hiddenBody);
  const privateContribution = draft.contribution;
  const unit = privateDraftUnit(draft.revision);
  const source = await readExactContributionDraft(env, privateContribution,
    draft.revision, async () => true);
  expect(source).toMatchObject({ contribution: privateContribution,
    revision: draft.revision, work: work.work, author: actor,
    body: hiddenBody, language: 'en',
    sourcePosition: { dataEpoch: env.lineage.dataEpoch } });
  const publicAfter = await publicPhrase(visibleTerm);
  expect(publicAfter.total).toBe(publicBefore.total);
  expect(publicAfter.population).toBe(publicBefore.population);
  expect(publicAfter.results).toEqual(publicBefore.results);
  for (const result of [...publicBefore.results, ...publicAfter.results]) {
    expect(result.score).toBeGreaterThan(0);
  }
  const hiddenPublic = await publicPhrase(hiddenTerm);
  expect(hiddenPublic.total).toBe(hiddenBefore.total);
  expect(hiddenPublic.population).toBe(hiddenBefore.population);
  expect(hiddenPublic.results).toEqual(hiddenBefore.results);
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
      rv:contribution <${privateContribution}> ; rv:revision <${draft.revision}> ;
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

  const scope = await openReadScope(privateContribution);
  const lease = () => latestLease(scope);
  fuseki.queries.length = 0;
  await expect(prepareAdmittedPrivateContributionPhrase(env, access, settlement,
    { ...principal, subject: 'unrepresented' }, actor,
    { contribution: privateContribution, phrase: hiddenTerm }))
    .rejects.toBeInstanceOf(AdmissionDenied);
  expect(fuseki.queries).toEqual([]);
  const session = await prepareAdmittedPrivateContributionPhrase(env, access, settlement,
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
    results: [{ matchUnit: unit, revision: draft.revision,
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

  // The final native check follows the durable arm; a moved head withholds.
  const stale = await prepareAdmittedPrivateContributionPhrase(env, second, secondSettlement,
    principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
  expect((await editDraft(privateContribution, draft.revision,
    `${hiddenTerm} revised body`)).outcome).toBe('succeeded');
  let offered = false;
  await expect(stale.send(() => { offered = true; return 1; }))
    .rejects.toBeInstanceOf(PrivateSearchUnavailable);
  expect(offered).toBe(false);
  expect(await lease()).toMatchObject({ state: 'withheld', settled_by: 'session' });
  expect((await lease()).send_started_at).toBeTruthy();

  const expired = await prepareAdmittedPrivateContributionPhrase(env, access, settlement,
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

  const held = await prepareAdmittedPrivateContributionPhrase(env, access, settlement,
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
    secondSettlement, other, actor, { contribution: privateContribution, phrase: hiddenTerm });
  const deactivated = await access.strongDeactivatePrincipal(otherId, '0');
  expect(deactivated.pendingReads).toBe(0);
  expect((await lease()).state).toBe('aborted');
  await expect(principalSession.send(() => { offered = true; return 1; }))
    .rejects.toBeInstanceOf(AdmissionDenied);
  expect(offered).toBe(false);

  const unarmed = await prepareAdmittedPrivateContributionPhrase(env, access, settlement,
    principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
  expect(await unarmed.disconnect()).toBe('aborted');
  expect((await lease()).state).toBe('aborted');

  // A zero send status may still have emitted bytes: never an abort, but a
  // terminal possible delivery once the transport stops handing bytes over.
  const uncertain = await prepareAdmittedPrivateContributionPhrase(env, second,
    secondSettlement, principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
  let uncertainFrame = '';
  await uncertain.send(value => { uncertainFrame = value; return 0; });
  const pending = receipt(uncertainFrame);
  expect(await uncertain.disconnect()).toBe('unconfirmed');
  expect(await lease()).toMatchObject({ id: pending.leaseId, state: 'unconfirmed',
    settled_by: 'session' });
  expect((await second.unresolvedContributionSearchDeliveries())
    .some(row => row.id === pending.leaseId)).toBe(false);

  // Interpose a real Access closure exactly between delivery begin and the
  // durable send arm. No transport callback may run.
  const armFence = new AccessAdmissionRegistry(secondPool);
  const arm = armFence.armContributionSearchSend.bind(armFence);
  let closurePending = -1;
  armFence.armContributionSearchSend = async (id, token) => {
    closurePending = (await access.strongCloseScope(scope, '0')).pendingReads;
    await arm(id, token);
  };
  const fenced = await prepareAdmittedPrivateContributionPhrase(env, armFence, secondSettlement,
    principal, actor, { contribution: privateContribution, phrase: hiddenTerm });
  offered = false;
  await expect(fenced.send(() => { offered = true; return 1; }))
    .rejects.toBeInstanceOf(AdmissionDenied);
  expect(offered).toBe(false);
  expect(closurePending).toBe(1);
  expect((await lease()).state).toBe('aborted');
  await expect(prepareAdmittedPrivateContributionPhrase(env, access, settlement,
    principal, actor, { contribution: privateContribution, phrase: hiddenTerm }))
    .rejects.toBeInstanceOf(AdmissionDenied);
  // Every armed row is terminal, so the strong closure completes.
  expect((await access.strongCloseScope(scope, '1')).pendingReads).toBe(0);

  // A replica without delivery owners keeps the HTTP profile closed.
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
}, 120_000);

test('SEARCH11: a hidden matching body beside a visible nonmatching one stays hidden until visibility reverses', async () => {
  const term = `nebula${randomUUID().replaceAll('-', '')}`;
  const work = await createWork(`Private visibility ${randomUUID()}`);
  const visible = await privateDraft(work.work, 'visible draft body without the searched term');
  const hidden = await privateDraft(work.work, `${term} hidden draft body`);
  const visibleScope = await openReadScope(visible.contribution);
  await openReadScope(hidden.contribution, false);
  const { server, port } = socketServer(access, settlement);
  try {
    const queriesBefore = fuseki.queries.length;
    const deniedMatch = await socketQuery(port, hidden.contribution, term, true);
    const deniedMiss = await socketQuery(port, hidden.contribution, 'absent phrase', true);
    // Access denies before any graph or Lucene call; the problem is identical
    // whether the hidden body matches or not.
    expect(fuseki.queries.length).toBe(queriesBefore);
    expect(deniedMatch).toEqual(deniedMiss);
    expect(deniedMatch.close).toEqual({ code: 4403, reason: 'authority_denied' });
    expect(deniedMatch.messages.map(message => JSON.parse(message))).toEqual([{ type: 'problem',
      status: 403, code: 'authority_denied', title: 'Authority is not admitted' }]);

    const visibleRead = await socketQuery(port, visible.contribution, term, true);
    expect(visibleRead.close).toEqual({ code: 1000, reason: 'delivered' });
    const visibleResult = receipt(visibleRead.messages[0]!);
    expect(visibleResult.result).toMatchObject({ complete: true, total: 0, results: [] });
    expect(visibleRead.messages[0]).not.toContain(hidden.contribution);
    expect(visibleRead.messages[0]).not.toMatch(/score|snippet|facet|population|count/);
    expect((await latestLease(visibleScope)).state).toBe('delivered');

    // Reverse visibility: close the visible scope and grant the hidden one.
    expect((await second.strongCloseScope(visibleScope, '0')).pendingReads).toBe(0);
    await openReadScope(hidden.contribution);
    const hiddenRead = await socketQuery(port, hidden.contribution, term, true);
    expect(hiddenRead.close).toEqual({ code: 1000, reason: 'delivered' });
    expect(receipt(hiddenRead.messages[0]!).result).toMatchObject({ complete: true, total: 1,
      results: [{ contribution: hidden.contribution, revision: hidden.revision,
        matchUnit: privateDraftUnit(hidden.revision) }] });
    const visibleDenied = await socketQuery(port, visible.contribution, term, true);
    expect(visibleDenied).toEqual(deniedMatch);
  } finally { await server.stop(); }
}, 60_000);

test('SEARCH11: a hidden-match-heavy private corpus keeps one concrete-subject posting at fixed cost', async () => {
  const term = `quasar${randomUUID().replaceAll('-', '')}`;
  const work = await createWork(`Private corpus ${randomUUID()}`);
  // Dense short decoys outrank the target, so a capped query that joined the
  // subject after Lucene's top two would lose the target.
  const target = await privateDraft(work.work, `${term} ${'long filler text '.repeat(120)}`);
  const unit = privateDraftUnit(target.revision);
  await openReadScope(target.contribution);
  const costs: Array<{ decoys: number; queries: number; health: number }> = [];
  let decoys = 0;
  for (const size of [0, 3, 12]) {
    while (decoys < size) {
      await privateDraft(work.work, `${term} ${term} ${term}`);
      decoys++;
    }
    const unbound = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE {
        GRAPH <${PRIVATE_SEARCH_GRAPH}> {
          (?unit ?score) text:query (rv:privateSearchBody ${JSON.stringify(`"${term}"`)} 2) .
        } }`);
    const capped = unbound.results?.bindings.map(row => row.unit?.value) ?? [];
    expect(capped).toHaveLength(Math.min(2, size + 1));
    if (size >= 2) expect(capped).not.toContain(unit);
    const queries = fuseki.queries.length;
    const health = fuseki.health;
    const session = await prepareAdmittedPrivateContributionPhrase(env, access, settlement,
      principal, actor, { contribution: target.contribution, phrase: term });
    let frame = '';
    await session.send(value => { frame = value; return Buffer.byteLength(value); });
    const delivered = receipt(frame);
    expect(delivered.result).toMatchObject({ complete: true, total: 1,
      results: [{ matchUnit: unit, contribution: target.contribution }] });
    expect(await session.receipt(acknowledge(delivered))).toBe(true);
    const observed = fuseki.queries.slice(queries);
    for (const query of observed.filter(value => value.includes('text:query'))) {
      expect(query).toContain(`(<${unit}> ?score ?literal ?graph ?predicate)`);
    }
    costs.push({ decoys: size, queries: observed.length, health: fuseki.health - health });
  }
  // Hidden matching units change neither the result nor the per-request work.
  expect(new Set(costs.map(cost => `${cost.queries}/${cost.health}`)).size).toBe(1);
  expect(costs[0]!.queries + costs[0]!.health)
    .toBeLessThanOrEqual(PRIVATE_SEARCH_FUSEKI_CALLS + PRIVATE_SEARCH_FINAL_FUSEKI_CALLS);
}, 120_000);

test('SEARCH12: a closure on another replica after the arm stays pending until the offer settles', async () => {
  const term = `pulsar${randomUUID().replaceAll('-', '')}`;
  const work = await createWork(`Private replica race ${randomUUID()}`);

  // Closure lands after the durable arm: the offer proceeds, the closure
  // counts it pending, and completes only after the exact receipt.
  const delivered = await privateDraft(work.work, `${term} delivered body`);
  const deliveredScope = await openReadScope(delivered.contribution);
  const afterArm = new AccessAdmissionRegistry(pool);
  const arm = afterArm.armContributionSearchSend.bind(afterArm);
  let closure: StrongScopeClosure | undefined;
  afterArm.armContributionSearchSend = async (id, token) => {
    await arm(id, token);
    closure = await second.strongCloseScope(deliveredScope, '0');
  };
  let replica = socketServer(afterArm, settlement);
  try {
    const read = await socketQuery(replica.port, delivered.contribution, term, true);
    expect(closure?.pendingReads).toBe(1);
    expect(read.close).toEqual({ code: 1000, reason: 'delivered' });
    expect(receipt(read.messages[0]!).result.total).toBe(1);
    expect((await second.strongCloseScope(deliveredScope, '1')).pendingReads).toBe(0);
    expect((await latestLease(deliveredScope)).state).toBe('delivered');
    const after = await socketQuery(replica.port, delivered.contribution, term, true);
    expect(after.close).toEqual({ code: 4403, reason: 'authority_denied' });
  } finally { await replica.server.stop(); }

  // A graph edit between the arm and the final native check withholds.
  const edited = await privateDraft(work.work, `${term} edited body`);
  const editedScope = await openReadScope(edited.contribution);
  const editAfterArm = new AccessAdmissionRegistry(pool);
  const editArm = editAfterArm.armContributionSearchSend.bind(editAfterArm);
  editAfterArm.armContributionSearchSend = async (id, token) => {
    await editArm(id, token);
    expect((await editDraft(edited.contribution, edited.revision, `${term} moved body`)).outcome)
      .toBe('succeeded');
  };
  replica = socketServer(editAfterArm, settlement);
  try {
    const read = await socketQuery(replica.port, edited.contribution, term, true);
    expect(read.close).toEqual({ code: 4503, reason: 'private_search_unavailable' });
    expect(read.messages.map(message => JSON.parse(message).type)).toEqual(['problem']);
    expect(await latestLease(editedScope)).toMatchObject({ state: 'withheld', settled_by: 'session' });
    expect((await second.strongCloseScope(editedScope, '0')).pendingReads).toBe(0);
  } finally { await replica.server.stop(); }

  // A client withholding its receipt is terminated at the deadline, then settled.
  const silent = await privateDraft(work.work, `${term} silent body`);
  const silentScope = await openReadScope(silent.contribution);
  replica = socketServer(access, settlement, 300);
  try {
    const read = await socketQuery(replica.port, silent.contribution, term, false);
    expect(receipt(read.messages[0]!).result.total).toBe(1);
    expect(read.close.code).toBe(1006);
    const settled = await terminalLease(silentScope);
    expect(settled).toMatchObject({ state: 'unconfirmed', settled_by: 'session' });
    expect(settled.finished_at!.getTime() - settled.send_started_at!.getTime())
      .toBeLessThan(PRIVATE_SEARCH_SEND_WINDOW_MS);
    expect((await second.strongCloseScope(silentScope, '0')).pendingReads).toBe(0);
  } finally { await replica.server.stop(); }
}, 90_000);

test('SEARCH12: rows abandoned by a lost replica are swept after the send window, releasing closure and recovery', async () => {
  const term = `magnetar${randomUUID().replaceAll('-', '')}`;
  const work = await createWork(`Private replica loss ${randomUUID()}`);
  const draft = await privateDraft(work.work, `${term} abandoned body`);
  const scope = await openReadScope(draft.contribution);
  // Replica 2 arms and offers, then vanishes without settling its row.
  const lost = await prepareAdmittedPrivateContributionPhrase(env, second, secondSettlement,
    principal, actor, { contribution: draft.contribution, phrase: term });
  let lostFrame = '';
  await lost.send(value => { lostFrame = value; return Buffer.byteLength(value); });
  const armed = receipt(lostFrame).leaseId;
  // Another lease began delivery but its replica died before the arm.
  const unarmed = await second.admitContributionSearchRead(principal, actor, draft.contribution);
  await second.beginContributionSearchDelivery(unarmed.id, principal, actor, draft.contribution);
  expect((await access.strongCloseScope(scope, '0')).pendingReads).toBe(2);
  const hold = await engageAccessRecoveryFence(pool);
  await expect(releaseAccessRecoveryFence(pool, hold)).rejects.toBeInstanceOf(AdmissionUnavailable);
  expect(await settlement.sweep(100)).toEqual({ unconfirmed: [], aborted: [] });
  // Migration 160 itself refuses an early window label, and only the arming
  // challenge can settle a row for its session.
  await expect(pool.query(`UPDATE access.search_read_lease
    SET state = 'unconfirmed', settled_by = 'window', finished_at = clock_timestamp()
    WHERE id = $1`, [armed])).rejects.toThrow('search_read_settlement');
  expect(await settlement.settle(armed, '00'.repeat(32), 'withheld')).toBeNull();
  expect((await pool.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint
     WHERE conrelid = 'access.search_read_lease'::regclass
       AND conname IN ('search_read_settlement', 'search_read_terminal_send')
     ORDER BY conname`)).rows).toEqual([
    { conname: 'search_read_settlement', convalidated: true },
    { conname: 'search_read_terminal_send', convalidated: false },
  ]);
  // Model elapsed time on the Access clock only.
  await pool.query(`UPDATE access.search_read_lease
    SET send_started_at = send_started_at - interval '31 seconds' WHERE id = $1`, [armed]);
  await pool.query(`UPDATE access.search_read_lease
    SET created_at = clock_timestamp() - interval '12 seconds',
        delivery_started_at = clock_timestamp() - interval '11 seconds',
        expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [unarmed.id]);
  // Any replica's next private query sweeps before its own admission, even
  // while the recovery hold still refuses that admission.
  const { server, port } = socketServer(access, settlement);
  try {
    const refused = await socketQuery(port, draft.contribution, term, true);
    expect(refused.close).toEqual({ code: 4503, reason: 'dependency_unavailable' });
  } finally { await server.stop(); }
  const rows = await pool.query<{ id: string; state: string; settled_by: string | null }>(
    'SELECT id, state, settled_by FROM access.search_read_lease WHERE id = ANY($1::uuid[])',
    [[armed, unarmed.id]]);
  expect(Object.fromEntries(rows.rows.map(row => [row.id, [row.state, row.settled_by]]))).toEqual({
    [armed]: ['unconfirmed', 'window'], [unarmed.id]: ['aborted', null] });
  await releaseAccessRecoveryFence(pool, hold);
  expect((await access.strongCloseScope(scope, '1')).pendingReads).toBe(0);
  // A late receipt cannot relabel the possible delivery.
  expect(await lost.receipt(acknowledge(receipt(lostFrame)))).toBe(false);
  expect((await pool.query<{ state: string }>(
    'SELECT state FROM access.search_read_lease WHERE id = $1', [armed])).rows[0]?.state)
    .toBe('unconfirmed');
}, 60_000);

test('SEARCH12: migration 160 keeps historical outcomes and in-flight arms across the upgrade', async () => {
  const database = `upgrade_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${database}`);
  const upgrade = new Pool({ ...accessConfig, database, max: 2 });
  try {
    const migrations = join(root, 'services/main/migrations/access');
    const files = [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort();
    const apply = async (select: (file: string) => boolean) => {
      for (const file of files.filter(select)) {
        await upgrade.query(readFileSync(join(migrations, file), 'utf8'));
      }
    };
    await apply(file => file < '010');
    const reader = randomUUID();
    const identity = { issuer: principal.issuer, subject: randomUUID() };
    const contribution = ID + randomUUID();
    const scope = `contribution:read:${contribution}`;
    await upgrade.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
    await upgrade.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [reader, identity.issuer, identity.subject]);
    await upgrade.query(`INSERT INTO access.representation (id, principal_id, subject_id, action,
      valid_until) VALUES ($1, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [randomUUID(), reader, actor]);
    await upgrade.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await upgrade.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [randomUUID(), actor, scope]);
    const registry = new AccessAdmissionRegistry(upgrade);
    // A 009 terminal outcome that predates receipts.
    const historical = await registry.admitContributionSearchRead(identity, actor, contribution);
    await registry.beginContributionSearchDelivery(historical.id, identity, actor, contribution);
    await upgrade.query(`UPDATE access.search_read_lease SET state = 'delivered',
      finished_at = clock_timestamp() WHERE id = $1`, [historical.id]);
    await apply(file => file >= '010' && file < '160');
    // A delivery armed under 010 whose session is still live during the upgrade.
    const inflight = await registry.admitContributionSearchRead(identity, actor, contribution);
    await registry.beginContributionSearchDelivery(inflight.id, identity, actor, contribution);
    const token = 'ab'.repeat(32);
    await registry.armContributionSearchSend(inflight.id, token);
    await apply(file => file >= '160' && file < '170');
    const sweepIndexes = await upgrade.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'access'
       AND indexname IN ('search_read_armed_window', 'search_read_unarmed_expiry')
       ORDER BY indexname`);
    expect(sweepIndexes.rows.map(row => row.indexname)).toEqual([
      'search_read_armed_window', 'search_read_unarmed_expiry']);
    expect(sweepIndexes.rows[0]?.indexdef).toContain('send_started_at IS NOT NULL');
    expect(sweepIndexes.rows[1]?.indexdef).toContain('send_started_at IS NULL');
    const rows = await upgrade.query<{ id: string; state: string; send_started_at: Date | null;
      settled_by: string | null }>(`SELECT id, state, send_started_at, settled_by
      FROM access.search_read_lease WHERE id = ANY($1::uuid[])`, [[historical.id, inflight.id]]);
    const byId = new Map(rows.rows.map(row => [row.id, row]));
    expect(byId.get(historical.id)).toMatchObject({ state: 'delivered', send_started_at: null,
      settled_by: null });
    expect(byId.get(inflight.id)).toMatchObject({ state: 'delivering', settled_by: null });
    expect(await new PrivateSearchSettlement(upgrade).settle(inflight.id, token, 'unconfirmed'))
      .toBe('unconfirmed');
    // New rows still cannot claim delivery without the 010 send marker.
    const unarmed = await registry.admitContributionSearchRead(identity, actor, contribution);
    await registry.beginContributionSearchDelivery(unarmed.id, identity, actor, contribution);
    await expect(upgrade.query(`UPDATE access.search_read_lease SET state = 'delivered',
      finished_at = clock_timestamp() WHERE id = $1`, [unarmed.id]))
      .rejects.toThrow('search_read_terminal_send');
    await expect(upgrade.query(`UPDATE access.search_read_lease SET state = 'withheld',
      settled_by = 'session', finished_at = clock_timestamp() WHERE id = $1`, [unarmed.id]))
      .rejects.toThrow('search_read_terminal_send');
    await registry.finishContributionSearchRead(unarmed.id, 'aborted');
  } finally {
    await upgrade.end();
    await pool.query(`DROP DATABASE ${database}`);
  }
}, 60_000);
