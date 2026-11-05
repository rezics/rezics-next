import { expect, test } from 'bun:test';
import { ConversionError } from '../src/index.ts';
import { convertBangumi } from '../src/bangumi.ts';
import { convertVndb } from '../src/vndb.ts';
import { convertOpenLibrary } from '../src/open-library.ts';
import { convertWikidata } from '../src/wikidata.ts';

const converters = [
  { name: 'Bangumi', convert: convertBangumi, external_id: '1' },
  { name: 'VNDB', convert: convertVndb, external_id: 'v1' },
  { name: 'Open Library', convert: convertOpenLibrary, external_id: '/works/OL1W' },
  { name: 'Wikidata', convert: convertWikidata, external_id: 'Q1' },
] as const;
for (const source of converters) {
  test(`${source.name} pure public conversion rejects source Proxy without executing traps`, () => {
    let traps = 0;
    const record = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps++;
          return Object.prototype;
        },
        getOwnPropertyDescriptor() {
          traps++;
          return undefined;
        },
        get() {
          traps++;
          return undefined;
        },
        ownKeys() {
          traps++;
          return [];
        },
      },
    );
    expect(() => source.convert({ external_id: source.external_id, record_revision: '1', record })).toThrow(
      ConversionError,
    );
    expect(traps).toBe(0);
  });
}
