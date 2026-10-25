import { expect, spyOn, test } from 'bun:test';
import { checkBatchWrite, type BatchCommand, type BatchReference } from '@rezics/definitions/bulk';
import type { CoverCredit, CoverProvenance, MediaImportRequest } from '@rezics/definitions/media-import';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { loadOpenLibraryDriver } from './imports-open-library-driver';
import type {
  Conversion,
  FieldObservation,
  OpenLibraryDriver,
  RecordPayload,
  ConversionContext,
} from './imports-open-library-driver';

const SUBJECT = '00000000-0000-4000-8000-000000000001';
const AUTHOR = '00000000-0000-4000-8000-000000000002';
const WORK = '00000000-0000-4000-8000-000000000003';
const MEDIA = '00000000-0000-4000-8000-000000000004';
const context = { subjectId: SUBJECT };

async function fixture(name: string): Promise<RecordPayload> {
  return Bun.file(new URL(`./fixtures/imports/open-library/${name}.json`, import.meta.url)).json();
}
function pointer(root: unknown, path: string): unknown {
  expect(path.startsWith('/')).toBe(true);
  return path
    .slice(1)
    .split('/')
    .reduce<unknown>((node, token) => {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
      expect(node !== null && typeof node === 'object').toBe(true);
      expect(Object.hasOwn(node as object, key)).toBe(true);
      return (node as Record<string, unknown>)[key];
    }, root);
}
function nonempty(value: unknown) {
  expect(typeof value).toBe('string');
  expect((value as string).trim().length).toBeGreaterThan(0);
}
function freeze(record: unknown): void {
  if (record && typeof record === 'object') {
    Object.values(record).forEach(freeze);
    Object.freeze(record);
  }
}
function recordIdentifier(key: unknown) {
  return (key as string).replace(/^\/(?:works|books)\//, '');
}
function sourceDay(record: RecordPayload) {
  return {
    time: `+${(record.last_modified as { value: string }).value.slice(0, 10)}T00:00:00Z`,
    precision: 11,
    calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
  };
}
function recordCitation(reference: BatchReference, record: RecordPayload) {
  const parts = [
    ['schema:url', `https://openlibrary.org${record.key}`],
    ['wdt:P648', recordIdentifier(record.key)],
    ['schema:version', String(record.revision)],
    ['schema:dateModified', sourceDay(record)],
  ].map(([id, content]) => ({ property: { id }, value: { type: 'value', content } }));
  expect(reference.parts).toHaveLength(4);
  expect(reference.parts).toEqual(expect.arrayContaining(parts));
}
function converted(driver: OpenLibraryDriver, record: RecordPayload, supplied: ConversionContext | null = context) {
  const result = supplied === null ? driver.convert(record) : driver.convert(record, supplied);
  expect(result.outcome).toBe('converted');
  nonempty(driver.converter_revision);
  expect(result.converter_revision).toBe(driver.converter_revision);
  expect(Array.isArray(result.proposals)).toBe(true);
  expect(result.proposals.length).toBeGreaterThan(0);
  const proposed = structuredClone(result.proposals);
  expect(checkBatchWrite({ commands: proposed })).toEqual([]);
  expect(proposed.filter((c) => c.op === 'create')).toHaveLength(supplied === null ? 1 : 0);
  if (supplied === null) expect(proposed).toHaveLength(1);
  for (const command of proposed) {
    if (supplied === null) {
      expect(command.op).toBe('create');
      expect(command.source.field_group).toBe('facts');
      expect(command.subject).not.toHaveProperty('id');
      expect(command.subject).not.toHaveProperty('statements');
      for (const key of Object.keys(command.subject))
        expect(['type', 'labels', 'descriptions', 'aliases']).toContain(key);
    } else {
      expect(command.op).toBe('propose');
      expect(command.subject).toBe(supplied.subjectId);
      for (const key of ['type', 'labels', 'descriptions', 'aliases']) expect(command).not.toHaveProperty(key);
    }
    expect(command.source.source).toBe('open-library');
    expect<unknown>(command.source.external_id).toBe(record.key);
    expect(command.source.record_revision).toBe(String(record.revision));
    const statements = command.op === 'propose' ? [command.statement] : [];
    for (const statement of statements) {
      expect(['schema:identifier', 'schema:version', 'schema:dateModified']).not.toContain(statement.property.id);
      expect(statement.qualifiers?.some((part) => part.property.id === 'schema:identifier') ?? false).toBe(false);
      expect(statement.references).toHaveLength(1);
      recordCitation(statement.references[0]!, record);
    }
    expect(command.source.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(command.source.converter_revision).toBe(driver.converter_revision);
    if (command.source.field_group === 'facts') expect(command).not.toHaveProperty('rights');
  }
  const metadata = driver.inspectMetadata(result);
  expect(String(pointer(result, metadata.bibliographyPermission))).toMatch(/CC0|public.domain|bibliograph/i);
  const consumed = driver.consume(result.proposals);
  expect(result.proposals).toEqual(proposed);
  expect(consumed.accepted).toEqual(proposed);
  if (supplied === null) expect(consumed.fields).toEqual([]);
  else expect(consumed.fields.length).toBeGreaterThan(0);
  for (const field of consumed.fields) {
    const command = consumed.accepted[field.command];
    expect(Number.isInteger(field.command) && field.command >= 0).toBe(true);
    expect(command !== null && typeof command === 'object').toBe(true);
    if (!command) throw new Error('Field must locate an actual command');
    expect(pointer(command, field.valuePath)).toBeDefined();
    expect(pointer(command, field.groupPath)).toBe(
      field.kind === 'cover' ? 'cover' : field.kind === 'description' ? 'summary' : 'facts',
    );
    const ref = field.reference;
    const reference = pointer(command, ref.path) as BatchReference;
    expect(command.op).toBe('propose');
    expect(ref.path).toMatch(/^\/statement\/references\/\d+$/);
    recordCitation(reference, record);
    for (const [path, property] of [
      [ref.keyPath, 'wdt:P648'],
      [ref.urlPath, 'schema:url'],
      [ref.revisionPath, 'schema:version'],
      [ref.lastModifiedPath, 'schema:dateModified'],
    ]) {
      const index = reference.parts.findIndex((part) => part.property.id === property);
      expect(path).toBe(`${ref.path}/parts/${index}/value/content`);
    }
    for (const path of [ref.keyPath, ref.urlPath, ref.revisionPath, ref.lastModifiedPath]) {
      expect(path.startsWith(`${ref.path}/`)).toBe(true);
    }
    expect(pointer(command, ref.keyPath)).toBe(recordIdentifier(record.key));
    expect(pointer(command, ref.urlPath)).toBe(`https://openlibrary.org${record.key}`);
    expect(command.source.record_revision).toBe(String(record.revision));
    expect(pointer(command, ref.revisionPath)).toBe(String(record.revision));
    expect(pointer(command, ref.lastModifiedPath)).toEqual(sourceDay(record));
    if (field.sourceValuePath !== undefined) {
      pointer(command, field.sourceValuePath);
      expect(
        field.sourceValuePath.startsWith(`${ref.path}/`) ||
          (field.statementPath !== undefined && field.sourceValuePath.startsWith(`${field.statementPath}/qualifiers/`)),
      ).toBe(true);
    }
    if (field.kind === 'title' || field.kind === 'isbn13' || field.kind === 'publishDate') {
      expect(command.op).toBe('propose');
      if (command.op !== 'propose') throw new Error('Mapped facts must be source candidates');
      expect(command.statement.property.id).toBe(
        field.kind === 'title' ? 'schema:name' : field.kind === 'isbn13' ? 'schema:isbn' : 'schema:datePublished',
      );
      expect(command.statement.value.type).toBe('value');
      if (field.kind === 'title') {
        expect(field.valuePath).toBe('/statement/value/content/text');
        expect(command.statement.value).toEqual({
          type: 'value',
          content: {
            language: expect.any(String),
            text: pointer(command, field.valuePath),
          },
        });
      }
    }
    if (field.kind === 'author' || field.kind === 'work') {
      nonempty(field.statementPath);
      nonempty(field.sourceValuePath);
      const statement = pointer(command, field.statementPath!) as import('@rezics/definitions/bulk').BatchStatement;
      expect(pointer(command, field.valuePath)).toEqual(statement.value);
      expect(statement.qualifiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: { id: 'wdt:P648' },
            value: {
              type: 'value',
              content: pointer(command, field.sourceValuePath!),
            },
          }),
        ]),
      );
    }
  }
  return { result, ...consumed };
}
type Accepted = ReturnType<typeof converted>;
function values(output: Accepted, kind: FieldObservation['kind']) {
  return output.fields
    .filter((field) => field.kind === kind)
    .map((field) => pointer(output.accepted[field.command], field.valuePath));
}
function relationshipSource(output: Accepted, kind: 'author' | 'work', identifier: string) {
  const fields = output.fields.filter((field) => field.kind === kind);
  expect(fields.map((field) => pointer(output.accepted[field.command], field.sourceValuePath!))).toEqual([identifier]);
  for (const field of fields) {
    const statement = pointer(
      output.accepted[field.command],
      field.statementPath!,
    ) as import('@rezics/definitions/bulk').BatchStatement;
    const key = output.accepted[field.command]!.source.external_id;
    expect(statement.references).toHaveLength(1);
    expect(statement.references[0]!.parts).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P648' }, value: { type: 'value', content: recordIdentifier(key) } },
        { property: { id: 'schema:url' }, value: { type: 'value', content: `https://openlibrary.org${key}` } },
      ]),
    );
  }
}
function noProposals(result: Conversion) {
  expect(['skipped', 'rejected']).toContain(result.outcome);
  nonempty(result.converter_revision);
  expect(result.proposals).toEqual([]);
  nonempty(result.reason);
}
function rejected(result: Conversion) {
  expect(result.outcome).toBe('rejected');
  noProposals(result);
}

