import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { discloseInventory, DisclosureUnavailable } from '../../../services/main/src/modules/disclosure/read.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { startHomeStack, seedHome } from './feed-read-support.ts';
import { WorkReaderStats } from '../../../services/main/src/modules/work/read-stats.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { png } from './media-support.ts';

test('G-897 H1: rated summaries, public previews and statements are absent for anonymous and unknown-age readers', async () => {
  const home = await startHomeStack('g897h1');
  try {
    const seeded = await seedHome(home, 3), work = seeded.works[0]!;
    const suitability = new SuitabilityStore(home.stack.accessPool, home.stack.access);
    const governance = new GovernanceStore(home.stack.accessPool,
      { capture: async () => { throw new Error('Evidence capture is unused in this read test'); } },
      { current: async () => null }, { current: async () => null });
    const cursor = new ContentProjectionCursor(home.stack.contentPool), consumer = `g897-${randomUUID()}`;
    await cursor.initialize(consumer);
    const projectContent = async () => {
      for (let i = 0; i < 200; i++) if (!await relayContentProjectionOnce(home.stack.env, home.stack.content, cursor, consumer)) return;
      throw new Error('Content fixture projection exceeded its preparation budget');
    };
    const app = createMainApp(home.stack.fuseki, { ...home.deps, suitability,
      workStats: new WorkReaderStats(home.stack.contentPool, home.stack.accessPool),
      accessPolicy: new AccessPolicyOwner(home.stack.accessPool),
      exports: new ExportStore(home.stack.contentPool),
      contentProjection: { content: home.stack.content, cursor, consumer },
      governance: { store: governance } });
    await home.author.grant('governance:platform', 'governance.moderate');
    // seedHome provisions a separate author Agent; platform authority belongs
    // to the upload fixture's represented Agent for this owner command.
    const call = (method: string, path: string, body?: object, signed = false) => app.handle(
      new Request(`http://main.local${path}`, { method, headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        'idempotency-key': randomUUID(),
        ...(signed ? { authorization: `Bearer ${home.author.token}` } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      const body = await response.text();
      if (response.status !== status) throw new Error(`${response.status}: ${body}`);
      return JSON.parse(body) as T;
    };
    const grant = async (scope: string, action: string) => {
      await home.stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await home.stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), home.author.principalId, seeded.author, action]);
      await home.stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), seeded.author, scope, action]);
    };
    const heads = (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?head ?mainHead ?selection WHERE { GRAPH <urn:rezics:graph:current> {
        <${work.work}> rv:head ?head . <${work.mainVersion}> rv:head ?mainHead ; rv:selectionHead ?selection } }`))
      .results!.bindings[0]!;
    const head = heads.head!.value;
    // Give the reproduced statements handler an actual authored scalar value.
    await grant(`semantic:edit:${work.work}`, 'semantic.change');
    const description = await json<{ revision: string }>(await call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1',
      target: work.work, expectedHead: head, actingSubject: seeded.author,
      state: { component: 'resource', types: [], properties: [{
        predicate: 'https://example.org/g897Property', value: { kind: 'string', lexical: 'G897 secret statement' },
      }] } }, true));
    await grant(`release:seal:${work.mainVersion}`, 'release.seal');
    const release = await json<{ release: string; sourcePosition: { dataEpoch: string; sequence: string } }>(
      await call('POST', '/v1/fixed-releases', { profile: 'fixed-native-text-release-v1', work: work.work,
        mainVersion: work.mainVersion, expectedMainRevision: heads.mainHead!.value,
        expectedSelection: heads.selection!.value, actingSubject: seeded.author }, true), 201);
    await grant(`export:${release.release}`, 'export.create');
    const exportBody = { profile: 'export-create-v1', actingSubject: seeded.author, useScope: 'excerpt',
      selection: { kind: 'fixed-release', reference: release.release, expectedPosition: {
        dataEpoch: release.sourcePosition.dataEpoch, sequence: release.sourcePosition.sequence } } };
    for (const [scope, action] of [[`content:draft:${work.work}`, 'content.draft'],
      [`content:publish:${work.work}`, 'content.publish'], [`work:read:${work.work}`, 'work.read']] as const) {
      await home.author.grant(scope, action);
    }
    const picture = await home.author.upload(png(12, 12), 'public');
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const media = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string };
      body: { items: { use: string }[] } }>(await call('POST', '/v1/media/publications', {
      profile: 'media-set-v1', resourceId: work.work, variantId: variant, expectedHead: null,
      assets: [picture.asset], actingSubject: home.author.actor }, true), 201);
    await json(await call('POST', '/v1/content-publications', { profile: 'content-publication-v1',
      preparationId: `g897-${randomUUID()}`, revisionId: media.revisionId, expectedDigest: media.byteDigest,
      expectedContentEpoch: media.sourcePosition.dataEpoch, resourceId: work.work, variantId: variant,
      expectedPublicationHead: null, actingSubject: home.author.actor }, true), 201);
    await projectContent();
    const search = async () => {
      await projectContent();
      return json<{ total: number; results: { work: string }[] }>(await call('POST', '/v1/queries',
        { profile: 'public-main-phrase-v1', phrase: 'g897h1', language: null }));
    };
    const requests = (target: string, signed: boolean) => [
      () => call('POST', '/v1/resources/summaries', { profile: 'resource-summary-batch-v1',
        resources: [target], ...(signed ? { actingSubject: seeded.author } : {}) }, signed),
      () => call('GET', `/v1/public-previews/${target.slice(-36)}`),
      () => call('GET', `/v1/resources/${target.slice(-36)}/statements`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed),
    ];
    const resourceGets = [
      '/v1/resources/:resource', '/v1/resources/:resource/page',
      '/v1/resources/:resource/statements', '/v1/resources/:resource/discussion',
      '/v1/resources/:resource/parts', '/v1/resources/:resource/wholes',
      '/v1/resources/:resource/relations', '/v1/resources/:resource/rating-contexts',
      '/v1/resources/:resource/ratings', '/v1/resources/:resource/reviews',
      '/v1/public-previews/:resource',
    ];
    // A future resource GET cannot escape this adverse boundary test by merely
    // adding a new route file or a different reader implementation.
    expect(app.routes.filter(route => route.method === 'GET'
      && /^\/v1\/(resources\/|public-previews\/)/.test(route.path))
      .map(route => route.path).sort()).toEqual(resourceGets.toSorted());
    const readResource = (path: string, target: string, signed: boolean) => {
      const url = new URL(path.replace(':resource', target.slice(-36)), 'http://main.local');
      if (path.endsWith('/reviews')) url.searchParams.set('context', seeded.realm.realm);
      if (signed && !path.startsWith('/v1/public-previews/')) url.searchParams.set('actingSubject', seeded.author);
      return call('GET', `${url.pathname}${url.search}`, undefined,
        signed && !path.startsWith('/v1/public-previews/'));
    };
    for (const signed of [false, true]) for (const read of requests(work.work, signed)) {
      const response = await read();
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect(await (await requests(work.work, false)[2]!()).text()).toContain('G897 secret statement');
    expect((await search()).total).toBe(3);
    expect((await call('GET', `/v1/media/uses/${media.body.items[0]!.use}`)).status).toBe(200);
    const assessment = await suitability.write(home.author.principal,
      { resource: work.work, base: 'work', work: work.work, revision: head, types: [], disclosure: 'public' },
      { actingSubject: home.author.actor, expectedRevision: null, labels: ['r18'], basis: 'platform' }, randomUUID());
    const absent = `https://rezics.com/id/${randomUUID()}`;
    for (const signed of [false, true]) {
      const deniedReads = requests(work.work, signed), absentReads = requests(absent, signed);
      for (const [index, read] of deniedReads.entries()) {
        const response = await read(), missing = await absentReads[index]!();
        const body = await response.text(), missingBody = await missing.text();
        expect(response.status, body).toBe(missing.status);
        expect(body).not.toContain(work.title);
        expect(body).not.toContain('G897 secret statement');
        expect(body.replaceAll(work.work, absent)).toBe(missingBody);
      }
      for (const path of resourceGets) {
        const response = await readResource(path, work.work, signed);
        const missing = await readResource(path, absent, signed);
        const body = await response.text(), missingBody = await missing.text();
        expect(response.status, `${path}: ${body}`).toBe(404);
        expect(response.status).toBe(missing.status);
        expect(body).toBe(missingBody);
      }
      for (const suffix of ['', `/revisions/${description.revision.slice(-36)}`]) {
        const semantic = (target: string) => call('GET', `/v1/semantic/resources/${target.slice(-36)}${suffix}`
          + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
        const denied = await semantic(work.work), missing = await semantic(absent);
        expect(denied.status, await denied.clone().text()).toBe(404);
        expect(await denied.text()).toBe(await missing.text());
      }
      const stats = (target: string) => call('GET', `/v1/works/${target.slice(-36)}/reader-stats`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
      const deniedStats = await stats(work.work), missingStats = await stats(absent);
      expect(deniedStats.status, await deniedStats.clone().text()).toBe(404);
      expect(await deniedStats.text()).toBe(await missingStats.text());
      const delivery = await call('GET', `/v1/media/uses/${media.body.items[0]!.use}`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
      const absentDelivery = await call('GET', `/v1/media/uses/${randomUUID()}`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
      expect(delivery.status).toBe(404);
      expect(await delivery.text()).toBe(await absentDelivery.text());
    }
    const filtered = await search();
    expect(filtered.total).toBe(2);
    expect(JSON.stringify(filtered)).not.toContain(work.work);
    for (const child of [work.mainVersion, work.variants[0]!.contribution, release.release]) {
      expect((await discloseInventory(home.stack.env, [{ owner: 'graph', resource: child, component: 'record' }],
        undefined, 'read'))[0]).not.toBe('visible');
    }
    const readDisclosure = governance.disclosure.read.bind(governance.disclosure);
    governance.disclosure.read = async () => { throw new DisclosureUnavailable('Assessment store unavailable'); };
    try {
      for (const signed of [false, true]) {
        for (const read of requests(work.work, signed)) {
          const response = await read();
          expect(response.status).toBe(503);
          expect(await response.text()).not.toContain(work.title);
        }
        const suffix = signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : '';
        expect((await call('GET', `/v1/works/${work.work.slice(-36)}/reader-stats${suffix}`, undefined, signed)).status).toBe(503);
        expect((await call('GET', `/v1/media/uses/${media.body.items[0]!.use}${suffix}`, undefined, signed)).status).toBe(503);
      }
      expect((await call('POST', '/v1/queries', { profile: 'public-main-phrase-v1', phrase: 'g897h1', language: null })).status).toBe(503);
      expect((await call('POST', '/v1/exports', exportBody, true)).status).toBe(503);
    } finally { governance.disclosure.read = readDisclosure; }
    // Exports run last: their owner sequence currently advances without a
    // Content outbox event, which would invalidate unrelated search fixtures.
    const exported = await json<{ plan: unknown }>(await call('POST', '/v1/exports', exportBody, true), 201);
    expect(JSON.stringify(exported)).toContain('disclosure_restricted');
    expect(JSON.stringify(exported)).not.toContain(work.title);
    await suitability.write(home.author.principal,
      { resource: work.work, base: 'work', work: work.work, revision: head, types: [], disclosure: 'public' },
      { actingSubject: home.author.actor, expectedRevision: assessment.assessment.revision,
        labels: [], basis: 'platform' }, randomUUID());
    for (const read of requests(work.work, false)) expect((await read()).status).toBe(200);
  } finally { await home.stop(); }
}, 180_000);
