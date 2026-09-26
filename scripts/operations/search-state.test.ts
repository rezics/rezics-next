import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assemblerFacts, assertPinnedAssembler, assertPinnedState, assertStorageHeadroom,
  OFFLINE_INDEX_SCRIPT, OWNER_ENTRYPOINT, PINNED_ANALYZER, SearchStateRefused, sha256,
  storageHeadroom, type FusekiStateRunner, type StatePins } from './search-state.ts';
import { COMMAND_MODULE_VERSION } from '../../services/main/src/infrastructure/profile.ts';

const root = resolve(import.meta.dir, '../..');
const assembler = (name: string) => readFileSync(resolve(root, 'infra/jena', name), 'utf8');

test('OPS16: every shipped assembler opens only the relative pinned state and CJK analyzer', () => {
  for (const name of ['fuseki-text.ttl', 'fuseki-text-qa.ttl', 'fuseki-text-qa-raw.ttl']) {
    const facts = assemblerFacts(assembler(name));
    expect(facts).toEqual({ tdb2Location: 'databases/rezics/tdb2',
      luceneDirectory: 'databases/rezics/lucene', analyzer: PINNED_ANALYZER, textDatasets: 1 });
    expect(() => assertPinnedAssembler(facts)).not.toThrow();
  }
});

test('OPS16: a changed analyzer or an absolute original path is refused before index work', () => {
  const product = assembler('fuseki-text.ttl');
  const standard = product.replace(PINNED_ANALYZER, 'org.apache.lucene.analysis.standard.StandardAnalyzer');
  expect(() => assertPinnedAssembler(assemblerFacts(standard))).toThrow(/analyzer .*StandardAnalyzer/);
  const absolute = product.replace('"databases/rezics/tdb2"', '"/srv/original/databases/rezics/tdb2"');
  expect(() => assertPinnedAssembler(assemblerFacts(absolute))).toThrow(/TDB2 location/);
  const twoIndexes = product.replace('text:directory "databases/rezics/lucene" ;',
    'text:directory "databases/rezics/lucene" ; text:directory "databases/other" ;');
  expect(() => assemblerFacts(twoIndexes)).toThrow(SearchStateRefused);
  // A commented-out alternative does not count as a declaration.
  expect(assemblerFacts(`# text:class "x"\n${product}`).analyzer).toBe(PINNED_ANALYZER);
});

test('OPS16: pins name the image, state volume, module and both assemblers', () => {
  const facts = assemblerFacts(assembler('fuseki-text.ttl'));
  const pins: StatePins = { imageId: 'sha256:a', stateVolume: 'restore_fuseki',
    serverAssembler: '/fuseki/fuseki-text-qa.ttl',
    serverAssemblerSha256: sha256(assembler('fuseki-text-qa.ttl')),
    indexerAssemblerSha256: sha256(assembler('fuseki-text.ttl')),
    fusekiJarSha256: 'b'.repeat(64), commandJarSha256: 'c'.repeat(64),
    moduleVersion: COMMAND_MODULE_VERSION, facts };
  const expected = { imageId: 'sha256:a', stateVolume: 'restore_fuseki', isolatedFrom: ['original_fuseki'],
    assemblers: { 'fuseki-text.ttl': sha256(assembler('fuseki-text.ttl')),
      'fuseki-text-qa.ttl': sha256(assembler('fuseki-text-qa.ttl')) } };
  expect(() => assertPinnedState(pins, expected)).not.toThrow();
  expect(() => assertPinnedState({ ...pins, imageId: 'sha256:other' }, expected)).toThrow(/image/);
  expect(() => assertPinnedState({ ...pins, stateVolume: 'original_fuseki' },
    { ...expected, stateVolume: 'original_fuseki' })).toThrow(/isolated original/);
  expect(() => assertPinnedState({ ...pins, moduleVersion: '0.0.1' }, expected)).toThrow(/command module/);
  expect(() => assertPinnedState({ ...pins, indexerAssemblerSha256: 'd'.repeat(64) }, expected))
    .toThrow(/indexer assembler/);
  expect(() => assertPinnedState({ ...pins, facts: { ...facts, analyzer: 'x' } }, expected))
    .toThrow(/analyzer x/);
  expect(OWNER_ENTRYPOINT).toBe('/usr/local/bin/fuseki-owner');
});

test('OPS09: headroom requires the replacement index and reserve beside the current one', () => {
  const runner = (free: number): FusekiStateRunner => ({
    exec: script => {
      expect(script).toContain('du -sk tdb2 lucene');
      return `2048\ttdb2\n512\tlucene\n/dev/vda1 100000 50000 ${free} 50% /fuseki/databases\n`;
    },
    offline: () => { throw new Error('headroom must not start a second container'); },
    stop: () => { throw new Error('headroom must not stop Fuseki'); },
    start: () => undefined,
    container: () => 'abc',
  });
  const enough = storageHeadroom(runner(2048), 1_048_576);
  expect(enough).toEqual({ freeBytes: 2_097_152, tdb2Bytes: 2_097_152, luceneBytes: 524_288,
    reserveBytes: 1_048_576, requiredBytes: 2_097_152 });
  expect(() => assertStorageHeadroom(enough)).not.toThrow();
  expect(() => assertStorageHeadroom(storageHeadroom(runner(2047), 1_048_576)))
    .toThrow(/insufficient storage headroom/);
  expect(() => storageHeadroom(runner(1), -1)).toThrow('invalid storage reserve');
});

test('OPS13/OPS15: the offline indexer takes the owner lock and clears doubt only after success', () => {
  const lines = OFFLINE_INDEX_SCRIPT.split('\n');
  expect(lines[0]).toMatch(/^exec 9>>\/fuseki\/databases\/rezics\/owner\.lock$/);
  expect(lines[1]).toMatch(/^flock -n 9 \|\| /);
  const indexer = lines.findIndex(line => line.includes('jena.textindexer'));
  const mark = lines.findIndex(line => line.includes(': > /fuseki/databases/rezics/lucene.uncertain'));
  const empty = lines.findIndex(line => line.includes('rm -rf /fuseki/databases/rezics/lucene'));
  const clear = lines.findIndex(line => line.includes('rm -f /fuseki/databases/rezics/lucene.uncertain'));
  expect(mark).toBeGreaterThan(1);
  expect(empty).toBeGreaterThan(mark);
  expect(indexer).toBeGreaterThan(empty);
  expect(clear).toBeGreaterThan(indexer);
  expect(OFFLINE_INDEX_SCRIPT).not.toMatch(/tdb\.lock|write\.lock/);
});