test('Open Library citations use the released source identifier and reference-only revision/date terms', async () => {
  const driver = await loadOpenLibraryDriver();
  const output = converted(driver, await fixture('work'));
  expect(values(output, 'identity')).toEqual(['/works/OL900000001W']);
  expect(values(output, 'title')).toEqual(['The Glass Atlas']);
  expect(values(output, 'author')).toEqual([{ type: 'somevalue' }]);
  relationshipSource(output, 'author', 'OL900000001A');
  expect(values(output, 'isbn10')).toEqual([]);
  expect(values(output, 'isbn13')).toEqual([]);
  expect(values(output, 'publishDate')).toEqual([]);
});

test('edition remains distinct from work and preserves ISBN authors and source date precision', async () => {
  const driver = await loadOpenLibraryDriver();
  const output = converted(driver, await fixture('edition'));
  expect(values(output, 'identity')).toEqual(['/books/OL900000002M']);
  expect(values(output, 'work')).toEqual([{ type: 'somevalue' }]);
  relationshipSource(output, 'work', 'OL900000001W');
  expect(values(output, 'title')).toEqual(['The Glass Atlas: Pocket Edition']);
  expect(values(output, 'author')).toEqual([{ type: 'somevalue' }]);
  relationshipSource(output, 'author', 'OL900000001A');
  // Both source ISBN forms identify the same ISBN-13 candidate.
  expect(values(output, 'isbn10')).toEqual([]);
  expect(values(output, 'isbn13')).toEqual(['9780306406157']);
  expect(values(output, 'publishDate')).toEqual([
    { time: '+1980-05-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  ]);
  const date = output.fields.find((f) => f.kind === 'publishDate')!;
  expect(pointer(output.accepted[date.command], date.reference.keyPath)).toBe('OL900000002M');
  expect(JSON.stringify(output.accepted)).not.toContain('May 1980');
});

test('Open Library distinguishes edition bootstrap and actual independent unknown asset rights', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  const output = converted(driver, record);
  // An unknown licence cannot authorize a summary command. Preserve the source
  // description as non-command metadata without assigning catalogue database rights.
  expect(values(output, 'description')).toEqual([]);
  expect(output.result.proposals.some((c) => c.source.field_group === 'summary')).toBe(false);
  expect(output.accepted.some((c) => c.op === 'propose' && c.statement.property.id === 'schema:abstract')).toBe(false);
  const metadata = driver.inspectMetadata(output.result);
  const description = metadata.assets.filter((a) => a.kind === 'description');
  const covers = metadata.assets.filter((a) => a.kind === 'cover');
  expect(description).toHaveLength(1);
  expect(covers).toHaveLength(1);
  expect(pointer(output.result, description[0]!.value)).toBe((record.description as { value: string }).value);
  const cover = covers[0]!;
  const sourceUrl = pointer(output.result, cover.value) as string;
  expect(sourceUrl).toMatch(/^https:\/\/covers\.openlibrary\.org\/b\/id\/900000001-[SML]\.jpg$/);
  expect<unknown[]>([null, 'LicenseRef-unknown']).toContain(pointer(output.result, description[0]!.license));
  const credit = pointer(output.result, cover.credit!) as CoverCredit;
  nonempty(credit.rightsHolder);
  expect(credit.rightsHolder).toMatch(/rights[ -]?holder/i);
  expect(credit.via.name).toBe('Open Library');
  expect(credit.via.url).toBe(`https://openlibrary.org${record.key}`);
  expect(cover.license).toBe(`${cover.credit}/license`);
  expect(pointer(output.result, cover.license)).toBe('LicenseRef-unknown');
  expect(credit.license).toBe('LicenseRef-unknown');
  expect(credit.obligations).toEqual([]);
  const provenance = pointer(output.result, cover.provenance!) as CoverProvenance;
  expect(provenance).toMatchObject({ ...output.accepted[0]!.source, field_group: 'cover' });
  expect(provenance.references).toHaveLength(1);
  recordCitation(provenance.references[0]!, record);
  expect(pointer(output.result, cover.role!)).toBe('cover');
  expect(pointer(output.result, cover.takedownEligible!)).toBe(true);
  expect(values(output, 'cover')).toEqual([]);
  const title = output.fields.find((f) => f.kind === 'title')!;
  const factGroup = pointer(output.accepted[title.command], title.groupPath);
  expect(pointer(output.result, description[0]!.group)).toBe('summary');
  expect(pointer(output.result, cover.group)).toBe('cover');
  expect(pointer(output.result, description[0]!.group)).not.toEqual(factGroup);
  expect(pointer(output.result, cover.group)).not.toEqual(factGroup);
  expect(pointer(output.result, cover.group)).not.toEqual(pointer(output.result, description[0]!.group));
  const final = converted(driver, record, { subjectId: SUBJECT, mediaIds: { [sourceUrl]: MEDIA } });
  expect(values(final, 'cover')).toEqual([MEDIA]);
  const finalCover = driver.inspectMetadata(final.result).assets.find((a) => a.kind === 'cover')!;
  for (const key of ['license', 'credit', 'provenance', 'role', 'takedownEligible'] as const) {
    expect(pointer(final.result, finalCover[key]!)).toEqual(pointer(output.result, cover[key]!));
  }
  expect(final.result.proposals.some((c) => c.source.field_group === 'summary')).toBe(false);
  expect(values(final, 'description')).toEqual([]);
  expect(final.accepted.some((c) => c.op === 'propose' && c.statement.property.id === 'schema:abstract')).toBe(false);
  const field = final.fields.find((f) => f.kind === 'cover')!;
  expect(final.accepted[field.command]).toMatchObject({
    op: 'propose',
    subject: SUBJECT,
    source: { field_group: 'cover' },
    statement: { property: { id: 'schema:image' }, value: { type: 'value', content: MEDIA } },
  });
  expect(final.accepted[field.command]).not.toHaveProperty('rights');
  const command = final.accepted[field.command]!;
  if (command.op !== 'propose') throw new Error('Expected cover proposal');
  const request = pointer(output.result, cover.mediaImportRequest!) as Omit<MediaImportRequest, 'containerId'>;
  expect(cover.value).toBe(`${cover.mediaImportRequest}/sourceUrl`);
  expect(request.sourceUrl).toBe(sourceUrl);
  expect(request.credit).toEqual(credit);
  expect(request.provenance).toEqual(provenance);
  expect(request.provenance.references).toHaveLength(1);
  recordCitation(request.provenance.references[0]!, record);
  // Content's API acceptance, not this pure suite, proves upload/re-encoding.
});

test('missing optional data creates no authors ISBN dates descriptions or covers', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('edition');
  for (const key of ['authors', 'isbn_10', 'isbn_13', 'publish_date', 'publishers', 'works', 'notes'])
    delete record[key];
  const output = converted(driver, record);
  expect(values(output, 'identity')).toEqual([record.key]);
  expect(values(output, 'title')).toEqual([record.title]);
  for (const kind of ['author', 'work', 'isbn10', 'isbn13', 'publishDate', 'description', 'cover'] as const) {
    expect(values(output, kind)).toEqual([]);
  }
});

test('lists accounts authors redirects and other non-book records emit no proposals', async () => {
  const driver = await loadOpenLibraryDriver();
  const records = await Bun.file(new URL('./fixtures/imports/open-library/excluded.json', import.meta.url)).json();
  for (const record of records) noProposals(driver.convert(record));
  for (const [type, key] of [
    ['/type/author', '/authors/OL900000001A'],
    ['/type/redirect', '/books/OL900000002M'],
    ['/type/post', '/people/example/posts/1'],
  ]) {
    noProposals(driver.convert({ ...(await fixture('work')), type: { key: type }, key }));
  }
});

test('book records never disclose unknown private user post or account fields', async () => {
  const driver = await loadOpenLibraryDriver();
  for (const name of ['work', 'edition']) {
    const record = await fixture(name);
    const clean = structuredClone(record);
    for (const key of ['private_notes', 'user_posts', 'account', 'notes']) delete clean[key];
    const output = converted(driver, record);
    expect(output.result).toEqual(converted(driver, clean).result);
    expect(
      converted(driver, {
        ...clean,
        future_extension: { text: 'UNKNOWN_PRIVATE_SENTINEL', license: 'CC0-1.0', converter_revision: 'forged' },
      }).result,
    ).toEqual(output.result);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE_TEXT_SENTINEL|USER_POST_SENTINEL|ACCOUNT_SENTINEL/);
  }
});

