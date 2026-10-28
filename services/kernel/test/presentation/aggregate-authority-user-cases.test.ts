import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  PROFILE_FORMAT,
  planReads,
  platformRegistry,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import type { HttpResponse } from '../../../../specs/pages-driver.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { syncSubjectListing } from '../../src/library/listing.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { createSearchService } from '../../src/search/service.ts';
import { decodeSession, type SessionComponent } from '../../src/tokens/session.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';
import { createPagesDriver } from './outcome-driver.ts';

const SESSION = 'rezics-session-token';
const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({
  type,
  props: { id, ...props },
});
const document = (...content: ReturnType<typeof node>[]): CompositionDocument => ({ root: { props: {} }, content });
const profile = (generic: CompositionDocument): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic,
  types: [],
  bases: [],
  routes: [],
});
const stable = (body: Record<string, unknown>) => {
  const { request_id: _request, instance: _instance, ...rest } = body;
  return rest;
};
function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
}
function record(value: unknown): Record<string, any> {
  expect(value).toBeObject();
  return value as Record<string, any>;
}
function components(ring: KeyRing, scope: string, response: HttpResponse): SessionComponent[] {
  const token = response.headers.get(SESSION);
  // Some native routes do not emit a session token. Preserve every component they
  // actually return, rather than fabricating components for those routes.
  if (token === null) return [];
  const decoded = decodeSession(ring, scope, token!);
  expect(decoded).toBeDefined();
  expect(decoded!.length).toBeGreaterThan(0);
  return decoded!;
}
function preserves(actual: SessionComponent[], required: SessionComponent[]) {
  for (const component of required) {
    const found = actual.find(({ partition }) => partition === component.partition);
    expect(found, `missing native session partition ${component.partition}`).toBeDefined();
    expect(found!.epoch).toBeGreaterThanOrEqual(component.epoch);
    if (found!.epoch === component.epoch) expect(found!.position >= component.position).toBe(true);
  }
}

test('native pages driver preserves unknown, hidden and taken-down standalone authority despite presentation grants', async () => {
  const driver = await createPagesDriver();
  try {
    const targets: string[] = [Bun.randomUUIDv7()];
    for (const mode of ['hidden', 'taken_down'] as const) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: `Authority ${mode}` },
        },
        key(),
      );
      status(created, 201);
      const id = record(created.body.subject).id as string;
      status(await driver.request('anonymous', 'GET', `/v1/subjects/${id}`), 200);
      await driver.remove(id, mode);
      targets.push(id);
    }
    for (const persona of ['anonymous', 'editor', 'curator'] as const) {
      const unknown = await driver.request(persona, 'GET', `/v1/subjects/${targets[0]}`);
      status(unknown, 404);
      for (const id of targets) {
        const standalone = await driver.request(persona, 'GET', `/v1/subjects/${id}`);
        const aggregate = await driver.request(persona, 'POST', '/v1/pages:read', { target: { subject: id } });
        status(standalone, 404);
        status(aggregate, standalone.status);
        expect(stable(aggregate.body)).toEqual(stable(standalone.body));
        expect(stable(aggregate.body)).toEqual(stable(unknown.body));
      }
    }
    // Accounts suspends and revokes the bearer. This is deliberately NOT a suspended-valid cell.
    // Root persona reconciliation must provide that missing cell; never mint a replacement token here.
    const standalone = await driver.request('suspended', 'GET', `/v1/subjects/${targets[0]}`);
    const aggregate = await driver.request('suspended', 'POST', '/v1/pages:read', { target: { subject: targets[0] } });
    status(standalone, 401);
    status(aggregate, 401);
    expect(stable(aggregate.body)).toEqual(stable(standalone.body));
  } finally {
    await driver.close();
  }
}, 180_000);

type Observation = {
  root: boolean;
  path: string;
  method: string;
  headers: Headers;
  status: number;
  responseHeaders: Headers;
  body: Record<string, unknown>;
};
type Capture = { requests: Observation[]; active: number; peak: number; engine?: string[] };

