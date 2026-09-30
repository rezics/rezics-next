import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest } from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest } from '../../../services/main/src/modules/contribution/publish.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { selectRealmLocal, realmSelectionDigest } from '../../../services/main/src/modules/work/select-realm.ts';
import { queryPublicMainTitleBody } from '../../../services/main/src/modules/work/search-multifield.ts';
import { CompositionConflict } from '../../../services/main/src/modules/structure/change.ts';
import { structureProfileFor } from '../../../services/main/src/modules/structure/profiles.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { queryPublicMainPhrase } from '../../../services/main/src/modules/work/search-public.ts';

interface Work { work: string; mainVersion: string }
interface Composition { structure: string; revision: string; receipt: string; replayed: boolean;
  occurrences: string[]; cost?: { placementsWritten: number; pagesWritten: number } }
interface Part { occurrence: string; role: 'group' | 'part'; work?: string; mainVersion?: string;
  parent: string; displayLabel?: string; inclusion?: string; segmentKey: string; orderKey: string }
interface Parts { parts: Part[]; next: string | null; revision: string;
  completion: { status: string; evidence: string[] } }

test('G-830: Index compositions retain local numbering, publication order, replay, authority and cross-level paging', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `g-830-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as WorkActivationEnvironment & { structureObjects: S3ImmutableObjects }).structureObjects = objects;
  const query = `?actingSubject=${encodeURIComponent(f.actor)}`;
  const createWork = async (title: string, semanticType = 'https://schema.org/Book') => {
    const work = await f.json<Work>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title, language: 'en', semanticTypes: [semanticType], actingSubject: f.actor }), 201);
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    return work;
  };
  const create = async (work: Work) => f.json<Composition>(await f.call('POST', '/v1/compositions', {
    profile: 'work-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: f.actor }), 201);
  const change = (composition: Composition, operations: object[], key = randomUUID()) => f.call('POST',
    `/v1/compositions/${shortId(composition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: f.actor, operations }, key);
  const part = (composition: Composition, work: Work, displayLabel: string, inclusion = 'required') => ({
    op: 'insert', parent: composition.structure, position: 'last', role: 'part', target: work.work, displayLabel, inclusion,
  });
  const parts = async (work: Work, suffix = '') => f.json<Parts>(await f.call('GET',
    `/v1/resources/${shortId(work.work)}/parts${query}${suffix}`), 200);
  try {
    const overall = await createWork('A Certain Magical Index');
    const original = await createWork('Index Original');
    const nt = await createWork('Index New Testament');
    const gt = await createWork('Index Genesis Testament');
    let whole = await create(overall);
    whole = await f.json<Composition>(await change(whole, [part(whole, original, 'Original'),
      part(whole, nt, 'New Testament'), part(whole, gt, 'Genesis Testament')]), 200);
    const entries: Array<{ work: Work; composition: Composition; labels: string[] }> = [];
    for (const [work, labels] of [
      [original, [...Array.from({ length: 22 }, (_, i) => String(i + 1)), 'SS1', 'SS2']],
      [nt, [...Array.from({ length: 22 }, (_, i) => String(i + 1)), '22 Reverse']],
      [gt, ['1', '2', '3']],
    ] as const) {
      let composition = await create(work);
      const volumes: Work[] = [];
      for (let start = 0; start < labels.length; start += 8) {
        volumes.push(...await Promise.all(labels.slice(start, start + 8).map(label => createWork(`${shortId(work.work)} volume ${label}`))));
      }
      for (let start = 0; start < labels.length; start += 16) {
        const operations = labels.slice(start, start + 16).map((label, i) => part(composition, volumes[start + i]!, label,
          label.startsWith('SS') ? 'extra' : 'required'));
        const key = randomUUID();
        const changed = await f.json<Composition>(await change(composition, operations, key), 200);
        expect(changed.cost?.placementsWritten).toBe(operations.length);
        const replay = await f.json<Composition>(await change(composition, operations, key), 200);
        expect(replay).toMatchObject({ revision: changed.revision, receipt: changed.receipt, replayed: true });
        expect(replay.occurrences).toEqual(changed.occurrences);
        composition = changed;
      }
      const all: Part[] = [];
      let cursor: string | null = null;
      do {
        const page = await parts(work, `&limit=7${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
        expect(page).not.toHaveProperty('placementCount');
        all.push(...page.parts);
        cursor = page.next;
      } while (cursor);
      expect(all.map(item => item.displayLabel)).toEqual([...labels]);
      expect(all.map(item => item.mainVersion)).toEqual(volumes.map(item => item.mainVersion));
      expect(all.filter(item => item.displayLabel?.startsWith('SS')).map(item => item.inclusion)).toEqual(
        labels.filter(label => label.startsWith('SS')).map(() => 'extra'));
      entries.push({ work, composition, labels: [...labels] });
    }
    const initial = entries[0]!;
    const before = await parts(initial.work);
    const moved = await f.json<Composition>(await change(initial.composition, [{ op: 'move',
      occurrence: before.parts[0]!.occurrence, parent: initial.composition.structure, position: 'last' }]), 200);
    const reordered = await parts(initial.work);
    expect(reordered.parts.map(item => item.occurrence)).toEqual([...before.parts.slice(1), before.parts[0]!].map(item => item.occurrence));
    expect(reordered.parts.at(-1)?.displayLabel).toBe('1');
    expect((await change(initial.composition, [{ op: 'remove', occurrence: before.parts[1]!.occurrence }])).status).toBe(409);
    const denied = await f.call('POST', `/v1/compositions/${shortId(moved.structure)}/changes`, {
      profile: 'work-composition', expectedHead: moved.revision, actingSubject: f.actor,
      operations: [{ op: 'remove', occurrence: before.parts[1]!.occurrence }],
    }, randomUUID(), f.account.tokenB);
    expect(denied.status).toBe(403);
    const ancestor = await change(moved, [part(moved, overall, 'cycle')]);
    expect(ancestor.status).toBe(409);
    const self = await change(moved, [part(moved, original, 'self')]);
    expect(self.status).toBe(409);
    const updated = await f.json<Composition>(await change(moved, [{ op: 'update', occurrence: before.parts[0]!.occurrence,
      displayLabel: '1 revised', inclusion: 'optional' }]), 200);
    expect((await parts(initial.work)).parts.at(-1)).toMatchObject({ displayLabel: '1 revised', inclusion: 'optional' });
    const completed = await f.json<Composition>(await change(updated, [{ op: 'completion',
      completion: { status: 'concluded', evidence: ['https://publisher.example/index/original/completed'] } }]), 200);
    expect(completed.cost).toMatchObject({ placementsWritten: 0, pagesWritten: 1 });
    expect((await parts(initial.work)).completion).toEqual({ status: 'concluded', evidence: ['https://publisher.example/index/original/completed'] });
    const exact = await f.json<Parts>(await f.call('GET', `/v1/compositions/${shortId(completed.structure)}/revisions/${shortId(updated.revision)}${query}`), 200);
    expect(exact.completion).toEqual({ status: 'unknown', evidence: [] });

    const repeatedWork = { work: before.parts[0]!.work!, mainVersion: before.parts[0]!.mainVersion! };
    let genesis = entries[2]!.composition;
    genesis = await f.json<Composition>(await change(genesis, [part(genesis, repeatedWork, 'Shared appendix', 'optional')]), 200);
    const wholePath = `/v1/resources/${shortId(repeatedWork.work)}/wholes${query}`;
    const wholes = await f.json<{ wholes: Array<{ work: string }>; next: string | null }>(await f.call('GET', wholePath), 200);
    expect(wholes.wholes.map(item => item.work).sort()).toEqual([original.work, gt.work].sort());
    const wholePage = await f.json<{ wholes: unknown[]; next: string }>(await f.call('GET', `${wholePath}&limit=1`), 200);
    expect(wholePage.wholes).toHaveLength(1);
    expect((await f.json<{ wholes: unknown[] }>(await f.call('GET', `${wholePath}&limit=1&after=${encodeURIComponent(wholePage.next)}`), 200)).wholes).toHaveLength(1);

    const restored = await f.json<Composition>(await f.call('POST', `/v1/compositions/${shortId(completed.structure)}/restorations`, {
      expectedHead: completed.revision, restoredFrom: completed.revision, actingSubject: f.actor,
    }), 200);
    expect((await parts(original)).parts.map(item => item.occurrence)).toEqual(reordered.parts.map(item => item.occurrence));
    expect((await parts(original)).completion.status).toBe('concluded');
    expect((await parts(original)).parts.at(-1)).toMatchObject({ displayLabel: '1 revised', inclusion: 'optional' });
    expect(restored.revision).not.toBe(completed.revision);

    // A lost graph acknowledgement resolves from the durable receipt, with the same IDs on retry.
    const originalFuseki = f.env.fuseki;
    let lost = false;
    f.env.fuseki = new Proxy(originalFuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
        const result = await target.commandWithReceipt(...args);
        if (!lost) { lost = true; throw new Error('lost composition acknowledgement'); }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const groupKey = randomUUID();
    const groupOperation = [{ op: 'insert', parent: genesis.structure, position: 'last', role: 'group',
      label: { value: 'Extras', language: 'en' } }];
    let grouped: Composition;
    try {
      grouped = await f.json<Composition>(await change(genesis, groupOperation, groupKey), 200);
      const retry = await f.json<Composition>(await change(genesis, groupOperation, groupKey), 200);
      expect(retry).toMatchObject({ receipt: grouped.receipt, revision: grouped.revision, occurrences: grouped.occurrences, replayed: true });
      expect(lost).toBe(true);
    } finally { f.env.fuseki = originalFuseki; }
    const firstGenesis = (await parts(gt)).parts[0]!;
    genesis = await f.json<Composition>(await change(grouped!, [{ op: 'move', occurrence: firstGenesis.occurrence,
      parent: grouped!.occurrences[0], position: 'last' }]), 200);
    expect((await parts(gt, `&parent=${encodeURIComponent(grouped!.occurrences[0]!)}`)).parts[0]).toMatchObject({
      occurrence: firstGenesis.occurrence, work: firstGenesis.work, displayLabel: '1', inclusion: 'required' });

    // Leading and trailing private uses cannot turn limit=1 into a hidden-item counter.
    for (const work of [original, gt]) await f.accessPool.query(
      'DELETE FROM access.permission_grant WHERE scope_id=$1', [`work:read:${work.work}`]);
    const onlyDisclosed = await parts(overall, '&limit=1');
    expect(onlyDisclosed.parts.map(item => item.work)).toEqual([nt.work]);
    expect(onlyDisclosed.next).toBeNull();
    expect(JSON.stringify(onlyDisclosed)).not.toContain(whole.occurrences[0]!);
    expect(JSON.stringify(onlyDisclosed)).not.toContain(whole.occurrences[2]!);
    const noWholes = await f.json<{ wholes: unknown[]; next: string | null }>(
      await f.call('GET', `${wholePath}&limit=1`), 200);
    expect(noWholes).toMatchObject({ wholes: [], next: null });
    await f.grant(`work:read:${gt.work}`, 'work.read');
    const oneWhole = await f.json<{ wholes: Array<{ work: string }>; next: string | null }>(
      await f.call('GET', `${wholePath}&limit=1`), 200);
    expect(oneWhole.wholes.map(item => item.work)).toEqual([gt.work]);
    expect(oneWhole.next).toBeNull();
    await f.grant(`work:read:${original.work}`, 'work.read');

    // Revoking one target withholds its whole occurrence, its label and all total/ordinal hints.
    await f.accessPool.query('DELETE FROM access.permission_grant WHERE scope_id=$1', [`work:read:${repeatedWork.work}`]);
    const privatePage = await parts(original);
    expect(privatePage.parts.map(item => item.work)).not.toContain(repeatedWork.work);
    expect(JSON.stringify(privatePage)).not.toContain('1 revised');
    expect(privatePage).not.toHaveProperty('placementCount');
    expect(privatePage).not.toHaveProperty('count');
    const direct = await f.call('GET', `/v1/compositions/${shortId(completed.structure)}/occurrences/${shortId(before.parts[0]!.occurrence)}${query}`);
    expect(direct.status).toBe(404);
    const privateRaw = await f.json<{ occurrences: unknown[] }>(await f.call('GET', `/v1/compositions/${shortId(completed.structure)}${query}`), 200);
    expect(privateRaw).not.toHaveProperty('placementCount');
    expect(JSON.stringify(privateRaw)).not.toContain(repeatedWork.work);
    const disclosedParts: Part[] = [];
    let disclosedAfter: string | null = null;
    do {
      const page = await parts(original, `&limit=1${disclosedAfter ? `&after=${encodeURIComponent(disclosedAfter)}` : ''}`);
      expect(page.parts).toHaveLength(1);
      disclosedParts.push(...page.parts);
      disclosedAfter = page.next;
    } while (disclosedAfter);
    expect(disclosedParts.map(item => item.occurrence)).toEqual(reordered.parts.slice(0, -1).map(item => item.occurrence));
    const links = await f.env.fuseki.query(`SELECT ?part ?parent WHERE { GRAPH ${iri(GRAPHS.current)} {
      VALUES ?part { ${[...before.parts.map(item => item.work!), original.work, nt.work, gt.work].map(iri).join(' ')} }
      ?part <https://schema.org/isPartOf> ?parent } }`);
    expect(links.results?.bindings).toEqual([]);

    // Admission plus the transaction guard rejects reciprocal inserts even on different heads.
    const a = await createWork('Season A', 'https://schema.org/DigitalDocument');
    const b = await createWork('Season B', 'https://schema.org/DigitalDocument');
    const ac = await create(a), bc = await create(b);
    const racing = await Promise.all([change(ac, [part(ac, b, 'B')]), change(bc, [part(bc, a, 'A')])]);
    expect(racing.map(response => response.status).sort()).toEqual([200, 409]);
    const ancestors = await Promise.all(['Level one', 'Level two', 'Level three'].map(title => createWork(title)));
    const ancestorCompositions = [];
    for (const work of ancestors) ancestorCompositions.push(await create(work));
    await f.json(await change(ancestorCompositions[2]!, [part(ancestorCompositions[2]!, overall, 'Index')]), 200);
    await f.json(await change(ancestorCompositions[1]!, [part(ancestorCompositions[1]!, ancestors[2]!, 'Next')]), 200);
    // A fifth edge is refused, so the four-level cycle proof cannot silently miss a longer cycle.
    expect((await change(ancestorCompositions[0]!, [part(ancestorCompositions[0]!, ancestors[1]!, 'Too deep')])).status).toBe(409);
  } finally { await f.close(); }
}, 240_000);

test('G-830: a composed volume stays discoverable in multifield search, public search, author works and Zone browse', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `g-830-search-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as WorkActivationEnvironment & { structureObjects: S3ImmutableObjects }).structureObjects = objects;
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => ({
    id: randomUUID(), principalId: f.principalId, actingSubject: f.actor, scope, action,
    idempotencyKey: randomUUID(), requestDigest, authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), state: 'claimed', dispatchEligible: true, replayed: false,
  });
  try {
    const token = `g830${randomUUID().replaceAll('-', '')}`;
    const authorKey = '/authors/OL830830A';
    const proposal = await f.propose('OL830830W', [{ author: { key: authorKey } }], `Volume ${token}`);
    const volume = await f.adoptWork(proposal);
    await f.grant(`work:read:${volume.work}`, 'work.read');
    f.setAuthorName(authorKey, 'Catalogue author');
    await f.sourceAuthorNames.command(f.principalId, randomUUID(), authorKey, { action: 'refresh', expectedRevision: null });
    const series = await f.json<Work>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Volume catalogue series', semanticTypes: ['https://schema.org/Book'],
      language: 'en', actingSubject: f.actor }), 201);
    await f.grant(`work:edit:${series.work}`, 'work.edit');
    await f.grant(`work:read:${series.work}`, 'work.read');
    const composition = await f.json<Composition>(await f.call('POST', '/v1/compositions', {
      profile: 'work-composition', work: series.work, mainVersion: series.mainVersion, actingSubject: f.actor }), 201);
    await f.json(await f.call('POST', `/v1/compositions/${shortId(composition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', parent: composition.structure, position: 'last', role: 'part',
        target: volume.work, displayLabel: '1', inclusion: 'required' }],
    }), 200);
    const draftInput = { work: volume.work, language: 'en', body: `Volume searchable ${token}`, actingSubject: f.actor };
    const draft = await activateTextContribution(f.env,
      admission(`contribution:create:${volume.work}`, 'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (!draft.contribution || !draft.draftRevision) throw new Error('volume draft failed');
    const publicationInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: f.actor };
    const publication = await publishTextContribution(f.env, admission(`contribution:publish:${draft.contribution}`,
      'contribution.publish', textPublicationDigest(publicationInput)), publicationInput);
    if (!publication.publicationDecision) throw new Error('volume publication failed');
    const selectionInput = { context: { kind: 'main-version-default' as const, id: volume.mainVersion },
      work: volume.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: f.actor };
    expect((await selectMainDefault(f.env, admission(`publication:select:${volume.mainVersion}`,
      'publication.select', mainSelectionDigest(selectionInput)), selectionInput)).outcome).toBe('succeeded');
    expect((await queryPublicMainTitleBody(f.env, { titleTerm: token, bodyTerm: token, language: 'en' })).results
      .map(item => item.work)).toContain(volume.work);
    expect((await queryPublicMainPhrase(f.env, { phrase: token, language: 'en' })).results
      .map(item => item.work)).toContain(volume.work);
    const authorPage = await f.json<{ items: Array<{ id: string }> }>(await f.call('GET',
      `/v1/authors/open-library/OL830830A/works?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(authorPage.items.map(item => item.id)).toContain(volume.work);
    const realmInput = { name: `Volume catalogue ${token}`, actingSubject: f.actor };
    const space = await createRealmSpace(f.env, admission('space:create:root', 'space.create',
      spaceCreationDigest(realmInput)), realmInput);
    if (!space.realm) throw new Error('volume realm failed');
    const adoptionInput = { context: { kind: 'realm-local' as const, id: space.realm },
      work: volume.work, mainVersion: volume.mainVersion, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review' as const, actingSubject: f.actor };
    expect((await selectRealmLocal(f.env, admission(`publication:adopt:${space.realm}`,
      'publication.adopt', realmSelectionDigest(adoptionInput)), adoptionInput)).outcome).toBe('succeeded');
    const zone = await f.json<{ items: Array<{ id: string }> }>(await f.call('GET',
      `/v1/realms/${shortId(space.realm)}/modules/browse`), 200);
    expect(zone.items.map(item => item.id)).toContain(volume.work);
    expect((await f.env.fuseki.query(`SELECT ?parent WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(volume.work)} <https://schema.org/isPartOf> ?parent } }`)).results?.bindings).toEqual([]);
  } finally { await f.close(); }
}, 180_000);


test('G-830: Zone restore validates the candidate generation and seals qualifier topology rejections', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `g-830-restore-${randomUUID()}`),
    'openid work:create work:read space:create zone:edit collection:edit semantic:read');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as WorkActivationEnvironment & { structureObjects: S3ImmutableObjects }).structureObjects = objects;
  const profile = structureProfileFor('zone-navigation'), originalValidation = profile.qualifierValidations;
  try {
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Restore mounts', capabilities: ['realm'], actingSubject: f.actor }), 201);
    const collection = nativeId(), zoneId = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    await f.json(await f.call('POST', '/v1/collections', {
      collection, name: 'Restored target', disclosure: 'public', actingSubject: f.actor }), 201);
    await f.grant(`zone:edit:${zoneId}`, 'zone.edit');
    const zone = await f.json<{ zone: string; navigation: string; revision: string }>(await f.call('POST', '/v1/zones', {
      zone: zoneId, space: space.space, disclosure: 'public', actingSubject: f.actor }), 201);
    const mounted = await f.json<Composition>(await f.call('POST', `/v1/zones/${shortId(zone.zone)}/mounts`, {
      expectedHead: zone.revision, collection, routeSegment: 'restored', disclosure: 'public', actingSubject: f.actor }), 200);
    const live = (await readCompositionHeader(f.env, zone.navigation))!;
    let observedGeneration: string | undefined, rejectCandidate = false;
    // Owner contract regression: replacement checks use the complete candidate;
    // the same retained mount in the live generation is not a competing placement.
    profile.qualifierValidations = async (env, changed, context) => {
      expect(context?.replacement).toBe(true);
      expect(context?.structure).toBe(zone.navigation);
      expect(context?.generation).not.toBe(live.generation);
      expect(context?.placements).toEqual(changed);
      expect(changed).toHaveLength(1);
      expect(changed[0]?.qualifier).toMatchObject({ type: 'zone-mount', routeSegment: 'restored' });
      observedGeneration = context!.generation;
      const current = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
        GRAPH ${iri(GRAPHS.current)} { ?placement a rv:OccurrencePlacement ; rv:generation ${iri(live.generation)} ;
          rv:qualifier ?qualifier . ?qualifier rv:routeSegment "restored" . } }`);
      expect(current.boolean).toBe(true);
      if (rejectCandidate) throw new CompositionConflict('candidate mount conflicts');
      return await originalValidation?.(env, changed, context) ?? [];
    };
    const path = `/v1/compositions/${shortId(zone.navigation)}/restorations`;
    const restored = await f.json<Composition>(await f.call('POST', path, {
      expectedHead: mounted.revision, restoredFrom: mounted.revision, actingSubject: f.actor }), 200);
    expect((await readCompositionHeader(f.env, zone.navigation))!.generation).toBe(observedGeneration!);
    rejectCandidate = true;
    const key = randomUUID(), body = { expectedHead: restored.revision, restoredFrom: mounted.revision, actingSubject: f.actor };
    expect((await f.call('POST', path, body, key)).status).toBe(409);
    expect((await f.call('POST', path, body, key)).status).toBe(409);
    const receipts = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:action "composition.restore" ; rv:reason rv:TopologyConflict } }`);
    expect(receipts.results?.bindings).toHaveLength(1);
    expect((await readCompositionHeader(f.env, zone.navigation))!.head).toBe(restored.revision);
  } finally { profile.qualifierValidations = originalValidation; await f.close(); }
}, 180_000);