test('malformed keys type-key mismatches and unsafe relationship identifiers reject without proposals', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  for (const key of [
    '/works/OLoopsW',
    '/works/OL123M',
    '/books/OL123M',
    '/works/OL1W/../people/private',
    'https://evil.example/works/OL1W',
    '/works/OL1W?private=1',
  ]) {
    rejected(driver.convert({ ...record, key }));
  }
  rejected(driver.convert({ ...record, authors: [{ author: { key: 'javascript:alert(1)' } }] }));
  rejected(driver.convert({ ...(await fixture('edition')), works: [{ key: '//evil.example/works/OL1W' }] }));
});

test('unsafe URLs are rejected without fetching or emitting partial proposals', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,private',
    'file:///etc/passwd',
    'http://127.0.0.1/private',
    'http://169.254.169.254/latest/meta-data/',
    'https://user:secret@openlibrary.org/works/OL1W',
    '//evil.example/private',
  ]) {
    const result = driver.convert({ ...record, links: [{ title: 'Unsafe', url }] });
    rejected(result);
  }
});

test('missing or malformed required source metadata and title reject rather than inventing values', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  for (const key of ['key', 'type', 'title', 'revision', 'last_modified']) {
    const input = { ...record };
    delete input[key];
    rejected(driver.convert(input, context));
  }
  for (const patch of [
    { title: '' },
    { revision: -1 },
    { revision: '7' },
    { last_modified: { value: 'not-a-date' } },
    { last_modified: { value: '2025-02-30T03:04:05.123456' } },
    { last_modified: { value: '2025-01-02T25:04:05.123456' } },
    { last_modified: { value: '2025-01-02T03:04:05.123456garbage' } },
  ]) {
    rejected(driver.convert({ ...record, ...patch }));
  }
});

