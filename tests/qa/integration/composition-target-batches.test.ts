import { expect, test } from 'bun:test';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import type { PoolClient } from 'pg';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { claimFixture, fixtureReasons } from './g-565-decision-support.ts';
import { isForegroundOperation } from './support/operation-cost.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { DisclosureStore } from '../../../services/main/src/modules/disclosure/read.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { ownerEvidenceCapture } from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';
import { rightsRoutes } from '../../../services/main/src/routes/rights.ts';

interface Work { work: string; workRevision: string; mainVersion: string }
interface Episode { component: string; revision: string }
interface Composition { structure: string; revision: string; occurrences: string[] }
interface Occurrence { occurrence: string; target: string; displayLabel?: string }
interface Page { revision: string; occurrences: Occurrence[]; next: string | null }
interface Parts { parts: Array<{ occurrence: string; work: string }>; next: string | null }

// Episodes use their admitted semantic Resource grain. Repeated placements
// alone cannot detect scalar hydration; Work parts must exclude these targets.
test('100 distinct public semantic Episodes fit current/exact Composition budgets, with Work-only parts, live withholding and sparse continuation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const started = performance.now();
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `composition-target-batches-${randomUUID()}`),
    'openid work:create work:edit work:read work:protect source:intake source:acquire '
      + 'source:convert source:propose source:adopt source:correspond source:read governance:report rights:decide');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/structure/' });
  await objects.initialize();
  Object.assign(f.env, { structureObjects: objects });
  const scopes = `governance:platform:composition-${randomUUID()}`;
  const decider = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  const governance = new GovernanceStore(f.accessPool, ownerEvidenceCapture({ graph: {
    env: f.env, canReadWork: f.access.canReadWork.bind(f.access),
  } }), { current: async target => {
    const rows = (await f.env.fuseki.query(`SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(target.resource)} <${RV}head> ?head } } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length > 1) throw new Error('Governance target head is ambiguous');
    return rows[0]?.head?.value ?? null;
  } }, { current: async ref => ref === 'urn:rezics:rule:source-rights'
    ? { revision: 'v1', digest: f.ruleDigest } : null },
  ownerModerationEffects(new ContentModeration(f.pool), f.env));
  const rightsApp = new Elysia().use(rightsRoutes({ environment: f.env, account: f.account.verifier,
    access: f.access, governance: { store: governance }, rights: { store: f.rightsStore } }));
  const rightsCall = (path: string, body: object, token: string, key = randomUUID()) => rightsApp.handle(
    new Request(`http://main.local${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const publishWork = async (work: Pick<Work, 'work' | 'mainVersion'>, title: string) => {
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await f.json<{ contribution: string; draftRevision: string }>(await f.call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, body: `${title} original text`, language: 'en', actingSubject: f.actor }), 201);
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publication = await f.json<{ publicationDecision: string }>(await f.call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.actor }), 201);
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    await f.json(await f.call('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: f.actor }), 201);
  };
  const createWork = async (title: string, type = 'https://schema.org/Book') => {
    const work = await f.json<Work>(await f.call('POST', '/v1/works', await f.authoredBody({
      profile: 'metadata-only-v1', title, language: 'en', semanticTypes: [type], actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    await publishWork(work, title);
    return work;
  };
  const createEpisode = async (name: string, number: number, publicWork?: string) => {
    const episode = await f.json<Episode>(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
      state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
        { predicate: 'https://schema.org/episodeNumber', value: {
          kind: Number.isInteger(number) ? 'integer' : 'decimal', lexical: String(number) } },
        ...(publicWork ? [{ predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: publicWork } }] : []),
      ] },
    }), 201);
    await f.grant(`semantic:read:${episode.component}`, 'semantic.read');
    return episode;
  };
  // Record actual graph transport debits and the real Access owner's queries, rather
  // than using the response limit as a cost estimate. Background stays attributed.
  const originalFetch = globalThis.fetch;
  const graphBase = new URL(Bun.env.FUSEKI_URL!);
  graphBase.pathname = graphBase.pathname.replace(/\/*$/, '/');
  const originalConnect = f.accessPool.connect.bind(f.accessPool);
  const clients = new Map<PoolClient, PoolClient['query']>();
  const originalCanReadWork = f.access.canReadWork.bind(f.access);
  let measuring = false, graphCalls = 0, graphBytes = 0, ownerSql = 0, workProbes = 0;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const query = url.href === new URL('query', graphBase).href;
    const template = url.href === new URL('command', graphBase).href && typeof init?.body === 'string'
      && /"template(?:Query|Index)"\s*:/.test(init.body);
    const count = measuring && isForegroundOperation() && (query || template);
    if (count) graphCalls++;
    const response = await originalFetch(...args);
    // clone observes the bytes delivered by the real transport, including the
    // unbudgeted preflight. The production reader still consumes its own body.
    if (count) graphBytes += (await response.clone().arrayBuffer()).byteLength;
    return response;
  }, originalFetch);
  const meterClient = (client: PoolClient) => {
    if (clients.has(client)) return;
    const original = client.query;
    clients.set(client, original);
    client.query = ((...args: unknown[]) => {
      if (measuring && isForegroundOperation()) ownerSql++;
      return Reflect.apply(original, client, args);
    }) as typeof client.query;
  };
  // Pool.query also checks out one of these clients. Counting at the client
  // observes real public semantic-gate transactions without double-counting.
  f.accessPool.connect = ((callback?: Parameters<typeof f.accessPool.connect>[0]) => {
    if (callback) return originalConnect((error, client, release) => {
      if (client) meterClient(client);
      callback(error, client, release);
    });
    return originalConnect().then(client => { meterClient(client); return client; });
  }) as typeof f.accessPool.connect;
  f.access.canReadWork = async (...args) => { if (measuring) workProbes++; return originalCanReadWork(...args); };
  const evidence: object[] = [];
  const measured = async <T>(label: string, path: string, authenticated = false): Promise<T> => {
    graphCalls = 0; graphBytes = 0; ownerSql = 0; workProbes = 0;
    const readStarted = performance.now();
    measuring = true;
    let response: Response;
    try { response = await f.call('GET', path, undefined, randomUUID(), authenticated ? f.account.tokenA : null); }
    finally { measuring = false; }
    const body = await f.json<T>(response!, 200);
    const ms = performance.now() - readStarted;
    const sample = { label, graphCalls, graphTransportBytes: graphBytes, ownerSql, workProbes, ms };
    evidence.push(sample);
    console.log('Composition target batch cost', JSON.stringify(sample));
    // The graph-owned restriction moves the dataset cut; the read retries once
    // under the same production call/byte/deadline envelope.
    const attempts = label === 'rights-race-exact' ? 2 : 1;
    expect(graphCalls).toBeGreaterThan(0);
    expect(graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
    expect(graphCalls).toBeLessThanOrEqual((authenticated ? 60 : 40) * attempts);
    expect(graphBytes).toBeGreaterThan(0);
    expect(graphBytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
    expect(ms).toBeLessThan(WORK_READ_COST.deadlineMs);
    expect(ownerSql).toBeGreaterThan(0);
    expect(ownerSql).toBeLessThanOrEqual((authenticated ? 64 : 48) * attempts);
    // Public targets cannot turn a fixed range into one private owner probe per target.
    if (!authenticated) expect(workProbes).toBe(0);
    return body;
  };
  const prepareRestriction = async (work: Work) => {
    const key = randomUUID();
    const complaint = await f.json<{ caseId: string; evidenceDigest: string }>(await rightsCall('/v1/rights/complaints', {
      profile: 'rights-complaint-v1', actingSubject: f.actor, authority: { kind: 'platform', scopeId: scopes },
      context: 'urn:rezics:context:global', target: { owner: 'graph', resource: work.work, component: 'title' },
      disclosure: 'parties', reasonCode: 'claimed_title', statement: 'Disputed Episode title',
      evidence: [{ owner: 'graph', resource: work.work, component: 'title', revision: work.workRevision, locator: null }],
      idempotencyKey: key, complaint: { process: 'dmca_512', claimantKind: 'rights_holder', claimantName: 'Fixture claimant',
        claimantContact: null, claimedWork: 'Episode title', claimedRight: 'copyright',
        noticeDigest: createHash('sha256').update(key).digest('hex'), noticeReceivedAt: new Date().toISOString() },
    }, f.account.tokenA, key), 201);
    await claimFixture(f.accessPool, complaint.caseId, f.otherPrincipal, decider);
    const decisionKey = randomUUID();
    const body = { profile: 'rights-restriction-v1', outcome: 'interim_restrict', caseId: complaint.caseId,
      expectedGeneration: '0', actingSubject: decider, evidenceDigest: complaint.evidenceDigest,
      targets: [{ owner: 'graph', resource: work.work, component: 'title', locator: null,
        scopeKind: 'component', revision: null, expectedHead: work.workRevision, effect: 'disclosure' }],
      rule: { ref: 'urn:rezics:rule:source-rights', revision: 'v1', digest: f.ruleDigest },
      reversesDecisionId: null, answersStepId: null, reasons: fixtureReasons,
      rationale: 'Withhold the disputed title during review.', disclosure: 'parties', idempotencyKey: decisionKey };
    return async () => {
      await f.json(await rightsCall('/v1/rights/restrictions', body, f.account.tokenB, decisionKey), 202);
      for (let attempt = 0; attempt < 8; attempt++) {
        const response = await rightsCall('/v1/rights/restrictions', body, f.account.tokenB, decisionKey);
        if (response.status === 200) { await f.json(response, 200); return; }
        await f.json(response, 202);
      }
      throw new Error('Rights restriction did not settle within its bounded notice steps');
    };
  };
  try {
    await f.grant(scopes, 'governance.appeal');
    await f.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [decider]);
    await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'governance.rights.decide',now() + interval '1 hour')`, [randomUUID(), f.otherPrincipal, decider]);
    await f.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'governance.rights.decide',now() + interval '1 hour')`, [randomUUID(), decider, scopes]);
    const series = await createWork('A hundred distinct public Episodes', 'https://schema.org/TVSeries');
    await f.grant('semantic:create:root', 'semantic.change');
    const episodes: Episode[] = [];
    // Specials and fractional accepted numbers are data, independent of placement order.
    for (let index = 0; index < 100; index++) episodes.push(await createEpisode(`Public Episode ${index + 1}`,
      index === 0 ? 0 : index === 1 ? 1.5 : index, series.work));
    expect(new Set(episodes.map(episode => episode.component)).size).toBe(100);
    const types = (await f.env.fuseki.query(`SELECT ?episode WHERE { GRAPH ${iri(GRAPHS.current)} {
      VALUES ?episode { ${episodes.map(episode => iri(episode.component)).join(' ')} }
      ?episode a <https://schema.org/Episode> .
      FILTER NOT EXISTS { ?episode a <https://schema.org/CreativeWork> } } }`)).results?.bindings ?? [];
    expect(types).toHaveLength(100);
    const composition = await f.json<Composition>(await f.call('POST', '/v1/compositions', {
      profile: 'work-composition', work: series.work, mainVersion: series.mainVersion, actingSubject: f.actor }), 201);
    const path = `/v1/compositions/${shortId(composition.structure)}`;
    const partsPath = `/v1/resources/${shortId(series.work)}/parts`;
    let current = composition;
    const insert = async (targets: readonly string[]) => {
      const changed = await f.json<Composition>(await f.call('POST', `${path}/changes`, {
        profile: 'work-composition', expectedHead: current.revision, actingSubject: f.actor,
        operations: targets.map(target => ({ op: 'insert', parent: composition.structure, position: 'last', role: 'part',
          target, displayLabel: `Placement ${shortId(target)}`, inclusion: 'required' })),
      }), 200);
      current = changed;
      return changed;
    };
    const occurrences: string[] = [];
    for (let at = 0; at < episodes.length; at += 16) occurrences.push(...(await insert(episodes.slice(at, at + 16).map(episode => episode.component))).occurrences);
    const originalRevision = current.revision;
    const exactPath = `${path}/revisions/${shortId(originalRevision)}`;
    expect(performance.now() - started).toBeLessThan(600_000);
    const targetIds = episodes.map(episode => episode.component);
    for (const [label, endpoint] of [['current-100', path], ['exact-100', exactPath]] as const) {
      const page = await measured<Page>(label, `${endpoint}?limit=100`);
      expect(page.occurrences.map(item => item.target)).toEqual(targetIds);
      expect(page.next).toBeNull();
    }
    const parts = await measured<Parts>('parts-exclude-100-Episodes', `${partsPath}?limit=100`);
    expect(parts.parts).toEqual([]);
    expect(parts.next).toBeNull();

    // Duplicate placements retain their identities while target hydration is shared.
    const privateEpisode = await createEpisode('Private trailing Episode', 0);
    const appended = await insert([episodes[0]!.component, privateEpisode.component]);
    await f.accessPool.query('DELETE FROM access.permission_grant WHERE scope_id=$1', [`semantic:read:${privateEpisode.component}`]);
    const duplicate = await measured<Page>('duplicate-lookahead', `${path}?limit=100`);
    expect(duplicate.occurrences.map(item => item.target)).toEqual(targetIds);
    expect(duplicate.next).not.toBeNull();
    const final = await measured<Page>('duplicate-continuation', `${path}?limit=100&after=${encodeURIComponent(duplicate.next!)}`);
    expect(final.occurrences.map(item => item.occurrence)).toEqual([appended.occurrences[0]!]);
    expect(final.next).toBeNull();
    const exact = await measured<Page>('exact-after-new-head', `${exactPath}?limit=100`);
    expect(exact.occurrences.map(item => item.occurrence)).toEqual(occurrences);

    const restricted = await createWork('Rights-restricted Book');
    const protectedWork = await createWork('Protected Book');
    const raceTarget = await createWork('Book restricted during hydration');
    await insert([restricted.work, protectedWork.work, raceTarget.work]);
    await (await prepareRestriction(restricted))();
    await f.grant(`work:protect:${protectedWork.work}`, 'work.protection.tighten');
    const state = await f.json<{ contentHead: string; protectionHead: string | null; controlHead: string | null;
      controlEpoch: string }>(await f.call('GET', `/v1/works/${shortId(protectedWork.work)}/editorial-state?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    await f.json(await f.call('POST', '/v1/work-title-protections', { profile: 'work-title-protection-v1', action: 'tighten',
      work: protectedWork.work, expectedHead: state.contentHead, expectedProtection: state.protectionHead,
      expectedControl: state.controlHead, expectedControlEpoch: state.controlEpoch, expectedRuleRevision: PROTECTION_RULE,
      actingSubject: f.actor, reason: 'Review disputed Book title', evidence: [] }), 201);
    // A closed semantic gate withholds public Resources even from explicit grantees.
    const closedEpisodes = [episodes[1]!, episodes[2]!, episodes[4]!];
    for (const episode of closedEpisodes) await f.access.strongCloseScope(`semantic:read:${episode.component}`, '0');
    const erased = episodes[3]!;
    await f.nativeFuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(erased.revision)} a <${RV}ErasedRevision> } }`);
    const proposal = await f.propose(`OL${randomInt(1, 1_000_000_000_000)}W`, [], 'Withdrawn source title');
    const withdrawn = await f.adoptWork(proposal);
    await f.grant(`work:edit:${withdrawn.work}`, 'work.edit');
    await f.grant(`work:read:${withdrawn.work}`, 'work.read');
    await publishWork(withdrawn, 'Independent native contribution');
    const beforeWithdrawal = await insert([withdrawn.work]);
    const mixedExactPath = `${path}/revisions/${shortId(current.revision)}`;
    const beforeSupportWithdrawal = await measured<Page>('source-before-withdrawal', `${path}?limit=100`);
    expect(beforeSupportWithdrawal.occurrences.map(item => item.target)).toContain(withdrawn.work);
    await f.json(await f.call('POST', '/v1/sources/withdrawals', { profile: 'source-support-withdrawal-v1',
      support: withdrawn.binding, expectedSupport: withdrawn.binding, reason: 'Withdraw copied title evidence' }), 201);
    // Source support withdrawal retains independent native identity and title.
    const denied = new Set([restricted.work, protectedWork.work, erased.component, privateEpisode.component,
      ...closedEpisodes.map(episode => episode.component)]);
    const expected = [...targetIds.filter(target => !denied.has(target)), episodes[0]!.component,
      raceTarget.work, withdrawn.work];
    const mixed = await measured<Page>('mixed-current', `${path}?limit=100`);
    expect(mixed.occurrences.map(item => item.target)).toEqual(expected);
    expect(mixed.next).toBeNull();
    expect(mixed.occurrences.at(-1)?.occurrence).toBe(beforeWithdrawal.occurrences[0]!);
    const historical = await measured<Page>('mixed-exact', `${exactPath}?limit=100`);
    expect(historical.occurrences.map(item => item.target)).toEqual(targetIds.filter(target => !denied.has(target)));
    const granted = await measured<Page>('mixed-granted', `${path}?limit=100&actingSubject=${encodeURIComponent(f.actor)}`, true);
    expect(granted.occurrences.map(item => item.target)).toEqual(expected);
    const mixedParts = await measured<Parts>('mixed-parts', `${partsPath}?limit=100`);
    expect(mixedParts.parts.map(item => item.work)).toEqual([raceTarget.work, withdrawn.work]);
    for (const target of denied) expect(JSON.stringify(mixed)).not.toContain(target);
    for (const hidden of occurrences.slice(1, 5)) expect(JSON.stringify(mixed)).not.toContain(hidden!);
    expect(mixed).not.toHaveProperty('placementCount');
    expect(mixed).not.toHaveProperty('count');

    const collected: string[] = [];
    let after: string | null = null;
    do {
      const page = await measured<Page>('sparse-page', `${path}?limit=17${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      expect(page.occurrences.length).toBeGreaterThan(0);
      collected.push(...page.occurrences.map(item => item.target));
      after = page.next;
      expect(collected.length).toBeLessThanOrEqual(expected.length);
    } while (after);
    expect(collected).toEqual(expected);

    // A restriction committed after initial summary admission must win the
    // final hydrated-name fence. The immutable exact revision grants no rights.
    const restrictRace = await prepareRestriction(raceTarget);
    const originalDisclosure = DisclosureStore.prototype.read;
    let targetReads = 0, raced = false;
    DisclosureStore.prototype.read = async function (targets, viewer, channel) {
      if (!raced && targets.some(target => target.resource === raceTarget.work) && ++targetReads === 2) {
        raced = true;
        const wasMeasuring = measuring;
        measuring = false;
        try { await fusekiReadBudget.exit(restrictRace); }
        finally { measuring = wasMeasuring; }
      }
      return originalDisclosure.call(this, targets, viewer, channel);
    };
    try {
      const page = await measured<Page>('rights-race-exact', `${mixedExactPath}?limit=100`);
      expect(raced).toBe(true);
      expect(page.occurrences.map(item => item.target)).toEqual(expected.filter(target => target !== raceTarget.work));
      expect(JSON.stringify(page)).not.toContain(raceTarget.work);
    } finally { DisclosureStore.prototype.read = originalDisclosure; }
    console.log('Composition target batch costs', JSON.stringify(evidence));
  } finally {
    globalThis.fetch = originalFetch;
    f.accessPool.connect = originalConnect;
    for (const [client, query] of clients) client.query = query;
    f.access.canReadWork = originalCanReadWork;
    await f.close();
  }
}, 600_000);
