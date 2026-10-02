import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { discloseInventory, DisclosureUnavailable } from '../../../services/main/src/modules/disclosure/read.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import type { Assessed } from '../../../services/main/src/modules/suitability/contract.ts';
import type { Labels } from '../../../services/main/src/modules/suitability/policy.ts';
import { startHomeStack, seedHome } from './feed-read-support.ts';
import { WorkReaderStats } from '../../../services/main/src/modules/work/read-stats.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { png } from './media-support.ts';

test('G-897 H1: interactive reads return rated payload while public previews retain anonymous presentation', async () => {
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
    const baselineStatus = new Map<string, number>();
    for (const signed of [false, true]) for (const path of resourceGets) {
      baselineStatus.set(`${signed}:${path}`, (await readResource(path, work.work, signed)).status);
    }
    for (const signed of [false, true]) for (const suffix of ['', `/revisions/${description.revision.slice(-36)}`]) {
      const path = `/v1/semantic/resources/${work.work.slice(-36)}${suffix}`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : '');
      baselineStatus.set(`${signed}:semantic:${suffix}`, (await call('GET', path, undefined, signed)).status);
    }
    for (const signed of [false, true]) for (const read of requests(work.work, signed)) {
      const response = await read();
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect(await (await requests(work.work, false)[2]!()).text()).toContain('G897 secret statement');
    expect((await search()).total).toBe(3);
    expect((await call('GET', `/v1/media/uses/${media.body.items[0]!.use}`)).status).toBe(200);
    const rate = (labels: Labels, expectedRevision: string | null, actor = home.author.actor) =>
      call('PUT', `/v1/suitability/${work.work.slice(-36)}`, {
        actingSubject: actor, expectedRevision, labels, basis: 'platform' }, true);
    const assessment = await json<{ assessment: Assessed }>(await rate(['r18'], null));
    const absent = `https://rezics.com/id/${randomUUID()}`;
    for (const signed of [false, true]) {
      const ratedReads = requests(work.work, signed), absentReads = requests(absent, signed);
      for (const [index, read] of ratedReads.entries()) {
        const response = await read(), missing = await absentReads[index]!();
        const body = await response.text(), missingBody = await missing.text();
        if (index === 1) {
          expect(response.status, body).toBe(404);
          expect(response.status).toBe(missing.status);
          expect(body).not.toContain(work.title);
          expect(body.replaceAll(work.work, absent)).toBe(missingBody);
        } else {
          expect(response.status, body).toBe(200);
          expect(body).toContain(index === 0 ? work.title : 'G897 secret statement');
          expect(missingBody).not.toContain(work.title);
          expect(missingBody).not.toContain('G897 secret statement');
        }
      }
      for (const path of resourceGets) {
        const response = await readResource(path, work.work, signed);
        const missing = await readResource(path, absent, signed);
        const body = await response.text(), missingBody = await missing.text();
        expect(missing.status, missingBody).toBe(404);
        if (path.startsWith('/v1/public-previews/')) {
          expect(response.status, `${path}: ${body}`).toBe(404);
          expect(body).toBe(missingBody);
        } else expect(response.status, `${path}: ${body}`).toBe(baselineStatus.get(`${signed}:${path}`)!);
      }
      for (const suffix of ['', `/revisions/${description.revision.slice(-36)}`]) {
        const semantic = (target: string) => call('GET', `/v1/semantic/resources/${target.slice(-36)}${suffix}`
          + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
        const rated = await semantic(work.work), missing = await semantic(absent);
        expect(rated.status, await rated.clone().text()).toBe(baselineStatus.get(`${signed}:semantic:${suffix}`)!);
        expect(missing.status).toBe(404);
      }
      const stats = (target: string) => call('GET', `/v1/works/${target.slice(-36)}/reader-stats`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
      const ratedStats = await stats(work.work), missingStats = await stats(absent);
      expect(ratedStats.status, await ratedStats.clone().text()).toBe(200);
      expect(missingStats.status).toBe(404);
      const delivery = await call('GET', `/v1/media/uses/${media.body.items[0]!.use}`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
      const absentDelivery = await call('GET', `/v1/media/uses/${randomUUID()}`
        + (signed ? `?actingSubject=${encodeURIComponent(seeded.author)}` : ''), undefined, signed);
      expect(delivery.status).toBe(200);
      expect(absentDelivery.status).toBe(404);
    }
    const ratedResults = await search();
    expect(ratedResults.total).toBe(3);
    expect(JSON.stringify(ratedResults)).toContain(work.work);
    for (const child of [work.mainVersion, work.variants[0]!.contribution, release.release]) {
      expect((await discloseInventory(home.stack.env, [{ owner: 'graph', resource: child, component: 'record' }],
        undefined, 'read'))[0]).toBe('visible');
    }
    // Moderation is a command proof, independent of permission to read rated
    // content. Withdraw this Agent's Work read grant before correcting it.
    await home.stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.read'`, [home.author.actor, `work:read:${work.work}`]);
    const corrected = await json<{ assessment: Assessed }>(await rate(['r18g'], assessment.assessment.revision));
    expect(corrected.assessment.predecessor).toBe(assessment.assessment.revision);
    expect(corrected.assessment.labels).toEqual(['r18g']);
    for (const [index, read] of requests(work.work, false).entries()) {
      const response = await read();
      expect(response.status, await response.clone().text()).toBe(index === 1 ? 404 : 200);
    }
    expect((await rate([], assessment.assessment.revision)).status).toBe(409);
    expect((await rate([], corrected.assessment.revision, seeded.author)).status).toBe(403);
    await home.stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = 'governance:platform' AND action = 'governance.moderate'`, [home.author.actor]);
    expect((await rate([], corrected.assessment.revision)).status).toBe(403);
    await home.author.grant('governance:platform', 'governance.moderate');
    await home.author.grant(`work:read:${work.work}`, 'work.read');
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
    expect(JSON.stringify(exported)).not.toContain('disclosure_restricted');
    expect(JSON.stringify(exported)).toContain(work.work);
    const cleared = await json<{ assessment: Assessed }>(await rate([], corrected.assessment.revision));
    expect(cleared.assessment.predecessor).toBe(corrected.assessment.revision);
    expect(cleared.assessment.labels).toEqual([]);
    for (const read of requests(work.work, false)) expect((await read()).status).toBe(200);
  } finally { await home.stop(); }
}, 180_000);
