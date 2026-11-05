import { expect, spyOn, test } from 'bun:test';
import { checkBatchWrite, type BatchCommand, type BatchStatement } from '@rezics/definitions/bulk';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import entity from './fixtures/imports/wikidata/entity.json';
import excluded from './fixtures/imports/wikidata/excluded.json';
import { loadWikidataDriver, type WikidataDriver } from './imports-wikidata-driver';
const SUBJECT = '00000000-0000-4000-8000-000000000001';
const context = { subjectId: SUBJECT };
function classMeaning(value: unknown) {
  expect(typeof value).toBe('string');
  return (value as string)
    .replace(/^schema:/, 'http://schema.org/')
    .replace(/^https:\/\/schema\.org\//, 'http://schema.org/');
}
const content = (value: BatchStatement['value']) => (value.type === 'value' ? value.content : undefined);

const author = '00000000-0000-8000-8000-000100000042';
const otherAuthor = '00000000-0000-8000-8000-000100000043';
const resolved = Object.freeze({ Q42: author });
const fresh = () => structuredClone(entity);

/** Resolve real output locations, never accept detached adapter-made values. */
function at<T = unknown>(raw: unknown, pointer: string): T {
  expect(pointer === '' || pointer.startsWith('/')).toBe(true);
  let current = raw;
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    expect(current !== null && typeof current === 'object').toBe(true);
    expect(Object.hasOwn(current as object, key)).toBe(true);
    current = (current as Record<string, unknown>)[key];
  }
  return current as T;
}
const inside = (parent: string, child: string) => expect(child.startsWith(`${parent}/`)).toBe(true);
function leaves(value: unknown): unknown[] {
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value];
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}
function checked(
  driver: WikidataDriver,
  raw: unknown,
  phase: 'bootstrap' | 'resolved' = 'resolved',
  revision = '24681012',
) {
  expect(driver.converter_revision.trim().length).toBeGreaterThan(0);
  const view = driver.observe(raw);
  expect(view.outcome).toBe('converted');
  expect(view.proposals.length).toBeGreaterThan(0);
  expect(new Set(view.proposals.map((p) => p.command)).size).toBe(view.proposals.length);
  const commands = view.proposals.map((p) => at<BatchCommand>(raw, p.command));
  expect(checkBatchWrite({ commands })).toEqual([]);
  expect(commands.filter((c) => c.op === 'create')).toHaveLength(phase === 'bootstrap' ? 1 : 0);
  if (phase === 'bootstrap') expect(commands).toHaveLength(1);
  for (const command of commands) {
    expect(command.source.field_group).toBe('facts');
    expect(command).not.toHaveProperty('rights');
    expect(command.source.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(command.source.record_revision).toBe(revision);
    expect(command.source).toMatchObject({
      source: 'wikidata',
      external_id: 'Q571',
      converter_revision: driver.converter_revision,
    });
    if (phase === 'bootstrap') {
      expect(command.op).toBe('create');
      expect(command.subject).not.toHaveProperty('id');
      expect(command.subject).not.toHaveProperty('statements');
      for (const key of Object.keys(command.subject))
        expect(['type', 'labels', 'descriptions', 'aliases']).toContain(key);
    } else {
      expect(command.op).toBe('propose');
      expect(command.subject).toBe(SUBJECT);
      for (const key of ['type', 'labels', 'descriptions', 'aliases']) expect(command).not.toHaveProperty(key);
    }
  }
  for (const proposal of view.proposals) {
    const command = at(raw, proposal.command);
    expect(command).toBeInstanceOf(Object);
    expect(proposal.fieldGroups.length).toBeGreaterThan(0);
    for (const pointer of proposal.fieldGroups) {
      inside(proposal.command, pointer);
      expect(at(raw, pointer)).toBe('facts');
    }
    if (phase === 'bootstrap') {
      expect(proposal.citations).toEqual([]);
      expect(proposal.statements).toEqual([]);
    } else {
      expect(proposal.citations.length).toBeGreaterThan(0);
      expect(proposal.statements).toEqual([`${proposal.command}/statement`]);
    }
    for (const cite of proposal.citations) {
      for (const [name, pointer] of Object.entries(cite)) {
        at(raw, pointer);
        if (name !== 'license') inside(proposal.command, pointer);
      }
      expect(at(raw, cite.reference)).toBeInstanceOf(Object);
      expect(at(raw, cite.source)).toBe('wikidata');
      expect(at(raw, cite.externalId)).toBe('Q571');
      expect(String(at(raw, cite.sourceRevision))).toBe(revision);
      expect(at(raw, cite.license)).toBe('CC0-1.0');
      const url = new URL(at<string>(raw, cite.url));
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('www.wikidata.org');
      expect(['/wiki/Q571', '/entity/Q571', '/wiki/Special:EntityData/Q571.json']).toContain(url.pathname);
    }
    if (phase === 'resolved') {
      for (const key of ['labels', 'descriptions', 'aliases', 'subjectType'] as const)
        expect(proposal[key]).toBeUndefined();
    }
    for (const pointer of [
      proposal.labels,
      proposal.descriptions,
      proposal.aliases,
      proposal.subjectType,
      ...proposal.statements,
    ])
      if (pointer !== undefined) inside(proposal.command, pointer);
    for (const pointer of proposal.statements) {
      const statement = at<BatchStatement>(raw, pointer);
      const actual = at<BatchCommand>(raw, proposal.command);
      expect(actual.op).toBe('propose');
      if (actual.op !== 'propose') throw new Error('Every source statement must be a resolved proposal');
      expect(pointer).toBe(`${proposal.command}/statement`);
      expect(actual.statement).toEqual(statement);
    }
    // Structural acceptance must consume the very proposals inspected above.
    const accepted = driver.accept(command);
    expect<unknown>(accepted.command).toEqual(command);
    expect(accepted.citations).toEqual(proposal.citations.map((c) => at(raw, c.reference)));
  }
  return view;
}
function statements(driver: WikidataDriver, raw: unknown): BatchStatement[] {
  return checked(driver, raw).proposals.flatMap((p) => p.statements.map((pointer) => at<BatchStatement>(raw, pointer)));
}
function invalid(driver: WikidataDriver, input: unknown) {
  const raw = driver.convert(input, resolved, context);
  const view = driver.observe(raw);
  expect(view.outcome).toBe('invalid');
  expect(view.proposals).toEqual([]);
  expect(view.diagnostics.length).toBeGreaterThan(0);
  for (const diagnostic of view.diagnostics) {
    expect(diagnostic.code.trim().length).toBeGreaterThan(0);
    expect(diagnostic.pointer === '' || diagnostic.pointer.startsWith('/')).toBe(true);
  }
}

test('Mapped Wikidata facts and terms are cited command proposals accepted by the semantic consumer', async () => {
  const driver = await loadWikidataDriver();
  const raw = driver.convert(fresh(), resolved, context);
  checked(driver, raw);
  const bootstrap = driver.convert(fresh(), resolved);
  const bootstrapView = checked(driver, bootstrap, 'bootstrap');
  expect(
    bootstrapView.proposals.flatMap((p) =>
      p.subjectType === undefined ? [] : [classMeaning(at(bootstrap, p.subjectType))],
    ),
  ).toEqual(['http://schema.org/Book']);
  for (const [field, expected] of Object.entries({
    labels: { en: 'The Example Book', 'en-GB': 'Example Book' },
    descriptions: { en: 'A synthetic book work for conversion tests' },
    aliases: { en: ['Example Volume'] },
  })) {
    const pointers = bootstrapView.proposals.flatMap((p) => {
      const pointer = p[field as 'labels' | 'descriptions' | 'aliases'];
      return pointer === undefined ? [] : [pointer];
    });
    expect(pointers).toHaveLength(1);
    expect(at(bootstrap, pointers[0]!)).toEqual(expected);
  }
  const facts = statements(driver, raw);
  expect(facts.filter((s) => s.property.id === 'schema:name').map((s) => s.value)).toEqual([
    { type: 'value', content: { language: 'en', text: 'The Example Book' } },
    { type: 'value', content: { language: 'en-GB', text: 'Example Book' } },
  ]);
  expect(facts.map((s) => s.property.id).sort()).toEqual([
    'schema:author',
    'schema:author',
    'schema:datePublished',
    'schema:name',
    'schema:name',
    'schema:url',
  ]);
  expect(facts.find((s) => s.property.id === 'schema:url')?.value).toEqual({
    type: 'value',
    content: 'https://books.example.org/example',
  });
  expect(facts.find((s) => s.property.id === 'schema:datePublished')?.value).toEqual({
    type: 'value',
    content: {
      time: '+2001-02-03T00:00:00Z',
      timezone: 0,
      before: 0,
      after: 0,
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    },
  });
});

test('Supported qualifier reference URL and preferred rank survive on the mapped author statement', async () => {
  const driver = await loadWikidataDriver();
  const facts = statements(driver, driver.convert(fresh(), resolved, context));
  const authors = facts.filter((s) => s.property.id === 'schema:author' && s.value.type === 'value');
  expect(authors).toHaveLength(1);
  expect(authors[0]).toMatchObject({
    rank: 'preferred',
    value: { type: 'value', content: author },
    qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '1' } }],
  });
  expect(authors[0]!.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            property: expect.objectContaining({ id: 'schema:url' }),
            value: { type: 'value', content: 'https://catalogue.example.org/books/example' },
          }),
        ]),
      }),
    ]),
  );
});

