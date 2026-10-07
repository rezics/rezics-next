import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { fromPlainText } from '@rezics/document';
import { uuidToSid } from '@rezics/model/address/sid';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ObjectUnavailable, S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { changeAdmittedComposition } from '../../../services/main/src/modules/structure/change-admitted.ts';
import type { CompositionOperation } from '../../../services/main/src/modules/structure/change.ts';
import { checkStructureManifest, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_INDEXED_MANIFEST_FORMAT }
  from '../../../services/main/src/modules/structure/format.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import type { ZoneRoute } from '../../../services/main/src/modules/zone/route.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { isForegroundOperation } from './support/operation-cost.ts';

// Exercise the published route HTTP operation against admitted Jena state and
// real S3 bytes. Empty Collection hydration cannot hide a navigation scan.
for (const mountCount of [128, 1_000]) test(`published Zone routes seek one retained key across ${mountCount} mounts and fail closed without coverage`, async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const prepared = performance.now();
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-route-keyed-${randomUUID()}`),
    'openid work:create work:edit work:read space:create zone:edit collection:edit semantic:read');
  const originalQuery = f.nativeFuseki.query.bind(f.nativeFuseki);
  const originalCommand = f.nativeFuseki.commandWithReceipt.bind(f.nativeFuseki);
  f.nativeFuseki.commandWithReceipt = async envelope => {
    const result = await originalCommand(envelope);
    if (envelope.update.includes('rv:sitePublicationRevision') && result.status !== 'committed') {
      console.error('Route fixture publication rejected', result.status,
        'report' in result ? result.report : '');
    }
    return result;
  };
  let measuring = false;
  let queries: string[] = [], reads: string[] = [];
  let hideCollection: { collection: string; work: string } | null = null;
  f.nativeFuseki.query = async (sparql, maxBytes) => {
    if (measuring && isForegroundOperation()) queries.push(sparql);
    if (hideCollection && sparql.includes('SELECT DISTINCT ?resource ?type')
      && sparql.includes(iri(hideCollection.work))) {
      const selected = hideCollection;
      hideCollection = null;
      await f.env.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(selected.collection)} <${RV}disclosure> <${RV}Public> } };
        INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(selected.collection)} <${RV}disclosure> <${RV}Private> } }`);
    }
    return originalQuery(sparql, maxBytes);
  };
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try { await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [f.account.a.id]); }
    finally { await accountPool.end(); }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    await f.authoredBody({ actingSubject: f.actor });
    // Content authoring needs direct controller continuity as well as stewardship.
    const controlId = randomUUID();
    await f.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity'::timestamptz)`, [controlId, f.principalId, f.actor]);
    await f.accessPool.query(`INSERT INTO access.agent_provision
      (id,principal_id,idempotency_key,request_digest,agent_id,agent_kind,display_name,
        principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
      VALUES ($1,$2,$3,$4,$5,'person','Route fixture author',0,'active',$6,0,$7)`,
    [randomUUID(), f.principalId, randomUUID(), 'a'.repeat(64), f.actor, f.env.lineage.dataEpoch, controlId]);
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    let fault: 'none' | 'legacy-coverage' | 'missing-key-root' = 'none';
    let retainedManifest = '', retainedKeyRoot = '';
    const counted: ImmutableObjects = {
      put: bytes => objects.put(bytes),
      get: async (digest, maxBytes, signal) => {
        if (measuring && isForegroundOperation()) reads.push(digest);
        if (fault === 'missing-key-root' && digest === retainedKeyRoot) {
          throw new ObjectUnavailable('Retained route key root is unavailable');
        }
        const bytes = await objects.get(digest, maxBytes, signal);
        if (fault === 'legacy-coverage' && digest === retainedManifest) {
          // Fault only this request's adapter; retained S3 bytes stay intact.
          const manifest = checkStructureManifest(bytes);
          const legacy = { ...manifest, format: STRUCTURE_MANIFEST_FORMAT };
          Reflect.deleteProperty(legacy, 'qualifierKeys');
          return new TextEncoder().encode(JSON.stringify(legacy));
        }
        return bytes;
      },
    };
    Object.assign(f.env, { structureObjects: counted });
    const content = new ContentCore(f.pool);
    let zone = '';
    const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
      access: f.access, content, contentAuthoring: content, catalogueIntake: f.catalogueIntake });
    const call = (method: string, path: string, body?: object, authenticated = true) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { ...(authenticated ? { authorization: `Bearer ${f.account.tokenA}` } : {}),
          'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    await f.grant('space:create:root', 'space.create');
    const created = await f.json<{ space: string; zone: string; navigation: string; navigationRevision: string }>(
      await call('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Keyed route site',
        capabilities: ['zone'], actingSubject: f.actor }), 201);
    zone = created.zone;
    const initialNavigation = (await readCompositionHeader(f.env, created.navigation))!;
    expect(checkStructureManifest(await objects.get(initialNavigation.manifest.slice(-64))))
      .toMatchObject({ format: STRUCTURE_INDEXED_MANIFEST_FORMAT, qualifierKeys: { root: { count: 0 } } });
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const curated = await f.json<{ structure: string; revision: string }>(await call('POST', '/v1/collections', {
      collection, name: 'Empty routed collection', disclosure: 'public', actingSubject: f.actor,
    }), 201);
    expect((await normalizeStoredMembership(f.env)).complete).toBe(true);
    const root = `/v1/zones/${shortId(zone)}`;
    let head = created.navigationRevision;
    const mutate = async (operations: readonly CompositionOperation[]) => {
      const changed = await changeAdmittedComposition(f.env, f.account.verifier, f.access,
        new Request('http://main.local/structure-change', { headers: { authorization: `Bearer ${f.account.tokenA}` } }),
        { structure: created.navigation, expectedHead: head, operations,
          actingSubject: f.actor, idempotencyKey: randomUUID() });
      expect(changed.outcome).toBe('succeeded');
      expect(changed.revision).toBeString();
      head = changed.revision!;
      return changed;
    };
    const mount = (segment: string, key: 'alias' | 'id' = 'id', disclosure: 'public' | 'private' = 'public'):
      CompositionOperation => ({ op: 'insert', role: 'mount', parent: created.navigation,
        position: 'last', target: collection,
        qualifier: { type: 'zone-mount', zone, routeSegment: segment, disclosure, key } });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await f.json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      await call('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: zone,
        variantId, expectedHead: null, document: fromPlainText('Published keyed route home', 'blocks'),
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: f.actor }), 201);
    const publish = async () => f.json(await call('POST', `${root}/site-publications`, {
      routesRevision: head, navigationRevision: head,
      expectedHead: (await readZoneConfiguration(f.env, zone)).revision, actingSubject: f.actor,
      pages: [{ page: zone, variantId, revisionId: saved.revisionId,
        byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch }],
    }), 201);
    await publish();
    let firstOccurrence = '';
    for (let offset = 0; offset < mountCount; offset += 16) {
      const changed = await mutate(Array.from({ length: Math.min(16, mountCount - offset) }, (_, index) =>
        mount(`route-${offset + index}`, offset + index === 0 ? 'alias' : 'id')));
      if (offset === 0) firstOccurrence = changed.occurrences![0]!;
    }
    await publish();
    expect(performance.now() - prepared).toBeLessThan(600_000);
    const header = (await readCompositionHeader(f.env, created.navigation))!;
    retainedManifest = header.manifest.slice(-64);
    const manifest = checkStructureManifest(await objects.get(retainedManifest));
    if (!('qualifierKeys' in manifest)) throw new Error('Published fixture must have complete qualifier coverage');
    expect(manifest.placementCount).toBe(mountCount);
    retainedKeyRoot = manifest.qualifierKeys.root.page.slice(7);
    const navigationOrderRoot = manifest.order.page.slice(7);
    const route = (path: string, authenticated = false) => call('GET', `${root}/routes?${new URLSearchParams({ path,
      ...(authenticated ? { actingSubject: f.actor } : {}) })}`, undefined, authenticated);
    const missingProblem = { type: 'https://rezics.com/problems/route_missing',
      title: 'Zone route is unavailable', status: 404, code: 'route_missing' };
    const missing = async (response: Response) => {
      expect(await f.json(response, 404)).toEqual(missingProblem);
    };
    const measure = async (segment: string, status: number) => {
      queries = []; reads = [];
      const before = f.nativeFuseki.queries;
      measuring = true;
      let response: Response;
      try { response = await route(`/${segment}`); }
      finally { measuring = false; }
      const graphCalls = f.nativeFuseki.queries - before;
      const keyedRevisionReads = queries.filter(query => query.includes('SELECT ?manifest ?count ?epoch ?sequence')
        && query.includes(`<${head}>`)).length;
      const navigationOrderReads = reads.filter(digest => digest === navigationOrderRoot).length;
      console.log('Published Zone route key cost', JSON.stringify({ segment, graphCalls, keyedRevisionReads,
        navigationOrderReads, objectReads: reads.length }));
      expect(graphCalls).toBeLessThanOrEqual(64);
      expect(keyedRevisionReads).toBe(1);
      expect(navigationOrderReads).toBe(0);
      expect(reads.length).toBeLessThanOrEqual(20);
      const body = await f.json<ZoneRoute>(response, status);
      return { body, graphCalls };
    };
    const first = await measure('route-0', 200);
    const lastSegment = `route-${mountCount - 1}`;
    const last = await measure(lastSegment, 200);
    const absent = await measure('absent', 404);
    expect(first.body).toMatchObject({ kind: 'index', mount: { occurrence: firstOccurrence, target: collection, key: 'alias' },
      items: [], nextCursor: null });
    expect(last.body).toMatchObject({ kind: 'index', mount: { target: collection, key: 'id' }, items: [] });
    expect(last.graphCalls).toBe(first.graphCalls);
    expect(absent.graphCalls).toBeLessThanOrEqual(first.graphCalls);
    expect(absent.body).toEqual(missingProblem);

    for (const failure of ['legacy-coverage', 'missing-key-root'] as const) {
      fault = failure;
      try {
        for (const segment of ['route-0', 'absent']) {
          const response = await route(`/${segment}`);
          expect(await f.json(response, 503)).toMatchObject({ code: 'zone_unavailable' });
        }
      } finally { fault = 'none'; }
    }
    expect((await route('/route-0')).status).toBe(200);

    await mutate([mount('draft-added')]);
    await missing(await route('/draft-added'));
    expect((await route(`/${lastSegment}`)).status).toBe(200);
    await publish();
    expect((await route('/draft-added')).status).toBe(200);
    await mutate([{ op: 'remove', occurrence: firstOccurrence }]);
    expect((await route('/route-0')).status).toBe(200);
    await publish();
    await missing(await route('/route-0'));
    expect((await route(`/${lastSegment}`)).status).toBe(200);

    // Add content only after cost probes, then exercise both retained key modes.
    await mutate([mount('aliases', 'alias'), mount('private-mount', 'id', 'private')]);
    await publish();
    const work = await f.json<{ work: string }>(await call('POST', '/v1/works', await f.catalogueBody({
      profile: 'metadata-only-v1', title: 'Keyed route member', language: 'en', actingSubject: f.actor,
    })), 201);
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.json(await call('POST', `/v1/collections/${shortId(collection)}/changes`, {
      expectedHead: curated.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', role: 'member', parent: curated.structure, position: 'last',
        target: work.work, selection: { mode: 'follow-context' } }],
    }), 200);
    const alias = `member-${randomUUID()}`;
    await f.accessPool.query(`INSERT INTO access.alias_registry
      (scope,key,skeleton,holder,controller,state,revision) VALUES ($1,$2,$2,$3,$4,'current',$5)`,
    [`zone:${created.space}`, alias, work.work, f.actor, randomUUID()]);
    expect(await f.json(await route(`/aliases/${alias}`), 200)).toMatchObject({ kind: 'detail',
      mount: { key: 'alias' }, resource: { id: work.work, address: { key: alias } } });
    for (const key of [shortId(work.work), uuidToSid(shortId(work.work))]) {
      expect(await f.json(await route(`/${lastSegment}/${key}`), 200)).toMatchObject({ kind: 'detail',
        mount: { key: 'id' }, resource: { id: work.work } });
    }
    await missing(await route(`/${lastSegment}/${alias}`));
    await missing(await route('/private-mount'));
    expect((await route('/private-mount', true)).status).toBe(200);
    // A published key admits membership, while delivery still checks the
    // Collection's current disclosure after resource hydration.
    hideCollection = { collection, work: work.work };
    try {
      await missing(await route(`/aliases/${alias}`));
      expect(hideCollection).toBeNull();
    } finally {
      hideCollection = null;
      await f.env.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(collection)} <${RV}disclosure> <${RV}Private> } };
        INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(collection)} <${RV}disclosure> <${RV}Public> } }`);
    }
    expect((await route(`/aliases/${alias}`)).status).toBe(200);
  } finally {
    f.nativeFuseki.query = originalQuery;
    f.nativeFuseki.commandWithReceipt = originalCommand;
    await f.close();
  }
}, 600_000);