test('converter revision and proposals are deterministic while changed source values and revisions propagate', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  const first = converted(driver, record);
  expect(converted(await loadOpenLibraryDriver(), structuredClone(record)).result).toEqual(first.result);
  const clock = spyOn(Date, 'now').mockReturnValue(1);
  const random = spyOn(Math, 'random').mockReturnValue(0.125);
  try {
    const earlier = driver.convert(structuredClone(record), context);
    clock.mockReturnValue(2_000_000_000_000);
    random.mockReturnValue(0.875);
    expect(driver.convert(structuredClone(record), context)).toEqual(earlier);
    expect(earlier).toEqual(first.result);
  } finally {
    clock.mockRestore();
    random.mockRestore();
  }
  const changed = {
    ...record,
    title: 'The Copper Atlas',
    revision: 8,
    last_modified: { type: '/type/datetime', value: '2025-04-05T06:07:08.123456' },
  };
  const second = converted(driver, changed);
  const digests = (commands: BatchCommand[]) => commands.map((c) => c.source.digest);
  expect(digests(second.result.proposals)).not.toEqual(digests(first.result.proposals));
  const edited = converted(driver, { ...record, title: 'Changed title only' });
  expect(digests(edited.result.proposals)).not.toEqual(digests(first.result.proposals));
  expect(values(edited, 'title')).toEqual(['Changed title only']);
  expect(values(second, 'title')).toEqual(['The Copper Atlas']);
  expect(second.result.proposals).not.toEqual(first.result.proposals);
  expect(second.result.converter_revision).toBe(first.result.converter_revision);
});

