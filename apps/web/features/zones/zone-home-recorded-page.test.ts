import { afterEach, expect, test } from 'bun:test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import homeRendering from '../../../../tests/qa/fixtures/outcomes/zone/home-rendering.json';
import { addressKey } from '../address/path.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { settleRealmRead } from '../realm/browse-page-read.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { siteHref } from '../realm/route.ts';
import { realmFrameReads } from '../realm/zone-presentation-read.ts';
import type { RealmHeader, ZonePresentationRead } from '../realm/types.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { zoneHomeProse } from '../zone-editor/home-document.tsx';
import { messages } from './messages.ts';
import { mapZoneSiteHome } from './zone-site-recorded-page.ts';
import { loadZoneHomeFrame, loadZoneHomeModules, recordedZoneHomeClient, zoneHomeFrameModel } from './zone-home-recorded-page.tsx';

const record = homeRendering as AnswerRecord;
const persona = 'visitor';
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded zone home answer: ${label}`);
  return found;
}

function pathId(label: string) {
  return new URL(sample(label).path, 'https://recorded.invalid').pathname.split('/')[3]!;
}

function queryValue(label: string, name: string) {
  const value = new URL(sample(label).path, 'https://recorded.invalid').searchParams.get(name);
  if (value === null) throw new Error(`Recorded ${label} has no ${name}`);
  return value;
}

function client(labels: readonly { label: string; state: RecordedState }[]) {
  const replay = recordedFetch(record, persona, labels, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  return recordedZoneHomeClient(replay.fetcher);
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  const nested = [node.doc, ...(Array.isArray(node.content) ? node.content : [])];
  return [node, ...nested.flatMap(nodes)];
}

function texts(value: unknown): string[] {
  return nodes(value).flatMap(node => typeof node.text === 'string' ? [node.text] : []);
}

function extensionBlocks(value: unknown) {
  return nodes(value).flatMap(node => {
    if (node.type !== 'extensionBlock' || !node.attrs || typeof node.attrs !== 'object') return [];
    const attrs = node.attrs as { id?: unknown; fallback?: unknown; payload?: unknown };
    return [{ id: attrs.id, fallback: attrs.fallback, payload: attrs.payload }];
  });
}

test('recorded published home keeps its slide, document, rights and continuation', async () => {
  const main = client([
    { label: 'frame-published-space-address', state: 'populated' },
    { label: 'frame-published-presentation', state: 'populated' },
    { label: 'frame-published-realm-header', state: 'populated' },
    { label: 'published-home-route', state: 'populated' },
    { label: 'published-content-revision', state: 'populated' },
  ]);
  const header = sample('frame-published-realm-header').answer as RealmHeader;
  const published = sample('frame-published-presentation').answer as ZonePresentationRead;
  const loaded = await loadZoneHomeFrame(main, queryValue('frame-published-space-address', 'key'), 'en');
  expect(loaded.kind).toBe('attached');
  if (loaded.kind !== 'attached') throw new Error('The recorded published home did not attach its Realm');
  const data = loaded.presentation;
  expect(data.navigationNext).toBeNull();
  expect(data.navigationComplete).toBe(true);
  expect(data.name).toBe(published.name);
  expect(data.realm).toBe(header.id);
  const mapped = mapZoneSiteHome(data);
  if (mapped.kind !== 'published' || data.home == null || data.name === null) throw new Error('The recorded home document was dropped');
  expect(mapped.page).toBe(data.home);
  const page = mapped.page;
  const model = zoneHomeFrameModel(loaded, 'en', realmMessages.home);
  if (model.kind !== 'attached') throw new Error('The recorded published home did not attach its Realm');
  expect(model.zone.name.value).toBe(header.name.value);
  expect(model.zone.realm).toBe(header.id);
  expect(model.links.map(link => link.label.value)).toEqual([
    realmMessages.home, ...data.navigation.map(mount => mount.name.value),
  ]);
  const mount = model.links[1];
  expect(mount?.href).toContain(data.navigation[0]?.segment);
  expect(mount?.href ?? '').not.toContain('cursor');
  if (data.address.prefix !== '/z/') throw new Error(`Recorded site address prefix is ${data.address.prefix}`);
  expect(model.links[0]?.href).toBe(siteHref('en', addressKey({ ...data.address, prefix: '/z/' }), []));

  const modules = await loadZoneHomeModules(page, data.presentation, {
    moduleData: data.moduleData, slideMedia: data.slideMedia,
  }, model.context, messages.moduleHeroCarousel);
  expect(modules.modules.map(module => module.module.id)).toEqual(['$default']);
  expect(modules.representedShowcases).toContain('$default');
  const hero = modules.modules[0];
  if (!hero || hero.state.state !== 'ready' || !('slides' in hero.state.data)) throw new Error('The recorded hero did not load');
  const slides = (data.home.showcaseData?.slides ?? []).map(slide => {
    if (typeof slide.title !== 'string' || !('href' in slide)) throw new Error('Recorded showcase slide has no title and href');
    return { title: slide.title, href: slide.href };
  });
  expect(hero.state.data.slides.map(slide => slide.title.value)).toEqual(slides.map(slide => slide.title));
  expect(hero.state.data.slides.map(slide => slide.href)).toEqual(slides.map(slide => slide.href));

  const prose = zoneHomeProse(page.document, page.blocks, modules.representedShowcases);
  const sourceBlocks = extensionBlocks(page.document);
  const resolved = sourceBlocks.filter(block => page.blocks.some(item => item.id === block.id && item.status === 'resolved'));
  const proseBlocks = extensionBlocks(prose);
  expect(proseBlocks.map(block => block.id)).toEqual(sourceBlocks.flatMap(block =>
    resolved.some(item => item.id === block.id) ? [] : [block.id]));
  expect(texts(prose)).toEqual(texts(page.document));
  expect(proseBlocks.map(block => block.fallback)).toEqual(sourceBlocks.flatMap(block =>
    resolved.some(item => item.id === block.id) ? [] : [block.fallback]));
  expect(proseBlocks.map(block => block.payload)).toEqual(sourceBlocks.flatMap(block =>
    resolved.some(item => item.id === block.id) ? [] : [block.payload]));
  expect(JSON.stringify(page.document)).not.toContain(privateDraftText());

  const route = await realmFrameReads({ main, personal: main, keepProblem: false }).readZoneRoute(
    loaded.site.zone, queryValue('published-home-route', 'path'));
  expect(route.ok).toBe(true);
  if (!route.ok || route.data.kind !== 'home' || !route.data.page) throw new Error('The recorded home route was not a home');
  expect(route.data.page.document).toEqual(page.document);

  const revision = await settleRealmRead(() => main.v1['content-revisions']({ revision: pathId('published-content-revision') }).get());
  expect(revision.ok).toBe(true);
  if (!revision.ok) throw new Error('The recorded content revision did not load');
  expect(revision.data.body.document).toEqual(page.document);
  expect(data.home.reference.provenance.rightsBasis).toBe('original-contribution');
  expect(revision.data.reference.provenance?.rightsBasis).toBe(data.home.reference.provenance.rightsBasis);
  expect(revision.data.reference.provenance?.author).toBe(data.home.reference.provenance.author);
});

test('a recorded route refusal stays missing rather than an empty home', async () => {
  const routeSample = sample('unpublished-route-refused');
  const draftSample = sample('draft-content-revision');
  const main = client([
    { label: 'frame-published-space-address', state: 'populated' },
    { label: 'frame-published-presentation', state: 'populated' },
    { label: 'frame-published-realm-header', state: 'populated' },
    { label: 'unpublished-route-refused', state: 'error' },
    { label: 'draft-content-revision', state: 'error' },
  ]);
  const loaded = await loadZoneHomeFrame(main, queryValue('frame-published-space-address', 'key'), 'en',
    queryValue('unpublished-route-refused', 'path'));
  expect(routeSample.status).toBe(404);
  expect(routeSample.answer).toMatchObject({ code: 'route_missing' });
  expect(loaded.kind).toBe('missing');
  if (loaded.kind !== 'missing') throw new Error('The recorded route refusal became a page');
  expect(loaded.route).toEqual({ ok: false, failure: 'missing', status: 404, problem: routeSample.answer });
  const draft = await settleRealmRead(() => main.v1['content-revisions']({ revision: pathId('draft-content-revision') }).get());
  expect(draftSample.status).toBe(404);
  expect(draftSample.answer).toMatchObject({ code: 'revision_unavailable' });
  expect(draft).toEqual({ ok: false, failure: 'missing' });
});

test('an empty published home and an empty mount keep their recorded continuation', async () => {
  const main = client([
    { label: 'frame-empty-space-address', state: 'populated' },
    { label: 'frame-empty-presentation', state: 'empty' },
    { label: 'published-index-empty', state: 'empty' },
  ]);
  const loaded = await loadZoneHomeFrame(main, queryValue('frame-empty-space-address', 'key'), 'en');
  expect(loaded.kind).toBe('standalone');
  if (loaded.kind !== 'standalone') throw new Error('The recorded empty home attached a Realm');
  expect(loaded.presentation.realm).toBeNull();
  expect(mapZoneSiteHome(loaded.presentation).kind).toBe('empty');
  const model = zoneHomeFrameModel(loaded, 'en', realmMessages.home);
  if (model.kind !== 'standalone') throw new Error('The recorded empty home attached a Realm');
  const modules = await loadZoneHomeModules(null, loaded.presentation.presentation, {
    moduleData: loaded.presentation.moduleData, slideMedia: loaded.presentation.slideMedia,
  }, model.context, messages.moduleHeroCarousel);
  expect(modules.modules).toEqual([]);
  if (loaded.presentation.name === null) throw new Error('The recorded empty presentation has no name');
  expect(model.zone.name.value).toBe(loaded.presentation.name);
  expect(model.zone.realm).toBeNull();
  expect(model.links.map(link => link.label.value)).toEqual([realmMessages.home]);
  expect(loaded.presentation.navigationNext).toBeNull();
  expect(loaded.presentation.navigationComplete).toBe(true);

  const index = await realmFrameReads({ main, personal: main }).readZoneRoute(
    pathId('published-index-empty'), queryValue('published-index-empty', 'path'));
  expect(index.ok).toBe(true);
  if (!index.ok || index.data.kind !== 'index') throw new Error('The recorded index was not an index');
  expect(index.data.items).toEqual([]);
  expect(index.data.nextCursor).toBeNull();
});

function privateDraftText() {
  const draft = record.personas.owner?.find(item => item.label === 'draft-content-revision');
  const published = texts((sample('frame-published-presentation').answer as { home?: { document?: unknown } }).home?.document);
  const extra = texts((draft?.answer as { body?: { document?: unknown } } | undefined)?.body?.document)
    .filter(text => !published.includes(text));
  if (!extra.length) throw new Error('The recorded owner draft has no text beyond the published home');
  return extra[0]!;
}
