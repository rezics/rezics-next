import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClassificationProposition, classificationPropositionDigest }
  from '../../../services/main/src/modules/classification/proposition.ts';
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

test('VIEW07: private, revoked and erased media and resources leak no preview, sitemap entry or delivery', async () => {
  const { member, publicWork, privateWork, call, access } = await stack();
  const owner = await member('owner');
  const reader = await member('reader');
  const shown = await publicWork(owner.actor);
  const hidden = await privateWork(owner.actor);
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
  expect(await privatePreview.text()).toBe(await absentPreview.text());
  const anonymousSummary = await call('GET', `/v1/resources/${local(hidden.work)}`);
  expect(anonymousSummary.status).toBe(404);
  expect(await anonymousSummary.text()).not.toContain(hidden.title);

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
  const { member, publicWork, privateWork, call, fuseki, env, admission, contentPool } = await stack();
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
    const response = await as.send('POST', '/v1/resources/summaries', { profile: 'resource-summary-batch-v1',
      resources, actingSubject: as.actor, ...extra });
    expect(response.status).toBe(200);
    const body = await response.json() as { summaries: Summary[];
      cost: { graphQueries: number; mediaQueries: number; accessChecks: number };
      generation: { graph: string; media: string } };
    // One lineage check plus one batch query, whatever the batch size.
    expect(fuseki.queries - graphBefore).toBe(2);
    return body;
  };
  const mixed = await batch(references);
  expect(mixed.summaries.map(summary => [summary.status, summary.type ?? null])).toEqual([
    ['available', 'work'], ['available', 'work'], ['available', 'work'], ['available', 'main-version'],
    ['available', 'work'], ['unavailable', null], ['available', 'space'], ['available', 'concept'],
    ['unavailable', null]]);
  expect(mixed.cost).toEqual({ graphQueries: 1, mediaQueries: 1, accessChecks: 2 });
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
    expect(sized.cost).toEqual({ graphQueries: 1, mediaQueries: 1, accessChecks: 0 });
  }
  await contentPool.query(`INSERT INTO media.selection_slot (target, context, role, policy)
    SELECT 'https://rezics.com/id/' || gen_random_uuid(), 'urn:rezics:media:context:default', 'avatar',
      'avatar-selection-v1' FROM generate_series(1, 5000)`);
  await contentPool.query('ANALYZE media.selection_slot');
  expect((await batch(filler, {}, owner)).cost).toEqual({ graphQueries: 1, mediaQueries: 1, accessChecks: 0 });
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