test('conversion is synchronous leaves frozen input intact and performs no network filesystem or process I/O', async () => {
  const driver = await loadOpenLibraryDriver();
  const work = await fixture('work');
  const inputs = [
    work,
    await fixture('edition'),
    { ...work, key: '/works/OLbadW' },
    { ...work, links: [{ url: 'http://127.0.0.1/private' }] },
  ];
  const before = structuredClone(inputs);
  inputs.forEach(freeze);
  const attempts: string[] = [];
  const guards: { mockRestore(): void }[] = [];
  function guard<T extends object>(target: T, key: keyof T) {
    guards.push(
      spyOn(target, key as never).mockImplementation((() => {
        attempts.push(String(key));
        throw new Error(`Unexpected converter I/O: ${String(key)}`);
      }) as never),
    );
  }
  let results: Conversion[] = [];
  try {
    guard(globalThis, 'fetch');
    for (const key of ['file', 'write', 'spawn', 'spawnSync', 'connect', 'listen'] as const) guard(Bun, key);
    for (const key of [
      'readFileSync',
      'writeFileSync',
      'openSync',
      'createReadStream',
      'createWriteStream',
      'readFile',
      'writeFile',
      'open',
    ] as const)
      guard(fs, key);
    for (const key of ['readFile', 'writeFile', 'open'] as const) guard(fsPromises, key);
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
      guard(childProcess, key);
    for (const key of ['request', 'get'] as const) {
      guard(http, key);
      guard(https, key);
    }
    for (const key of ['connect', 'createConnection'] as const) guard(net, key);
    results = inputs.map((input) => driver.convert(input, context));
  } finally {
    guards.reverse().forEach((mock) => mock.mockRestore());
  }
  expect(attempts).toEqual([]);
  for (const result of results) expect(result).not.toBeInstanceOf(Promise);
  for (const result of results.slice(0, 2)) {
    expect(result.outcome).toBe('converted');
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(checkBatchWrite({ commands: result.proposals })).toEqual([]);
    expect(result.proposals.filter((c) => c.op === 'create')).toHaveLength(0);
    for (const command of result.proposals) {
      expect(command.op).toBe('propose');
      expect(command.subject).toBe(SUBJECT);
    }
  }
  results.slice(2).forEach(rejected);
  expect(inputs).toEqual(before);
});

