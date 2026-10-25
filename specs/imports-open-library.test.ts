import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { loadOpenLibraryDriver } from './imports-open-library-driver';
import type { Conversion, FieldObservation, OpenLibraryDriver, RecordPayload } from './imports-open-library-driver';

async function fixture(name: string): Promise<RecordPayload> {
  return Bun.file(new URL(`./fixtures/imports/open-library/${name}.json`, import.meta.url)).json();
}
function pointer(root: unknown, path: string): unknown {
  expect(path.startsWith('/')).toBe(true);
  return path.slice(1).split('/').reduce<unknown>((node, token) => {
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
function converted(driver: OpenLibraryDriver, record: RecordPayload) {
  const result = driver.convert(record);
  expect(result.outcome).toBe('converted');
  nonempty(driver.converter_revision);
  expect(result.converter_revision).toBe(driver.converter_revision);
  expect(Array.isArray(result.proposals)).toBe(true);
  expect(result.proposals.length).toBeGreaterThan(0);
  const proposed = structuredClone(result.proposals);
  const consumed = driver.consume(result.proposals);
  expect(result.proposals).toEqual(proposed);
  expect(consumed.accepted).toEqual(proposed);
  expect(consumed.fields.length).toBeGreaterThan(0);
  for (const field of consumed.fields) {
    const command = consumed.accepted[field.command];
    expect(Number.isInteger(field.command) && field.command >= 0).toBe(true);
    expect(command !== null && typeof command === 'object').toBe(true);
    expect(pointer(command, field.valuePath)).toBeDefined();
    nonempty(pointer(command, field.groupPath));
    const ref = field.reference;
    expect(pointer(command, ref.path)).toBeTruthy();
    for (const path of [ref.keyPath, ref.urlPath, ref.revisionPath, ref.lastModifiedPath]) {
      expect(path.startsWith(`${ref.path}/`)).toBe(true);
    }
    expect(pointer(command, ref.keyPath)).toBe(record.key);
    expect(pointer(command, ref.urlPath)).toBe(`https://openlibrary.org${record.key}`);
    expect(pointer(command, ref.revisionPath)).toBe(record.revision);
    expect(pointer(command, ref.lastModifiedPath)).toBe((record.last_modified as { value: string }).value);
    expect(pointer(command, field.rights.path)).toBeTruthy();
    expect(field.rights.licensePath.startsWith(`${field.rights.path}/`)).toBe(true);
    expect(['fact', 'verbatim']).toContain(field.rights.mode);
    const license = pointer(command, field.rights.licensePath);
    if (license !== null) nonempty(license);
  }
  return { result, ...consumed };
}
type Accepted = ReturnType<typeof converted>;
function values(output: Accepted, kind: FieldObservation['kind']) {
  return output.fields.filter(field => field.kind === kind)
    .map(field => pointer(output.accepted[field.command], field.valuePath));
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

test('work identity title and author carry exact source key revision timestamp and reference URL', async () => {
  const driver = await loadOpenLibraryDriver();
  const output = converted(driver, await fixture('work'));
  expect(values(output, 'identity')).toEqual(['/works/OL900000001W']);
  expect(values(output, 'title')).toEqual(['The Glass Atlas']);
  expect(values(output, 'author')).toEqual(['/authors/OL900000001A']);
  expect(values(output, 'isbn10')).toEqual([]);
  expect(values(output, 'isbn13')).toEqual([]);
  expect(values(output, 'publishDate')).toEqual([]);
});

test('edition remains distinct from work and preserves ISBN authors and source date precision', async () => {
  const driver = await loadOpenLibraryDriver();
  const output = converted(driver, await fixture('edition'));
  expect(values(output, 'identity')).toEqual(['/books/OL900000002M']);
  expect(values(output, 'work')).toEqual(['/works/OL900000001W']);
  expect(values(output, 'title')).toEqual(['The Glass Atlas: Pocket Edition']);
  expect(values(output, 'author')).toEqual(['/authors/OL900000001A']);
  expect(values(output, 'isbn10')).toEqual(['0306406152']);
  expect(values(output, 'isbn13')).toEqual(['9780306406157']);
  expect(values(output, 'publishDate')).toEqual(['May 1980']);
});

test('bibliographic facts and verbatim descriptions and covers have separate rights and field groups', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  const output = converted(driver, record);
  expect(values(output, 'description')).toEqual([(record.description as { value: string }).value]);
  expect(values(output, 'cover')).toHaveLength(1);
  expect(values(output, 'cover')[0]).toMatch(/^https:\/\/covers\.openlibrary\.org\/b\/id\/900000001-[SML]\.jpg$/);
  const groups = new Map<string, unknown>();
  for (const field of output.fields) {
    const command = output.accepted[field.command];
    groups.set(field.kind, pointer(command, field.groupPath));
    const creative = field.kind === 'description' || field.kind === 'cover';
    expect(field.rights.mode).toBe(creative ? 'verbatim' : 'fact');
    if (creative) {
      // No license supplied for either creative asset; catalogue CC0 cannot fill it.
      expect(pointer(command, field.rights.licensePath)).toBeNull();
      const title = output.fields.find(item => item.kind === 'title')!;
      expect(pointer(command, field.rights.path)).not.toEqual(pointer(output.accepted[title.command], title.rights.path));
    }
  }
  expect(groups.get('description')).not.toEqual(groups.get('title'));
  expect(groups.get('cover')).not.toEqual(groups.get('title'));
  expect(groups.get('cover')).not.toEqual(groups.get('description'));
});

test('missing optional data creates no authors ISBN dates descriptions or covers', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('edition');
  for (const key of ['authors', 'isbn_10', 'isbn_13', 'publish_date', 'publishers', 'works', 'notes']) delete record[key];
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
  for (const [type, key] of [['/type/author', '/authors/OL900000001A'], ['/type/redirect', '/books/OL900000002M'], ['/type/post', '/people/example/posts/1']]) {
    noProposals(driver.convert({ ...await fixture('work'), type: { key: type }, key }));
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
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE_TEXT_SENTINEL|USER_POST_SENTINEL|ACCOUNT_SENTINEL/);
  }
});

test('malformed keys type-key mismatches and unsafe relationship identifiers reject without proposals', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  for (const key of ['/works/OLoopsW', '/works/OL123M', '/books/OL123M', '/works/OL1W/../people/private', 'https://evil.example/works/OL1W', '/works/OL1W?private=1']) {
    rejected(driver.convert({ ...record, key }));
  }
  rejected(driver.convert({ ...record, authors: [{ author: { key: 'javascript:alert(1)' } }] }));
  rejected(driver.convert({ ...await fixture('edition'), works: [{ key: '//evil.example/works/OL1W' }] }));
});

