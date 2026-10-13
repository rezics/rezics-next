import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import navigationAndTheme from '../../../../tests/qa/fixtures/outcomes/zone/navigation-and-theme.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import type { ZonePresentationRead, ZoneRouteRead } from '../realm/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages as zoneMessages } from '../zones/messages.ts';
import { defaultPresentation } from '../zones/presentation.ts';
import { zoneHomeDocument } from './home-document.tsx';
import { publicationWire, type PublicationChoice } from './model.ts';
import { NAV_PAGE_SIZE, pageNameOf } from './navigation.ts';
import {
  loadNavigationEditor,
  loadPublishedFrame,
  loadRecordedRoute,
  loadThemeEditor,
  loadZoneNavigationRead,
  recordedActingSubject,
  recordedRoutePath,
  recordedThemeSaveKey,
  recordedThemeWrite,
  saveRecordedTheme,
  themeEditorAfterStaleSave,
  zoneIdFromRecordedPath,
} from './zone-navigation-theme-recorded-page.ts';

const record = navigationAndTheme as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${persona}/${label}`);
  return found;
}

function open(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  let unmatched: unknown;
  const calls: string[] = [];
  const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), 'https://recorded.invalid');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    try {
      const response = await replay.fetcher(input, init);
      calls.push(`${method} ${url.pathname}${url.search} ${response.status}`);
      return response;
    } catch (error) {
      unmatched = error;
      throw error;
    }
  }, { preconnect: globalThis.fetch.preconnect });
  disposals.push(replay.dispose);
  return {
    main: browserMainApi('https://recorded.invalid', { anonymous: true, fetcher }),
    unmatched: () => unmatched,
    calls,
  };
}

function recordedZoneName(answer: ZonePresentationRead): string {
  if (typeof answer.name !== 'string') throw new Error('Recorded presentation has no name');
  return answer.name;
}

function creditOf(home: unknown): { provenance?: { rightsBasis?: string; author?: string } } | null {
  if (!home || typeof home !== 'object' || !('reference' in home)) return null;
  const reference = home.reference;
  return reference && typeof reference === 'object'
    ? reference as { provenance?: { rightsBasis?: string; author?: string } }
    : null;
}

test('a recorded published presentation keeps navigation, home text and original contribution', async () => {
  const item = sample('visitor', 'published-presentation');
  const session = open('visitor', [{ label: item.label, state: 'populated' }]);
  const frame = await loadPublishedFrame(session.main, zoneIdFromRecordedPath(item.path), 'en',
    realmMessages.home, zoneMessages.moduleHeroCarousel);
  if (!frame.ok) throw new Error(String(session.unmatched() ?? frame.failure));
  const answer = item.answer as ZonePresentationRead;
  expect(frame.data.zone.name.value).toBe(recordedZoneName(answer));
  expect(frame.data.cuts.navigation.map(link => link.label.value)).toEqual([
    realmMessages.home, ...answer.navigation.map(mount => mount.name.value),
  ]);
  expect(frame.data.navigationNext).toBeNull();
  expect(frame.data.navigationComplete).toBe(true);
  expect(frame.data.home).toEqual(answer.home);
  expect(zoneHomeDocument(frame.data.home)).toEqual(zoneHomeDocument(answer.home));
  const credit = creditOf(frame.data.home);
  expect(credit).toEqual(creditOf(answer.home));
  expect(credit?.provenance?.rightsBasis).toBe('original-contribution');
  expect(credit?.provenance?.author).toBe(recordedActingSubject(sample('owner', 'draft-configuration').path));
  expect(frame.data.zone.tokens.density).toBe('comfortable');
  expect(frame.data.zone.tokens.pageSurface).toBe('flat');
  expect(frame.data.theme.style['--zone-tiles']).toBe('5');
});

test('a recorded republished presentation keeps both mounts and the later home text', async () => {
  const item = sample('owner', 'republished-presentation');
  const session = open('owner', [{ label: item.label, state: 'populated' }]);
  const frame = await loadPublishedFrame(session.main, zoneIdFromRecordedPath(item.path), 'en',
    realmMessages.home, zoneMessages.moduleHeroCarousel);
  if (!frame.ok) throw new Error(String(session.unmatched() ?? frame.failure));
  const answer = item.answer as ZonePresentationRead;
  expect(answer.navigation).toHaveLength(2);
  expect(frame.data.cuts.navigation.map(link => link.label.value)).toEqual([
    realmMessages.home, ...answer.navigation.map(mount => mount.name.value),
  ]);
  expect(frame.data.navigationNext).toBeNull();
  expect(frame.data.home).toEqual(answer.home);
  expect(creditOf(frame.data.home)?.provenance?.rightsBasis).toBe('original-contribution');
  expect(frame.data.zone.tokens.density).toBe('compact');
  expect(frame.data.zone.tokens.pageSurface).toBe('cards');
  expect(frame.data.theme.style['--zone-tiles']).toBe('6');
});

test('a recorded empty home is a site with no mounts and no home document', async () => {
  const item = sample('visitor', 'empty-home-presentation');
  const session = open('visitor', [{ label: item.label, state: 'empty' }]);
  const frame = await loadPublishedFrame(session.main, zoneIdFromRecordedPath(item.path), 'en',
    realmMessages.home, zoneMessages.moduleHeroCarousel);
  if (!frame.ok) throw new Error(String(session.unmatched() ?? frame.failure));
  const answer = item.answer as ZonePresentationRead;
  expect(frame.data.zone.name.value).toBe(recordedZoneName(answer));
  expect(answer.navigation).toEqual([]);
  expect(frame.data.cuts.navigation.map(link => link.label.value)).toEqual([realmMessages.home]);
  expect(answer.home ?? null).toBeNull();
  expect(frame.data.home).toBe(answer.home);
  expect(frame.data.hero).toBeNull();
  expect(frame.data.mounts).toEqual([]);
  expect(frame.data.navigationNext).toBeNull();
});

test('a recorded empty index has no members and no continuation', async () => {
  const item = sample('visitor', 'published-index-empty');
  const session = open('visitor', [{ label: item.label, state: 'empty' }]);
  const read = await loadRecordedRoute(session.main, zoneIdFromRecordedPath(item.path), recordedRoutePath(item.path));
  if (!read.ok) throw new Error(String(session.unmatched() ?? read.failure));
  expect(read.data.kind).toBe('index');
  if (read.data.kind !== 'index') throw new Error('The recorded route was not an index');
  const answer = item.answer as Extract<ZoneRouteRead, { kind: 'index' }>;
  expect(read.data.items).toEqual(answer.items);
  expect(read.data.items).toEqual([]);
  expect(read.data.nextCursor).toBeNull();
});

test('a recorded missing route stays missing and keeps its problem', async () => {
  const item = sample('visitor', 'unpublished-route-refused');
  const session = open('visitor', [{ label: item.label, state: 'error' }]);
  const read = await loadRecordedRoute(session.main, zoneIdFromRecordedPath(item.path), recordedRoutePath(item.path));
  expect(item.answer).toMatchObject({ code: 'route_missing', title: 'Zone route is unavailable' });
  expect(read).toEqual({ ok: false, failure: 'missing' });
});

test('an owner configuration opens the recorded compact card theme', async () => {
  const item = sample('owner', 'draft-configuration');
  const session = open('owner', [{ label: item.label, state: 'populated' }]);
  const loaded = await loadThemeEditor(session.main, zoneIdFromRecordedPath(item.path),
    recordedActingSubject(item.path), defaultPresentation(zoneMessages));
  if (loaded.kind !== 'editor') throw new Error(String(session.unmatched() ?? loaded.failure));
  expect(loaded.start.kind).toBe('ready');
  if (loaded.start.kind !== 'ready') throw new Error('The recorded theme did not open');
  expect(loaded.start.state.initialization).toBe('saved');
  expect(loaded.start.state.choice).toEqual({ density: 'compact', pageSurface: 'cards' });
  expect(loaded.start.state.saved).toEqual(loaded.start.state.choice);
  expect(loaded.start.state.expectedHead).toBe(loaded.revision);
  expect(loaded.revision).toBe((item.answer as { revision: string }).revision);
  expect(loaded.start.state.presentation.profile).toBe('zone-presentation-v2');
});

test('a stranger configuration refusal stays denied', async () => {
  const item = sample('stranger', 'draft-configuration-refused');
  const session = open('stranger', [{ label: item.label, state: 'error' }]);
  const loaded = await loadThemeEditor(session.main, zoneIdFromRecordedPath(item.path),
    recordedActingSubject(item.path), defaultPresentation(zoneMessages));
  expect(item.answer).toMatchObject({ code: 'zone_unavailable', title: 'Zone is unavailable' });
  expect(loaded).toEqual({ kind: 'failure', failure: 'denied' });
});

test('a stale theme save keeps the recorded refusal and the refused presentation', async () => {
  const item = sample('owner', 'stale-configuration-refused');
  const session = open('owner', [{ label: item.label, state: 'error' }]);
  const write = recordedThemeWrite(item.body);
  const saved = await saveRecordedTheme(session.main, zoneIdFromRecordedPath(item.path), write, recordedThemeSaveKey);
  expect(item.answer).toMatchObject({ code: 'stale_zone_head', title: 'Zone head changed' });
  expect(saved).toEqual({ ok: false, failure: 'stale', currentHead: null });
  const editor = themeEditorAfterStaleSave(write);
  expect(editor?.notice).toBe('stale');
  expect(editor?.needsReview).toBe(true);
  expect(editor?.expectedHead).toBe(write.expectedHead);
  expect(editor?.choice).toEqual({ density: 'comfortable', pageSurface: 'flat' });
});

test('an owner navigation read keeps the recorded mounts and the collection name', async () => {
  const item = sample('owner', 'draft-navigation-editor');
  const names = sample('owner', 'mount-target-collection-name');
  const work = sample('owner', 'mount-target-work');
  const draft = sample('owner', 'showcase-editor');
  const session = open('owner', [
    { label: item.label, state: 'populated' },
    { label: 'draft-navigation', state: 'populated' },
    { label: draft.label, state: 'populated' },
    { label: names.label, state: 'populated' },
    { label: work.label, state: 'error' },
  ]);
  const zoneId = zoneIdFromRecordedPath(item.path);
  const acting = recordedActingSubject(item.path);
  const loaded = await loadNavigationEditor(session.main, zoneId, acting);
  if (loaded.kind !== 'editor') throw new Error(String(session.unmatched() ?? loaded.failure));
  const answer = navigationAnswer(item.answer);
  const collectionName = collectionLabel(names.answer);
  expect(answer.mounts.length).toBeGreaterThan(0);
  expect(work.status).toBe(404);
  expect(work.answer).toMatchObject({ code: 'work_unavailable', title: 'Resource is unavailable' });
  expect(pageNameOf(work.answer)).toBe('Resource is unavailable');
  expect(loaded.navigation.links.map(link => link.name)).toEqual(answer.mounts.map(() => collectionName));
  expect(loaded.navigation.links.map(link => link.segment)).toEqual(answer.mounts.map(mount => mount.qualifier.routeSegment));
  expect(loaded.navigation.links.map(link => link.occurrence)).toEqual(answer.mounts.map(mount => mount.occurrence));
  expect(loaded.navigation.links.map(link => link.target)).toEqual(answer.mounts.map(mount => mount.target));
  expect(loaded.navigation.head).toBe(answer.revision);
  expect(loaded.navigation.navigation).toBe(answer.navigation);
  expect(loaded.navigation.complete).toBe(answer.next === null);
  expect(loaded.navigation.after).toBeNull();
  expect(loaded.navigation.notice).toEqual({ kind: 'idle' });
  expect(loaded.home.zoneHead).toBe(answer.ownerRevision);
  expect(loaded.home.navigationRevision).toBe(answer.revision);
  expect(loaded.home.basis).toEqual(draftBasis(draft.answer));
  const again = await loaded.client.readNavigation(zoneId, acting);
  if (!again.ok) throw new Error(String(session.unmatched() ?? again.failure));
  expect(again.data.links).toEqual(loaded.navigation.links);
  expect(again.data.head).toBe(loaded.navigation.head);
  expect(again.data.navigation).toBe(loaded.navigation.navigation);
  expect(again.data.complete).toBe(true);
  expect(again.data.after).toBeNull();
  expect(again.data.zoneHead).toBe(answer.ownerRevision);
  const workPath = new URL(work.path, 'https://recorded.invalid').pathname;
  const namePath = new URL(names.path, 'https://recorded.invalid').pathname;
  const reads = answer.mounts.length * 2;
  expect(session.calls.filter(call => call.includes(workPath) && call.endsWith(' 404'))).toHaveLength(reads);
  expect(session.calls.filter(call => call.includes(namePath) && call.endsWith(' 200'))).toHaveLength(reads);
});

test('the navigation reader asks for a page the recorded draft does not', async () => {
  const item = sample('owner', 'draft-navigation');
  const session = open('owner', [{ label: item.label, state: 'populated' }]);
  const read = await loadZoneNavigationRead(session.main, zoneIdFromRecordedPath(item.path),
    recordedActingSubject(item.path));
  expect(item.path.includes('limit=')).toBe(false);
  expect(read).toEqual({ ok: false, failure: 'unavailable' });
  const discrepancy = String(session.unmatched());
  expect(discrepancy).toContain(`limit=${NAV_PAGE_SIZE}`);
  expect(discrepancy).toContain(zoneIdFromRecordedPath(item.path));
  expect(discrepancy).toContain(encodeURIComponent(recordedActingSubject(item.path)));
});

test('publishing names the zone as the page, which the recorded home document does not', () => {
  const item = sample('owner', 'publish-site-bundle');
  const body = publishBody(item.body);
  const zoneIri = `https://rezics.com/id/${zoneIdFromRecordedPath(item.path)}`;
  const choice: PublicationChoice = {
    routesRevision: body.routesRevision,
    navigationRevision: body.navigationRevision,
    zoneHead: body.expectedHead,
    page: zoneIri,
    variantId: body.pages[0].variantId,
    revisionId: body.pages[0].revisionId,
    byteDigest: body.pages[0].byteDigest,
    contentEpoch: body.pages[0].contentEpoch,
  };
  const wire = publicationWire(choice, body.actingSubject);
  expect(item.status).toBe(201);
  expect(body.pages[0].page).not.toBe(zoneIri);
  expect(wire.pages[0]?.page).toBe(zoneIri);
  expect(wire.expectedHead).toBe(body.expectedHead);
  expect(wire.actingSubject).toBe(body.actingSubject);
  expect(wire.navigationRevision).toBe(body.navigationRevision);
  expect(wire.routesRevision).toBe(body.routesRevision);
  expect(wire.pages[0]).toEqual({ ...body.pages[0], page: zoneIri });
});

