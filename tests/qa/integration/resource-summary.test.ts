import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClassificationProposition, classificationPropositionDigest }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { createClassificationContext, classificationContextDigest }
  from '../../../services/main/src/modules/classification/context.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { png, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('resource-summary');
afterAll(async () => { if (started) await (await started).stop(); });

const ID = 'https://rezics.com/id/';
const local = (iri: string) => iri.slice(ID.length);
type Summary = { reference: string; status: string; type?: string; disclosure?: string;
  name?: { value: string; language: string; direction: string; basis: string };
  avatar?: { kind: string; url?: string; selection?: string; key?: string; basis?: { context: string } } };

/** Select an avatar through the product command, granting the target scope once. */
async function selectAvatar(member: Awaited<ReturnType<MediaStack['member']>>, target: string,
  asset: string | null, expectedSelection: string | null, context?: string) {
  const response = await member.send('PUT', `/v1/resources/${local(target)}/avatar`, {
    profile: 'resource-avatar-selection-v1', expectedSelection, asset, actingSubject: member.actor,
    ...(context ? { context } : {}) });
  if (response.status !== 201) throw new Error(`avatar: ${response.status} ${await response.text()}`);
  return (await response.json() as { selection: string }).selection;
}

test('VIEW07: private, revoked and erased content/media leak no preview, sitemap entry or delivery', async () => {
  const { member, publicWork, privateWork, call, access, content } = await stack();
  const owner = await member('owner');
  const reader = await member('reader');
  const shown = await publicWork(owner.actor);
  const hidden = await privateWork(owner.actor);
  const erasedText = `private erased body ${randomUUID()}`;
  const erasedDraft = await content.saveDraft({ operationId: `view07-${randomUUID()}`,
    variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: hidden.work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
    expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
    provenance: { fixture: 'VIEW07' }, serializedJson: JSON.stringify({ body: erasedText }) });
  expect(erasedDraft.outcome).toBe('succeeded');
  expect(erasedDraft.revisionId).toBeTruthy();
  await owner.grant(`erasure:${hidden.work}`, 'erasure.request');
  const contentErasure = await owner.send('POST', '/v1/erasures', { profile: 'content-revision-erasure-v1',
    actingSubject: owner.actor, resourceId: hidden.work, revisionIds: [erasedDraft.revisionId!] });
  expect(contentErasure.status).toBe(200);
  expect(await contentErasure.json()).toMatchObject({ suppression: 'suppressed', destruction: 'retained',
    targets: [{ owner: 'content', kind: 'content_revision', ref: erasedDraft.revisionId }] });
  expect((await content.readExactBatch([erasedDraft.revisionId!], async ids => new Set(ids)))[0]?.status)
    .toBe('erased');
  for (const target of [shown.work, hidden.work]) await owner.grant(`media:avatar:${target}`, 'media.avatar');
  await owner.grant(`work:read:${hidden.work}`, 'work.read');
  const bytes = png(128, 128);
  const image = await owner.upload(bytes, 'public');
  const shownSelection = await selectAvatar(owner, shown.work, image.asset, null);
  const hiddenSelection = await selectAvatar(owner, hidden.work, image.asset, null);

  // Anonymous: only the public Work previews; the private Work answers like an absent one.
  const preview = await call('GET', `/v1/public-previews/${local(shown.work)}`);
  expect(preview.status).toBe(200);
  const previewed = await preview.json() as Summary & { generation: unknown };
  expect(previewed).toMatchObject({ reference: shown.work, type: 'work', disclosure: 'public',
    name: { value: shown.title, language: 'en' }, avatar: { kind: 'image', selection: shownSelection } });
  expect(preview.headers.get('cache-control')).toBe('public, no-cache');
  const privatePreview = await call('GET', `/v1/public-previews/${local(hidden.work)}`);
  const absentPreview = await call('GET', `/v1/public-previews/${randomUUID()}`);
  expect(privatePreview.status).toBe(404);
  const privatePreviewText = await privatePreview.text();
  expect(privatePreviewText).toBe(await absentPreview.text());
  expect(privatePreviewText).not.toContain(erasedText);
  const anonymousSummary = await call('GET', `/v1/resources/${local(hidden.work)}`);
  expect(anonymousSummary.status).toBe(404);
  const anonymousSummaryText = await anonymousSummary.text();
  expect(anonymousSummaryText).not.toContain(hidden.title);
  expect(anonymousSummaryText).not.toContain(erasedText);

  // The sitemap lists the public Work and never the private one.
  const pages: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const listed = await (await call('GET', `/v1/sitemap${after ? `?after=${encodeURIComponent(after)}` : ''}`))
      .json() as { entries: Array<{ reference: string }>; next: string | null };
    pages.push(...listed.entries.map(entry => entry.reference));
    if (!listed.next) break;
    after = listed.next;
  }
  expect(pages).toContain(shown.work);
  expect(pages).not.toContain(hidden.work);

  // A public image selected on a private Work is not publicly deliverable.
  expect((await call('GET', `/v1/media/avatars/${hiddenSelection}`)).status).toBe(404);
  const ownerView = await owner.read(`/v1/media/avatars/${hiddenSelection}`);
  expect(ownerView.status).toBe(200);
  expect(ownerView.headers.get('cache-control')).toBe('private, no-store');

  // Revoked access: a reader's restricted summary and delivery end with the grant.
  await reader.grant(`work:read:${hidden.work}`, 'work.read');
  const readable = await reader.read(`/v1/resources/${local(hidden.work)}`);
  expect(readable.status).toBe(200);
  expect(await readable.json()).toMatchObject({ disclosure: 'restricted', avatar: { kind: 'image' } });
  const closed = await access.strongCloseScope(`work:read:${hidden.work}`, '0');
  expect(closed.pending).toBe(0);
  const revoked = await reader.read(`/v1/resources/${local(hidden.work)}`);
  expect(revoked.status).toBe(404);
  expect(await revoked.text()).not.toContain(hidden.title);
  expect((await reader.read(`/v1/media/avatars/${hiddenSelection}`)).status).toBe(404);

  // A stale avatar URL or preview cannot outlive a replacement: the old selection stops resolving.
  const oldUrl = previewed.avatar!.url!;
  const replacement = await owner.upload(png(64, 64), 'public');
  const newSelection = await selectAvatar(owner, shown.work, replacement.asset, shownSelection);
  expect((await call('GET', oldUrl)).status).toBe(404);
  const refreshed = await call('GET', `/v1/public-previews/${local(shown.work)}`);
  expect(refreshed.headers.get('etag')).not.toBe(preview.headers.get('etag'));
  expect(await refreshed.json()).toMatchObject({ avatar: { kind: 'image', selection: newSelection } });

  // Private, erased or removed media resolve to one fallback without asset identity or reason.
  const fallbackOf = async () => {
    const response = await call('GET', `/v1/public-previews/${local(shown.work)}`);
    const text = await response.text();
    for (const secret of [replacement.asset, image.asset, newSelection, 'media/asset', 'erased', 'private']) {
      expect(text).not.toContain(secret);
    }
    return (JSON.parse(text) as Summary).avatar;
  };
  const made = await owner.send('POST', `/v1/media/assets/${replacement.asset}/state`, {
    profile: 'media-asset-state-v1', expectedState: replacement.stateHead, disclosure: 'private', lifecycle: 'active',
    actingSubject: owner.actor });
  expect(made.status).toBe(201);
  const privateFallback = await fallbackOf();
  expect(privateFallback).toMatchObject({ kind: 'fallback', policy: 'avatar-fallback-v1', resourceType: 'work' });
  const erasedHead = (await made.json() as { id: string }).id;
  const erased = await owner.send('POST', `/v1/media/assets/${replacement.asset}/state`, {
    profile: 'media-asset-state-v1', expectedState: erasedHead, disclosure: 'private', lifecycle: 'erased',
    actingSubject: owner.actor });
  expect(erased.status).toBe(201);
  expect(await fallbackOf()).toEqual(privateFallback);
  expect((await owner.read(`/v1/media/avatars/${newSelection}`)).status).toBe(404);
  await selectAvatar(owner, shown.work, null, newSelection);
  expect(await fallbackOf()).toEqual(privateFallback);
  const neverUploaded = await publicWork(owner.actor);
  const blank = await (await call('GET', `/v1/public-previews/${local(neverUploaded.work)}`)).json() as Summary;
  expect(Object.keys(blank.avatar!).sort()).toEqual(Object.keys(privateFallback!).sort());
  expect(blank.avatar!.key).not.toBe(privateFallback!.key);
}, 180_000);