test('unsafe URLs are rejected without fetching or emitting partial proposals', async () => {
  const driver = await loadOpenLibraryDriver();
  const record = await fixture('work');
  for (const url of ['javascript:alert(1)', 'data:text/html,private', 'file:///etc/passwd', 'http://127.0.0.1/private', 'http://169.254.169.254/latest/meta-data/', 'https://user:secret@openlibrary.org/works/OL1W', '//evil.example/private']) {
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
    rejected(driver.convert(input));
  }
  for (const patch of [{ title: '' }, { revision: -1 }, { revision: '7' }, { last_modified: { value: 'not-a-date' } }]) {
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
    const earlier = driver.convert(structuredClone(record));
    clock.mockReturnValue(2_000_000_000_000);
    random.mockReturnValue(0.875);
    expect(driver.convert(structuredClone(record))).toEqual(earlier);
    expect(earlier).toEqual(first.result);
  } finally { clock.mockRestore(); random.mockRestore(); }
  const changed = { ...record, title: 'The Copper Atlas', revision: 8,
    last_modified: { type: '/type/datetime', value: '2025-04-05T06:07:08.123456' } };
  const second = converted(driver, changed);
  expect(values(second, 'title')).toEqual(['The Copper Atlas']);
  expect(second.result.proposals).not.toEqual(first.result.proposals);
  expect(second.result.converter_revision).toBe(first.result.converter_revision);
});

test('conversion is synchronous leaves frozen input intact and performs no network filesystem or process I/O', async () => {
  const driver = await loadOpenLibraryDriver();
  const work = await fixture('work');
  const inputs = [work, await fixture('edition'), { ...work, key: '/works/OLbadW' },
    { ...work, links: [{ url: 'http://127.0.0.1/private' }] }];
  const before = structuredClone(inputs);
  inputs.forEach(freeze);
  const attempts: string[] = [];
  const guards: { mockRestore(): void }[] = [];
  function guard<T extends object>(target: T, key: keyof T) {
    guards.push(spyOn(target, key as never).mockImplementation((() => {
      attempts.push(String(key));
      throw new Error(`Unexpected converter I/O: ${String(key)}`);
    }) as never));
  }
  let results: Conversion[] = [];
  try {
    guard(globalThis, 'fetch');
    for (const key of ['file', 'write', 'spawn', 'spawnSync', 'connect', 'listen'] as const) guard(Bun, key);
    for (const key of ['readFileSync', 'writeFileSync', 'openSync', 'createReadStream', 'createWriteStream', 'readFile', 'writeFile', 'open'] as const) guard(fs, key);
    for (const key of ['readFile', 'writeFile', 'open'] as const) guard(fsPromises, key);
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) guard(childProcess, key);
    for (const key of ['request', 'get'] as const) { guard(http, key); guard(https, key); }
    for (const key of ['connect', 'createConnection'] as const) guard(net, key);
    results = inputs.map(input => driver.convert(input));
  } finally {
    guards.reverse().forEach(mock => mock.mockRestore());
  }
  expect(attempts).toEqual([]);
  for (const result of results) expect(result).not.toBeInstanceOf(Promise);
  for (const result of results.slice(0, 2)) {
    expect(result.outcome).toBe('converted');
    expect(result.proposals.length).toBeGreaterThan(0);
  }
  results.slice(2).forEach(rejected);
  expect(inputs).toEqual(before);
});

test('bulk consumer structurally rejects arbitrary objects and accepts converter output with unchanged citations', async () => {
  const driver = await loadOpenLibraryDriver();
  for (const invalid of [[{}], [{ sql: 'INSERT INTO subjects VALUES (1)' }], [{ title: 'fabricated', source: 'open-library' }]]) {
    expect(() => driver.consume(invalid)).toThrow();
  }
  converted(driver, await fixture('work'));
  converted(driver, await fixture('edition'));
});