test('Changed supported source values flow into proposals instead of returning a fabricated fixture snapshot', async () => {
  const driver = await loadWikidataDriver();
  const changed = fresh();
  changed.labels.en.value = 'Another Example Book';
  changed.aliases.en[0]!.value = 'Another Volume';
  changed.descriptions.en.value = 'A changed description';
  changed.claims.P856[0]!.mainsnak.datavalue.value = 'https://books.example.org/changed';
  changed.claims.P577[0]!.mainsnak.datavalue.value.time = '+2002-03-04T00:00:00Z';
  const sourceAuthor = changed.claims.P50[0]!;
  sourceAuthor.rank = 'normal';
  sourceAuthor.qualifiers!.P1545[0]!.datavalue.value = '2';
  sourceAuthor.references![0]!.snaks.P854[0]!.datavalue.value = 'https://catalogue.example.org/books/changed';
  const raw = driver.convert(changed, resolved, context);
  checked(driver, raw);
  const bootstrap = driver.convert(structuredClone(changed), resolved);
  const bootstrapView = checked(driver, bootstrap, 'bootstrap');
  for (const [field, expected] of Object.entries({
    labels: { en: 'Another Example Book', 'en-GB': 'Example Book' },
    aliases: { en: ['Another Volume'] },
    descriptions: { en: 'A changed description' },
  })) {
    expect(
      bootstrapView.proposals.flatMap((p) => {
        const pointer = p[field as 'labels' | 'aliases' | 'descriptions'];
        return pointer === undefined ? [] : [at(bootstrap, pointer)];
      }),
    ).toEqual([expected]);
  }
  const facts = statements(driver, raw);
  expect(facts).toHaveLength(6);
  expect(facts.filter((s) => s.property.id === 'schema:name').map((s) => s.value)).toEqual([
    { type: 'value', content: { language: 'en', text: 'Another Example Book' } },
    { type: 'value', content: { language: 'en-GB', text: 'Example Book' } },
  ]);
  expect(content(facts.find((s) => s.property.id === 'schema:url')!.value)).toBe('https://books.example.org/changed');
  expect(content(facts.find((s) => s.property.id === 'schema:datePublished')!.value)).toMatchObject({
    time: '+2002-03-04T00:00:00Z',
  });
  const original = driver.convert(fresh(), resolved, context);
  const digests = (output: unknown) =>
    driver.observe(output).proposals.map((p) => at<BatchCommand>(output, p.command).source.digest);
  expect(digests(raw)).not.toEqual(digests(original));
  const titleOnly = fresh();
  titleOnly.labels.en.value = 'Changed title only';
  const edited = driver.convert(titleOnly, resolved, context);
  expect(digests(edited)).not.toEqual(digests(original));
  expect(
    statements(driver, edited)
      .filter((s) => s.property.id === 'schema:name')
      .map((s) => s.value),
  ).toEqual([
    { type: 'value', content: { language: 'en', text: 'Changed title only' } },
    { type: 'value', content: { language: 'en-GB', text: 'Example Book' } },
  ]);
  const mappedAuthor = facts.find((s) => s.property.id === 'schema:author')!;
  expect(mappedAuthor).toMatchObject({
    rank: 'normal',
    value: { type: 'value', content: author },
    qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }],
  });
  expect(mappedAuthor.references!.flatMap((r) => r.parts).map((p) => content(p.value))).toContain(
    'https://catalogue.example.org/books/changed',
  );
});

