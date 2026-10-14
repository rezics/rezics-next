import type { CanonicalAddress } from '@rezics/model/address';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { documentText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { answerPersonas, type AnswerPersona, type AnswerRecord, type AnswerSample } from '../../../../scripts/api/answer-record.ts';
import independentZone from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import { resolvedAddress } from '../address/client.ts';
import { addressKey } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { pageRequest } from '../entity-page/request-fixture.ts';
import { localizedPath } from '../../i18n/locale.ts';
import * as i18nServer from '../../i18n/server.ts';
import * as manageServer from '../manage/server.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { readCompletePresentation, resolveSite } from '../realm/read.ts';
import { idOf } from '../realm/route.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { browserZoneAuthoring, loadCompleteZoneNavigation } from '../zone-editor/api.ts';
import { readZoneManagementFrame, type ZoneManagementFrame } from '../zone-editor/authoring-reads.ts';
import * as editorRead from '../zone-editor/read.ts';
import { zoneHomeDocument } from '../zone-editor/home-document.tsx';
import { authoringModel, draftChoice, draftWire, publicationChoice, publicationWire } from '../zone-editor/model.ts';
import { zoneEditorPath } from '../zone-editor/routes.ts';
import { loadSavedPreviewFrame } from '../zone-editor/saved-preview-frame.ts';
import ZoneEditorLayout, { zoneManagementShell as shellFromLayout } from '../../app/[locale]/manage/z/[space]/layout.tsx';
import { zoneHomeView as homeFromPage } from '../../app/[locale]/manage/z/[space]/page.tsx';
import { zonePreviewBody as previewFromPage } from '../../app/[locale]/manage/z/[space]/preview/page.tsx';
import {
  zoneHomeView as homeFromStory,
  zoneManagementShell as shellFromStory,
  zonePreviewBody as previewFromStory,
} from './independent-zone-recorded-page-manage.tsx';
import * as shellRoutes from './independent-zone-recorded-page-routes.tsx';
import {
  independentZoneHomeBoundary,
  independentZoneVisit,
  readIndependentZoneHome,
  type IndependentZoneRead,
} from './independent-zone-recorded-page.ts';

const record = independentZone as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(item => item.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

function selections(persona: AnswerPersona): readonly RecordedSelection[] {
  const editor = record.personas[persona].find(item => item.label === 'page-editor-link');
  return [
    { label: 'page-address', state: 'populated' },
    { label: 'page-presentation', state: 'populated' },
    ...(editor ? [{ label: 'page-editor-link', state: editor.status === 200 ? 'populated' as const : 'error' as const }] : []),
  ];
}

function requestOf(item: AnswerSample) {
  const url = new URL(item.path, 'https://recorded.invalid');
  return { method: item.method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

function homeOf(persona: AnswerPersona) {
  const answer = sample(persona, 'page-presentation').answer as {
    name: string;
    realm: null;
    navigationNext: null;
    navigationComplete: boolean;
    home: { reference: { revisionId: string; provenance: { rightsBasis: string; author: string } } };
  };
  const document = zoneHomeDocument(answer.home);
  if (!document) throw new Error(`${persona} presentation home is not a readable document`);
  return { answer, text: documentText(document) };
}

async function replay(persona: AnswerPersona, selected: readonly RecordedSelection[]) {
  const visit = independentZoneVisit(record, persona, selected);
  const transport = recordedFetch(record, persona, selected, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  const requests: { method: string; path: string; query: Record<string, string> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.startsWith(`${BFF_PREFIX}/`) ? url.pathname.slice(BFF_PREFIX.length) : url.pathname;
    requests.push({ method: request.method, path, query: Object.fromEntries(url.searchParams) });
    return transport.fetcher(input, init);
  }) as typeof fetch;
  const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher });
  const acting = browserMainApi('https://recorded.invalid', { anonymous: visit.actingSubject === undefined, fetcher });
  return { visit, requests, anonymous, acting };
}

function published(read: IndependentZoneRead) {
  if (read.kind !== 'published') throw new Error(`expected a published home, received ${read.kind}${read.kind === 'discrepancy' ? `: ${read.detail}` : ''}`);
  return read;
}

for (const persona of answerPersonas) {
  test(`${persona} reads the recorded realm-less home through the production visit`, async () => {
    const escapedFetch = Object.assign(async () => { throw new Error('A zone read escaped its supplied client'); },
      { preconnect: globalThis.fetch.preconnect });
    const escaped = spyOn(globalThis, 'fetch').mockImplementation(escapedFetch);
    disposals.push(() => escaped.mockRestore());
    const selected = selections(persona);
    const home = homeOf(persona);
    const route = sample(persona, 'page-home-route').answer as { realm: null; page?: unknown };
    const address = sample(persona, 'page-address');
    const admitted = resolvedAddress(address.answer);
    if (!admitted) throw new Error(`${persona} address is not admitted`);
    expect(admitted.capabilities?.realm).toBeUndefined();
    expect(idOf(admitted.capabilities?.zone ?? '')).toBe(admitted.key);
    const { visit, requests, anonymous, acting } = await replay(persona, selected);
    const read = published(await readIndependentZoneHome(independentZoneHomeBoundary({
      main: anonymous, personal: acting, actingSubject: visit.actingSubject,
      editorClient: visit.actingSubject ? acting : null,
    }), { space: visit.space, locale: 'en', actingSubject: visit.actingSubject }));
    expect(read.zone.realm).toBeNull();
    expect(read.presentation.realm).toBeNull();
    expect(read.zoneId).toBe(admitted.key);
    expect(read.mapped.text).toBe(home.text);
    expect(read.mapped.name).toBe(home.answer.name);
    expect(read.credit).toEqual({
      rightsBasis: home.answer.home.reference.provenance.rightsBasis,
      author: home.answer.home.reference.provenance.author,
      revisionId: home.answer.home.reference.revisionId,
    });
    expect(read.presentation.navigationNext).toBeNull();
    expect(read.presentation.navigationComplete).toBe(true);
    expect(route.realm).toBeNull();
    const editor = record.personas[persona].find(item => item.label === 'page-editor-link');
    if (!editor) expect(read.editor).toBeNull();
    else if (editor.status === 200) expect(read.editor).toEqual({ ok: true });
    else {
      const problem = editor.answer as { title: string; code: string; status: number };
      expect(read.editor).toEqual({ ok: false, failure: 'denied', problem: { status: editor.status, title: problem.title, code: problem.code } });
    }
    if (persona === 'operator') expect(visit.actingSubject).not.toBe(read.credit?.author);
    expect(requests[0]).toEqual(requestOf(address));
    expect(requests.some(item => item.path.endsWith('/routes'))).toBe(false);
    expect(requests.map(item => JSON.stringify(item)).sort()).toEqual(selected.map(item => JSON.stringify(requestOf(sample(persona, item.label)))).sort());
    expect(escaped).not.toHaveBeenCalled();
  });
}

test('production and replay install the same home boundary', () => {
  const production = independentZoneHomeBoundary({ production: { resolveSite, readCompletePresentation } });
  expect(production.resolveSite).toBe(resolveSite);
  expect(production.readCompletePresentation).toBe(readCompletePresentation);
  expect(production.editorOpen).toBeNull();
});

test('production and replay install the same management boundaries', async () => {
  expect(homeFromPage).toBe(shellRoutes.zoneHomeView);
  expect(homeFromStory).toBe(shellRoutes.zoneHomeView);
  expect(previewFromPage).toBe(shellRoutes.zonePreviewBody);
  expect(previewFromStory).toBe(shellRoutes.zonePreviewBody);
  expect(shellFromLayout).toBe(shellRoutes.zoneManagementShell);
  expect(shellFromStory).toBe(shellRoutes.zoneManagementShell);

  const space = zoneSpace('owner');
  const actingSubject = actingPerson('owner');
  const locale = 'en' as const;
  const agent: AgentOption = {
    iri: actingSubject, label: 'Outcome owner', handle: null, kind: 'person', path: 'direct-principal',
  };
  const children = 'recorded home';
  const frame: ZoneManagementFrame = {
    missing: false, name: 'Independent original site', lifecycleOnly: true,
    lifecycleAddress: { zoneId: space, spaceId: space, returnAddress: space },
    draftZoneId: space, authoring: { kind: 'missing' }, lifecycle: { kind: 'missing' },
  };
  const manageMessages = { title: 'Manage' };
  const main = { v1: {} };
  const shellSpy = spyOn(shellRoutes, 'zoneManagementShell');
  const managerSpy = spyOn(manageServer, 'manager').mockResolvedValue({
    principal: 'recorded', agent, actingSubject, main, anonymous: main, signInHref: '/en/auth/start',
  } as Awaited<ReturnType<typeof manageServer.manager>>);
  const localeSpy = spyOn(i18nServer, 'requestLocale').mockResolvedValue(locale);
  const messagesSpy = spyOn(i18nServer, 'getMessages').mockResolvedValue(
    manageMessages as Awaited<ReturnType<typeof i18nServer.getMessages>>,
  );
  const frameSpy = spyOn(editorRead, 'loadZoneManagementFrame').mockResolvedValue(frame);
  disposals.push(() => {
    shellSpy.mockRestore();
    managerSpy.mockRestore();
    localeSpy.mockRestore();
    messagesSpy.mockRestore();
    frameSpy.mockRestore();
  });

  const rendered = await ZoneEditorLayout({ children, params: Promise.resolve({ space }) });
  expect(managerSpy).toHaveBeenCalledWith(locale, zoneEditorPath(space));
  expect(messagesSpy).toHaveBeenCalledWith('manage', locale);
  expect(frameSpy).toHaveBeenCalledWith(main, space, locale, actingSubject);
  expect(shellSpy).toHaveBeenCalledTimes(1);
  expect(shellSpy.mock.calls[0]?.[0]).toEqual({
    space, frame, agent, actingSubject, locale, manageMessages, children,
  });
  expect(rendered).toBe(shellSpy.mock.results[0]?.value);
});

const managed = ['stranger', 'member', 'moderator', 'owner', 'operator'] as const;
type ManagedPersona = (typeof managed)[number];
const editors = ['owner', 'operator'] as const;

interface SeenRequest { method: string; path: string; query: Record<string, string>; body: unknown }

function zoneSpace(persona: AnswerPersona): string {
  const key = new URL(sample(persona, 'page-address').path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error(`${persona} address has no space`);
  return key;
}

function actingPerson(persona: ManagedPersona): string {
  const acting = new URL(sample(persona, 'management-configuration').path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!acting) throw new Error(`${persona} configuration has no acting person`);
  return acting;
}

function callOf(item: AnswerSample): SeenRequest {
  const url = new URL(item.path, 'https://recorded.invalid');
  return { method: item.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
    body: Object.hasOwn(item, 'body') ? item.body : undefined };
}

function signature(request: SeenRequest): string {
  const query = Object.keys(request.query).sort().map(key => `${key}=${request.query[key]}`).join('&');
  return `${request.method} ${request.path}${query ? `?${query}` : ''}${request.body === undefined ? '' : ` ${JSON.stringify(request.body)}`}`;
}

function install(persona: AnswerPersona, labels: readonly string[]) {
  const transport = recordedFetch(record, persona, labels.map(label => {
    const item = sample(persona, label);
    const state = [200, 201, 204].includes(item.status) ? 'populated' as const : 'error' as const;
    return { label, state };
  }), { pathPrefix: BFF_PREFIX });
  const requests: SeenRequest[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const probe = new Request(input instanceof Request ? input.clone() : new URL(String(input), 'https://recorded.invalid'), init);
    const url = new URL(probe.url);
    const path = url.pathname.startsWith(`${BFF_PREFIX}/`) ? url.pathname.slice(BFF_PREFIX.length) : url.pathname;
    const text = await probe.text();
    let body: unknown = undefined;
    if (text) { try { body = JSON.parse(text) as unknown; } catch { body = text; } }
    requests.push({ method: probe.method, path, query: Object.fromEntries(url.searchParams), body });
    return transport.fetcher(input, init);
  }) as typeof fetch;
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  return { requests, main, restore() { globalThis.fetch = previous; transport.dispose(); } };
}

function expectVisit(requests: readonly SeenRequest[], ordered: readonly string[], parallel: readonly string[], persona: AnswerPersona) {
  const head = ordered.map(label => signature(callOf(sample(persona, label))));
  const tail = parallel.map(label => signature(callOf(sample(persona, label)))).sort();
  expect(requests.slice(0, head.length).map(signature)).toEqual(head);
  expect(requests.slice(head.length).map(signature).sort()).toEqual(tail);
  expect(requests).toHaveLength(head.length + tail.length);
}

test('a visitor is sent to sign in before any Zone editor read', async () => {
  const space = zoneSpace('visitor');
  const expected = signInPath(localizedPath(zoneEditorPath(space), 'en'));
  let called = false;
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => { called = true; throw new Error('visitor management sent a request'); },
    { preconnect: globalThis.fetch.preconnect }) as unknown as typeof fetch;
  try {
    await pageRequest(async () => { await manageServer.manager('en', zoneEditorPath(space)); });
    throw new Error('visitor management continued into the editor');
  } catch (error) {
    const digest = error && typeof error === 'object' && 'digest' in error && typeof error.digest === 'string'
      ? error.digest.split(';') : [];
    const target = digest[0] === 'NEXT_REDIRECT' ? digest.slice(2, -2).join(';') : error instanceof Error ? error.message : String(error);
    expect(target).toBe(expected);
  } finally { globalThis.fetch = previous; }
  expect(called).toBe(false);
});

test('signed-in personas read the recorded management and saved preview', async () => {
  for (const persona of managed) {
    const acting = actingPerson(persona);
    const space = zoneSpace(persona);
    const editor = (editors as readonly ManagedPersona[]).includes(persona);
    const host = install(persona, ['management-configuration', 'management-address', 'management-editor', 'management-zone']);
    try {
      const frame = await pageRequest(() => readZoneManagementFrame(host.main, space, 'en', acting));
      const parallel = ['management-editor', 'management-zone',
        ...(editor ? [] : ['management-lifecycle-configuration'])];
      expectVisit(host.requests, ['management-configuration', 'management-address'], parallel, persona);
      expect(host.requests.some(item => item.path.endsWith('/routes') || item.path.endsWith('/presentation'))).toBe(false);
      expect(host.requests.find(item => item.path === '/v1/addresses/resolve')?.query.actingSubject).toBe(acting);
      const address = sample(persona, 'management-address').answer as { capabilities?: { realm?: unknown }; canonical: CanonicalAddress };
      expect(address.capabilities?.realm).toBeUndefined();
      const loaded = frame.authoring;
      if (!editor) {
        expect(loaded.kind).toBe('failure');
        if (loaded.kind === 'failure') expect(loaded.failure).toBe('denied');
        expect(frame.lifecycle).toEqual({ kind: 'failure', failure: 'denied' });
        const repeated = sample(persona, 'management-lifecycle-configuration');
        expect(callOf(repeated).path).toBe(callOf(sample(persona, 'management-configuration')).path);
        expect(callOf(repeated).query).toEqual(callOf(sample(persona, 'management-configuration')).query);
      } else {
        expect(loaded.kind).toBe('ready');
        expect(frame.lifecycle.kind).toBe('ready');
        if (loaded.kind !== 'ready' || frame.lifecycle.kind !== 'ready') continue;
        const zone = sample(persona, 'management-zone').answer as { name: string };
        const draft = (sample(persona, 'management-editor').answer as { draft: { document: DocumentSnapshot } }).draft.document;
        const bound = new URL(sample(persona, 'management-address').path, 'https://recorded.invalid').searchParams.get('key');
        if (!bound) throw new Error('management address has no key');
        expect(loaded.realm).toBeNull();
        expect(loaded.model.name).toBe(zone.name);
        expect(loaded.model.zoneId).toBe(space);
        expect(loaded.frameMetadata.ref).toBe(addressKey(address.canonical));
        expect(loaded.frameMetadata.name.value).toBe(zone.name);
        expect(documentText(loaded.model.document!)).toBe(documentText(draft));
        expect(frame.lifecycle.zoneId).toBe(space);
        expect(frame.lifecycle.spaceId).toBe(bound);
        expect(frame.lifecycle.status).toBe('active');
      }
    } finally { host.restore(); }

    const previewLabels = ['saved-preview-configuration', 'saved-preview-address', 'saved-preview-editor', 'saved-preview-zone',
      ...(editor ? ['saved-preview-navigation'] : [])];
    const preview = install(persona, previewLabels);
    const unexpected: string[] = [];
    try {
      const saved = await pageRequest(async () => {
        const frame = await readZoneManagementFrame(preview.main, space, 'en', acting);
        return loadSavedPreviewFrame({
          authoring: async () => frame.authoring,
          navigation: ready => loadCompleteZoneNavigation(preview.main, ready.model.zoneId, acting, ready.model.state),
          presentation: async () => { unexpected.push('presentation'); return { ok: false }; },
          realmHeader: async () => { unexpected.push('realm'); return { ok: false }; },
          installedDigest: async () => { unexpected.push('digest'); return null; },
          packages: {
            load: async () => { unexpected.push('package'); return null; },
            declarations: async () => { unexpected.push('declarations'); return null; },
          },
        }, { locale: 'en', homeName: realmMessages.home, lookEnabled: true });
      });
      expect(unexpected).toEqual([]);
      expect(preview.requests.some(item => item.path.endsWith('/presentation'))).toBe(false);
      if (!editor) {
        expectVisit(preview.requests, ['saved-preview-configuration', 'saved-preview-address'],
          ['saved-preview-editor', 'saved-preview-zone', 'saved-preview-lifecycle-configuration'], persona);
        expect(saved.kind).toBe('failure');
        if (saved.kind === 'failure') expect(saved.failure).toBe('denied');
      } else {
        const navigation = preview.requests.at(-1);
        if (!navigation) throw new Error(`${persona} preview sent no navigation read`);
        expectVisit(preview.requests.slice(0, -1), ['saved-preview-configuration', 'saved-preview-address'],
          ['saved-preview-editor', 'saved-preview-zone'], persona);
        expect(signature(navigation)).toBe(signature(callOf(sample(persona, 'saved-preview-navigation'))));
        expect(saved.kind).toBe('ready');
        if (saved.kind !== 'ready') continue;
        const draft = (sample(persona, 'saved-preview-editor').answer as { draft: { document: DocumentSnapshot } }).draft.document;
        expect(saved.frame.saved.realm).toBeNull();
        expect(saved.frame.zone.realm).toBeNull();
        expect(saved.frame.context.realm).toBe(saved.frame.saved.model.zoneId);
        expect(saved.frame.zone.name.value).toBe(saved.frame.saved.model.name);
        expect(documentText(saved.frame.saved.model.document!)).toBe(documentText(draft));
      }
    } finally { preview.restore(); }
  }
});

test('the owner and the mandated operator save, republish, reopen and keep a stale draft', async () => {
  for (const persona of editors) {
  const acting = actingPerson(persona);
  const zone = zoneSpace(persona);
  const editor = sample(persona, 'management-editor').answer;
  const zoneAnswer = sample(persona, 'management-zone').answer;
  const model = authoringModel(editor, zoneAnswer, zone, 'Independent original site');
  if (!model) throw new Error('Recorded owner editor did not open');
  const save = sample(persona, 'editor-save');
  const document = (save.body as { document: DocumentSnapshot }).document;
  const started = { ...model.state, value: serializeDocument(document) };
  const choice = draftChoice(started, acting);
  expect(save.body).toEqual(draftWire(choice));

  const saving = install(persona, ['editor-save', 'editor-publication']);
  try {
    const client = browserZoneAuthoring(saving.main);
    const saved = await client.saveDraft(draftWire(choice), crypto.randomUUID());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const basis = { revisionId: saved.data.revisionId, byteDigest: saved.data.byteDigest, contentEpoch: saved.data.contentEpoch };
    const publication = publicationChoice({ ...started, value: choice.savedValue, savedValue: choice.savedValue,
      expectedHead: saved.data.revisionId, basis });
    if (!publication) throw new Error('owner publication choice was empty');
    expect(sample(persona, 'editor-publication').body).toEqual(publicationWire(publication, acting));
    const published = await client.publish(publication, acting, crypto.randomUUID(), zone);
    expect(published.ok).toBe(true);
    expect(saving.requests.map(signature)).toEqual([
      signature(callOf(save)),
      signature(callOf(sample(persona, 'editor-publication'))),
    ]);
  } finally { saving.restore(); }

  const stale = install(persona, ['editor-stale-save', 'editor-reopen-draft', 'editor-reopen-heads']);
  try {
    const client = browserZoneAuthoring(stale.main);
    const refused = await client.saveDraft(draftWire(choice), crypto.randomUUID());
    const problem = sample(persona, 'editor-stale-save').answer as { code: string; currentHead: string };
    expect(problem.code).toBe('stale_head');
    expect(refused).toEqual({ ok: false, failure: 'stale', currentHead: problem.currentHead });
    const reopened = await client.readDraft(zone, acting);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok || !reopened.data.document) return;
    const draft = (sample(persona, 'editor-reopen-draft').answer as { draft: { document: DocumentSnapshot } }).draft.document;
    expect(documentText(reopened.data.document)).toBe(documentText(draft));
    expect(stale.requests.map(signature)).toEqual([
      signature(callOf(sample(persona, 'editor-stale-save'))),
      signature(callOf(sample(persona, 'editor-reopen-draft'))),
      signature(callOf(sample(persona, 'editor-reopen-heads'))),
    ]);
  } finally { stale.restore(); }
  }
});
