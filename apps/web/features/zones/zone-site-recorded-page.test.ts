import { afterEach, expect, test } from 'bun:test';
import { documentText } from '@rezics/document';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import sitePages from '../../../../tests/qa/fixtures/outcomes/zone/site-pages.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { zoneHomeDocument } from '../zone-editor/home-document.tsx';
import { readZoneSiteRecorded, type ZoneSiteMapped } from './zone-site-recorded-page.ts';

const record = sitePages as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function visitor(label: string) {
  const sample = record.personas.visitor.find(item => item.label === label);
  if (!sample || !sample.answer || typeof sample.answer !== 'object') throw new Error(`Missing visitor sample ${label}`);
  return sample;
}

async function replay(selections: readonly RecordedSelection[]) {
  const transport = recordedFetch(record, 'visitor', selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: transport.fetcher });
  const loaded = await readZoneSiteRecorded(main, record, 'visitor', selections);
  if (loaded.mapped.kind === 'discrepancy') throw new Error(loaded.mapped.detail);
  return loaded;
}

function published(mapped: ZoneSiteMapped) {
  if (mapped.kind !== 'published') throw new Error(`expected a published home, received ${mapped.kind}`);
  return mapped;
}

test('visitor published home keeps the recorded document, credit and revision', async () => {
  const presentation = visitor('published-presentation');
  const revision = visitor('published-content-revision');
  const answer = presentation.answer as {
    name: string;
    realm: null;
    navigationNext: null;
    navigationComplete: boolean;
    home: { document: unknown; reference: { revisionId: string; provenance: { rightsBasis: string; author: string } } };
  };
  const revisionAnswer = revision.answer as { body: { body: string } };
  const document = zoneHomeDocument(answer.home);
  if (!document) throw new Error('recorded presentation home is not a readable document');
  const loaded = await replay([
    { label: 'published-presentation', state: 'populated' },
    { label: 'published-home-route', state: 'populated' },
    { label: 'published-content-revision', state: 'populated' },
  ]);
  const mapped = published(loaded.mapped);
  const page = loaded.presentation?.home;
  if (!page) throw new Error('published presentation has no home');
  expect(page).toBe(mapped.page);
  expect(mapped.name).toBe(answer.name);
  expect(mapped.text).toBe(documentText(document));
  expect(mapped.text).toBe(revisionAnswer.body.body);
  expect(mapped.credit).toEqual({
    rightsBasis: answer.home.reference.provenance.rightsBasis,
    author: answer.home.reference.provenance.author,
    revisionId: answer.home.reference.revisionId,
  });
  expect(loaded.presentation?.realm).toBe(answer.realm);
  expect(loaded.presentation?.navigationNext).toBe(answer.navigationNext);
  expect(loaded.presentation?.navigationComplete).toBe(answer.navigationComplete);
  expect(presentation.status).toBe(200);
  expect(revision.status).toBe(200);
});

test('visitor missing path stays the recorded refusal', async () => {
  const sample = visitor('missing-route-refused');
  const answer = sample.answer as { title: string; code: string; status: number };
  const address = visitor('space-address').answer as { canonical: { prefix: string; key: string; suffixSource: string } };
  const loaded = await replay([
    { label: 'space-address', state: 'populated' },
    { label: 'missing-route-refused', state: 'error' },
  ]);
  expect(loaded.mapped).toEqual({
    kind: 'refusal',
    problem: { status: sample.status, title: answer.title, code: answer.code },
  });
  expect(loaded.address?.canonical).toEqual(address.canonical);
  expect(loaded.presentation).toBeNull();
});

test('visitor draft revision stays concealed', async () => {
  const sample = visitor('draft-content-revision');
  const answer = sample.answer as { title: string; code: string };
  const loaded = await replay([{ label: 'draft-content-revision', state: 'error' }]);
  expect(loaded.mapped).toEqual({
    kind: 'refusal',
    problem: { status: sample.status, title: answer.title, code: answer.code },
  });
});

test('visitor presentation without a home stays empty', async () => {
  const sample = visitor('empty-home-presentation');
  const answer = sample.answer as { name: string; home?: unknown };
  const loaded = await replay([{ label: 'empty-home-presentation', state: 'empty' }]);
  expect(loaded.mapped).toEqual({ kind: 'empty', name: answer.name });
  expect(answer.home).toBeUndefined();
  expect(loaded.presentation?.home).toBeUndefined();
});