test('Unknown Wikidata properties cannot invent schema fields or carry their sentinel into proposals', async () => {
  const driver = await loadWikidataDriver();
  const raw = driver.convert(fresh(), resolved, context);
  const facts = statements(driver, raw);
  expect(facts).toHaveLength(6);
  expect(
    facts.every((s) => ['schema:author', 'schema:datePublished', 'schema:name', 'schema:url'].includes(s.property.id)),
  ).toBe(true);
  for (const p of checked(driver, raw).proposals) {
    expect(leaves(at(raw, p.command))).not.toContain('UNKNOWN_PROPERTY_SENTINEL');
    expect(leaves(at(raw, p.command))).not.toContain('P999999');
  }
  const clean = fresh();
  delete (clean.claims as Partial<typeof clean.claims>).P999999;
  expect(driver.convert(clean, resolved, context)).toEqual(raw);
});

test('Only supplied entity resolutions become REZICS relations and unresolved entities never acquire invented IDs', async () => {
  const driver = await loadWikidataDriver();
  const missing = statements(driver, driver.convert(fresh(), {}, context));
  const unresolved = missing.filter((s) => s.property.id === 'schema:author');
  expect(unresolved).toHaveLength(2);
  expect(unresolved.map((s) => s.value)).toEqual([{ type: 'somevalue' }, { type: 'somevalue' }]);
  for (const [index, key] of ['Q42', 'Q999999999'].entries()) {
    expect(unresolved[index]!.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: { id: 'schema:sameAs' },
          value: { type: 'value', content: `http://www.wikidata.org/entity/${key}` },
        }),
      ]),
    );
    // P6298 identifies a Bangumi person, never a Wikidata entity.
    expect(unresolved[index]!.qualifiers?.some((q) => q.property.id === 'wdt:P6298')).toBe(false);
    expect(JSON.stringify(unresolved[index]!.references)).toContain(key);
  }
  const one = statements(driver, driver.convert(fresh(), resolved, context));
  expect(one.filter((s) => s.property.id === 'schema:author' && s.value.type === 'value').map((s) => s.value)).toEqual([
    { type: 'value', content: author },
  ]);
  const both = statements(driver, driver.convert(fresh(), { ...resolved, Q999999999: otherAuthor }, context));
  expect(
    both
      .filter((s) => s.property.id === 'schema:author')
      .map((s) => content(s.value))
      .sort(),
  ).toEqual([author, otherAuthor]);
});

