import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

const RV = 'https://rezics.com/vocab/';

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