function navigationAnswer(answer: unknown): {
  revision: string;
  navigation: string;
  ownerRevision: string;
  next: string | null;
  mounts: { occurrence: string; target: string; qualifier: { routeSegment: string } }[];
} {
  if (!answer || typeof answer !== 'object') throw new Error('Recorded navigation has no answer');
  const row = answer as Record<string, unknown>;
  const mounts = Array.isArray(row.mounts) ? row.mounts : null;
  if (typeof row.revision !== 'string' || typeof row.navigation !== 'string' || typeof row.ownerRevision !== 'string'
    || (row.next !== null && typeof row.next !== 'string') || !mounts) {
    throw new Error('Recorded navigation is missing its mounts');
  }
  return {
    revision: row.revision,
    navigation: row.navigation,
    ownerRevision: row.ownerRevision,
    next: row.next,
    mounts: mounts.map(mount => {
      if (!mount || typeof mount !== 'object') throw new Error('Recorded navigation mount is missing');
      const item = mount as Record<string, unknown>;
      const qualifier = item.qualifier;
      if (typeof item.occurrence !== 'string' || typeof item.target !== 'string' || !qualifier
        || typeof qualifier !== 'object' || typeof (qualifier as { routeSegment?: unknown }).routeSegment !== 'string') {
        throw new Error('Recorded navigation mount is missing its path');
      }
      return {
        occurrence: item.occurrence,
        target: item.target,
        qualifier: { routeSegment: (qualifier as { routeSegment: string }).routeSegment },
      };
    }),
  };
}

