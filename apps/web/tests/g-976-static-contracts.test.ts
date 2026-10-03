import { describe, expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import { readRatingPopulations } from '../../../services/main/src/modules/rating/populations.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { fixtureFollow } from '../features/relationships/fixtures.ts';
import { addressPath } from '../features/address/path.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];

function populationSession(language: string) {
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    let rows: Row[];
    if (query.includes('SELECT ?epoch ?sequence ?hold')) rows = [{
      epoch: literal('epoch'), sequence: literal('1'), r: uri(id(1)), type: literal('work'),
      work: uri(id(1)), head: uri(id(2)), public: literal('true'), erased: literal('false'),
      label: { type: 'literal', value: 'A public Work', 'xml:lang': 'en' },
    }];
    else if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) rows = [{
      epoch: literal('epoch'), sequence: literal('1'), r: uri(id(1)), revision: uri(id(2)),
      type: uri('https://schema.org/CreativeWork'),
    }];
    else if (query.includes('SELECT ?main WHERE')) rows = [{ main: uri(id(3)) }];
    else if (query.includes('SELECT ?complete WHERE')) rows = [{ complete: literal('true') }];
    else if (query.includes('SELECT ?population ?count WHERE')) rows = [{
      population: uri(GLOBAL_RATING_POPULATION_OWNER), count: literal('7'),
    }];
    else throw new Error(`Unexpected population query: ${query}`);
    return { results: { bindings: rows } };
  };
  const deps: MainWorkDependencies = {
    environment: { fuseki: graph, objectDirectory: '.temp/g-976-populations',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    account: {} as never, access: {} as never,
  };
  return new WorkReadSession(deps, new Request('http://main.test/v1/rating-populations', {
    headers: { 'accept-language': language },
  }), {}, { dataEpoch: 'epoch', sequence: '1' });
}

describe('G-976 static contract fixes', () => {
  test('relationship fixture records preserve Chinese, Arabic and English language and direction', () => {
    for (const [n, language, direction] of [[10, 'zh-Hans', 'ltr'], [11, 'ar', 'rtl'], [12, 'en', 'ltr']] as const) {
      const follow = fixtureFollow(n);
      expect(follow.name).toMatchObject({ language, direction });
      expect(addressPath(follow.href!)?.lookup).toMatchObject({ scope: 'space' });
      const resource = fixtureFollow(n, 'work');
      expect(addressPath(resource.href!)?.lookup.scope).toBe('resource');
    }
  });

  test('Global population names report the authored language and requested or fallback selection basis', async () => {
    for (const [language, basis] of [['en', 'requested'], ['ja', 'fallback'], ['ar', 'fallback']] as const) {
      const page = await readRatingPopulations(populationSession(language), { target: id(1) });
      expect(page.items).toEqual([{
        id: GLOBAL_RATING_POPULATION_OWNER, global: true, readerCommunity: false, ratingCount: 7,
        name: { value: 'Global', language: 'en', direction: 'ltr', basis },
      }]);
      expect(page).toMatchObject({ complete: true, nextCursor: null, stale: false });
    }
  });
});