test('Revision citations track the exact entity revision while converter revision remains explicit and stable', async () => {
  const driver = await loadWikidataDriver();
  const revision = driver.converter_revision;
  const first = driver.convert(fresh(), resolved, context);
  checked(driver, first);
  const changed = fresh();
  changed.lastrevid = 24681013;
  const second = driver.convert(changed, resolved, context);
  const view = checked(driver, second, 'resolved', '24681013');
  for (const p of view.proposals) {
    expect(p.citations.length).toBeGreaterThan(0);
    for (const c of p.citations) expect(String(at(second, c.sourceRevision))).toBe('24681013');
    expect(driver.accept(at(second, p.command)).citations).toEqual(p.citations.map((c) => at(second, c.reference)));
  }
  expect(second).not.toEqual(first);
  expect(driver.converter_revision).toBe(revision);
});

test('Conversion is synchronous deterministic and does not mutate input or perform ambient I/O', async () => {
  const driver = await loadWikidataDriver();
  const input = fresh();
  const before = structuredClone(input);
  freeze(input);
  const deny = () => {
    throw new Error('Pure conversion attempted ambient I/O or nondeterminism');
  };
  const guards = [
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(deny, { preconnect: deny })),
    spyOn(Date, 'now').mockImplementation(deny),
    spyOn(Math, 'random').mockImplementation(deny),
    spyOn(Bun, 'file').mockImplementation(deny),
    spyOn(Bun, 'write').mockImplementation(deny),
    spyOn(Bun, 'spawn').mockImplementation(deny),
    spyOn(Bun, 'spawnSync').mockImplementation(deny),
    spyOn(Bun, 'connect').mockImplementation(deny),
    spyOn(fs, 'readFileSync').mockImplementation(deny),
    spyOn(fs, 'writeFileSync').mockImplementation(deny),
    spyOn(fsp, 'readFile').mockImplementation(deny),
    spyOn(fsp, 'writeFile').mockImplementation(deny),
  ];
  let expected: unknown;
  let again: unknown;
  try {
    expected = driver.convert(input, resolved, context);
    again = driver.convert(input, resolved, context);
  } finally {
    guards.forEach((g) => g.mockRestore());
  }
  checked(driver, expected);
  expect(expected).not.toBeInstanceOf(Promise);
  expect(again).not.toBeInstanceOf(Promise);
  expect(again).toEqual(expected);
  expect(input).toEqual(before);
  expect(resolved).toEqual({ Q42: author });
  expect(driver.convert(fresh(), resolved, context)).toEqual(expected);
});

