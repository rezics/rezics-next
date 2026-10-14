import { afterEach, expect, spyOn, test } from 'bun:test';
import { documentText } from '@rezics/document';
import { answerPersonas, type AnswerPersona, type AnswerRecord, type AnswerSample } from '../../../../scripts/api/answer-record.ts';
import independentZone from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import { resolvedAddress } from '../address/client.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { realmFrameReads } from '../realm/read.ts';
import { idOf } from '../realm/route.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneHomeDocument } from '../zone-editor/home-document.tsx';
import { independentZoneVisit, readIndependentZonePublished, type IndependentZoneRead } from './independent-zone-recorded-page.ts';

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
    { label: 'page-home-route', state: 'populated' },
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
  const main = browserMainApi('https://recorded.invalid', { anonymous: visit.actingSubject === undefined, fetcher });
  return { visit, requests, main, fetcher };
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
    const { visit, requests, main, fetcher } = await replay(persona, selected);
    const read = published(await readIndependentZonePublished(main, {
      space: visit.space, locale: 'en', actingSubject: visit.actingSubject,
      origin: 'https://recorded.invalid', fetcher,
    }));
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
    expect(requests.map(item => JSON.stringify(item)).sort()).toEqual(selected.map(item => JSON.stringify(requestOf(sample(persona, item.label)))).sort());
    const production = await replay(persona, selected.filter(item => item.label !== 'page-editor-link'));
    const reads = realmFrameReads({ main: production.main, actingSubject: visit.actingSubject });
    const site = await reads.resolveSite(visit.space, 'en');
    expect<unknown>(site).toEqual({ kind: 'site', address: address.answer, zone: admitted.key, realm: null });
    expect<unknown>(await reads.readCompletePresentation(admitted.key)).toEqual({ ok: true, data: sample(persona, 'page-presentation').answer });
    expect<unknown>(await reads.readZoneRoute(admitted.key, '/')).toEqual({ ok: true, data: sample(persona, 'page-home-route').answer });
    expect(escaped).not.toHaveBeenCalled();
  });
}
