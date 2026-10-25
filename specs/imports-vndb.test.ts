import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { loadVndbDriver, type Path, type VndbDriver } from './imports-vndb-driver.ts';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/imports/vndb/record.json', import.meta.url), 'utf8'));
const hostileUrls: string[] = JSON.parse(
  readFileSync(new URL('./fixtures/imports/vndb/hostile-urls.json', import.meta.url), 'utf8'),
);

function at(root: unknown, path: Path): unknown {
  expect(Array.isArray(path)).toBe(true);
  let value = root;
  for (const part of path) {
    expect(value !== null && typeof value === 'object').toBe(true);
    expect(Object.hasOwn(value as object, part)).toBe(true);
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}

/** Test-only bulk sink: real semantic structural validation, no writes. */
function consume(driver: VndbDriver, output: unknown) {
  expect(output).toBeDefined();
  expect(output).not.toBeInstanceOf(Promise);
  const located = driver.locate(output);
  expect(driver.converter_revision.trim().length).toBeGreaterThan(0);
  expect(at(output, located.converterRevision)).toBe(driver.converter_revision);
  expect(located.proposals.length).toBeGreaterThan(0);
  return located.proposals.map((path) => {
    const proposal = at(output, path);
    expect(proposal).not.toBeNull();
    expect(typeof proposal).toBe('object');
    const accepted = driver.parseProposal(proposal);
    expect(accepted).toEqual(proposal);
    const facts = driver.observe(accepted);
    expect(facts.length).toBeGreaterThan(0);
    return { proposal: accepted, facts };
  });
}

function assertMetadata(driver: VndbDriver, output: unknown, id = 'v123', revision = 7, title = 'Sentinel Harbor') {
  const commands = consume(driver, output);
  const facts = commands.flatMap((command) => command.facts);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'title', language: 'en', value: title }),
      expect.objectContaining({ kind: 'external-id', value: id }),
      expect.objectContaining({ kind: 'type', value: 'visual-novel' }),
    ]),
  );
  expect(facts.filter((fact) => fact.kind === 'external-id').map((fact) => fact.value)).toEqual([id]);
  expect(facts.filter((fact) => fact.kind === 'type').map((fact) => fact.value)).toEqual(['visual-novel']);
  for (const { proposal, facts } of commands) {
    for (const fact of facts) {
      expect(['description', 'cover', 'user-content']).not.toContain(fact.kind);
      // The type observation resolves the real production definition term.
      const rawValue = at(proposal, fact.valuePath);
      expect(rawValue).toBeDefined();
      expect(rawValue).not.toBeNull();
      if (fact.kind !== 'type') expect(rawValue).toEqual(fact.value);
      expect(at(proposal, fact.fieldGroupPath)).toBe('metadata');
      expect(at(proposal, fact.reference.source)).toBe('vndb');
      expect(at(proposal, fact.reference.externalId)).toBe(id);
      expect(at(proposal, fact.reference.revision)).toBe(revision);
      expect(at(proposal, fact.reference.url)).toBe(`https://vndb.org/${id}.${revision}`);
      expect(at(proposal, fact.rights.databaseLicense)).toBe('ODbL-1.0');
      expect(at(proposal, fact.rights.contentsLicense)).toBe('LicenseRef-DbCL-1.0');
      expect(at(proposal, fact.rights.attribution)).toBe('VNDB');
    }
  }
  return facts;
}

test('VNDB metadata becomes structurally accepted command proposals with exact revision citations and dump rights', async () => {
  const driver = await loadVndbDriver();
  const facts = assertMetadata(driver, driver.convert(fixture()));
  expect(
    facts
      .filter((fact) => fact.kind === 'title')
      .map((fact) => [fact.language, fact.value])
      .sort(),
  ).toEqual([
    ['de', 'Harbor German Edition'],
    ['en', 'Sentinel Harbor'],
  ]);
  // The fake consumer must reject empty or fabricated command shapes as well.
  for (const invalid of [null, {}, { sql: 'INSERT INTO subjects DEFAULT VALUES' }]) {
    expect(() => driver.parseProposal(invalid)).toThrow();
  }
});

test('VNDB changed source values and revisions change real proposals without inventing release identifiers as VN identities', async () => {
  const driver = await loadVndbDriver();
  const input = fixture();
  input.vn.id = input.entry_meta.id = 'v124';
  input.entry_meta.revision = 8;
  for (const title of input.vn_titles) title.id = 'v124';
  input.vn_titles[0].title = 'Another Harbor';
  input.releases_vn[0].vid = input.vn_extlinks[0].id = 'v124';
  const original = driver.convert(fixture());
  const changed = driver.convert(input);
  expect(changed).not.toEqual(original);
  assertMetadata(driver, changed, 'v124', 8, 'Another Harbor');
});

