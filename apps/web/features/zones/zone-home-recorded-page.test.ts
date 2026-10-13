import { afterEach, expect, test } from 'bun:test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import homeRendering from '../../../../tests/qa/fixtures/outcomes/zone/home-rendering.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { zoneHomeProse } from '../zone-editor/home-document.tsx';
import { messages } from './messages.ts';
import { loadZoneHomeModules, readCompleteZonePresentation, readContentRevisionAnswer, readZoneRouteAnswer,
  zoneHomeIdentity, zoneHomePage } from './zone-home-recorded-page.tsx';

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
  return browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
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
    { label: 'published-presentation', state: 'populated' },
    { label: 'published-home-route', state: 'populated' },
    { label: 'published-content-revision', state: 'populated' },
  ]);
  const zone = pathId('published-presentation');
  const presentation = await readCompleteZonePresentation(main, zone);
  expect(presentation.ok).toBe(true);
  if (!presentation.ok) throw new Error('The recorded presentation did not load');
  const data = presentation.data;
  expect(data.navigationNext).toBeNull();
  expect(data.navigationComplete).toBe(true);
  const page = zoneHomePage(data.home);
  if (!page || data.home == null || data.name === null) throw new Error('The recorded home document was dropped');
  expect(page).toBe(data.home);
  const identity = zoneHomeIdentity(data, 'en', realmMessages.home);
  expect(identity.zone.name.value).toBe(data.name);
  expect(identity.links.map(link => link.label.value)).toEqual([
    realmMessages.home, ...data.navigation.map(mount => mount.name.value),
  ]);
  const mount = identity.links[1];
  expect(mount?.href).toContain(data.navigation[0]?.segment);
  expect(mount?.href ?? '').not.toContain('cursor');

  const loaded = await loadZoneHomeModules(page, data.presentation, {
    moduleData: data.moduleData, slideMedia: data.slideMedia,
  }, identity.context, messages.moduleHeroCarousel);
  expect(loaded.modules.map(module => module.module.id)).toEqual(['$default']);
  expect(loaded.representedShowcases).toContain('$default');
  const hero = loaded.modules[0];
  if (!hero || hero.state.state !== 'ready' || !('slides' in hero.state.data)) throw new Error('The recorded hero did not load');
  const slides = (data.home.showcaseData?.slides ?? []).map(slide => {
    if (typeof slide.title !== 'string' || !('href' in slide)) throw new Error('Recorded showcase slide has no title and href');
    return { title: slide.title, href: slide.href };
  });
  expect(hero.state.data.slides.map(slide => slide.title.value)).toEqual(slides.map(slide => slide.title));
  expect(hero.state.data.slides.map(slide => slide.href)).toEqual(slides.map(slide => slide.href));

  const prose = zoneHomeProse(page.document, page.blocks, loaded.representedShowcases);
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

  const route = await readZoneRouteAnswer(main, zone, queryValue('published-home-route', 'path'));
  expect(route.ok).toBe(true);
  if (!route.ok || route.data.kind !== 'home' || !route.data.page) throw new Error('The recorded home route was not a home');
  expect(route.data.page.document).toEqual(page.document);

  const revision = await readContentRevisionAnswer(main, pathId('published-content-revision'));
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
    { label: 'unpublished-route-refused', state: 'error' },
    { label: 'draft-content-revision', state: 'error' },
  ]);
  const route = await readZoneRouteAnswer(main, pathId('unpublished-route-refused'), queryValue('unpublished-route-refused', 'path'));
  expect(routeSample.status).toBe(404);
  expect(routeSample.answer).toMatchObject({ code: 'route_missing' });
  expect(route).toEqual({ ok: false, failure: 'missing' });
  const draft = await readContentRevisionAnswer(main, pathId('draft-content-revision'));
  expect(draftSample.status).toBe(404);
  expect(draftSample.answer).toMatchObject({ code: 'revision_unavailable' });
  expect(draft).toEqual({ ok: false, failure: 'missing' });
});

test('an empty published home and an empty mount keep their recorded continuation', async () => {
  const main = client([
    { label: 'empty-home-presentation', state: 'empty' },
    { label: 'published-index-empty', state: 'empty' },
  ]);
  const presentation = await readCompleteZonePresentation(main, pathId('empty-home-presentation'));
  expect(presentation.ok).toBe(true);
  if (!presentation.ok) throw new Error('The recorded empty presentation did not load');
  expect(zoneHomePage(presentation.data.home)).toBeNull();
  const identity = zoneHomeIdentity(presentation.data, 'en', realmMessages.home);
  const loaded = await loadZoneHomeModules(null, presentation.data.presentation, {
    moduleData: presentation.data.moduleData, slideMedia: presentation.data.slideMedia,
  }, identity.context, messages.moduleHeroCarousel);
  expect(loaded.modules).toEqual([]);
  if (presentation.data.name === null) throw new Error('The recorded empty presentation has no name');
  expect(identity.zone.name.value).toBe(presentation.data.name);
  expect(identity.links.map(link => link.label.value)).toEqual([realmMessages.home]);
  expect(presentation.data.navigationNext).toBeNull();
  expect(presentation.data.navigationComplete).toBe(true);

  const index = await readZoneRouteAnswer(main, pathId('published-index-empty'), queryValue('published-index-empty', 'path'));
  expect(index.ok).toBe(true);
  if (!index.ok || index.data.kind !== 'index') throw new Error('The recorded index was not an index');
  expect(index.data.items).toEqual([]);
  expect(index.data.nextCursor).toBeNull();
});

function privateDraftText() {
  const draft = record.personas.owner?.find(item => item.label === 'draft-content-revision');
  const published = texts((sample('published-presentation').answer as { home?: { document?: unknown } }).home?.document);
  const extra = texts((draft?.answer as { body?: { document?: unknown } } | undefined)?.body?.document)
    .filter(text => !published.includes(text));
  if (!extra.length) throw new Error('The recorded owner draft has no text beyond the published home');
  return extra[0]!;
}
