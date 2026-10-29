import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { bundledDigest } from '@rezics/definitions/bundled';
import { validateFilter } from '@rezics/filter';
import { Compile } from 'typebox/schema';
import { CountProducerInputSchema, type CountProducerInput } from '../../src/semantic/measured-text-contract.ts';
import type { Statement, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

// Proposed vocabulary, pending Semantic adoption. No replacement release or private transport.
const words = 'schema:wordCount';
const characters = 'rezics:characterCount';
const textVersion = 'rezics:measuredText';
const language = 'schema:inLanguage';
const scope = 'rezics:measurementScope';
const method = 'wdt:P459';
const measuredAt = 'rezics:measuredAt';
const realizationVersion = 'owned-manuscript-v1';
const producerInput = Compile(CountProducerInputSchema);
const body = 'Amber birds cross quiet winter fields.';
const digest = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const controlledRecord = {
  url: 'https://example.org/released-discovery/v1/controlled-assertions',
  digest: digest('Controlled association and threshold assertions; not a measured manuscript'),
};
const wordMethod =
  'Owned ASCII words v1: maximal runs [A-Za-z]+ count as words; punctuation and U+0020 delimit runs. No normalization, dictionary or locale tailoring; input restricted to ASCII English.';
const characterMethod =
  'Owned ASCII characters v1: Unicode code points except U+0020; include punctuation. No normalization; input restricted to ASCII. This is not a word method or an extended-grapheme claim.';
const part = (property: string, content: StatementInput['value']['content']) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
});
let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);
async function read(holder: CreatedSubject): Promise<Subject> {
  const response = await fixture.read(holder);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.subject as Subject;
}
type NativeStatement = Omit<Statement, 'value'> & { value: Input['value'] };
function fact(holder: Subject, property: string): NativeStatement {
  expect(holder.statements[property], `${holder.id} public ${property}`).toHaveLength(1);
  return holder.statements[property]![0]! as NativeStatement;
}
async function authored(holder: CreatedSubject, text: string) {
  const snapshot = fromPlainText(text);
  const input = discoveryStatement('schema:abstract', {
    document: snapshot,
    licence: 'CC-BY-4.0',
    language: 'en',
  } as unknown as StatementInput['value']['content']);
  const receipt = await fixture.adopt(holder, input);
  const authoredValue = fact(await read(holder), 'schema:abstract').value;
  if (authoredValue.type !== 'value') throw new Error('Authored snapshot is not a concrete value');
  const stored = authoredValue.content as {
    document: string;
    digest: string;
    language: string;
  };
  const response = await fixture.request('anonymous', 'GET', `/v1/documents/${stored.document}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.document).toMatchObject({
    id: stored.document,
    subjectId: holder.id,
    candidateId: receipt.candidate,
    digest: stored.digest,
    language: 'en',
    licence: 'CC-BY-4.0',
    origin: 'account',
    availability: 'available',
    body: snapshot,
  });
  // Content's snapshot digest and the measured UTF-8 text digest have different domains.
  return { ...stored, url: `https://rezics.com/v1/documents/${stored.document}` };
}
async function methods() {
  const scheme = await fixture.createSubject('skos:ConceptScheme', 'Owned measurement methods');
  const word = await fixture.createSubject('skos:Concept', 'Owned ASCII words v1');
  const character = await fixture.createSubject('skos:Concept', 'Owned ASCII characters v1');
  for (const [concept, definition] of [
    [word, wordMethod],
    [character, characterMethod],
  ] as const) {
    await fixture.adopt(concept, discoveryStatement('skos:inScheme', scheme.id));
    // Concept has no abstract slot in the actual bundle; cite a real authored work.
    const source = await fixture.createSubject('schema:Book', 'Owned versioned method definition');
    const document = await authored(source, definition);
    await fixture.adopt(concept, discoveryStatement('schema:url', document.url));
    expect(fact(await read(concept), 'schema:url').value).toEqual({ type: 'value', content: document.url });
    expect(fact(await read(concept), 'skos:inScheme').value).toEqual({ type: 'value', content: scheme.id });
  }
  return { word, character };
}
type Input = Omit<StatementInput, 'value'> & {
  value: StatementInput['value'] | { type: 'somevalue' } | { type: 'novalue' };
};
function measurement(
  property: string,
  amount: string,
  methodId: string,
  record: { url: string; digest: string },
  time: string,
  overrides: { text?: string; language?: string; scope?: string; version?: string } = {},
): Input {
  return {
    ...part(property, { amount, unit: '1' }),
    rank: 'preferred',
    qualifiers: [
      part(textVersion, overrides.text ?? digest(body)),
      part(language, overrides.language ?? 'en'),
      part(scope, overrides.scope ?? 'partial'),
      part('schema:version', overrides.version ?? realizationVersion),
      part(method, methodId),
      part(measuredAt, time),
    ],
    references: [{ parts: [part('schema:url', record.url), part('schema:version', record.digest)] }],
  };
}
async function propose(holder: CreatedSubject, statement: Input) {
  return fixture.request('editor', 'POST', `/v1/subjects/${holder.id}/candidates`, { statement }, discoveryKey());
}
async function selected(holder: CreatedSubject, input: Input) {
  const receipt = await fixture.adopt(holder, input);
  const value = fact(await read(holder), input.property.id);
  expect(value.id).toBe(receipt.candidate);
  expect(value.rezics.release).toBe(bundledDigest);
  expect(value.value).toEqual(input.value);
  expect(value.qualifiers).toMatchObject(input.qualifiers!);
  expect(value.references).toMatchObject(input.references!);
  expect(value.references[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  return value;
}

// This genuinely measures owned input. Threshold amounts below are separate controls.
async function ownedMeasurement() {
  expect(body.match(/[A-Za-z]+/g)).toHaveLength(6);
  expect(Array.from(body).filter((point) => point !== ' ')).toHaveLength(33);
  const time = new Date().toISOString();
  const holder = await fixture.createSubject('schema:Book', 'Owned six-word manuscript');
  const producer = await fixture.createSubject('schema:Organization', 'Controlled native publisher identity');
  const manuscript = await authored(holder, body);
  const m = await methods();
  const evidence = await fixture.createSubject('schema:Book', 'Owned auditable measurement record');
  const record = await authored(
    evidence,
    JSON.stringify({
      kind: 'trusted contributor measurement assertion',
      holder: holder.id,
      manuscript: manuscript.url,
      producer: producer.id,
      version: realizationVersion,
      measuredText: digest(body),
      language: 'en',
      coverage: { kind: 'partial', included: ['authored summary'], excluded: ['whole holder not declared'] },
      measuredAt: time,
      words: { amount: '+6', unit: '1', method: m.word.id, definition: wordMethod },
      characters: { amount: '+33', unit: '1', method: m.character.id, definition: characterMethod },
      rights: 'Original controlled manuscript and measurement record, CC-BY-4.0',
    }),
  );
  return { holder, producer, record, m, time };
}

test('native measured word and character assertions preserve holder text version language method scope and evidence together', async () => {
  const { holder, producer, record, m, time } = await ownedMeasurement();
  const wordInput = measurement(words, '+6', m.word.id, record, time);
  const characterInput = measurement(characters, '+33', m.character.id, record, time);
  const supplied = {
    kind: 'supplied-text',
    holder: holder.id,
    producer: producer.id,
    language: 'en',
    version: { kind: 'declared', value: realizationVersion },
    coverage: { kind: 'partial', included: ['authored summary'], excluded: ['whole holder not declared'] },
    text: body,
    digest: digest(body),
    measuredAt: time,
    method: { concept: m.word.id, version: 'v1', definition: wordMethod },
    statement: {
      property: { id: 'schema:wordCount' },
      value: { type: 'value', content: { amount: '+6', unit: '1' } },
      qualifiers: wordInput.qualifiers!,
      references: wordInput.references!,
      rank: 'preferred',
    },
  } satisfies CountProducerInput;
  expect(producerInput.Check(supplied)).toBe(true);
  const { digest: omittedDigest, ...missingDigest } = supplied;
  expect(omittedDigest).toBe(digest(body));
  expect(producerInput.Check(missingDigest)).toBe(false);
  expect(producerInput.Check({ ...supplied, inventedEligibility: true })).toBe(false);
  for (const kind of ['partial', 'unknown', 'unsupported-multilingual'] as const) {
    expect(producerInput.Check({ ...supplied, coverage: { ...supplied.coverage, kind } })).toBe(true);
  }
  const observed = [];
  // Collect both actual admission outcomes before asserting: missing definitions are expected-201 reds.
  for (const input of [wordInput, characterInput]) {
    const response = await propose(holder, input);
    observed.push({ property: input.property.id, status: response.status, body: response.body });
  }
  expect(
    observed.map(({ property, status }) => ({ property, status })),
    JSON.stringify(observed),
  ).toEqual([
    { property: words, status: 201 },
    { property: characters, status: 201 },
  ]);
  for (const content of [
    { amount: '-1', unit: '1' },
    { amount: '+0.5', unit: '1' },
    { amount: '+1', unit: 'pages' },
    { amount: '+1', unit: '1', lowerBound: '+1' },
  ]) {
    expect(
      producerInput.Check({ ...supplied, statement: { ...supplied.statement, value: { type: 'value', content } } }),
    ).toBe(false);
  }
  const word = await selected(holder, wordInput);
  const character = await selected(holder, characterInput);
  expect(word.qualifiers.find((q) => q.property.id === method)!.value.content).toBe(m.word.id);
  expect(character.qualifiers.find((q) => q.property.id === method)!.value.content).toBe(m.character.id);
  const compactInput = structuredClone(wordInput);
  expect(wordInput.qualifiers!.find((q) => q.property.id === scope)!.value.content).toBe('partial');
  compactInput.references = [
    { parts: [part('schema:url', 'https://example.org/released-discovery/v1/controlled-assertions')] },
  ];
  const compact = await fixture.createSubject('schema:Book', 'Compact controlled association', {
    [words]: [compactInput],
  });
  const compactWord = fact(await read(compact), words);
  expect(compactWord.rezics).toEqual({ release: bundledDigest, revision: 1 });
  expect(compactWord.qualifiers).toEqual(word.qualifiers);
  expect(compactWord.references).toMatchObject(compactInput.references!);
  // A second reference belongs to its candidate, never to the selected one implicitly.
  const alternate = structuredClone(wordInput);
  const competingHolder = await fixture.createSubject('schema:Book', 'Controlled incomplete competing citation');
  const competingRecord = await authored(
    competingHolder,
    JSON.stringify({
      holder: holder.id,
      language: 'ja',
      version: 'controlled-v2',
      kind: 'Controlled incomplete citation; supplies no method or whole-holder declaration',
    }),
  );
  alternate.references!.push({
    parts: [part('schema:url', competingRecord.url), part('schema:version', competingRecord.digest)],
  });
  alternate.qualifiers = alternate.qualifiers!.map((q) =>
    q.property.id === textVersion
      ? part(textVersion, digest(body + ' Again.'))
      : q.property.id === scope
        ? part(scope, 'partial')
        : q,
  );
  const pending = await propose(holder, alternate);
  expect(pending.status, JSON.stringify(pending.body)).toBe(201);
  expect(fact(await read(holder), words)).toEqual(word);
  const rejection = await fixture.request(
    'acceptor',
    'POST',
    `/v1/subjects/${holder.id}/candidates/${pending.body.candidate}:reject`,
    { context: (await read(holder)).context, expected_head: null },
    discoveryKey(),
  );
  expect(rejection.status, JSON.stringify(rejection.body)).toBe(200);
  const global = (await read(holder)).context;
  await fixture.grant('acceptor', ['moderation:hide', 'moderation:takedown'], global);
  for (const action of ['hide', 'restore'] as const) {
    const response = await fixture.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}/candidates/${word.id}:${action}`,
      { reason: 'Controlled current measurement disclosure' },
      discoveryKey(),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const visible = (await read(holder)).statements[words] ?? [];
    expect(visible.some((s) => s.id === word.id)).toBe(action === 'restore');
  }
  const publicWords = (await read(holder)).statements[words]! as NativeStatement[];
  expect(publicWords.filter((s) => s.rank !== 'deprecated')).toEqual([word]);
  expect(publicWords.find((s) => s.id === pending.body.candidate)).toMatchObject({
    rank: 'deprecated',
    qualifiers: alternate.qualifiers,
    references: alternate.references,
  });
}, 120_000);

test('edition and characters never become Book work words and incomplete crossstatement qualifiers never match', async () => {
  const { m, time } = await ownedMeasurement();
  const record = controlledRecord;
  const work = await fixture.createSubject('schema:Book', 'Absent work count');
  const edition = await fixture.createSubject('bf:Instance', 'Translation-only count');
  await fixture.adopt(edition, discoveryStatement('schema:exampleOfWork', work.id));
  await selected(
    edition,
    measurement(words, '+1000001', m.word.id, record, time, { language: 'ja', text: digest('Controlled edition v2') }),
  );
  const characterOnly = await fixture.createSubject('schema:Book', 'Character-only threshold control');
  await selected(characterOnly, measurement(characters, '+1000001', m.character.id, record, time));
  expect((await read(work)).statements[words] ?? []).toEqual([]);
  expect((await read(characterOnly)).statements[words] ?? []).toEqual([]);
  const crossed = await fixture.createSubject('schema:Book', 'Crossed language and text versions');
  const en = measurement(words, '+1000000', m.word.id, record, time);
  const ja = measurement(words, '+1000001', m.character.id, record, time, {
    language: 'ja',
    text: digest('Controlled v2'),
    version: 'controlled-v2',
    scope: 'whole-holder',
  });
  // Compact multivalued statements retain both associations without successive replace adoptions.
  const tuples = await fixture.createSubject('schema:Book', 'Two complete measured versions', { [words]: [en, ja] });
  const actual = (await read(tuples)).statements[words]!;
  expect(actual).toHaveLength(2);
  for (const [tag, input] of [
    ['en', en],
    ['ja', ja],
  ] as const) {
    const tuple = actual.find((s) => s.qualifiers.some((q) => q.property.id === language && q.value.content === tag));
    expect(tuple).toMatchObject({ value: input.value, qualifiers: input.qualifiers });
  }
  const missingLanguage = structuredClone(ja);
  missingLanguage.qualifiers = missingLanguage.qualifiers!.filter((q) => q.property.id !== language);
  const missingText = structuredClone(en);
  missingText.qualifiers = missingText.qualifiers!.filter((q) => q.property.id !== textVersion);
  // Incomplete evidence may be retained, but cannot supply a complete measurement tuple.
  const incomplete = await fixture.createSubject('schema:Book', 'Split required associations', {
    [words]: [missingLanguage, missingText],
  });
  const partial = (await read(incomplete)).statements[words]!;
  expect(partial).toHaveLength(2);
  for (const [missing, input] of [
    [language, missingLanguage],
    [textVersion, missingText],
  ] as const) {
    const tuple = partial.find((s) => !s.qualifiers.some((q) => q.property.id === missing));
    expect(tuple).toMatchObject({ value: input.value, qualifiers: input.qualifiers });
  }
  expect((await read(crossed)).statements[words] ?? []).toEqual([]);
  // Grammar admission is separate from Source/index query conformance, which is not frozen.
  // Input grammar only: execution and current Source/index conformance are NOT YET FROZEN.
  const query = {
    and: [
      { type: { in: ['schema:Book'] } },
      {
        statement: {
          property: words,
          range: { gte: 1000001, unit: '1' },
          qualifiers: [
            { property: language, in: ['en'] },
            { property: textVersion, in: [digest(body)] },
            { property: scope, in: ['whole-holder'] },
            { property: method, in: [m.word.id] },
          ],
        },
      },
    ],
  };
  expect(validateFilter(query, fixture.release.definition), 'Required same-statement language/text admission').toEqual(
    [],
  );
}, 120_000);

test('controlled threshold values remain independent from proof of owned measurement input', async () => {
  const { producer } = await ownedMeasurement();
  const record = controlledRecord;
  for (const amount of ['+999999', '+1000000', '+1000001', '+0']) {
    const holder = await fixture.createSubject('schema:Book', `Controlled reported total ${amount}`);
    const input: StatementInput = {
      ...part(words, { amount, unit: '1' }),
      rank: 'preferred',
      qualifiers: [part(scope, 'whole-holder'), part(language, 'en'), part('schema:version', 'declared-total-v1')],
      references: [{ parts: [part('schema:url', record.url), part('schema:version', record.digest)] }],
    };
    const declaration: CountProducerInput = {
      kind: 'reported-total',
      holder: holder.id,
      producer: producer.id,
      language: 'en',
      version: { kind: 'declared', value: 'declared-total-v1' },
      coverage: { kind: 'whole-holder', included: ['declared serial body total'], excluded: ['editorial apparatus'] },
      declaration: {
        kind: 'serial-total',
        convention: 'Controlled producer-declared word total; no character conversion',
      },
      statement: {
        property: { id: 'schema:wordCount' },
        value: { type: 'value', content: { amount, unit: '1' } },
        qualifiers: input.qualifiers!,
        references: input.references!,
        rank: 'preferred',
      },
    };
    expect(producerInput.Check(declaration)).toBe(true);
    expect('digest' in declaration).toBe(false);
    expect('measuredAt' in declaration).toBe(false);
    expect('method' in declaration).toBe(false);
    // Real native authored citation and receipts; synthetic totals, not a million-word manuscript/provider.
    const evidence = await fixture.createSubject('schema:Book', `Controlled declared-total evidence ${amount}`);
    const citation = await authored(evidence, JSON.stringify(declaration));
    input.references = [{ parts: [part('schema:url', citation.url), part('schema:version', citation.digest)] }];
    const response = await propose(holder, input);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const value = await selected(holder, input);
    expect(value.qualifiers.some((q) => [textVersion, method, measuredAt].includes(q.property.id))).toBe(false);
    // A carrier plus summary is still not proof of native admitted producer binding.
    expect(fixture.sources.state).toBe('prerequisite');
    expect(BigInt(amount) > 1000000n).toBe(amount === '+1000001');
  }
}, 120_000);

test('negative fractional bounded and wrong-unit measurements are rejected after successful exact admission', async () => {
  const { m, time } = await ownedMeasurement();
  const holder = await fixture.createSubject('schema:Book', 'Controlled exact-admission rejection anchor');
  const record = controlledRecord;
  for (const property of [words, characters]) {
    const input = measurement(property, '+0', property === words ? m.word.id : m.character.id, record, time);
    await selected(holder, input);
    for (const invalid of [
      { amount: '-1', unit: '1' },
      { amount: '+0.5', unit: '1' },
      { amount: '+1', unit: 'http://www.wikidata.org/entity/Q7727' },
      { amount: '+1', unit: '1', lowerBound: '+0', upperBound: '+2' },
    ]) {
      const response = await propose(holder, { ...input, value: { type: 'value', content: invalid } });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    }
    expect(fact(await read(holder), property).value).toEqual(input.value);
  }
}, 120_000);

test('unknown unmeasured and withheld method or evidence never masquerade as measured zero', async () => {
  const { m, time } = await ownedMeasurement();
  const record = controlledRecord;
  for (const state of ['somevalue', 'novalue'] as const) {
    const holder = await fixture.createSubject('schema:Book', `Unknown measurement ${state}`);
    const input = { ...measurement(words, '+0', m.word.id, record, time), value: { type: state } };
    const value = await selected(holder, input);
    expect(value.value).toEqual({ type: state });
  }
  const input = measurement(words, '+1000001', m.word.id, record, time);
  const absent = await fixture.createSubject('schema:Book', 'Unmeasured body');
  expect((await read(absent)).statements[words] ?? []).toEqual([]);
  const noMethod = measurement(words, '+1000001', m.word.id, record, time);
  noMethod.qualifiers = noMethod.qualifiers!.filter((q) => q.property.id !== method);
  const incomplete = await fixture.createSubject('schema:Book', 'Method withheld evidence', { [words]: [noMethod] });
  expect(fact(await read(incomplete), words).qualifiers.some((q) => q.property.id === method)).toBe(false);
  const unknownMethod = structuredClone(input) as unknown as {
    [key: string]: unknown;
    qualifiers: { property: { id: string }; value: unknown }[];
  };
  unknownMethod.qualifiers = unknownMethod.qualifiers.map((q) =>
    q.property.id === method ? { ...q, value: { type: 'somevalue' } } : q,
  );
  const withheld = await propose(absent, unknownMethod as unknown as Input);
  expect(withheld.status, JSON.stringify(withheld.body)).toBe(201);
  // Merely proposed unknown evidence cannot become selected exact words.
  expect((await read(absent)).statements[words] ?? []).toEqual([]);
  const noSource = { ...input, references: [] };
  const rejected = await propose(absent, noSource);
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
  expect((await read(absent)).statements[words] ?? []).toEqual([]);
}, 120_000);

test('explicit zero identifies a genuinely empty measured realization rather than absence', async () => {
  const empty = '';
  expect(empty.match(/[A-Za-z]+/g) ?? []).toEqual([]);
  const time = new Date().toISOString();
  const m = await methods();
  const holder = await fixture.createSubject('schema:Book', 'Owned empty manuscript realization');
  const recordHolder = await fixture.createSubject('schema:Book', 'Owned empty measurement record');
  const emptyScope =
    'Entire explicitly empty manuscript body; no titles, parts, footnotes, appendices, markup, ruby or whitespace.';
  const record = await authored(
    recordHolder,
    JSON.stringify({
      holder: holder.id,
      text: empty,
      measuredText: digest(empty),
      language: 'en',
      scope: emptyScope,
      measuredAt: time,
      amount: '+0',
      unit: '1',
      method: m.word.id,
      definition: wordMethod,
      kind: 'trusted contributor measurement assertion',
    }),
  );
  await selected(
    holder,
    measurement(words, '+0', m.word.id, record, time, { text: digest(empty), scope: 'whole-holder' }),
  );
  const absent = await fixture.createSubject('schema:Book', 'No measurement exists');
  expect((await read(absent)).statements[words] ?? []).toEqual([]);
}, 120_000);
