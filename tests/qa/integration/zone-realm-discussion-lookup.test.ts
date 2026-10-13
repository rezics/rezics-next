import { expect, spyOn, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { treaty } from '@elysia/eden';
import * as logging from '@rezics/observability/log';
import type { MainApp } from '../../../services/main/src/app.ts';
import { composeMain } from '../../../services/main/src/composition.ts';
import { fusekiReadBudget, type FusekiReadBudget }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { DisclosureStore, hasDisclosure }
  from '../../../services/main/src/modules/disclosure/read.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { addressPath, zoneMemberHref } from '../../../apps/web/features/address/path.ts';
import { readAboutDiscussion } from '../../../apps/web/features/zones/about-discussion-api.ts';
import { startHomeStack } from './feed-read-support.ts';
import { local } from './zone-realm-discussion-support.ts';

function errorChain(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return error;
  return { name: error.constructor.name, message: error.message, stack: error.stack,
    ...(depth < 8 && error.cause !== undefined ? { cause: errorChain(error.cause, depth + 1) } : {}) };
}

test('a signed-in Zone Work page looks up its attached Realm discussion through the configured disclosure owner', async () => {
  const home = await startHomeStack('zone-discussion-lookup');
  const accessPool = boundedPool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = boundedPool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const relayPool = boundedPool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 2 });
  const runtime = await composeMain({ config: home.stack.composition.config, fuseki: home.stack.fuseki,
    accessPool, contentPool, relayPool, erasureRelayPool: relayPool, ownerRelayPool: relayPool,
    recommendationRelayPool: relayPool, overrides: { account: home.deps.account } });
  const workers = [runtime.contentProjectionWorker, runtime.occurrenceLabelWorker, runtime.statementSeekWorker];
  const requestContext = new AsyncLocalStorage<string>();
  let constrainLookup = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const url = new URL(request.url), path = `${url.pathname}${url.search}`;
    return requestContext.run(path, () => constrainLookup && url.pathname.endsWith('/about-thread')
      ? fusekiReadBudget.run({ signal: AbortSignal.timeout(10_000), callsLeft: 8, bytesLeft: 4 * 1024 * 1024 },
        () => runtime.app.handle(request)) : runtime.app.handle(request));
  } });
  const costs: Array<{ request: string; budget: FusekiReadBudget;
    initialCalls: number; initialBytes: number; probes: Record<string, number> }> = [];
  let measureReads = false;
  let moveUnrelatedSequence = false;
  let unrelatedSequenceChanges = 0;
  const positions = new WeakMap<FusekiReadBudget, number>();
  const query = home.stack.fuseki.query.bind(home.stack.fuseki);
  const queryObserver = spyOn(home.stack.fuseki, 'query').mockImplementation(async (...args) => {
    const [sparql] = args;
    const budget = fusekiReadBudget.getStore(), request = requestContext.getStore();
    if (measureReads && budget && request) {
      let cost = costs.find(value => value.request === request && value.budget === budget);
      if (!cost) {
        cost = { request, budget, initialCalls: budget.callsLeft, initialBytes: budget.bytesLeft, probes: {} };
        costs.push(cost);
      }
      const origin = new Error().stack?.split('\n').filter(line => line.includes('/services/main/src/'))
        .map(line => line.slice(line.indexOf('services/main/src/')).replace(/:\d+\)?$/, ''))
        .slice(0, 3).join(' <- ') ?? 'unknown';
      const projection = /SELECT[^{}]*\{|ASK\s*\{/i.exec(sparql)?.[0].replace(/\s+/g, ' ').trim() ?? 'other';
      const probe = `${origin}: ${projection}`;
      cost.probes[probe] = (cost.probes[probe] ?? 0) + 1;
    }
    const result = await query(...args);
    // Dataset sequence is diagnostic; selected target revisions and the epoch
    // remain unchanged while the opening and closing target probes differ.
    if (moveUnrelatedSequence && budget && request?.includes('/about-thread?')
      && /SELECT \?epoch \?sequence \?r \?revision/.test(sparql)) {
      const position = (positions.get(budget) ?? 0) + 1;
      positions.set(budget, position);
      for (const row of result.results?.bindings ?? []) {
        if (row.sequence) {
          row.sequence.value = String(BigInt(row.sequence.value) + BigInt(position));
          unrelatedSequenceChanges++;
        }
      }
    }
    return result;
  });
  const measuredCosts = () => costs.map(({ request, budget, initialCalls, initialBytes, probes }) => ({
    request, graphCalls: initialCalls - budget.callsLeft, graphBytes: initialBytes - budget.bytesLeft, probes,
  }));
  const faults: Array<{ request: string | undefined; owner: string; error: unknown }> = [];
  const logFault = logging.logWorkerFault;
  const observer = spyOn(logging, 'logWorkerFault').mockImplementation((...args) => {
    const [owner, error] = args;
    faults.push({ request: requestContext.getStore(), owner, error: errorChain(error) });
    logFault(...args);
  });
  for (const worker of workers) worker.start();
  try {
    const call = (method: string, path: string, body?: object, key = randomUUID()) =>
      fetch(`${server.url.origin}${path}`, { method,
        headers: { authorization: `Bearer ${home.author.token}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    const command = async <T>(method: string, path: string, body: object): Promise<T> => {
      const key = randomUUID();
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await call(method, `/v1/${path}`, body, key);
        if (response.status === 202) { await Bun.sleep(300); continue; }
        if (response.status !== 200 && response.status !== 201) {
          throw new Error(`${method} ${path}: ${response.status} ${await response.text()} ${JSON.stringify(faults)}`);
        }
        return response.json() as Promise<T>;
      }
      throw new Error(`${method} ${path} did not settle`);
    };
    const post = <T>(path: string, body: object) => command<T>('POST', path, body);
    const actor = (await post<{ agent: string }>('agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Discussion author',
    })).agent;
    const grant = async (scope: string, action: string) => grantFixtureAuthority(home.stack.accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId: home.author.principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
    await grant('space:create:root', 'space.create');
    const site = await post<{ zone: string; space: string; navigationRevision: string }>('spaces', {
      profile: 'space-zone-v1', name: 'Harbor annex', language: 'en', capabilities: ['zone'],
      visibility: 'public', listing: 'listed', actingSubject: actor,
    });
    await grant(`zone:edit:${site.zone}`, 'zone.edit');
    const realm = await post<{ realm: string; space: string }>('spaces', {
      profile: 'space-realm-v2', name: 'North realm', language: 'en', capabilities: ['realm'],
      handle: `north${randomUUID().replaceAll('-', '').slice(0, 8)}`, actingSubject: actor,
      initialSettings: { visibility: 'public', reviewMode: 'open', reviewRequired: false,
        whoMaySubmit: 'granted', selfJoin: false, rules: [] },
    });
    await grant(`governance:realm:${realm.realm}`, 'realm.owner');
    await command('PUT', `zones/${local(site.zone)}/configuration`, {
      expectedHead: (await readZoneConfiguration(runtime.environment, site.zone)).revision,
      defaultRealm: realm.realm, actingSubject: actor,
    });
    const a = { site, realm };
    // Match the browser's native Work, publication and collection-member route;
    // the older proof mounts a catalogue fixture Work directly and reads anonymously.
    const work = await post<{ work: string; mainVersion: string }>('works', {
      profile: 'metadata-only-v1', title: 'Harbor field guide', language: 'en', authoring: 'own-work', actingSubject: actor,
    });
    await grant(`work:read:${work.work}`, 'work.read');
    const text = await post<{ contribution: string; draftRevision: string }>('contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: 'A published guide to the harbor.', actingSubject: actor,
    });
    const publication = await post<{ publicationDecision: string }>('contribution-publications', {
      profile: 'text-publication-v1', contribution: text.contribution, expectedDraftHead: text.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    });
    await post('publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: text.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor,
    });
    const collection = `https://rezics.com/id/${randomUUID()}`;
    await grant(`collection:edit:${collection}`, 'collection.edit');
    await grant(`semantic:read:${collection}`, 'semantic.read');
    const curated = await post<{ structure: string; revision: string }>('collections', {
      collection, name: 'Harbor reading shelf', language: 'en', disclosure: 'public', actingSubject: actor,
    });
    await post(`collections/${local(collection)}/changes`, {
      expectedHead: curated.revision, actingSubject: actor,
      operations: [{ op: 'insert', parent: curated.structure, position: 'last', role: 'member', target: work.work,
        selection: { mode: 'follow-context' } }],
    });
    const mounted = await post<{ revision: string; occurrences: string[] }>(`zones/${local(a.site.zone)}/mounts`, {
      expectedHead: a.site.navigationRevision, target: collection, routeSegment: 'guide', disclosure: 'public', actingSubject: actor,
    });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await command('PUT', `zones/${local(a.site.zone)}/configuration`, {
      expectedHead: (await readZoneConfiguration(runtime.environment, a.site.zone)).revision,
      prepareHomeDocument: true, actingSubject: actor,
    });
    const homeDocument = (await readZoneConfiguration(runtime.environment, a.site.zone)).homeDocument!;
    const draft = await post<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>('content-drafts', {
      profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead: null,
      document: fromPlainText('Harbor annex home', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
    });
    await post(`zones/${local(a.site.zone)}/site-publications`, {
      expectedHead: (await readZoneConfiguration(runtime.environment, a.site.zone)).revision,
      routesRevision: mounted.revision, navigationRevision: mounted.revision, actingSubject: actor,
      pages: [{ page: homeDocument, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest,
        contentEpoch: draft.sourcePosition.dataEpoch }],
    });
    // The browser selects two directly controlled Persons of the same Account.
    const secondPerson = (await post<{ agent: string }>('agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Harbor visitor',
    })).agent;
    expect(runtime.dependencies.governance?.store.disclosure).toBeInstanceOf(DisclosureStore);
    expect(hasDisclosure(runtime.environment)).toBe(true);
    const routePath = `/${addressPath(zoneMemberHref(local(a.site.space), 'guide', work.work))!.tail.join('/')}`;
    const failed: Array<{ request: Request; response: Response }> = [];
    const requests: string[] = [];
    const projections = new Map<string, { resource: string; revision: string }>();
    const main = treaty<MainApp>(server.url.origin, {
      headers: { authorization: `Bearer ${home.author.token}` }, parseDate: false,
      fetcher: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.url);
        const url = new URL(request.url);
        const response = await fetch(request);
        if (response.status >= 400) failed.push({ request, response: response.clone() });
        if (response.ok && url.pathname === `/v1/resources/${local(work.work)}/page`) {
          const projection = await response.clone().json() as { target: { resource: string; revision: string } };
          projections.set(url.searchParams.get('actingSubject')!, projection.target);
        }
        return response;
      }) as typeof fetch,
    });
    // Match both initial renders, including the adapter's four simultaneous
    // sibling reads. A generic route fault does not identify which one failed.
    measureReads = true;
    const reads = await Promise.all([actor, secondPerson].map(actingSubject => readAboutDiscussion(main, {
      zone: a.site.zone, path: routePath, signedIn: true, personal: true, actingSubject,
    })));
    if (failed.length) {
      const diagnostics = [];
      for (const { request, response } of failed) {
        const url = new URL(request.url);
        diagnostics.push({ request: { method: request.method, path: `${url.pathname}${url.search}` },
          status: response.status, problem: await response.text() });
      }
      throw new Error(JSON.stringify({ principal: home.author.principal, principalId: home.author.principalId,
        timing: 'after attachment and site publication, before the first post', diagnostics, faults,
        costs: measuredCosts() }));
    }
    expect(reads).toEqual([actor, secondPerson].map(actingSubject => ({
      kind: 'ready', basis: { realm: a.realm.realm, about: work.work, zone: a.site.zone, path: expect.any(String),
        routeRevision: expect.any(String), targetRevision: expect.any(String) },
      thread: null, realmName: expect.any(Object), mode: 'open', actingSubject,
    })));
    for (const actingSubject of [actor, secondPerson]) {
      const lookup = requests.filter(value => {
        const url = new URL(value);
        return url.pathname.endsWith('/about-thread') && url.searchParams.get('actingSubject') === actingSubject;
      });
      expect(lookup).toHaveLength(1);
      expect(Object.fromEntries(new URL(lookup[0]!).searchParams)).toEqual({ actingSubject, about: work.work });
    }
    const cachedAt = requests.length;
    expect(await readAboutDiscussion(main, {
      zone: a.site.zone, path: routePath, signedIn: true, personal: true, actingSubject: actor,
    }, async resource => {
      const projection = projections.get(actor)!;
      expect(projection.resource).toBe(resource);
      return projection;
    })).toEqual(reads[0]);
    expect(requests.slice(cachedAt).some(value => new URL(value).pathname.includes('/resources/'))).toBe(false);
    moveUnrelatedSequence = true;
    const path = `/v1/realms/${local(realm.realm)}/about-thread?${new URLSearchParams({ actingSubject: actor, about: work.work })}`;
    const unchanged = await call('GET', path);
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toEqual({ realm: realm.realm, about: work.work, thread: null });
    expect(unrelatedSequenceChanges).toBeGreaterThanOrEqual(2);
    moveUnrelatedSequence = false;

    // Removing a draft mount does not move the public selection. Publishing
    // that local navigation cut must refuse the old page and discussion basis.
    const ready = reads[0];
    if (!ready || ready.kind !== 'ready') throw new Error('Initial discussion basis is unavailable');
    expect(mounted.occurrences).toHaveLength(1);
    const removed = await command<{ revision: string }>('DELETE',
      `zones/${local(site.zone)}/mounts/${local(mounted.occurrences[0]!)}`, {
        expectedHead: mounted.revision, actingSubject: actor,
      });
    const routeRequest = `/v1/zones/${local(site.zone)}/routes?${new URLSearchParams({ path: routePath, actingSubject: actor })}`;
    const retained = await call('GET', routeRequest);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ revision: ready.basis.routeRevision, realm: realm.realm });
    const moved = await post<{ revision: string }>(`zones/${local(site.zone)}/site-publications`, {
      expectedHead: (await readZoneConfiguration(runtime.environment, site.zone)).revision,
      routesRevision: removed.revision, navigationRevision: removed.revision, actingSubject: actor,
      pages: [{ page: homeDocument, variantId, revisionId: draft.revisionId,
        byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
    });
    expect(moved.revision).not.toBe(ready.basis.routeRevision);
    const refused = await call('GET', routeRequest);
    expect(refused.status).toBe(404);
    expect(await readAboutDiscussion(main, {
      zone: site.zone, path: routePath, signedIn: true, personal: true, actingSubject: actor,
    })).toEqual({ kind: 'unavailable' });
    const independent = await call('GET', path);
    expect(independent.status).toBe(200);
    expect(await independent.json()).toEqual({ realm: realm.realm, about: work.work, thread: null });
    // Resource exhaustion remains distinct from local publication movement. Exercise
    // the exact lookup under an enclosing budget with
    // eight calls left; the closing Disclosure head probe is the ninth read.
    constrainLookup = true;
    const exhausted = await call('GET', path);
    expect(exhausted.status).toBe(503);
    expect(await exhausted.json()).toMatchObject({ code: 'work_read_unavailable' });
    expect(faults).toContainEqual({ request: path, owner: 'main.route.work_read_unavailable',
      error: { name: 'DisclosureUnavailable', message: 'Disclosure heads are unavailable', stack: expect.any(String),
        cause: { name: 'FusekiReadBudgetExceeded', message: 'Fuseki read call budget exceeded', stack: expect.any(String) } } });
    const diagnostics = measuredCosts().filter(cost => !cost.request.startsWith('/v1/agents'));
    await Bun.write(`.temp/zone-discussion-read-costs-${Bun.env.REZICS_QA_RUN_ID}.json`, JSON.stringify(diagnostics, null, 2));
    console.info(`Zone discussion read costs ${JSON.stringify(diagnostics.map(({ request, graphCalls, graphBytes, probes }) => ({
      path: request.split('?')[0], graphCalls, graphBytes,
      disclosureHeadQueries: Object.entries(probes).filter(([probe]) => probe.includes('SELECT ?work ?head ?owningWork'))
        .reduce((sum, [, count]) => sum + count, 0),
    })))}`);
  } finally {
    await server.stop(true);
    await Promise.all(workers.map(worker => worker.stop()));
    await runtime.templateSeek.stopRecovery();
    await runtime.app.stop();
    queryObserver.mockRestore();
    observer.mockRestore();
    await Promise.all([accessPool.end(), contentPool.end(), relayPool.end()]);
    await home.stop();
  }
}, 180_000);
