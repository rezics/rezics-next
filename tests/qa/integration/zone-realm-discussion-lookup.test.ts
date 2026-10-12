import { expect, spyOn, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { treaty } from '@elysia/eden';
import * as logging from '@rezics/observability/log';
import type { MainApp } from '../../../services/main/src/app.ts';
import { composeMain } from '../../../services/main/src/composition.ts';
import { FusekiReadBudgetExceeded } from '../../../services/main/src/infrastructure/fuseki.ts';
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
  const faults: Array<{ request: string | undefined; owner: string; error: unknown }> = [];
  const logFault = logging.logWorkerFault;
  const observer = spyOn(logging, 'logWorkerFault').mockImplementation((...args) => {
    const [owner, error] = args;
    faults.push({ request: requestContext.getStore(), owner, error: errorChain(error) });
    logFault(...args);
  });
  for (const worker of workers) worker.start();
  try {
    const call = (method: string, path: string, body?: object, key = randomUUID()) => requestContext.run(path,
      () => runtime.app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${home.author.token}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) })));
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
    const mounted = await post<{ revision: string }>(`zones/${local(a.site.zone)}/mounts`, {
      expectedHead: a.site.navigationRevision, target: collection, routeSegment: 'guide', disclosure: 'public', actingSubject: actor,
    });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await post<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>('content-drafts', {
      profile: 'content-text-v1', resourceId: a.site.zone, variantId, expectedHead: null,
      document: fromPlainText('Harbor annex home', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
    });
    await post(`zones/${local(a.site.zone)}/site-publications`, {
      expectedHead: (await readZoneConfiguration(runtime.environment, a.site.zone)).revision,
      routesRevision: mounted.revision, navigationRevision: mounted.revision, actingSubject: actor,
      pages: [{ page: a.site.zone, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest,
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
    const main = treaty<MainApp>('http://main.local', {
      headers: { authorization: `Bearer ${home.author.token}` }, parseDate: false,
      fetcher: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.url);
        const url = new URL(request.url);
        const response = await requestContext.run(`${url.pathname}${url.search}`, () => runtime.app.handle(request));
        if (response.status >= 400) failed.push({ request, response: response.clone() });
        return response;
      }) as typeof fetch,
    });
    // Match both initial renders, including the adapter's four simultaneous
    // sibling reads. A generic route fault does not identify which one failed.
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
        timing: 'after attachment and site publication, before the first post', diagnostics, faults }));
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
    // Validate the diagnostic against a controlled query failure. This proves
    // cause capture, without claiming that the historical failure exhausted a budget.
    const query = home.stack.fuseki.query.bind(home.stack.fuseki);
    const queryFailure = new FusekiReadBudgetExceeded('Diagnostic read call budget exceeded');
    const queryObserver = spyOn(home.stack.fuseki, 'query').mockImplementation((sparql, maxBytes) => {
      if (requestContext.getStore()?.includes('/about-thread?')
        && sparql.includes('SELECT ?work ?head ?owningWork ?owningHead')) throw queryFailure;
      return query(sparql, maxBytes);
    });
    try {
      const path = `/v1/realms/${local(realm.realm)}/about-thread?${new URLSearchParams({ actingSubject: actor, about: work.work })}`;
      const refused = await call('GET', path);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: 'work_read_unavailable' });
      expect(faults).toContainEqual({ request: path, owner: 'main.route.work_read_unavailable',
        error: { name: 'DisclosureUnavailable', message: 'Disclosure heads are unavailable', stack: expect.any(String),
          cause: { name: 'FusekiReadBudgetExceeded', message: queryFailure.message, stack: expect.any(String) } } });
    } finally { queryObserver.mockRestore(); }
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await runtime.templateSeek.stopRecovery();
    await runtime.app.stop();
    observer.mockRestore();
    await Promise.all([accessPool.end(), contentPool.end(), relayPool.end()]);
    await home.stop();
  }
}, 180_000);