test('VIEW07: erasing a published Content revision suppresses public metadata and media delivery', async () => {
  const { member, publicWork, call, content } = await stack();
  const owner = await member('published-erasure');
  const work = await publicWork(owner.actor, ['en'], `Erased publication ${randomUUID()}`);
  const picture = await owner.upload(png(72, 72), 'public');
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  await owner.grant(`content:draft:${work.work}`, 'content.draft');
  const saved = await owner.send('POST', '/v1/media/publications', { profile: 'media-set-v1',
    resourceId: work.work, variantId, expectedHead: null, assets: [picture.asset],
    actingSubject: owner.actor });
  expect(saved.status).toBe(201);
  const publication = await saved.json() as { revisionId: string; byteDigest: string;
    sourcePosition: { dataEpoch: string }; body: { items: Array<{ use: string }> } };
  await owner.grant(`content:publish:${work.work}`, 'content.publish');
  await owner.grant(`work:read:${work.work}`, 'work.read');
  const activated = await owner.send('POST', '/v1/content-publications', {
    profile: 'content-publication-v1', preparationId: `view07-${randomUUID()}`,
    revisionId: publication.revisionId, expectedDigest: publication.byteDigest,
    expectedContentEpoch: publication.sourcePosition.dataEpoch, resourceId: work.work, variantId,
    expectedPublicationHead: null, actingSubject: owner.actor });
  if (activated.status !== 201) throw new Error(`content activation: ${activated.status} ${await activated.text()}`);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const selection = await selectAvatar(owner, work.work, picture.asset, null);
  const previewUrl = `/v1/public-previews/${local(work.work)}`;
  const summaryUrl = `/v1/resources/${local(work.work)}`;
  const avatarUrl = `/v1/media/avatars/${selection}`;
  const useUrl = `/v1/media/uses/${publication.body.items[0]!.use}`;
  for (const url of [previewUrl, summaryUrl, avatarUrl, useUrl]) {
    expect((await call('GET', url)).status).toBe(200);
  }
  const privatePicture = await owner.upload(png(40, 40), 'private');
  await owner.grant(`work:read:${work.work}`, 'work.read');
  await selectAvatar(owner, work.work, privatePicture.asset, null, work.mainVersion);
  const privateBytesUrl = `/v1/media/assets/${privatePicture.asset}/bytes`
    + `?target=${encodeURIComponent(work.work)}&context=${encodeURIComponent(work.mainVersion)}`;
  const privateBefore = await owner.read(privateBytesUrl);
  expect(privateBefore.status).toBe(200);
  await privateBefore.arrayBuffer();
  const sitemap = async () => {
    const entries: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const response = await call('GET', `/v1/sitemap${after ? `?after=${encodeURIComponent(after)}` : ''}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { entries: Array<{ reference: string }>; next: string | null };
      entries.push(...body.entries.map(entry => entry.reference));
      if (!body.next) break;
      after = body.next;
    }
    return entries;
  };
  expect(await sitemap()).toContain(work.work);
  await owner.grant(`erasure:${work.work}`, 'erasure.request');
  const erased = await owner.send('POST', '/v1/erasures', { profile: 'content-revision-erasure-v1',
    actingSubject: owner.actor, resourceId: work.work, revisionIds: [publication.revisionId] });
  expect(erased.status).toBe(200);
  expect(await erased.json()).toMatchObject({ suppression: 'suppressed',
    targets: [{ owner: 'content', kind: 'content_revision', ref: publication.revisionId }] });
  expect((await content.readExactBatch([publication.revisionId], async ids => new Set(ids)))[0]?.status)
    .toBe('erased');
  expect(await sitemap()).not.toContain(work.work);
  const absent = await (await call('GET', `/v1/public-previews/${randomUUID()}`)).text();
  for (const url of [previewUrl, summaryUrl, avatarUrl, useUrl]) {
    const responses = [await call('GET', url)];
    if (url !== previewUrl) responses.push(await owner.read(url));
    for (const response of responses) {
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain(work.title);
      expect(body).not.toContain(publication.revisionId);
      if (url === previewUrl) expect(body).toBe(absent);
    }
  }
  const privateAfter = await owner.read(privateBytesUrl);
  expect(privateAfter.status).toBe(404);
  expect(await privateAfter.text()).not.toContain(work.title);
}, 180_000);

test('VIEW08: Main Version language selection, fallback, RTL direction and metadata-only emptiness are explicit', async () => {
  const { member, publicWork, privateWork, call } = await stack();
  const owner = await member('languages');
  const work = await publicWork(owner.actor, ['zh', 'ar']);
  const main = local(work.mainVersion);
  const read = async (query: string) => {
    const response = await call('GET', `/v1/resources/${main}${query}`);
    expect(response.status).toBe(200);
    return await response.json() as Summary & { content: { availability: string; languages: string[];
      requestedLanguage: string | null; selected: null | { language: string; direction: string;
        basis: string; mainDefault: boolean; contribution: string } } };
  };
  const requested = await read('?language=ar');
  expect(requested).toMatchObject({ type: 'main-version', name: { value: work.title, language: 'en',
    direction: 'ltr', basis: 'fallback' }, content: { availability: 'available', languages: ['ar', 'zh'],
    requestedLanguage: 'ar', selected: { language: 'ar', direction: 'rtl', basis: 'requested-language',
      mainDefault: false, contribution: work.variants[1]!.contribution } } });
  const fallback = await read('?language=fr');
  expect(fallback.content.selected).toMatchObject({ language: 'zh', direction: 'ltr',
    basis: 'language-fallback', mainDefault: true, contribution: work.variants[0]!.contribution });
  const ordinary = await read('');
  expect(ordinary.content.selected).toMatchObject({ basis: 'main-default', language: 'zh' });
  const named = await read('?language=en');
  expect(named.name).toMatchObject({ language: 'en', basis: 'requested' });

  // Metadata-only: an explicit empty state with a name and fallback avatar, no fabricated content.
  const bare = await privateWork(owner.actor);
  await owner.grant(`work:read:${bare.work}`, 'work.read');
  const empty = await owner.read(`/v1/resources/${local(bare.mainVersion)}?language=ar`);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({ type: 'main-version', disclosure: 'restricted',
    name: { value: bare.title }, avatar: { kind: 'fallback' },
    content: { availability: 'metadata-only', languages: [], requestedLanguage: 'ar', selected: null } });
  const variants = await call('GET', `/v1/main-versions/${local(bare.mainVersion)}/native-variants?language=ar`);
  expect(await variants.json()).toMatchObject({ complete: true, variants: [] });
}, 180_000);

test('VIEW08: batched summaries hydrate names and avatars with fixed owner round trips, contexts and partial results', async () => {
  const { member, publicWork, privateWork, call, fuseki, env, admission, contentPool, mediaAccess } = await stack();
  const owner = await member('batch');
  const reader = await member('batch-reader');
  const works: Array<Awaited<ReturnType<MediaStack['publicWork']>>> = [];
  for (let index = 0; index < 3; index++) works.push(await publicWork(owner.actor));
  const restricted = await privateWork(owner.actor);
  const unreadable = await privateWork(owner.actor);
  await reader.grant(`work:read:${restricted.work}`, 'work.read');
  const spaceInput = { name: `Summary Realm ${randomUUID()}`, actingSubject: owner.actor };
  const space = await createRealmSpace(env, admission(owner.actor, 'space:create:root', 'space.create',
    spaceCreationDigest(spaceInput)), spaceInput);
  const contextInput = { realm: space.realm!, actingSubject: owner.actor };
  await createClassificationContext(env, admission(owner.actor, `classification:context:${space.realm}`,
    'classification.context.configure', classificationContextDigest(contextInput)), contextInput);
  const conceptInput = { label: `Summary concept ${randomUUID().slice(0, 8)}`, actingSubject: owner.actor };
  const concept = await createClassificationProposition(env, admission(owner.actor, 'classification:define:global',
    'classification.proposition.define', classificationPropositionDigest(conceptInput)), conceptInput);
  const spaceIri = space.space!;
  const conceptIri = concept.definitions!.concept;
  const realm = space.realm!;

  // A Realm-context avatar and a default one; an explicit Realm removal does not fall through.
  const image = await owner.upload(png(96, 96), 'public');
  const other = await owner.upload(png(48, 48), 'public');
  await owner.grant(`media:avatar:${works[0]!.work}`, 'media.avatar');
  await owner.grant(`media:avatar:${works[1]!.work}`, 'media.avatar');
  const byDefault = await selectAvatar(owner, works[0]!.work, image.asset, null);
  const byRealm = await selectAvatar(owner, works[0]!.work, other.asset, null, realm);
  await selectAvatar(owner, works[1]!.work, image.asset, null);
  const removed = await selectAvatar(owner, works[1]!.work, image.asset, null, realm);
  await selectAvatar(owner, works[1]!.work, null, removed, realm);

  const references = [works[0]!.work, works[1]!.work, works[2]!.work, works[0]!.mainVersion,
    restricted.work, unreadable.work, spaceIri, conceptIri, `${ID}${randomUUID()}`];
  const batch = async (resources: string[], extra: Record<string, unknown> = {}, as = reader) => {
    const graphBefore = fuseki.queries;
    const accessBefore = mediaAccess.batches;
    const response = await as.send('POST', '/v1/resources/summaries', { profile: 'resource-summary-batch-v1',
      resources, actingSubject: as.actor, ...extra });
    expect(response.status).toBe(200);
    const body = await response.json() as { summaries: Summary[];
      cost: { graphQueries: number; mediaQueries: number; accessChecks: number; accessQueries: number };
      generation: { graph: string; media: string } };
    // The transport adds one recovery gate and two graph-position fences.
    // Space batches also include both visibility reads and the canonical address read.
    expect(fuseki.queries - graphBefore).toBe(body.cost.graphQueries + 3);
    expect(mediaAccess.batches - accessBefore).toBe(body.cost.accessQueries);
    return body;
  };
  const mixed = await batch(references);
  expect(mixed.summaries.map(summary => [summary.status, summary.type ?? null])).toEqual([
    ['available', 'work'], ['available', 'work'], ['available', 'work'], ['available', 'main-version'],
    ['available', 'work'], ['unavailable', null], ['available', 'space'], ['available', 'concept'],
    ['unavailable', null]]);
  expect(mixed.cost).toEqual({ graphQueries: 4, mediaQueries: 1, accessChecks: 2, accessQueries: 1 });
  expect(mixed.summaries[5]).toEqual({ reference: unreadable.work, status: 'unavailable' });
  for (const summary of mixed.summaries.filter(item => item.status === 'available')) {
    expect(summary.name!.value.length).toBeGreaterThan(0);
    expect(['image', 'fallback']).toContain(summary.avatar!.kind);
  }
  expect(mixed.summaries[0]!.avatar).toMatchObject({ kind: 'image', selection: byDefault,
    basis: { context: 'urn:rezics:media:context:default' } });
  expect(mixed.summaries[6]!.name!.value).toBe(spaceInput.name);
  expect(mixed.summaries[7]!.name!.value).toBe(conceptInput.label);
  const inRealm = await batch([works[0]!.work, works[1]!.work, works[2]!.work], { context: realm });
  expect(inRealm.summaries[0]!.avatar).toMatchObject({ kind: 'image', selection: byRealm,
    basis: { context: realm } });
  expect(inRealm.summaries[1]!.avatar!.kind).toBe('fallback');
  expect(inRealm.summaries[2]!.avatar!.kind).toBe('fallback');

  // Generation-bound: any media change moves the media generation a cache must compare.
  const later = await batch([works[0]!.work]);
  await selectAvatar(owner, works[0]!.work, other.asset, byDefault);
  expect((await batch([works[0]!.work])).generation.media).not.toBe(later.generation.media);

  // Fixed round trips across batch sizes and unrelated selection growth; the slot probe stays indexed.
  const filler = Array.from({ length: 64 }, (_, index) => references[index % 3]!);
  for (const size of [1, 16, 64]) {
    const sized = await batch(filler.slice(0, size), {}, owner);
    expect(sized.cost).toEqual({ graphQueries: 1, mediaQueries: 1, accessChecks: 0, accessQueries: 0 });
  }
  await contentPool.query(`INSERT INTO media.selection_slot (target, context, role, policy)
    SELECT 'https://rezics.com/id/' || gen_random_uuid(), 'urn:rezics:media:context:default', 'avatar',
      'avatar-selection-v1' FROM generate_series(1, 50000)`);
  await contentPool.query('ANALYZE media.selection_slot');
  expect((await batch(filler, {}, owner)).cost).toEqual({ graphQueries: 1, mediaQueries: 1,
    accessChecks: 0, accessQueries: 0 });
  const plan = await contentPool.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON)
    SELECT s.head FROM unnest($1::text[]) AS t(target) JOIN media.selection_slot s
      ON s.target = t.target AND s.context = 'urn:rezics:media:context:default' AND s.role = 'avatar'`,
  [filler]);
  expect(JSON.stringify(plan.rows[0]!['QUERY PLAN'])).not.toContain('"Seq Scan"');
  const overflow = await reader.send('POST', '/v1/resources/summaries', { profile: 'resource-summary-batch-v1',
    resources: Array.from({ length: 65 }, () => works[0]!.work), actingSubject: reader.actor });
  expect(overflow.status).toBe(400);
  const anonymous = await call('POST', '/v1/resources/summaries', { body: { profile: 'resource-summary-batch-v1',
    resources: [restricted.work, works[2]!.work] } });
  expect((await anonymous.json() as { summaries: Summary[] }).summaries.map(item => item.status))
    .toEqual(['unavailable', 'available']);
}, 180_000);

test('VIEW08: Character, Context, Realm, Role and RelationDefinition summaries obey owner reads', async () => {
  const { member, call, env, admission, access, publicWork } = await stack();
  const owner = await member('summary-owners');
  const outsider = await member('summary-outsider');
  await owner.grant('semantic:create:root', 'semantic.change');
  await owner.grant('context:create:root', 'context.create');
  const createSemantic = async (state: object) => {
    const response = await owner.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, state, actingSubject: owner.actor });
    expect(response.status).toBe(201);
    return (await response.json() as { component: string }).component;
  };
  const character = await createSemantic({ component: 'resource', types: ['https://rezics.com/vocab/Character'],
    properties: [{ predicate: 'https://schema.org/name', value: {
      kind: 'language-string', lexical: '雪子', language: 'ja' } },
    { predicate: 'https://schema.org/name', value: {
      kind: 'language-string', lexical: 'Yukiko', language: 'en' } }] });
  const role = await createSemantic({ component: 'resource', types: ['https://rezics.com/vocab/Role'],
    properties: [{ predicate: 'https://schema.org/name', value: {
      kind: 'language-string', lexical: 'Lead', language: 'en' } }] });
  const relation = await createSemantic({ component: 'definition', kind: 'relation', roles: [
    { key: 'actor', minParticipants: 1, maxParticipants: 1, ordered: false }], successor: null });
  const context = async (disclosure: 'public' | 'private') => {
    const response = await owner.send('POST', '/v1/contexts', { profile: 'context-v1', role: 'shared',
      disclosure, base: null, entries: [], actingSubject: owner.actor });
    expect(response.status).toBe(201);
    return (await response.json() as { context: string }).context;
  };
  const shared = await context('public');
  const hidden = await context('private');
  const spaceInput = { name: `Summary Realm ${randomUUID()}`, actingSubject: owner.actor };
  const space = await createRealmSpace(env, admission(owner.actor, 'space:create:root', 'space.create',
    spaceCreationDigest(spaceInput)), spaceInput);
  const realm = space.realm!;
  const resources = [character, role, relation, shared, hidden, realm];
  const summaries = async (as = owner, language = 'en') => {
    const response = await as.send('POST', '/v1/resources/summaries', {
      profile: 'resource-summary-batch-v1', resources, language, actingSubject: as.actor });
    expect(response.status).toBe(200);
    return (await response.json() as { summaries: Summary[] }).summaries;
  };
  const denied = await summaries();
  expect(denied.map(item => item.status)).toEqual([
    'unavailable', 'unavailable', 'available', 'available', 'unavailable', 'available']);
  // Relation definitions are public vocabulary; characters and roles retain their own disclosure.
  expect(denied[2]).toMatchObject({ type: 'relation-definition', disclosure: 'public' });
  expect(denied[5]).toMatchObject({ type: 'realm', name: { value: spaceInput.name },
    avatar: { kind: 'fallback' } });
  for (const resource of [character, role, relation]) await owner.grant(`semantic:read:${resource}`, 'semantic.read');
  await owner.grant(`context:read:${hidden}`, 'context.read');
  const available = await summaries(owner, 'ja');
  expect(available.map(item => item.type)).toEqual([
    'character', 'role', 'relation-definition', 'context', 'context', 'realm']);
  expect(available[0]).toMatchObject({ name: { value: '雪子', language: 'ja', basis: 'requested' },
    disclosure: 'restricted', avatar: { kind: 'fallback', resourceType: 'character' } });
  expect(available[1]).toMatchObject({ name: { value: 'Lead', basis: 'fallback' } });
  expect(available[2]!.name!.value).toContain('Relation definition');
  expect(available[4]).toMatchObject({ disclosure: 'restricted', avatar: { kind: 'fallback' } });
  // CTX07 labels belong to the selected readable Context, including definitions and Contexts.
  const naming = await owner.send('POST', '/v1/contexts', { profile: 'context-v1', role: 'shared',
    disclosure: 'public', base: null, entries: [shared, relation].map(target => ({
      target, relation: null, state: 'defined', definition: relation, applicability: [] })),
    actingSubject: owner.actor });
  expect(naming.status).toBe(201);
  const namingContext = (await naming.json() as { context: string }).context;
  await owner.grant(`context:change:${namingContext}`, 'context.preference');
  const labels = await owner.send('POST', `/v1/contexts/${local(namingContext)}/preferences`, {
    profile: 'context-preference-v1', expectedPreferenceHead: null,
    labels: [{ target: shared, language: 'ja', label: '共有の文脈' },
      { target: relation, language: 'ja', label: '関係の定義' }], actingSubject: owner.actor });
  expect(labels.status).toBe(201);
  const preferenceRevision = (await labels.json() as { preferenceRevision: string }).preferenceRevision;
  const selected = await owner.send('POST', '/v1/resources/summaries', {
    profile: 'resource-summary-batch-v1', resources: [shared, relation],
    context: namingContext, language: 'ja', actingSubject: owner.actor });
  expect(selected.status).toBe(200);
  const selectedBody = await selected.json() as { summaries: Summary[]; cost: { graphQueries: number } };
  expect(selectedBody.summaries[0]).toMatchObject({ name: { value: '共有の文脈', language: 'ja',
    basis: 'requested', context: namingContext, preferenceRevision } });
  expect(selectedBody.summaries[1]).toMatchObject({ name: { value: '関係の定義', language: 'ja',
    basis: 'requested', context: namingContext, preferenceRevision } });
  expect(selectedBody.cost.graphQueries).toBeLessThanOrEqual(5);
  const unselected = await summaries(owner, 'ja');
  expect(unselected[2]!.name!.value).toContain('Relation definition');
  const image = await owner.upload(png(80, 80), 'public');
  await owner.grant(`media:avatar:${character}`, 'media.avatar');
  await owner.grant(`media:avatar:${shared}`, 'media.avatar');
  const characterSelection = await selectAvatar(owner, character, image.asset, null);
  const contextSelection = await selectAvatar(owner, shared, image.asset, null);
  const contextualWork = await publicWork(owner.actor);
  await owner.grant(`media:avatar:${contextualWork.work}`, 'media.avatar');
  const hiddenSelection = await selectAvatar(owner, contextualWork.work, image.asset, null, hidden);
  const hiddenContextUrl = `/v1/resources/${local(contextualWork.work)}`
    + `?context=${encodeURIComponent(hidden)}`;
  const hiddenContextAnonymous = await call('GET', hiddenContextUrl);
  expect(hiddenContextAnonymous.status).toBe(200);
  const hiddenContextText = await hiddenContextAnonymous.text();
  expect(JSON.parse(hiddenContextText)).toMatchObject({ avatar: { kind: 'fallback' } });
  expect(hiddenContextText).not.toContain(hiddenSelection);
  expect(hiddenContextText).not.toContain(hidden);
  expect(await (await owner.read(hiddenContextUrl)).json()).toMatchObject({
    avatar: { kind: 'image', selection: hiddenSelection } });
  expect((await summaries())[0]!.avatar).toMatchObject({ kind: 'image', selection: characterSelection });
  expect((await call('GET', `/v1/public-previews/${local(shared)}`)).status).toBe(200);
  expect((await call('GET', `/v1/media/avatars/${contextSelection}`)).status).toBe(200);
  expect((await call('GET', `/v1/media/avatars/${characterSelection}`)).status).toBe(404);
  expect((await owner.read(`/v1/media/avatars/${characterSelection}`)).status).toBe(200);
  const costOf = async (resources: string[]) => {
    const response = await owner.send('POST', '/v1/resources/summaries', {
      profile: 'resource-summary-batch-v1', resources, actingSubject: owner.actor });
    expect(response.status).toBe(200);
    return (await response.json() as { cost: { graphQueries: number; mediaQueries: number;
      accessChecks: number; accessQueries: number } }).cost;
  };
  expect(await costOf(Array.from({ length: 64 }, () => character)))
    .toEqual(await costOf([character]));
  expect(await costOf([character])).toEqual({ graphQueries: 3, mediaQueries: 1,
    accessChecks: 1, accessQueries: 1 });
  expect(await costOf([character, role, relation])).toEqual({ graphQueries: 4, mediaQueries: 1,
    accessChecks: 3, accessQueries: 1 });
  expect(await costOf([shared, hidden])).toEqual({ graphQueries: 2, mediaQueries: 1,
    accessChecks: 1, accessQueries: 1 });
  const dual = await createSemantic({ component: 'resource', types: [
    'https://rezics.com/vocab/Role', 'https://rezics.com/vocab/Character'],
  properties: [{ predicate: 'https://schema.org/name', value: {
    kind: 'language-string', lexical: 'First', language: 'ja' } },
  { predicate: 'https://schema.org/name', value: {
    kind: 'language-string', lexical: 'Second', language: 'ja' } }] });
  await owner.grant(`semantic:read:${dual}`, 'semantic.read');
  const dualRead = await owner.read(`/v1/resources/${local(dual)}?language=ja`);
  expect(dualRead.status).toBe(200);
  expect(await dualRead.json()).toMatchObject({ type: 'character',
    name: { value: `Character ${dual.slice(-8)}`, basis: 'fallback' } });
  const other = await summaries(outsider);
  expect(other.map(item => item.status)).toEqual(denied.map(item => item.status));
  expect((await call('GET', `/v1/public-previews/${local(hidden)}`)).status).toBe(404);
  const closed = await access.strongCloseScope(`semantic:read:${character}`, '0');
  expect(closed.pending).toBe(0);
  expect((await summaries())[0]).toEqual({ reference: character, status: 'unavailable' });
  expect((await owner.read(`/v1/media/avatars/${characterSelection}`)).status).toBe(404);
}, 180_000);