function collectionLabel(answer: unknown): string {
  if (!answer || typeof answer !== 'object' || !('name' in answer)) throw new Error('Recorded collection has no name');
  const name = answer.name;
  if (!name || typeof name !== 'object' || !('original' in name) || !('labels' in name)) {
    throw new Error('Recorded collection has no name');
  }
  const original = name.original;
  const labels = name.labels;
  if (typeof original !== 'string' || !labels || typeof labels !== 'object') {
    throw new Error('Recorded collection has no name');
  }
  const label = (labels as Record<string, unknown>)[original];
  if (typeof label !== 'string') throw new Error('Recorded collection has no name');
  return label;
}

function draftBasis(answer: unknown): { revisionId: string; byteDigest: string; contentEpoch: string } {
  if (!answer || typeof answer !== 'object' || !('draft' in answer) || !answer.draft || typeof answer.draft !== 'object') {
    throw new Error('Recorded showcase has no draft');
  }
  const draft = answer.draft as Record<string, unknown>;
  const position = draft.sourcePosition;
  const epoch = position && typeof position === 'object' && 'dataEpoch' in position ? position.dataEpoch : null;
  if (typeof draft.revisionId !== 'string' || typeof draft.byteDigest !== 'string' || typeof epoch !== 'string') {
    throw new Error('Recorded showcase draft is missing its basis');
  }
  return { revisionId: draft.revisionId, byteDigest: draft.byteDigest, contentEpoch: epoch };
}