test('VNDB converter is synchronous deterministic and leaves deeply frozen source rows unchanged without I/O', async () => {
  const driver = await loadVndbDriver();
  const input = fixture();
  const before = structuredClone(input);
  function freeze(value: unknown) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(input);
  const calls: string[] = [];
  const deny = (name: string) => () => {
    calls.push(name);
    throw new Error('Unexpected I/O');
  };
  const watches = [
    spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(deny('fetch'), { preconnect: globalThis.fetch.preconnect }),
    ),
    spyOn(Bun, 'file').mockImplementation(deny('Bun.file')),
    spyOn(Bun, 'write').mockImplementation(deny('Bun.write')),
    spyOn(Bun, 'spawn').mockImplementation(deny('Bun.spawn')),
    spyOn(Bun, 'spawnSync').mockImplementation(deny('Bun.spawnSync')),
    spyOn(fs, 'readFileSync').mockImplementation(deny('readFileSync')),
    spyOn(fs, 'writeFileSync').mockImplementation(deny('writeFileSync')),
    spyOn(fs, 'openSync').mockImplementation(deny('openSync')),
    spyOn(fsPromises, 'readFile').mockImplementation(deny('readFile')),
    spyOn(fsPromises, 'writeFile').mockImplementation(deny('writeFile')),
    spyOn(fsPromises, 'open').mockImplementation(deny('open')),
  ];
  let first: unknown;
  let second: unknown;
  try {
    first = driver.convert(input);
    second = driver.convert(structuredClone(input));
    expect(calls).toEqual([]);
    expect(first).toEqual(second);
    expect(input).toEqual(before);
  } finally {
    for (const watch of watches) watch.mockRestore();
  }
  assertMetadata(driver, first);
});

test('VNDB descriptions covers posts reviews accounts and private lists never reach proposals', async () => {
  const driver = await loadVndbDriver();
  const dirty = fixture();
  const clean = structuredClone(dirty);
  for (const key of ['threads_posts', 'reviews', 'users', 'ulist_vns']) delete clean[key];
  clean.vn.description = '';
  clean.vn.image = clean.vn.c_image = null;
  clean.images = [];
  const output = driver.convert(dirty);
  assertMetadata(driver, output);
  expect(output).toEqual(driver.convert(clean));
  // Inspect the complete output as well as observations; adapters cannot hide leaks.
  const serialized = JSON.stringify(output);
  for (const marker of [
    'UNLICENSED_DESCRIPTION_SENTINEL',
    'USER_POST_SENTINEL',
    'USER_REVIEW_SENTINEL',
    'ACCOUNT_SENTINEL',
    'PRIVATE_LIST_SENTINEL',
    'cv123',
  ]) {
    expect(serialized).not.toContain(marker);
  }
});

test('VNDB malformed identifiers wrong entity types and malformed field types reject instead of producing proposals', async () => {
  const driver = await loadVndbDriver();
  assertMetadata(driver, driver.convert(fixture()));
  for (const id of ['', '123', 'v0', 'v-1', 'v01', 'r123', 'u123', 'w123', 'v123/../../u9', 'v123\n']) {
    const input = fixture();
    input.vn.id = id;
    expect(() => driver.convert(input)).toThrow();
  }
  for (const invalid of [null, [], {}, { vn: 'v123' }]) expect(() => driver.convert(invalid)).toThrow();
  const title = fixture();
  title.vn_titles[0].title = 42;
  const revision = fixture();
  revision.entry_meta.revision = 'seven';
  const mismatch = fixture();
  mismatch.entry_meta.id = 'v999';
  for (const input of [title, revision, mismatch]) expect(() => driver.convert(input)).toThrow();
});

test('VNDB hostile source URLs reject without fetching or returning partial proposals', async () => {
  const driver = await loadVndbDriver();
  assertMetadata(driver, driver.convert(fixture()));
  const calls: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      () => {
        calls.push('fetch');
        throw new Error('Unexpected fetch');
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    for (const url of hostileUrls) {
      const input = fixture();
      input.extlinks[0].value = url;
      expect(() => driver.convert(input)).toThrow();
    }
    expect(calls).toEqual([]);
  } finally {
    fetch.mockRestore();
  }
});
