import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ContentCore } from '../../../services/content/src/core.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { saveAdmittedContentDraft } from '../../../services/main/src/modules/content-publication/draft.ts';
import { ContentSearchReadAccess } from '../../../services/main/src/modules/search-disclosure/content-read-lease.ts';
import { PrivateSearchSettlement } from '../../../services/main/src/modules/contribution/private-search-settlement.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { queryRoutes } from '../../../services/main/src/routes/query.ts';
import { graphQueryRoutes } from '../../../services/main/src/routes/graph-queries.ts';
import { semanticRoutes } from '../../../services/main/src/routes/semantic.ts';
import { exportRoutes } from '../../../services/main/src/routes/exports.ts';
import { contentPrivateSearchRoutes } from '../../../services/main/src/routes/content-private-search.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

// Fixture setup, the first semantic write and three private-delivery sockets take
// 7-11 s on a cold shared stack, beyond Bun's 5 s default.
test('Selected capability gates retain closed refusals through HTTP owners and recheck private delivery after grant revocation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `selected-capability-${randomUUID()}`),
    'openid work:create work:edit work:read export:create export:read');
  const content = new ContentCore(f.pool);
  const searchAccess = new ContentSearchReadAccess(f.accessPool);
  let revokeOnArm: string | undefined;
  const revoke = (grant: string) => f.accessPool.query(`UPDATE access.principal_permission_grant
    SET active=false,generation=generation+1 WHERE id=$1`, [grant]);
  const deliveryAccess = new Proxy(searchAccess, { get(target, key) {
    if (key === 'arm') return async (...args: Parameters<typeof searchAccess.arm>) => {
      const armed = await searchAccess.arm(...args);
      if (revokeOnArm) { const grant = revokeOnArm; revokeOnArm = undefined; await revoke(grant); }
      return armed;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const work = { environment: f.env, account: f.account.verifier, access: f.access,
    platformAccess: new AccessExposure(f.accessPool), exports: new ExportStore(f.pool),
    contentPrivateSearch: { content, access: deliveryAccess, settlement: new PrivateSearchSettlement(f.accessPool) },
  } as MainWorkDependencies;
  const app = new Elysia().use(queryRoutes(f.env.fuseki, work)).use(graphQueryRoutes(work))
    .use(semanticRoutes(f.env.fuseki, work)).use(exportRoutes(work)).use(contentPrivateSearchRoutes(work));
  app.listen({ hostname: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server!.port}`;
  const http = (path: string, body?: unknown, key = randomUUID()) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${f.account.tokenA}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const open = async (capability: string) => {
    const id = randomUUID();
    await f.accessPool.query(`INSERT INTO access.principal_permission_grant
      (id,issuer_subject,principal_id,scope_id,action,valid_until)
      VALUES ($1,$2,$3,'platform:access',$4,now()+interval '1 hour')`,
    [id, f.actor, f.principalId, `platform:use:${capability}`]);
    await f.accessPool.query(`INSERT INTO access.platform_grant_episode
      (id,principal_grant_id,issuer_subject,permission,scope_id,assigned_by_principal,receipt)
      VALUES ($1,$1,$2,$3,'platform:access',$4,$5)`,
    [id, f.actor, `platform:use:${capability}`, f.principalId,
      `urn:rezics:access-receipt:${createHash('sha256').update(id).digest('hex')}`]);
    return id;
  };
  const expectClosed = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'platform_closed', status: 403 });
  };
  try {
    const query = { profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort: 'newest',
      filter: { all: [{ facet: 'type', any: ['https://schema.org/Event'] }] } };
    await expectClosed(await http('/v1/query', query));
    const edit = { profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
      state: { component: 'resource', types: ['https://schema.org/Event'], properties: [] } };
    await expectClosed(await http('/v1/semantic/changes', edit));
    const eventGrant = await open('events');
    // The opening grant does not provide the semantic creation grant.
    const noAuthority = await http('/v1/semantic/changes', edit);
    expect(noAuthority.status).toBe(403);
    expect(await noAuthority.json()).toMatchObject({ code: 'authority_denied' });
    await f.grant('semantic:create:root', 'semantic.change');
    const made = await http('/v1/semantic/changes', edit);
    expect(made.status).toBe(201);
    const resource = await made.json() as { component: string; revision: string; sourcePosition: { dataEpoch: string; sequence: string } };
    await f.grant(`semantic:read:${resource.component}`, 'semantic.read');
    const exportInput = { profile: 'export-create-v1', actingSubject: f.actor, useScope: 'full', selection: {
      kind: 'semantic-revision', resource: resource.component, reference: resource.revision, expectedPosition: { dataEpoch: resource.sourcePosition.dataEpoch, sequence: resource.sourcePosition.sequence },
    } };
    // A public generic export operation cannot open its selected historical profile.
    await expectClosed(await http('/v1/exports', exportInput));
    const dumpGrant = await open('postV1Exports');
    await f.grant(`export:${resource.revision}`, 'export.create');
    const exportKey = randomUUID();
    const exported = await http('/v1/exports', exportInput, exportKey);
    expect(exported.status).toBe(201);
    const saved = await exported.json() as { manifestId: string; plan: { targetProfile: string } };
    expect(saved.plan.targetProfile).toBe('rezics-semantic-values-v1');
    const replay = await http('/v1/exports', exportInput, exportKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ manifestId: saved.manifestId, replayed: true });
    await expectClosed(await http(`/v1/exports/${saved.manifestId}`));
    const downloadGrant = await open('getV1ExportsByExport');
    expect((await http(`/v1/exports/${saved.manifestId}`)).status).toBe(200);
    await revoke(downloadGrant);
    await expectClosed(await http(`/v1/exports/${saved.manifestId}`));
    await revoke(dumpGrant);
    await expectClosed(await http('/v1/exports', exportInput, exportKey));

    // Both implemented graph profiles are one-hop. Closed SPARQL/multi-hop
    // execution has no admitted profile; it cannot be described as a public read.
    const graph = await http('/v1/graph/queries', { profile: 'statement-graph-v1', anchor: resource.component,
      actingSubject: f.actor, direction: 'outgoing' });
    expect(graph.status).toBe(200);
    const unadmittedGraph = await http('/v1/graph/queries', { profile: 'sparql', actingSubject: f.actor,
      query: 'SELECT * WHERE {?s ?p ?o}' });
    expect(unadmittedGraph.status).toBe(422);

    // A Work can carry the generic Event description as a separate component.
    // Its exact private keyword source keeps ordinary work.read authority.
    const title = `Selected private source ${randomUUID()}`;
    const native = await activateMetadataWork(f.env, { title, admission: { id: randomUUID(),
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(),
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    await f.grant(`work:read:${native.work}`, 'work.read');
    await f.grant(`semantic:edit:${native.work}`, 'semantic.change');
    const description = await http('/v1/semantic/changes', { ...edit, target: native.work, expectedHead: native.workRevision });
    expect(description.status, await description.clone().text()).toBe(200);
    const variant = `urn:rezics:variant:${randomUUID()}`;
    await f.grant(`content:draft:${native.work}`, 'content.draft');
    const phrase = `secret${randomUUID().replaceAll('-', '')}`;
    const draft = await saveAdmittedContentDraft(f.env, content, f.account.verifier, f.access,
      new Request(`${base}/v1/content-drafts`, { headers: { authorization: `Bearer ${f.account.tokenA}` } }),
      { resourceId: native.work, variant: { id: variant, resourceId: native.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, body: `${phrase} private body`, actingSubject: f.actor, idempotencyKey: randomUUID() });
    expect(draft.outcome).toBe('succeeded');
    const input = { type: 'private-content-query-v1', profile: 'private-content-phrase-v1',
      resource: native.work, variant, actingSubject: f.actor, phrase };
    const socketRun = async () => {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/v1/private-content-queries`,
        { headers: { authorization: `Bearer ${f.account.tokenA}` } } as unknown as string[]);
      try {
        return await new Promise<{ frames: Array<{ type: string; code?: string; leaseId?: string; receiptChallenge?: string }>; close: number }>((done, reject) => {
          const frames: Array<{ type: string; code?: string; leaseId?: string; receiptChallenge?: string }> = [];
          const timer = setTimeout(() => { socket.close(); reject(new Error('Private capability delivery timed out')); }, 15_000);
          socket.onopen = () => socket.send(JSON.stringify(input));
          socket.onmessage = message => {
            const frame = JSON.parse(String(message.data)) as typeof frames[number]; frames.push(frame);
            if (frame.type === 'private-content-result-v1') socket.send(JSON.stringify({
              type: 'private-content-receipt-v1', leaseId: frame.leaseId, receiptChallenge: frame.receiptChallenge }));
          };
          socket.onclose = closed => { clearTimeout(timer); done({ frames, close: closed.code }); };
          socket.onerror = () => { clearTimeout(timer); reject(new Error('Private capability socket failed')); };
        });
      } finally { socket.close(); }
    };
    const publicDelivery = await socketRun();
    expect(publicDelivery.close).toBe(1000);
    expect(publicDelivery.frames.map(frame => frame.type)).toEqual(['private-content-result-v1']);
    revokeOnArm = eventGrant;
    const withheld = await socketRun();
    expect(withheld.close).toBe(4403);
    expect(withheld.frames).toEqual([expect.objectContaining({ type: 'problem', code: 'platform_closed', status: 403 })]);
    const lease = (await f.accessPool.query<{ state: string }>(`SELECT state FROM access.search_read_lease
      WHERE content_resource=$1 ORDER BY expires_at DESC LIMIT 1`, [native.work])).rows[0];
    expect(lease?.state).toBe('withheld');
    const closedAgain = await socketRun();
    expect(closedAgain.frames).toEqual([expect.objectContaining({ code: 'platform_closed' })]);
  } finally {
    await app.stop(true);
    await f.close();
  }
}, 60_000);
