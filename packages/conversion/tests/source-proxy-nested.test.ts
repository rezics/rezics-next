import { expect, test } from 'bun:test';
import bangumi from '../../../specs/fixtures/imports/bangumi/subject.json';
import vndb from '../../../specs/fixtures/imports/vndb/record.json';
import openLibrary from '../../../specs/fixtures/imports/open-library/work.json';
import wikidata from '../../../specs/fixtures/imports/wikidata/entity.json';
import { ConversionError, type ConversionInput } from '../src/index.ts';
import { convertBangumi } from '../src/bangumi.ts';
import { convertVndb } from '../src/vndb.ts';
import { convertOpenLibrary } from '../src/open-library.ts';
import { convertWikidata } from '../src/wikidata.ts';

const sources: {
  name: string;
  convert: (input: ConversionInput) => unknown;
  input: ConversionInput;
  visited: string[];
  ignored: string[];
}[] = [
  {
    name: 'Bangumi', convert: convertBangumi,
    input: { external_id: String(bangumi.id), record_revision: '7', record: bangumi },
    visited: ['images', 'tags', 'tags.0'],
    ignored: ['user_posts', 'images.common', 'tags.0.count'],
  },
  {
    name: 'VNDB', convert: convertVndb,
    input: { external_id: vndb.vn.id, record_revision: String(vndb.entry_meta.revision), record: vndb },
    visited: ['vn', 'entry_meta', 'vn_titles', 'vn_titles.0', 'vn_extlinks', 'vn_extlinks.0', 'extlinks', 'extlinks.0'],
    ignored: ['users', 'vn.description'],
  },
  {
    name: 'Open Library', convert: convertOpenLibrary,
    input: { external_id: openLibrary.key, record_revision: String(openLibrary.revision), record: openLibrary },
    visited: ['type', 'last_modified', 'authors', 'authors.0', 'authors.0.author', 'description', 'covers', 'links', 'links.0'],
    ignored: ['account', 'authors.0.type'],
  },
  {
    name: 'Wikidata', convert: convertWikidata,
    input: { external_id: wikidata.id, record_revision: String(wikidata.lastrevid), record: wikidata },
    visited: [
      'labels', 'labels.en', 'aliases', 'aliases.en', 'aliases.en.0', 'descriptions', 'descriptions.en',
      'claims', 'claims.P50', 'claims.P50.0', 'claims.P50.0.mainsnak', 'claims.P50.0.mainsnak.datavalue',
      'claims.P50.0.mainsnak.datavalue.value', 'claims.P50.0.qualifiers', 'claims.P50.0.qualifiers.P1545',
      'claims.P50.0.references', 'claims.P50.0.references.0', 'claims.P50.0.references.0.snaks',
      'claims.P50.0.references.0.snaks.P854',
    ],
    ignored: ['account', 'claims.P999999', 'labels.zz', 'claims.P50.0.qualifiers.P999999'],
  },
];

function replace(record: unknown, path: string, value: unknown): unknown {
  if (path === '') return value;
  const keys = path.split('.');
  let parent = record as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  return record;
}

for (const source of sources) {
  for (const path of ['', ...source.visited]) {
    for (const revoked of [false, true]) {
      test(`${source.name} rejects ${revoked ? 'revoked' : 'live'} Proxy at ${path || 'root'} without traps`, () => {
        let traps = 0;
        const trap = () => { traps++; throw new Error('Source Proxy trap executed'); };
        for (const target of [{}, []]) {
          const proxy = Proxy.revocable(target, {
            getPrototypeOf: trap, getOwnPropertyDescriptor: trap, get: trap, ownKeys: trap, has: trap,
          });
          if (revoked) proxy.revoke();
          const record = replace(structuredClone(source.input.record), path, proxy.proxy);
          expect(() => source.convert({ ...source.input, record })).toThrow(ConversionError);
        }
        expect(traps).toBe(0);
      });
    }
  }

  test(`${source.name} leaves Proxies in unknown and private subtrees unvisited`, () => {
    let traps = 0;
    const trap = () => { traps++; throw new Error('Private source Proxy trap executed'); };
    const proxy = new Proxy({}, { getPrototypeOf: trap, getOwnPropertyDescriptor: trap, get: trap, ownKeys: trap });
    const baseline = source.convert(source.input);
    for (const path of source.ignored) {
      const record = replace(structuredClone(source.input.record), path, proxy);
      expect(source.convert({ ...source.input, record })).toEqual(baseline);
    }
    expect(traps).toBe(0);
  });
}