test('bulk consumer structurally rejects arbitrary objects and accepts converter output with unchanged citations', async () => {
  const driver = await loadOpenLibraryDriver();
  for (const invalid of [
    [{}],
    [{ sql: 'INSERT INTO subjects VALUES (1)' }],
    [{ title: 'fabricated', source: 'open-library' }],
  ]) {
    expect(() => driver.consume(invalid)).toThrow();
  }
  converted(driver, await fixture('work'));
  converted(driver, await fixture('edition'));
});

test('only supplied native resolutions turn author and work external keys into item relations', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('edition');
  const output = converted(driver, record, {
    subjectId: SUBJECT,
    resolvedReferences: {
      '/authors/OL900000001A': AUTHOR,
      '/works/OL900000001W': WORK,
    },
  });
  expect(values(output, 'author')).toEqual([{ type: 'value', content: AUTHOR }]);
  expect(values(output, 'work')).toEqual([{ type: 'value', content: WORK }]);
  for (const [kind, identifier] of [
    ['author', 'OL900000001A'],
    ['work', 'OL900000001W'],
  ] as const) {
    relationshipSource(output, kind, identifier);
  }
});

test('valid ISBN-10 including X converts with 978 and a recomputed ISBN-13 check digit', async () => {
  const driver = await loadOpenLibraryDriver();
  const edition = await fixture('edition');
  for (const [isbn10, isbn13] of [
    ['0306406152', '9780306406157'],
    ['080442957X', '9780804429573'],
  ]) {
    const output = converted(driver, { ...edition, isbn_10: [isbn10], isbn_13: [] });
    expect(values(output, 'isbn10')).toEqual([]);
    expect(values(output, 'isbn13')).toEqual([isbn13]);
    const statements = output.accepted.flatMap((c) =>
      c.op === 'propose' ? [c.statement] : c.op === 'create' ? Object.values(c.subject.statements ?? {}).flat() : [],
    );
    expect(statements.filter((s) => s.property.id === 'schema:isbn').map((s) => s.value)).toEqual([
      { type: 'value', content: isbn13 },
    ]);
    expect(statements.some((s) => s.property.id === 'wdt:P957')).toBe(false);
  }
});

