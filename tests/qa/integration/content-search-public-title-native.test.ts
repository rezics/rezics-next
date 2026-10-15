import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

import { iri, lit, RV } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

test('SEARCH14: public title and body have independent native text membership', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const id = randomUUID();
  const graph = `urn:rezics:qa:public-title:${id}`;
  const unit = `urn:rezics:qa:public-title-unit:${id}`;
  const titleTerm = `title${id.replaceAll('-', '')}`;
  const bodyTerm = `body${randomUUID().replaceAll('-', '')}`;
  const title = `"${titleTerm} only title"@en`;
  const body = `"${bodyTerm} only body"@en`;
  const triples = `<${unit}> <${RV}publicTitle> ${title} ; <${RV}searchBody> ${body} .`;
  const hits = async (field: 'publicTitle' | 'searchBody', term: string) => {
    const result = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?unit ?literal ?predicate WHERE { GRAPH <${graph}> {
        (?unit ?score ?literal ?matchedGraph ?predicate)
          text:query (rv:${field} ${JSON.stringify(term)} 10) .
      } }`);
    return result.results?.bindings.map(row => ({ unit: row.unit?.value,
      literal: row.literal?.value, predicate: row.predicate?.value })) ?? [];
  };
  await fuseki.update(`INSERT DATA { GRAPH <${graph}> { ${triples} } }`);
  try {
    expect(await hits('publicTitle', titleTerm)).toEqual([{
      unit, literal: `${titleTerm} only title`, predicate: `${RV}publicTitle`,
    }]);
    expect(await hits('searchBody', bodyTerm)).toEqual([{
      unit, literal: `${bodyTerm} only body`, predicate: `${RV}searchBody`,
    }]);
    expect(await hits('publicTitle', bodyTerm)).toEqual([]);
    expect(await hits('searchBody', titleTerm)).toEqual([]);

    // Both predicates belong to one subject, but each text binding is a
    // separate posting. A caller can explicitly join them at that subject.
    const joined = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?unit WHERE { GRAPH <${graph}> {
        (?unit ?titleScore) text:query (rv:publicTitle ${JSON.stringify(titleTerm)} 10) .
        (?unit ?bodyScore) text:query (rv:searchBody ${JSON.stringify(bodyTerm)} 10) .
      } }`);
    expect(joined.results?.bindings.map(row => row.unit?.value)).toEqual([unit]);
  } finally {
    await fuseki.update(`DELETE DATA { GRAPH <${graph}> { ${triples} } }`);
  }
});

interface Hit { id: string; key: string | null; score: string; document?: number }
interface Page { hits: Hit[]; more: boolean; commit: string; restart?: boolean }

async function rank(phrase: string, scope: object, after = '') {
  const query = `PREFIX rv: <${RV}> SELECT ?page WHERE {
    BIND(rv:rankedText(rv:searchBody, ${lit(phrase)}, 1, ${lit(after)}, ${lit(JSON.stringify(scope))}) AS ?page)
  }`;
  const response = await fetch(new URL('query', `${Bun.env.FUSEKI_URL!.replace(/\/*$/, '')}/`), {
    method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' },
    body: query,
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { results: { bindings: { page: { value: string } }[] } };
  const counters = Object.fromEntries((response.headers.get('x-rezics-command-work') ?? '')
    .split(',').map(entry => entry.split('=')).map(([name, value]) => [name, Number(value)]));
  return { page: JSON.parse(result.results.bindings[0]!.page.value) as Page, counters };
}

test('ranked continuations keep the original scores and candidates through writes between every page', async () => {
  if (!Bun.env.FUSEKI_URL) throw new Error('Run through isolated integration QA');
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const phrase = `continuation${randomUUID().replaceAll('-', '')}`;
  const unit = (n: number) => `urn:rezics:match:${phrase}:${n}`;
  const add = async (n: number, body: string) => fuseki.update(`INSERT DATA {
    GRAPH <urn:rezics:search:public> { ${iri(unit(n))} <${RV}searchBody> ${lit(body)}@en }
  }`);
  for (let n = 0; n < 4; n++) await add(n, `${phrase} ${'passage '.repeat(n + 1)}`);
  const first = (await rank(phrase, {})).page;
  expect(first.hits).toHaveLength(1);
  expect(first.more).toBe(true);
  const original = [...first.hits];
  let page = first;
  while (page.more) {
    page = (await rank(phrase, {}, JSON.stringify({ ...page.hits[0]!, commit: page.commit }))).page;
    original.push(...page.hits);
  }
  expect(original).toHaveLength(4);
  const traversed = [...first.hits];
  page = first;
  for (let index = 0; page.more; index++) {
    expect(index).toBeLessThan(4);
    // New matching documents alter scores and rank in the latest index, but
    // cannot enter this traversal or move an existing hit behind its cursor.
    await add(10 + index, `${phrase} ${phrase} fresh ${'words '.repeat(index)}`);
    page = (await rank(phrase, {}, JSON.stringify({ ...page.hits[0]!, commit: page.commit }))).page;
    expect(page.restart).toBeUndefined();
    traversed.push(...page.hits);
  }
  expect(traversed).toEqual(original);
  expect(new Set(traversed.map(hit => hit.id)).size).toBe(4);
});

test('cached-title ranking reads a page-sized neighbourhood at 10, 100 and 1000 matches', async () => {
  const stack = await startMediaStack('cached-title-growth');
  try {
    const member = await stack.member('cached-title-growth-owner');
    // A real publication binds the native rank metadata owner before probing
    // its legacy cached-title documents through the actual query endpoint.
    await stack.publicWork(member.actor, ['en'], 'Rank metadata owner');
    const phrase = `cachedtitle${randomUUID().replaceAll('-', '')}`;
    let population = 0;
    const samples: { population: number; next: number; advance: number; matches: number }[] = [];
    for (const size of [10, 100, 1000]) {
      const rows: string[] = [];
      while (population < size) rows.push(`${iri(`urn:rezics:match:${phrase}:${population++}`)}
        <${RV}publicTitle> ${lit(`${phrase} authored name`)}@en .`);
      await stack.fuseki.update(`INSERT DATA { GRAPH <urn:rezics:search:public> { ${rows.join('\n')} } }`);
      const { page, counters } = await rank(phrase, { catalogue: true });
      expect(page.hits).toHaveLength(1);
      expect(page.hits[0]!.score).toBe('1000000.0');
      expect(page.more).toBe(true);
      const sample = { population: size, next: counters.rank_lucene_iterator_next_calls ?? 0,
        advance: counters.rank_lucene_iterator_advance_calls ?? 0,
        matches: counters.rank_lucene_two_phase_matches ?? 0 };
      samples.push(sample);
      expect(sample.next + sample.advance + sample.matches).toBeGreaterThan(0);
    }
    console.log('cached-title native growth', JSON.stringify(samples));
    const baseline = samples[0]!;
    for (const sample of samples) {
      expect(sample.next).toBeLessThanOrEqual(baseline.next + 128);
      expect(sample.advance).toBeLessThanOrEqual(baseline.advance + 128);
      expect(sample.matches).toBeLessThanOrEqual(baseline.matches + 128);
    }
  } finally { await stack.stop(); }
}, 120_000);