test('User and talk pages account records and private extensions produce no imported text', async () => {
  const driver = await loadWikidataDriver();
  for (const page of excluded) {
    const raw = driver.convert(structuredClone(page), resolved, context);
    const view = driver.observe(raw);
    expect(['ignored', 'invalid']).toContain(view.outcome);
    expect(view.proposals).toEqual([]);
  }
  const dirty = driver.convert(fresh(), resolved, context);
  const clean = fresh();
  const { posts: _posts, account: _account, ...entityOnly } = clean;
  const safe = driver.convert(entityOnly, resolved, context);
  const commands = (raw: unknown) => checked(driver, raw).proposals.map((p) => at(raw, p.command));
  expect(commands(dirty)).toEqual(commands(safe));
  expect(dirty).toEqual(safe);
  expect(
    driver.convert(
      {
        ...entityOnly,
        future_extension: { text: 'UNKNOWN_PRIVATE_SENTINEL', rights: 'CC0-1.0', converter_revision: 'forged' },
      },
      resolved,
      context,
    ),
  ).toEqual(safe);
  expect(statements(driver, dirty)).toHaveLength(6);
});

test('Malformed entities IDs revisions and mainsnaks reject clearly without command proposals', async () => {
  const driver = await loadWikidataDriver();
  for (const input of [
    null,
    [],
    {},
    'not an entity',
    ...['', 'Q0', 'Q-1', 'q571', 'Q571/../../User:Example', 'P571'].map((id) => ({ ...fresh(), id })),
    { ...fresh(), type: 'property' },
    { ...fresh(), lastrevid: -1 },
    { ...fresh(), lastrevid: 'not-a-revision' },
    { ...fresh(), lastrevid: null },
    { ...fresh(), lastrevid: 1.5 },
    { ...fresh(), claims: [] },
  ])
    invalid(driver, input);
  const broken = fresh();
  delete (broken.claims.P856[0]!.mainsnak as Partial<(typeof broken.claims.P856)[0]['mainsnak']>).datavalue;
  invalid(driver, broken);
});