test('invalid ISBN-10 check digits never become identifier candidates', async () => {
  const driver = await loadOpenLibraryDriver();
  const edition = await fixture('edition');
  for (const isbn of ['0306406153', '0804429570']) {
    const result = driver.convert({ ...edition, isbn_10: [isbn], isbn_13: [] }, context);
    if (result.outcome !== 'converted') noProposals(result);
    else {
      expect(checkBatchWrite({ commands: result.proposals })).toEqual([]);
      expect(result.proposals.filter((c) => c.op === 'create')).toHaveLength(0);
      for (const command of result.proposals) {
        expect(command.op).toBe('propose');
        expect(command.subject).toBe(SUBJECT);
      }
      const statements = result.proposals.flatMap((c) =>
        c.op === 'propose' ? [c.statement] : c.op === 'create' ? Object.values(c.subject.statements ?? {}).flat() : [],
      );
      expect(statements.filter((s) => ['schema:isbn', 'wdt:P957'].includes(s.property.id))).toEqual([]);
    }
  }
});

test('absent author and work identifiers produce no relationship proposals', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('edition');
  delete record.authors;
  delete record.works;
  const output = converted(driver, record);
  expect(values(output, 'author')).toEqual([]);
  expect(values(output, 'work')).toEqual([]);
  expect(output.accepted.flatMap((c) => (c.op === 'propose' ? [c.statement.property.id] : []))).not.toContain(
    'schema:author',
  );
  expect(output.accepted.flatMap((c) => (c.op === 'propose' ? [c.statement.property.id] : []))).not.toContain(
    'schema:exampleOfWork',
  );
});

test('Open Library bootstrap distinguishes Work Book and Edition Instance with creation metadata and source claims', async () => {
  const driver = await loadOpenLibraryDriver();
  const claims: string[] = [];
  for (const [name, expectedType] of [
    ['work', 'http://schema.org/Book'],
    ['edition', 'http://id.loc.gov/ontologies/bibframe/Instance'],
  ] as const) {
    const record = await fixture(name);
    const output = converted(driver, record, null);
    const command = output.accepted[0]!;
    expect(command.op).toBe('create');
    if (command.op !== 'create') throw new Error('Expected bootstrap create');
    expect(
      command.subject.type
        .replace(/^schema:/, 'http://schema.org/')
        .replace(/^https:\/\/schema\.org\//, 'http://schema.org/')
        .replace(/^bf:/, 'http://id.loc.gov/ontologies/bibframe/'),
    ).toBe(expectedType);
    expect<unknown>(Object.values(command.subject.labels)).toContain(record.title);
    // Unknown-licensed source prose cannot become a creation description.
    expect(command.subject.descriptions ?? {}).toEqual({});
    expect(command.source).toMatchObject({
      source: 'open-library',
      external_id: record.key,
      record_revision: String(record.revision),
      field_group: 'facts',
    });
    expect(output.fields.filter((f) => f.kind === 'cover' || f.kind === 'description')).toEqual([]);
    expect(command.subject).not.toHaveProperty('statements');
    for (const key of Object.keys(command.subject))
      expect(['type', 'labels', 'descriptions', 'aliases']).toContain(key);
    // Identity/title statements and full citations are checked by the resolved work/edition scenarios.
    claims.push(`${command.source.source}:${command.source.external_id}`);
  }
  expect(claims).toEqual(['open-library:/works/OL900000001W', 'open-library:/books/OL900000002M']);
  expect(new Set(claims).size).toBe(2);
});