test('production page aggregates preserve each standalone read authority and disclose only the callers public representation', async () => {
  const capture = new AsyncLocalStorage<Capture>();
  const prefix = `pa-${randomUUID().replaceAll('-', '').slice(0, 16)}-`;
  // Use the same native source, service and indexing runner as production. This slice does not
  // establish default-worker composition or the separate Performance composed capture.
  const nativeEngine = createOpenSearch(process.env.OPENSEARCH_URL!);
  const engine: OpenSearch = {
    request<T>(
      method: Parameters<OpenSearch['request']>[0],
      path: string,
      body?: unknown,
      options?: Parameters<OpenSearch['request']>[3],
    ) {
      capture.getStore()?.engine?.push(`${method} ${path}`);
      return nativeEngine.request<T>(method, path, body, options);
    },
    bulk: nativeEngine.bulk,
  };
  let ring!: KeyRing;
  let indexing: Awaited<ReturnType<typeof startSearchIndexing>> | undefined;
  const driver = await createSemanticDriver((config) => {
    ring = config.tokens!;
    const app = createKernel({
      ...config,
      search: createSearchService({
        pool: config.pool,
        client: engine,
        prefix,
        source: subjectSource(config.pool, config.routeKey),
        cursors: ring,
      }),
    });
    // All responses and headers below are genuine. Intercept the real kernel boundary,
    // including recursive standalone dispatch; do not replace dispatch or authorization.
    app.wrap((handle) => async (request: Request) => {
      const seen = capture.getStore();
      if (!seen) return handle(request);
      const root = seen.active === 0;
      seen.active += 1;
      seen.peak = Math.max(seen.peak, seen.active);
      // customMethod rewrites the genuine Request URL in place while routing.
      // Capture arrival metadata before dispatch, not that internal transport URL.
      const path = new URL(request.url).pathname + new URL(request.url).search;
      const headers = new Headers(request.headers);
      try {
        const response = await handle(request);
        seen.requests.push({
          root,
          path,
          method: request.method,
          headers,
          status: response.status,
          responseHeaders: new Headers(response.headers),
          body: await response.clone().json(),
        });
        return response;
      } finally {
        seen.active -= 1;
      }
    });
    return app;
  });
  try {
    const { fixtures } = driver;
    const publisher = await fixtures.person('aggregate_publisher');
    const editor = await fixtures.person('editor');
    const unscoped = await fixtures.person('aggregate_unscoped', { scopes: [] });
    await fixtures.grantAccount(publisher, ['presentation:publish', 'presentation:activate', 'subject:create']);
    const send = fixtures.send;
    const write = (path: string, body: unknown, account = publisher) => send(account, 'POST', path, body, key());
    async function activate(doc: CompositionDocument) {
      const active = await send(null, 'GET', '/v1/presentation/active');
      status(active, 200);
      const published = await write('/v1/presentation/profiles', { profile: profile(doc) });
      status(published, 201);
      const activated = await write(`/v1/presentation/profiles/${published.body.digest}:activate`, {
        expected_head: active.body.head,
      });
      status(activated, 200);
      return published.body.digest;
    }
    // The existing native account-agent producer supplies the private statement's owner.
    const agent = await ensureAccountAgent(fixtures.pool, {
      account: publisher.accountId,
      kind: 'person',
      name: 'Native page publisher',
    });
    const pen = await write('/v1/subjects', {
      type: 'schema:Person',
      labels: { en: 'Public pen name' },
      statements: {
        'rezics:penNameOf': [
          {
            property: { id: 'rezics:penNameOf' },
            value: { type: 'value', content: agent.subject.id },
            references: [],
            qualifiers: [],
          },
        ],
      },
    });
    status(pen, 201);
    const subject = record(pen.body.subject);
    const privateCandidate = subject.statements['rezics:penNameOf'][0].id as string;
    expect(privateCandidate).toBeString();
    const authored = await write('/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Native public source' },
      statements: {
        'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: subject.id } }],
      },
    });
    status(authored, 201);

    const collections: Record<string, string> = {};
    for (const visibility of ['public', 'unlisted', 'private'] as const) {
      const created = await write('/v1/collections', { title: `Native ${visibility} shelf`, visibility });
      status(created, 201);
      const collection = record(created.body.collection);
      collections[visibility] = collection.id;
      const added = await write(`/v1/collections/${collection.id}/members`, {
        subjectId: subject.id,
        note: `${visibility} member note`,
      });
      status(added, 201);
      // Existing production listing effect, never synthetic subject_collection rows.
      await syncSubjectListing({ pool: fixtures.pool }, { subjectId: subject.id, collectionId: collection.id });
      for (const suffix of ['', '/members']) {
        const path = `/v1/collections/${collection.id}${suffix}`;
        const ownerRead = await send(publisher, 'GET', path);
        status(ownerRead, 200);
        if (suffix) expect(record((ownerRead.body.members as unknown[])[0]).subjectId).toBe(subject.id);
        for (const caller of [null, editor]) {
          const actual = await send(caller, 'GET', path);
          status(actual, visibility === 'private' ? 404 : 200);
          if (visibility !== 'private') expect(actual.body).toEqual(ownerRead.body);
          else {
            const missing = await send(caller, 'GET', `/v1/collections/${Bun.randomUUIDv7()}${suffix}`);
            status(missing, 404);
            expect(stable(actual.body)).toEqual(stable(missing.body));
          }
        }
      }
    }

    const doc = document(
      node('SubjectHeader', 'header'),
      node('MoreStatements', 'facts'),
      node('Sources', 'sources'),
      node('Cover', 'cover'),
      node('Summary', 'summary'),
      node('SubjectList', 'works', { title: { en: 'Public works' }, property: 'schema:author', limit: 12 }),
      node('CollectionList', 'collections', { title: { en: 'Public collections' }, limit: 6 }),
      node('CollectionList', 'collections-again', { title: { en: 'Same descriptor' }, limit: 6 }),
      node('ReactionSummary', 'reactions'),
    );
    const digest = await activate(doc);
    // Real standalone paths are specified independently of planReads, which is only used
    // to locate the response's node keys. Physical counts come from captured requests.
    const routes = [
      ['header', `/v1/subjects/${subject.id}`],
      ['collections', `/v1/subjects/${subject.id}/collections?limit=6`],
      ['reactions', `/v1/subjects/${subject.id}/reactions`],
      ['works', `/v1/subjects/${subject.id}/links?property=schema%3Aauthor&limit=12`],
    ] as const;
    const plan = planReads(platformRegistry, doc, { subject: subject.id, account: null });
    const violations: string[] = [];
    for (const caller of [null, editor, publisher]) {
      const scope = caller ? `account:${caller.accountId}` : 'anonymous';
      const standalone: HttpResponse[] = [];
      for (const [, path] of routes) {
        const response = await send(caller, 'GET', path);
        status(response, 200);
        standalone.push(response);
      }
      const publicSubject = await send(null, 'GET', routes[0][1]);
      status(publicSubject, 200);
      expect(JSON.stringify(publicSubject.body)).not.toContain(privateCandidate);
      if (caller === publisher) expect(JSON.stringify(standalone[0]!.body)).toContain(privateCandidate);
      else expect(JSON.stringify(standalone[0]!.body)).not.toContain(privateCandidate);
      const list = standalone[1]!.body.collections as { id: string }[];
      expect(list.map(({ id }) => id)).toEqual([collections.public!]);
      expect(JSON.stringify(standalone[1]!.body)).not.toContain(collections.private!);
      expect(JSON.stringify(standalone[1]!.body)).not.toContain(collections.unlisted!);
      expect(JSON.stringify(standalone[3]!.body)).toContain(record(authored.body.subject).id);

      // Supply a genuine native token, with no minted or advanced source position.
      const incoming = standalone[0]!.headers.get(SESSION)!;
      expect(incoming).toBeString();
      const observed: Capture = { requests: [], active: 0, peak: 0 };
      const aggregate = await capture.run(observed, () =>
        send(
          caller,
          'POST',
          '/v1/pages:read',
          {
            target: { subject: subject.id },
          },
          { [SESSION]: incoming, cookie: 'not-forwarded=1', 'x-forwarded-for': '203.0.113.9' },
        ),
      );
      status(aggregate, 200);
      expect(aggregate.body.profile).toBe(digest);
      const reads = record(aggregate.body.reads);
      const subrequests = observed.requests.filter(({ root }) => !root);
      expect(subrequests.map(({ path }) => path).sort()).toEqual(routes.map(([, path]) => path).sort());
      expect(observed.peak - 1).toBeLessThanOrEqual(4); // outer page remains active
      for (const request of subrequests) {
        expect(request.headers.get('authorization')).toBe(caller ? `Bearer ${caller.bearer}` : null);
        expect(request.headers.get(SESSION)).toBe(incoming);
        expect(request.headers.get('cookie')).toBeNull();
        expect(request.headers.get('idempotency-key')).toBeNull();
        expect(request.headers.get('x-forwarded-for')).toBeNull();
      }
      for (let i = 0; i < routes.length; i++) {
        const [name] = routes[i]!;
        const actual = record(reads[plan.nodes[name]!]);
        expect(actual.status).toBe(standalone[i]!.status);
        if (name === 'works') {
          expect(record(actual.body).links).toEqual(standalone[i]!.body.links);
          expect(record(actual.body).count).toEqual(standalone[i]!.body.count);
        } else if (name !== 'header') expect(actual.body).toEqual(standalone[i]!.body);
        else {
          // Private standalone hydration is permitted. The public page has the caller's
          // public subject representation, while its request still uses the caller's bearer.
          const embedded = record(actual.body);
          if (JSON.stringify(embedded.subject) !== JSON.stringify(publicSubject.body.subject))
            violations.push(
              `${caller === publisher ? 'publisher' : caller ? 'editor' : 'anonymous'}: private standalone fields contaminated public subject`,
            );
          if (JSON.stringify(embedded.related) !== JSON.stringify(publicSubject.body.related))
            violations.push('publisher: private related IDs/fields contaminated public subject');
        }
      }
      expect(plan.nodes.header).toBe(plan.nodes.facts);
      expect(plan.nodes.collections).toBe(plan.nodes['collections-again']);
      const merged = components(ring, scope, aggregate);
      expect(merged.length).toBeGreaterThan(0);
      preserves(merged, decodeSession(ring, scope, incoming)!);
      for (const response of standalone) preserves(merged, components(ring, scope, response));
      for (const request of subrequests)
        preserves(
          merged,
          components(ring, scope, {
            status: request.status,
            headers: request.responseHeaders,
            body: request.body,
          }),
        );
    }
    for (const headers of [{ authorization: 'Bearer invalid-native-token' }]) {
      const standalone = await send(null, 'GET', routes[0][1], undefined, headers);
      const aggregate = await send(null, 'POST', '/v1/pages:read', { target: { subject: subject.id } }, headers);
      status(standalone, 401);
      status(aggregate, standalone.status);
      expect(stable(aggregate.body)).toEqual(stable(standalone.body));
    }
    const unscopedRead = await send(unscoped, 'GET', routes[0][1]);
    const unscopedPage = await send(unscoped, 'POST', '/v1/pages:read', { target: { subject: subject.id } });
    status(unscopedRead, 404);
    status(unscopedPage, unscopedRead.status);
    expect(stable(unscopedPage.body)).toEqual(stable(unscopedRead.body));

    // Fourteen distinct inverse reads cost 121 slots, plus subject(1) and
    // CollectionList(6): exactly sixteen distinct reads and 128 output slots.
    const limits = [...Array.from({ length: 12 }, (_, i) => i + 1), 19, 24];
    const bounded = document(
      node('SubjectHeader', 'header'),
      ...limits.map((limit) =>
        node('SubjectList', `works-${limit}`, {
          title: { en: 'Works' },
          property: 'schema:author',
          limit,
        }),
      ),
      node('CollectionList', 'collections', { title: { en: 'Collections' }, limit: 6 }),
      node('SubjectHeader', 'same-subject'),
      node('SubjectList', 'same-links', { title: { en: 'Duplicate' }, property: 'schema:author', limit: 24 }),
    );
    await activate(bounded);
    const budgetCapture: Capture = { requests: [], active: 0, peak: 0 };
    const budgetPage = await capture.run(budgetCapture, () =>
      send(null, 'POST', '/v1/pages:read', { target: { subject: subject.id } }),
    );
    status(budgetPage, 200);
    const executed = budgetCapture.requests.filter(({ root }) => !root);
    expect(executed).toHaveLength(16);
    expect(new Set(executed.map(({ method, path }) => `${method} ${path}`)).size).toBe(16);
    expect(budgetCapture.peak - 1).toBeLessThanOrEqual(4);
    for (const result of Object.values(record(budgetPage.body.reads))) expect(record(result).status).toBe(200);
    const beforeBudgetRejection = await send(null, 'GET', '/v1/presentation/active');
    for (const oversized of [
      // Seventeenth distinct read, still below 128 slots.
      document(
        node('SubjectHeader', 'header'),
        node('ReactionSummary', 'reactions'),
        ...Array.from({ length: 15 }, (_, i) =>
          node('SubjectList', `list-${i}`, {
            title: { en: 'Distinct' },
            property: 'schema:author',
            limit: i + 1,
          }),
        ),
      ),
      // Sixteen reads but 129 total slots (19 becomes 20).
      document(
        ...bounded.content.map((item) =>
          item.props.id === 'works-19'
            ? node('SubjectList', 'works-19', {
                title: { en: 'One slot too many' },
                property: 'schema:author',
                limit: 20,
              })
            : item,
        ),
      ),
    ]) {
      const refused = await write('/v1/presentation/profiles', { profile: profile(oversized) });
      status(refused, 400);
      expect(refused.body.code).toBe('invalid_request');
      expect((await send(null, 'GET', '/v1/presentation/active')).body).toEqual(beforeBudgetRejection.body);
    }

    // Native OpenSearch participates in an actual registry-planned public TypeList.
    indexing = await startSearchIndexing({
      pool: fixtures.pool,
      search: engine,
      prefix,
      source: subjectSource(fixtures.pool, Buffer.from(fixtures.runtime.routeKey, 'base64url')),
      listing: subjectListingSource(fixtures.pool),
    });
    await activate(
      document(
        node('TypeList', 'people', {
          title: { en: 'People' },
          types: ['schema:Person'],
          sort: 'name',
          limit: 12,
        }),
        node('TypeList', 'people-again', {
          title: { en: 'Same native query' },
          types: ['schema:Person'],
          sort: 'name',
          limit: 12,
        }),
      ),
    );
    const query = { filter: { type: { in: ['schema:Person'] } }, sort: 'name', limit: 12 };
    let standaloneSearch: HttpResponse | undefined;
    const deadline = Date.now() + 15_000;
    do {
      standaloneSearch = await send(null, 'POST', '/v1/subjects:search', query);
      if (
        standaloneSearch.status === 200 &&
        (standaloneSearch.body.subjects as { id: string }[]).some(({ id }) => id === subject.id)
      )
        break;
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    status(standaloneSearch!, 200);
    expect((standaloneSearch!.body.subjects as { id: string }[]).map(({ id }) => id)).toContain(subject.id);
    const observed: Capture = { requests: [], active: 0, peak: 0, engine: [] };
    const searchPage = await capture.run(observed, () =>
      send(null, 'POST', '/v1/pages:read', { target: { route: '/' } }),
    );
    status(searchPage, 200);
    expect(observed.requests.filter(({ path }) => path === '/v1/subjects:search')).toHaveLength(1);
    expect(observed.engine!.filter((request) => request.endsWith('/_search/template'))).toHaveLength(1);
    const searchRead = record(Object.values(record(searchPage.body.reads))[0]);
    expect(searchRead.status).toBe(standaloneSearch!.status);
    expect(record(searchRead.body).subjects).toEqual(standaloneSearch!.body.subjects);
    expect(JSON.stringify(searchPage.body)).not.toContain(privateCandidate);
    console.info(
      'native authority: standalone/aggregate statuses, public Collections/members, caller headers, physical dispatch and session components reached',
    );
    expect(violations, 'public page disclosure must exclude native private hydration').toEqual([]);
  } finally {
    try {
      await indexing?.stop();
    } finally {
      try {
        await engine.request('DELETE', `/${prefix}*`, undefined, {
          query: { allow_no_indices: true, ignore_unavailable: true },
        });
      } finally {
        await driver.close();
      }
    }
  }
}, 180_000);