test('Unsafe mapped URLs and reference URLs reject without proposals or unsafe citations', async () => {
  const driver = await loadWikidataDriver();
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,PRIVATE_TEXT_SENTINEL',
    'file:///etc/passwd',
    'https://user:secret@example.org/',
    'https://example.org/\r\nX-Injected:yes',
  ]) {
    const main = fresh();
    main.claims.P856[0]!.mainsnak.datavalue.value = url;
    invalid(driver, main);
    const reference = fresh();
    reference.claims.P50[0]!.references![0]!.snaks.P854[0]!.datavalue.value = url;
    invalid(driver, reference);
  }
});

test('The semantic consumer rejects empty and SQL-shaped output instead of fabricating acceptance', async () => {
  const driver = await loadWikidataDriver();
  checked(driver, driver.convert(fresh(), resolved, context));
  for (const command of [null, {}, [], { sql: 'INSERT INTO subjects DEFAULT VALUES' }, { proposals: [] }])
    expect(() => driver.accept(command)).toThrow();
});

test('WD-only author translator work and publisher use canonical sameAs identity until resolved', async () => {
  const driver = await loadWikidataDriver();
  for (const [source, target] of [
    ['P50', 'schema:author'],
    ['P655', 'schema:translator'],
    ['P629', 'schema:exampleOfWork'],
    ['P123', 'schema:publisher'],
  ] as const) {
    const input = fresh();
    const claim = structuredClone(input.claims.P50[0]!);
    claim.mainsnak.property = source;
    const claims: Record<string, unknown> = input.claims;
    delete claims.P50;
    claims[source] = [claim];
    const missing = statements(driver, driver.convert(input, {}, context)).filter((s) => s.property.id === target);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.value).toEqual({ type: 'somevalue' });
    expect(missing[0]!.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: { id: 'schema:sameAs' },
          value: {
            type: 'value',
            content: 'http://www.wikidata.org/entity/Q42',
          },
        }),
      ]),
    );
    expect(JSON.stringify(missing[0]!.references)).toContain('Q42');
    const native = statements(driver, driver.convert(input, resolved, context)).filter((s) => s.property.id === target);
    expect(native.map((s) => s.value)).toEqual([{ type: 'value', content: author }]);
    const noIdentity = structuredClone(input);
    const noIdentityClaims: Record<string, unknown> = noIdentity.claims;
    noIdentityClaims[source] = [
      {
        ...claim,
        mainsnak: {
          snaktype: 'somevalue',
          property: source,
          datatype: 'wikibase-item',
        },
      },
    ];
    expect(statements(driver, driver.convert(noIdentity, {}, context)).filter((s) => s.property.id === target)).toEqual(
      [],
    );
  }
});

test('Wikidata month precision stays a cited month without inventing a day', async () => {
  const driver = await loadWikidataDriver();
  const input = fresh();
  input.claims.P577[0]!.mainsnak.datavalue.value.time = '+1980-05-00T00:00:00Z';
  input.claims.P577[0]!.mainsnak.datavalue.value.precision = 10;
  const facts = statements(driver, driver.convert(input, resolved, context));
  expect(facts.filter((s) => s.property.id === 'schema:datePublished').map((s) => s.value)).toEqual([
    {
      type: 'value',
      content: {
        time: '+1980-05-00T00:00:00Z',
        timezone: 0,
        before: 0,
        after: 0,
        precision: 10,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      },
    },
  ]);
});
