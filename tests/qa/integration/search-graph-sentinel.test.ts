import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

const RV = 'https://rezics.com/vocab/';
const TEXT = 'http://jena.apache.org/text#';

test('SEARCH13: a retained named graph exposes deletion of its last indexed literal', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const id = randomUUID();
  const graph = `urn:rezics:qa:sentinel:${id}`;
  const unit = `urn:rezics:qa:sentinel-unit:${id}`;
  const term = `sentinel${id.replaceAll('-', '')}`;
  const body = `"${term} indexed body"@en`;
  const sentinel = `<${graph}> <${RV}sentinel> "alive"`;
  const textHits = async () => {
    const result = await fuseki.query(`PREFIX rv: <${RV}> PREFIX text: <${TEXT}>
      SELECT ?unit WHERE { GRAPH <${graph}> {
        (?unit ?score) text:query (rv:searchBody ${JSON.stringify(term)} 10) .
      } }`);
    return result.results?.bindings.map(row => row.unit?.value) ?? [];
  };
  await fuseki.update(`INSERT DATA { GRAPH <${graph}> {
    <${unit}> <${RV}searchBody> ${body} . ${sentinel} .
  } }`);
  try {
    expect(await textHits()).toEqual([unit]);
    await fuseki.update(`DELETE DATA { GRAPH <${graph}> {
      <${unit}> <${RV}searchBody> ${body} .
    } }`);
    const retained = await fuseki.query(`ASK { GRAPH <${graph}> { ${sentinel} } }`);
    expect(retained.boolean).toBe(true);
    expect(await textHits()).toEqual([]);
  } finally {
    await fuseki.update(`DELETE DATA { GRAPH <${graph}> {
      <${unit}> <${RV}searchBody> ${body} . ${sentinel} .
    } }`);
  }
});
