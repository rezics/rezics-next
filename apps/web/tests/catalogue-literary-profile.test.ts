import { expect, test } from 'bun:test';
import {
  literaryFields,
  literaryInitialItem,
  validateLiteraryItem,
  createLiteraryWork,
  type LiteraryItem,
} from '../src/features/catalogue/literary-profile';
import { initialTerms } from '../src/features/catalogue/create-subject';
import { allowedCreateAuthority } from '../src/features/catalogue/identity-intake';
import {
  literaryFixture,
  literaryRelease,
  literaryWords,
  literaryWorkId,
  literaryCandidateId,
} from '../src/kernel/fake/catalogue-literary-profile';
import { stageFact, sealFacts, sendFacts, type FactResult } from '../src/features/catalogue/subject-facts';

const terms = (type = 'schema:Book') =>
  initialTerms(type, [
    { language: 'ja', label: '原語の作品名', description: '', aliases: '別名' },
    { language: 'en', label: 'An original literary work', description: 'Original description', aliases: '' },
  ]).item;

test('Book and book-series work editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  const book = literaryFields(literaryRelease, 'schema:Book', 'en');
  expect(book.scalars).toContain('schema:wordCount');
  expect(book.scalars).not.toContain('schema:numberOfPages');
  expect(book.scalars).not.toContain('schema:isbn');
  expect(book.scalars).not.toContain('schema:name');
  expect(book.relations).toEqual(expect.arrayContaining(['schema:author', 'wdt:P179', 'wdt:P7937']));
  const series = literaryFields(literaryRelease, 'schema:BookSeries', 'en');
  expect(series.scalars).toContain('wdt:P2635');
  expect(series.scalars).not.toContain('schema:wordCount');
  expect(series.relations).toEqual(expect.arrayContaining(['schema:publisher', 'wdt:P1433']));
  expect(series.relations).not.toContain('schema:author');
  expect(literaryFields(literaryRelease, 'bf:Instance', 'en').scalars).toEqual([]);
  const item = literaryInitialItem(literaryRelease, terms(), [literaryWords], 'en');
  expect(item.errors).toEqual([]);
  expect(item.item.labels).toEqual({ ja: '原語の作品名', en: 'An original literary work' });
  expect(Object.keys(item.item.statements)).toEqual(['schema:wordCount']);
  const fixture = literaryFixture('uncertain');
  const command = { item: item.item, key: crypto.randomUUID() };
  expect(await fixture.transport.submit(command)).toEqual({ ok: false, reason: 'unavailable' });
  const result = await fixture.transport.submit(command);
  expect(result).toEqual({
    ok: true,
    id: literaryWorkId,
    reader: {
      state: 'ready',
      href: `/en/subjects/${literaryWorkId}/an-original-literary-work`,
      identity: { id: literaryWorkId, type: 'schema:Book', label: 'An original literary work' },
    },
  });
  const writes = fixture.calls.filter((call) => call.path === '/v1/subjects' && call.method === 'POST');
  expect(writes.map((call) => call.key)).toEqual([command.key, command.key]);
  expect(writes[0]!.body).toEqual(command.item);
  expect(fixture.calls.some((call) => call.method === 'GET' && call.path === `/v1/subjects/${literaryWorkId}`)).toBe(
    true,
  );
  expect(fixture.receipts.size).toBe(1);
  const parts = literaryInitialItem(
    literaryRelease,
    terms('schema:BookSeries'),
    [
      {
        ...literaryWords,
        property: { id: 'wdt:P2635' },
        value: { type: 'value', content: { amount: '+6', unit: 'http://www.wikidata.org/entity/Q1238720' } },
      },
    ],
    'en',
  );
  expect(parts.errors).toEqual([]);
  const pages: LiteraryItem = {
    ...item.item,
    statements: { 'schema:numberOfPages': [{ ...literaryWords, property: { id: 'schema:numberOfPages' } }] },
  };
  expect(validateLiteraryItem(literaryRelease, pages, 'en').length).toBeGreaterThan(0);
  const source = { ...item.item, source: { source: 'openlibrary' } };
  expect(validateLiteraryItem(literaryRelease, source, 'en').length).toBeGreaterThan(0);
  const closed = literaryFixture('reader-unavailable');
  expect(await closed.transport.submit(command)).toEqual({
    ok: true,
    id: literaryWorkId,
    reader: { state: 'unavailable' },
  });
  const denied = literaryFixture('denied');
  expect(await denied.transport.submit(command)).toEqual({ ok: false, reason: 'denied' });
  const invalid = await createLiteraryWork(
    fixture.client,
    new Request('https://site.invalid/api'),
    {},
    { ...command, item: pages },
    'en',
  );
  expect(invalid.ok).toBe(false);
});

test('Literary create load reads released definitions independently of parent subject.create eligibility', async () => {
  const fixture = literaryFixture();
  const read = await fixture.transport.load();
  expect(read.ok).toBe(true);
  expect(fixture.calls.every((call) => call.method === 'GET' && call.path.startsWith('/v1/definitions/'))).toBe(true);
  expect(await fixture.transport.eligibility()).toEqual(allowedCreateAuthority);
  expect(fixture.calls.every((call) => call.path.startsWith('/v1/definitions/'))).toBe(true);
});

test('Literary corrections retain untouched evidence and exact per-field keys while proposals remain separate from current reading', async () => {
  const fixture = literaryFixture('ready', 'en', 'schema:Book', true);
  const read = await fixture.facts.read();
  if (!read.ok) throw new Error('Expected current native reading');
  const baseline = structuredClone(read.public);
  const selected = read.public.subject.statements['schema:wordCount']![0]!;
  const words = stageFact(read, 'schema:wordCount', selected.id)!;
  const language = stageFact(read, 'schema:inLanguage', null)!;
  words.statement.value = { type: 'value', content: { amount: '+13000', unit: '1' } };
  language.statement.value = { type: 'value', content: 'ja' };
  language.statement.references = structuredClone(literaryWords.references);
  const drafts = sealFacts(literaryWorkId, literaryRelease, [words, language]);
  expect(drafts[0]!.statement.references).toEqual(literaryWords.references);
  const results = new Map<string, FactResult>();
  await sendFacts(
    drafts,
    async (command) => {
      if (command.statement.property.id === 'schema:inLanguage') throw new Error('Response lost');
      return fixture.facts.propose(command);
    },
    (property, result) => results.set(property, result),
  );
  expect(results.get('schema:wordCount')).toMatchObject({
    ok: true,
    kind: 'proposed-awaiting-review',
    candidate: literaryCandidateId,
  });
  expect(results.get('schema:inLanguage')).toEqual({ ok: false, reason: 'uncertain' });
  const retained = drafts.map((draft) => ({ ...draft, result: results.get(draft.property) }));
  const replay = sealFacts(literaryWorkId, literaryRelease, retained);
  expect(replay[1]!.command).toEqual(drafts[1]!.command);
  await sendFacts(replay, fixture.facts.propose, (property, result) => results.set(property, result));
  const proposals = fixture.calls.filter((call) => call.path.endsWith('/candidates') && call.method === 'POST');
  expect(proposals).toHaveLength(2);
  expect(proposals[0]!.body).toEqual({ statement: drafts[0]!.statement });
  expect(proposals[1]!.key).toBe(drafts[1]!.command!.key);
  expect(fixture.publicRead()).toEqual(baseline);
});