function publishBody(body: unknown): {
  expectedHead: string;
  actingSubject: string;
  routesRevision: string;
  navigationRevision: string;
  pages: [{ page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }];
} {
  if (!body || typeof body !== 'object') throw new Error('Recorded publication has no body');
  const row = body as Record<string, unknown>;
  const pages = row.pages;
  const page = Array.isArray(pages) ? pages[0] as Record<string, unknown> | undefined : undefined;
  if (typeof row.expectedHead !== 'string' || typeof row.actingSubject !== 'string'
    || typeof row.routesRevision !== 'string' || typeof row.navigationRevision !== 'string'
    || !page || typeof page.page !== 'string' || typeof page.variantId !== 'string'
    || typeof page.revisionId !== 'string' || typeof page.byteDigest !== 'string'
    || typeof page.contentEpoch !== 'string') {
    throw new Error('Recorded publication is missing the compare-and-set page');
  }
  return {
    expectedHead: row.expectedHead,
    actingSubject: row.actingSubject,
    routesRevision: row.routesRevision,
    navigationRevision: row.navigationRevision,
    pages: [{
      page: page.page, variantId: page.variantId, revisionId: page.revisionId,
      byteDigest: page.byteDigest, contentEpoch: page.contentEpoch,
    }],
  };
}
