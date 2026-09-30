import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, png } from './media-support.ts';
import { publicSemantics, SEMANTIC_DISCLOSURE_LIMIT }
  from '../../../services/main/src/modules/access/semantic-disclosure.ts';
import { SEMANTIC_TERMS } from '../../../services/main/src/modules/semantic/schema.ts';
import { searchRoutes, type SearchRouteDependencies }
  from '../../../services/main/src/routes/search.ts';
import { mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { SemanticStageStore, prepareSemanticStagePages }
  from '../../../services/main/src/modules/semantic/staging.ts';
import { readActiveModelGeneration }
  from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { readExportPlan, ExportSourceNotFound }
  from '../../../services/main/src/modules/export/readers.ts';

const ID = 'https://rezics.com/id/';
const local = (ref: string) => ref.slice(ID.length);
const id = () => `${ID}${randomUUID()}`;
type Write = { component: string; revision: string; sourcePosition: { dataEpoch: string; sequence: string } };
type Summary = { reference: string; status: string; disclosure?: string; name?: { value: string } };

test('G-539: current accepted semantic Resources follow live Work disclosure and Access restrictions across reads', async () => {
  const f = await startMediaStack('g-539');
  try {
    f.access.configureBaseline(f.fuseki);
    const owner = await f.member('semantic-owner');
    const outsider = await f.member('semantic-outsider');
    const editor = await f.member('semantic-editor');
    const shown = await f.publicWork(owner.actor);
    const hidden = await f.privateWork(owner.actor);
    await owner.grant('semantic:create:root', 'semantic.change');
    await owner.grant(`work:read:${shown.work}`, 'work.read');
    await owner.grant(`work:read:${hidden.work}`, 'work.read');
    expect((await publicSemantics({ pool: f.accessPool, graph: f.fuseki }, [shown.work])).size).toBe(0);
    expect(await f.access.canReadWork(owner.principal, owner.actor, shown.work)).toBe(true);
    const state = (name: string, works: readonly string[], type = 'Character', lifecycle = 'active') => ({
      component: 'resource', types: [type.startsWith('https://') ? type : `https://rezics.com/vocab/${type}`], lifecycle,
      properties: [{ predicate: 'https://schema.org/name', value: {
        kind: 'language-string', lexical: name, language: 'en' } },
      ...works.map(work => ({ predicate: SEMANTIC_TERMS.semanticWork, value: { kind: 'resource', ref: work } }))],
    });
    const create = async (name: string, works: readonly string[], type?: string, lifecycle?: string) => {
      const response = await owner.send('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null,
        state: state(name, works, type, lifecycle), actingSubject: owner.actor });
      if (response.status !== 201) throw new Error(`create semantic: ${response.status} ${await response.text()}`);
      return await response.json() as Write;
    };
    const visible = await create('Public heroine', [shown.work]);
    const privateOnly = await create('Draft heroine', [hidden.work]);
    const unlinked = await create('Unlinked heroine', []);
    const retired = await create('Retired heroine', [shown.work], 'Character', 'retired');
    const protectedResource = await create('Protected heroine', [shown.work]);
    const restricted = await create('Restricted heroine', [shown.work]);
    const closed = await create('Closed heroine', [shown.work]);
    const place = await create('Public place', [hidden.work, shown.work], 'Place');
    const event = await create('Public event', [shown.work], 'https://schema.org/Event');
    // An actual Content stage has pages but no committed graph head.
    const staged = id();
    const stagePages = prepareSemanticStagePages([{ target: staged, expectedHead: null,
      state: state('Staged heroine', [shown.work]) }]);
    const stageStore = new SemanticStageStore(f.contentPool, f.objects('semantic/stages/'));
    const stageAdmission = f.admission(owner.actor, 'semantic:create:root', 'semantic.change.bulk', 'a'.repeat(64));
    await stageStore.create({ admission: stageAdmission, principalId: owner.principalId,
      actingSubject: owner.actor, idempotencyKey: stageAdmission.idempotencyKey,
      requestDigest: stageAdmission.requestDigest, generation: (await readActiveModelGeneration(f.fuseki)).generation,
      pages: stagePages.pages, itemCount: stagePages.itemCount });
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> { <${protectedResource.component}> rv:protectionHead <${id()}> . } }`);
    await owner.grant(`semantic:read:${closed.component}`, 'semantic.read');
    await f.access.strongCloseScope(`semantic:read:${closed.component}`, '0');

    const policyBody = (resource: string, epoch: string, policyId: string, head: string, actor: string) => ({
      profile: 'access-policy-change-v1', action: 'publish-revision', scopeId: `semantic:read:${resource}`,
      expectedAuthorityEpoch: epoch, policyId, expectedHeadRevision: head,
      issuerSubject: actor, mandatory: [], ordered: [],
    });
    const restrictionId = randomUUID();
    const restriction = policyBody(restricted.component, '0', restrictionId, '0', owner.actor);
    // Reading or type membership supplies no authority to restrict.
    await owner.grant(`semantic:read:${restricted.component}`, 'semantic.read');
    expect((await owner.send('POST', '/v1/access/policy-changes', restriction)).status).toBe(403);
    await owner.grant(`semantic:edit:${restricted.component}`, 'semantic.change');
    const policyKey = `restrict-${randomUUID()}`;
    const policy = await owner.send('POST', '/v1/access/policy-changes', restriction, policyKey);
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ revision: '1', authorityEpoch: '1', replayed: false });
    expect(await (await owner.send('POST', '/v1/access/policy-changes', restriction, policyKey)).json())
      .toMatchObject({ revision: '1', authorityEpoch: '1', replayed: true });
    await editor.grant(`semantic:edit:${restricted.component}`, 'semantic.change');
    expect((await editor.send('POST', '/v1/access/policy-changes',
      { ...policyBody(restricted.component, '1', restrictionId, '1', editor.actor),
        ordered: [{ ruleId: randomUUID(), actions: ['work.read'], effect: 'allow',
          condition: { op: 'authenticated' } }] })).status).toBe(200);
    // Any policy, including an empty revision, is the restriction mark.
    expect((await publicSemantics({ pool: f.accessPool, graph: f.fuseki }, [restricted.component])).size).toBe(0);
    expect((await owner.send('POST', '/v1/access/policy-changes',
      policyBody(restricted.component, '0', restrictionId, '2', owner.actor))).status).toBe(409);

    const anonymous = (path: string) => f.call('GET', path);
    const viewers = [anonymous, outsider.read];
    const readPath = (ref: string) => `/v1/semantic/resources/${local(ref)}`;
    const resourcePath = (ref: string) => `/v1/resources/${local(ref)}`;
    const previewPath = (ref: string) => `/v1/public-previews/${local(ref)}`;
    for (const read of viewers) {
      for (const ref of [visible.component, place.component, event.component]) {
        expect((await read(readPath(ref))).status).toBe(200);
        const summary = await read(resourcePath(ref));
        expect(summary.status).toBe(200);
        expect(await summary.json()).toMatchObject({ disclosure: 'public' });
      }
      const absentSemantic = await (await read(readPath(id()))).text();
      const absentSummary = await (await read(resourcePath(id()))).text();
      for (const ref of [privateOnly.component, unlinked.component, retired.component,
        protectedResource.component, restricted.component, closed.component, staged]) {
        const semantic = await read(readPath(ref));
        expect(semantic.status).toBe(404);
        expect(await semantic.text()).toBe(absentSemantic);
        const summary = await read(resourcePath(ref));
        expect(summary.status).toBe(404);
        expect(await summary.text()).toBe(absentSummary);
      }
    }
    expect(await (await owner.read(resourcePath(restricted.component))).json())
      .toMatchObject({ disclosure: 'restricted', name: { value: 'Restricted heroine' } });
    expect((await owner.read(readPath(restricted.component))).status).toBe(200);
    expect((await owner.read(readPath(closed.component))).status).toBe(404);
    expect((await anonymous(previewPath(visible.component))).status).toBe(200);
    const absentPreview = await (await anonymous(previewPath(id()))).text();
    expect(await (await anonymous(previewPath(restricted.component))).text()).toBe(absentPreview);
    const refs = [visible.component, privateOnly.component, unlinked.component, restricted.component];
    const batch = await f.call('POST', '/v1/resources/summaries', { body: {
      profile: 'resource-summary-batch-v1', resources: refs } });
    expect(batch.status).toBe(200);
    const summaries = (await batch.json() as { summaries: Summary[] }).summaries;
    expect(summaries.map(row => row.status)).toEqual(['available', 'unavailable', 'unavailable', 'unavailable']);

    // Anonymous media delivery shares the same target disclosure decision.
    await owner.grant(`media:avatar:${visible.component}`, 'media.avatar');
    const asset = await owner.upload(png(64, 64));
    const selected = await owner.send('PUT', `/v1/resources/${local(visible.component)}/avatar`, {
      profile: 'resource-avatar-selection-v1', asset: asset.asset, expectedSelection: null, actingSubject: owner.actor });
    expect(selected.status).toBe(201);
    const avatar = (await selected.json() as { selection: string }).selection;
    expect((await anonymous(`/v1/media/avatars/${avatar}`)).status).toBe(200);

    // Public search uses the same batched Access reader before matching/counting.
    const searchApp = searchRoutes(f.fuseki, { environment: f.env, access: f.access,
      account: { verify: async (request: Request) => request.headers.get('authorization') === `Bearer ${owner.token}`
        ? owner.principal : outsider.principal }, media: f.media, mediaAccess: f.mediaAccess,
      governance: { store: { restrictedTitles: async () => new Set<string>() } },
    } as unknown as SearchRouteDependencies);
    const search = async (token?: string) => {
      const response = await searchApp.handle(new Request('http://main.local/v1/queries', {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({
          profile: 'public-disclosed-fields-phrase-v1', phrase: 'heroine', contexts: [], statements: [],
          resources: refs, mediaContext: DEFAULT_MEDIA_CONTEXT, language: 'en',
        }),
      }));
      if (response.status !== 200) throw new Error(`search: ${response.status} ${await response.text()}`);
      return await response.json() as { total: number; results: { owner: string; score: number }[];
        facets: { contexts: number; statements: number; names: number } };
    };
    for (const token of [undefined, outsider.token, owner.token]) {
      expect(await search(token)).toMatchObject({ total: 1,
        results: [{ owner: visible.component, score: 1 }],
        facets: { contexts: 0, statements: 0, names: 1 } });
    }

    // Unrestriction ends the governing effect without deleting any audit basis.
    await owner.grant(`media:avatar:${restricted.component}`, 'media.avatar');
    const restrictedAvatarResponse = await owner.send('PUT', `/v1/resources/${local(restricted.component)}/avatar`, {
      profile: 'resource-avatar-selection-v1', asset: asset.asset, expectedSelection: null, actingSubject: owner.actor });
    expect(restrictedAvatarResponse.status).toBe(201);
    const restrictedAvatar = (await restrictedAvatarResponse.json() as { selection: string }).selection;
    expect((await anonymous(`/v1/media/avatars/${restrictedAvatar}`)).status).toBe(404);
    const decisionRequest = { profile: 'access-policy-decision-v1', scopeId: restriction.scopeId,
      action: 'work.read', actingSubject: owner.actor, reusable: true };
    const decisionResponse = await owner.send('POST', '/v1/access/policy-decisions', decisionRequest);
    expect(decisionResponse.status).toBe(200);
    const decision = await decisionResponse.json() as { decisionId: string };
    expect(decision).toMatchObject({ result: 'allow', policyRevision: '2', reusable: true });
    const history = async () => ({
      revisions: (await f.accessPool.query('SELECT * FROM access.policy_revision WHERE policy_id = $1 ORDER BY revision',
        [restrictionId])).rows,
      rules: (await f.accessPool.query('SELECT * FROM access.policy_rule WHERE policy_id = $1 ORDER BY revision, tier, position',
        [restrictionId])).rows,
      references: (await f.accessPool.query('SELECT * FROM access.policy_rule_set_reference WHERE policy_id = $1',
        [restrictionId])).rows,
      frames: (await f.accessPool.query('SELECT * FROM access.decision_snapshot WHERE policy_id = $1',
        [restrictionId])).rows,
      receipts: (await f.accessPool.query(`SELECT * FROM access.policy_change_receipt
        WHERE policy_id = $1 AND action = 'publish-revision' ORDER BY policy_revision`, [restrictionId])).rows,
    });
    const retained = await history();
    expect(retained.revisions).toHaveLength(2);
    expect(retained.rules).toHaveLength(1);
    expect(retained.frames).toHaveLength(1);
    const end = { profile: 'access-policy-change-v1', action: 'end-policy', policyId: restrictionId,
      scopeId: restriction.scopeId, expectedHeadRevision: '2', expectedAuthorityEpoch: '2',
      issuerSubject: editor.actor };
    await outsider.grant(restriction.scopeId, 'semantic.read');
    expect((await outsider.send('POST', '/v1/access/policy-changes', { ...end, issuerSubject: outsider.actor })).status)
      .toBe(403);
    expect((await editor.send('POST', '/v1/access/policy-changes', { ...end, expectedAuthorityEpoch: '1' })).status)
      .toBe(409);
    expect((await editor.send('POST', '/v1/access/policy-changes', { ...end, expectedHeadRevision: '1' })).status)
      .toBe(409);
    await f.accessPool.query('UPDATE access.recovery_fence SET open = false');
    expect((await editor.send('POST', '/v1/access/policy-changes', end)).status).toBe(503);
    await f.accessPool.query('UPDATE access.recovery_fence SET open = true');
    expect((await f.accessPool.query('SELECT ended_at, head_revision FROM access.policy WHERE id = $1',
      [restrictionId])).rows[0]).toEqual({ ended_at: null, head_revision: '2' });
    expect(await history()).toEqual(retained);
    const endKeys = [randomUUID(), randomUUID()];
    const concurrent = await Promise.all(endKeys.map(key => editor.send('POST', '/v1/access/policy-changes', end, key)));
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = concurrent.findIndex(response => response.status === 200);
    expect(await concurrent[winner]!.json()).toMatchObject({ action: 'end-policy', policyId: restrictionId,
      revision: '2', authorityEpoch: '3', replayed: false });
    const ended = (await f.accessPool.query('SELECT ended_at, head_revision FROM access.policy WHERE id = $1',
      [restrictionId])).rows[0];
    expect(ended.ended_at).toBeInstanceOf(Date);
    expect(ended.head_revision).toBe('2');
    expect(await history()).toEqual(retained);
    await expect(f.accessPool.query('UPDATE access.policy SET ended_at = NULL WHERE id = $1', [restrictionId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(f.accessPool.query('DELETE FROM access.policy WHERE id = $1', [restrictionId]))
      .rejects.toMatchObject({ code: '23514' });
    await owner.grant(restriction.scopeId, 'access.policy.manage');
    for (const revision of ['1', '2']) {
      const historical = await owner.send('GET', `/v1/access/policies/${restrictionId}/revisions/${revision}`
        + `?issuerSubject=${encodeURIComponent(owner.actor)}`);
      expect(historical.status).toBe(200);
      expect(await historical.json()).toMatchObject({ policyId: restrictionId, headRevision: '2', revision });
    }
    expect(await (await editor.send('POST', '/v1/access/policy-changes', end, endKeys[winner])).json())
      .toMatchObject({ revision: '2', authorityEpoch: '3', replayed: true });
    expect((await editor.send('POST', '/v1/access/policy-changes', { ...end, expectedHeadRevision: '1' },
      endKeys[winner])).status).toBe(409);
    expect((await f.accessPool.query(`SELECT count(*) FROM access.policy_change_receipt
      WHERE policy_id = $1 AND action = 'end-policy'`, [restrictionId])).rows[0].count).toBe('1');
    expect((await owner.send('POST', '/v1/access/policy-decisions', decisionRequest)).status).toBe(404);
    expect((await owner.send('POST', '/v1/access/policy-decision-revalidations', {
      profile: 'access-policy-decision-revalidation-v1', decisionId: decision.decisionId,
      scopeId: restriction.scopeId, action: 'work.read', actingSubject: owner.actor })).status).toBe(409);
    for (const read of viewers) {
      expect((await read(readPath(restricted.component))).status).toBe(200);
      expect(await (await read(resourcePath(restricted.component))).json()).toMatchObject({ disclosure: 'public' });
      expect((await read(`/v1/media/avatars/${restrictedAvatar}`)).status).toBe(200);
    }
    for (const token of [undefined, outsider.token, owner.token]) {
      // Public previews accept a credential but have no actingSubject selector.
      expect((await f.call('GET', previewPath(restricted.component), { token })).status).toBe(200);
      const results = await search(token);
      expect(results.total).toBe(2);
      expect(results.facets.names).toBe(2);
      expect(results.results.map(row => row.owner).sort()).toEqual([visible.component, restricted.component].sort());
    }
    // Retained identity and head support a new restriction revision after ending.
    const restored = await owner.send('POST', '/v1/access/policy-changes',
      policyBody(restricted.component, '3', restrictionId, '2', owner.actor));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ revision: '3', authorityEpoch: '4' });
    expect((await f.accessPool.query('SELECT ended_at FROM access.policy WHERE id = $1',
      [restrictionId])).rows[0].ended_at).toBeNull();
    expect((await anonymous(readPath(restricted.component))).status).toBe(404);
    expect((await anonymous(`/v1/media/avatars/${restrictedAvatar}`)).status).toBe(404);
    expect((await search(owner.token)).total).toBe(1);

    // A private Work becoming public releases its linked Resource immediately.
    const published = await f.contribution(hidden.work, owner.actor, 'en', 'Newly published story');
    const selection = { context: { kind: 'main-version-default' as const, id: hidden.mainVersion },
      work: hidden.work, contribution: published.contribution, publicationDecision: published.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: owner.actor };
    await selectMainDefault(f.env, f.admission(owner.actor, `publication:select:${hidden.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    expect((await anonymous(readPath(privateOnly.component))).status).toBe(200);
    expect((await search()).total).toBe(2);

    // Only an editor can replace the resource's Work link; old revisions stay private.
    const editState = state('Public heroine revised', [shown.work]);
    const editBody = { profile: 'semantic-change-v1', target: visible.component,
      expectedHead: visible.revision, state: editState, actingSubject: outsider.actor };
    await outsider.grant(`work:read:${shown.work}`, 'work.read');
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`semantic:edit:${visible.component}`]);
    expect((await outsider.send('POST', '/v1/semantic/changes', editBody)).status).toBe(403);
    await owner.grant(`semantic:edit:${visible.component}`, 'semantic.change');
    const changed = await owner.send('POST', '/v1/semantic/changes', { ...editBody, actingSubject: owner.actor });
    expect(changed.status).toBe(200);
    const latest = await changed.json() as Write;
    for (const read of viewers) {
      expect((await read(`${readPath(visible.component)}/revisions/${local(latest.revision)}`)).status).toBe(200);
      expect((await read(`${readPath(visible.component)}/revisions/${local(visible.revision)}`)).status).toBe(404);
    }
    const exported = (revision: Write) => readExportPlan({ env: f.env,
      canReadWork: (principal, actor, work) => f.access.canReadWork(principal, actor, work),
      canReadSemantic: (principal, actor, resource, exactRevision) =>
        f.access.canReadSemanticResource(principal, actor, resource, exactRevision),
    }, outsider.principal, outsider.actor, { kind: 'semantic-revision', resource: visible.component,
      reference: revision.revision, expectedPosition: revision.sourcePosition }, 'excerpt');
    await expect(exported(latest)).resolves.toMatchObject({ targetProfile: 'rezics-semantic-values-v1' });
    await expect(exported(visible)).rejects.toBeInstanceOf(ExportSourceNotFound);
    await owner.grant(`semantic:read:${visible.component}`, 'semantic.read');
    expect((await owner.read(`${readPath(visible.component)}/revisions/${local(visible.revision)}`)).status).toBe(200);

    // Live Work protection suppresses every public consumer, despite an old public selection.
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> { <${shown.work}> rv:protectionHead <${id()}> . } }`);
    expect((await anonymous(readPath(visible.component))).status).toBe(404);
    expect((await anonymous(previewPath(visible.component))).status).toBe(404);
    expect((await anonymous(`/v1/media/avatars/${avatar}`)).status).toBe(404);
    expect((await search()).results.map(row => row.owner)).toEqual([privateOnly.component]);

    // Disclosure reads stay bounded and deduplicate independently of batch size.
    const before = f.fuseki.queries;
    expect((await publicSemantics({ pool: f.accessPool, graph: f.fuseki },
      Array.from({ length: SEMANTIC_DISCLOSURE_LIMIT }, () => privateOnly.component))).size).toBe(1);
    expect(f.fuseki.queries - before).toBe(1);
    await expect(publicSemantics({ pool: f.accessPool, graph: f.fuseki },
      Array.from({ length: SEMANTIC_DISCLOSURE_LIMIT + 1 }, id))).rejects.toBeInstanceOf(RangeError);
  } finally { await f.stop(); }
}, 360_000);
