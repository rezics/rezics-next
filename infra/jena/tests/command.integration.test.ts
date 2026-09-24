import { test, expect } from 'bun:test';
import manifest from '../../../generated/model/manifest.json';

const base = process.env.FUSEKI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:39030/rezics';
const profile = manifest.profiles.find(entry => entry.id === 'work-metadata-v1')!;
const weakProfile = manifest.profiles.find(entry => entry.id === 'classification-direct-decision-v1')!;
const rv = 'https://rezics.com/vocab/';
const sh = 'https://rezics.com/definition/work-metadata-v1/';
const nonce = crypto.randomUUID();
const current = 'urn:rezics:graph:current';
const receipts = 'urn:rezics:graph:receipts';
const control = 'urn:rezics:graph:control';
const work = `urn:rezics:p02:${nonce}:work`;
const main = `urn:rezics:p02:${nonce}:main`;
const dataset = `urn:rezics:p02:${nonce}:dataset`;
const epoch = `epoch-${nonce}`;
const validation = (shape: string, focus: string[]) => ({ profile: profile.id, sha256: profile.sha256,
  shape: `${sh}${shape}`, focus, graphs: [current] });
const command = async (receipt: string, digest: string, update: string, validations: object[] = []) => {
  const response = await fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt, digest, update, validations, deadlineMs: 10000 }) });
  const body = await response.json() as {status: string; position?: {sequence:string}; report?:string};
  expect(response.status).toBe(200);
  return body;
};
const query = async (sparql: string) => {
  const response = await fetch(`${base}/query?query=${encodeURIComponent(sparql)}`, {headers:{accept:'application/sparql-results+json'}});
  expect(response.ok).toBe(true);
  return response.json() as Promise<{boolean?:boolean}>;
};
const receiptTriples = (receipt:string, digest:string, sequence:string) => `GRAPH <${receipts}> { <${receipt}> <${rv}requestDigest> "${digest}" ; <${rv}datasetId> <${dataset}> ; <${rv}dataEpoch> "${epoch}" ; <${rv}sequence> ${sequence} . }`;

test('SYS02/SYS09/SYS10: Fuseki command commits valid post-state, aborts invalid and unmatched guards', async () => {
  let health: {moduleVersion:string;profiles:Record<string,string>} | undefined;
  for (let attempt = 0; attempt < 60 && !health; attempt++) {
    try { health = await (await fetch(`${base}/command`)).json(); } catch { await Bun.sleep(250); }
  }
  expect(health).toBeDefined();
  expect(health.moduleVersion).toBe('0.2.0');
  expect(health.profiles['work-metadata-v1']).toBe(profile.sha256);
  const createReceipt = `urn:rezics:p02:${nonce}:create`;
  const createUpdate = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> PREFIX schema: <https://schema.org/> PREFIX rv: <${rv}> INSERT {
    GRAPH <${current}> { <${work}> rdf:type schema:CreativeWork ; rv:mainVersion <${main}> ; rv:continuityProfile <https://rezics.com/definition/continuity/native-work-v1> ; <http://www.w3.org/2000/01/rdf-schema#label> "P02BlueGarden"@en .
      <${main}> rdf:type rv:MainVersion ; rv:work <${work}> ; rv:hostingPolicy rv:MetadataOnly . }
    ${receiptTriples(createReceipt,'create', '0')}
    GRAPH <${control}> { <${dataset}> rv:sequence 0 ; rv:head <${main}> . }
  } WHERE { FILTER NOT EXISTS { GRAPH <${receipts}> { <${createReceipt}> ?p ?o } } }`;
  const checks = [validation('work-shape',[work]), validation('main-version-shape',[main])];
  const created = await command(createReceipt,'create',createUpdate,checks);
  expect(created).toEqual({status:'committed',position:{datasetId:dataset,dataEpoch:epoch,sequence:'0'}});
  expect(await command(createReceipt,'create',createUpdate,checks)).toEqual(created);
  const textQuery = (term: string) => `PREFIX text: <http://jena.apache.org/text#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ASK { GRAPH <${current}> { ?s text:query (rdfs:label "${term}") } }`;
  expect((await query(textQuery("P02BlueGarden"))).boolean).toBe(true);
  expect((await command(createReceipt,'other',createUpdate,checks)).status).toBe('conflict');
  const invalidReceipt = `urn:rezics:p02:${nonce}:invalid`;
  const invalid = await command(invalidReceipt,'invalid',`INSERT { GRAPH <${current}> { <${work}> <${rv}mainVersion> <urn:broken> ; <http://www.w3.org/2000/01/rdf-schema#label> "P02AbortedGarden"@en . } ${receiptTriples(invalidReceipt,'invalid','1')} } WHERE { FILTER NOT EXISTS { GRAPH <${receipts}> { <${invalidReceipt}> ?p ?o } } }`, checks);
  expect(invalid.status).toBe('invalid');
  expect(invalid.report).toContain("Violation");
  const unknown = await command(`urn:rezics:p02:${nonce}:unknown`, "unknown", `INSERT { ${receiptTriples(`urn:rezics:p02:${nonce}:unknown`,"unknown","1")} } WHERE { FILTER NOT EXISTS { GRAPH <${receipts}> { <urn:rezics:p02:${nonce}:unknown> ?p ?o } } }`,
    [{...checks[0]!, sha256: "0".repeat(64)}]);
  expect(unknown.status).toBe("unknown-profile");
  expect((await query(`ASK { GRAPH <${receipts}> { <${invalidReceipt}> ?p ?o } }`)).boolean).toBe(false);
  expect((await query(textQuery("P02AbortedGarden"))).boolean).toBe(false);
  const noGuardReceipt = `urn:rezics:p02:${nonce}:no-guard`;
  const noGuard = await command(noGuardReceipt,'no-guard',`INSERT { GRAPH <${current}> { <urn:none> <urn:p> <urn:o> } ${receiptTriples(noGuardReceipt,'no-guard','1')} } WHERE { FILTER(false) }`);
  expect(noGuard.status).toBe('guard-unmatched');
  const stale = `urn:rezics:p02:${nonce}:race-a`;
  const other = `urn:rezics:p02:${nonce}:race-b`;
  const swap = (receipt:string,digest:string,next:string) => `PREFIX rv: <${rv}> DELETE { GRAPH <${control}> { <${dataset}> rv:head <${main}> ; rv:sequence 0 } } INSERT { GRAPH <${control}> { <${dataset}> rv:head <${next}> ; rv:sequence 1 } ${receiptTriples(receipt,digest,'1')} } WHERE { GRAPH <${control}> { <${dataset}> rv:head <${main}> ; rv:sequence 0 } FILTER NOT EXISTS { GRAPH <${receipts}> { <${receipt}> ?p ?o } } }`;
  const results = await Promise.all([command(stale,'race-a',swap(stale,'race-a','urn:next-a')),command(other,'race-b',swap(other,'race-b','urn:next-b'))]);
  expect(results.map(result=>result.status).sort()).toEqual(['committed','guard-unmatched']);
});

test('SYS02/MODEL17: command rejects omitted shape coverage and arbitrary write scope', async () => {
  const omittedReceipt = `urn:rezics:p02:${nonce}:omitted`;
  const omitted = await command(omittedReceipt, 'omitted', `INSERT {
    GRAPH <${current}> { <urn:rezics:p02:${nonce}:unvalidated> a <https://schema.org/CreativeWork> . }
    ${receiptTriples(omittedReceipt, 'omitted', '2')}
  } WHERE { FILTER NOT EXISTS { GRAPH <${receipts}> { <${omittedReceipt}> ?p ?o } } }`);
  expect(omitted.status).toBe('invalid');
  expect((await query(`ASK { GRAPH <${receipts}> { <${omittedReceipt}> ?p ?o } }`)).boolean).toBe(false);

  const hidden = `urn:rezics:p02:${nonce}:hidden`;
  const underReceipt = `urn:rezics:p02:${nonce}:underdeclared`;
  const under = await command(underReceipt, 'underdeclared', `INSERT {
    GRAPH <${current}> { <${hidden}> a <https://schema.org/CreativeWork> . }
    ${receiptTriples(underReceipt, 'underdeclared', '2')}
  } WHERE { FILTER NOT EXISTS { GRAPH <${receipts}> { <${underReceipt}> ?p ?o } } }`, [validation('work-shape', [work])]);
  expect(under.status).toBe('invalid');
  expect(under.report).toContain('focus omitted');
  expect((await query(`ASK { GRAPH <${current}> { <${hidden}> ?p ?o } }`)).boolean).toBe(false);

  const weakWork = `urn:rezics:p02:${nonce}:weak-work`;
  const weakReceipt = `urn:rezics:p02:${nonce}:weak-shape`;
  const weak = await command(weakReceipt, 'weak-shape', `INSERT {
    GRAPH <${current}> { <${weakWork}> a <https://schema.org/CreativeWork> ; <${rv}mainVersion> <urn:missing> . }
    ${receiptTriples(weakReceipt, 'weak-shape', '2')}
  } WHERE { FILTER NOT EXISTS { GRAPH <${receipts}> { <${weakReceipt}> ?p ?o } } }`, [{profile: weakProfile.id, sha256: weakProfile.sha256,
    shape: 'https://rezics.com/definition/classification-direct-decision-v1/work-shape',
    focus: [weakWork], graphs: [current]}]);
  expect(weak.status).toBe('invalid');
  expect((await query(`ASK { GRAPH <${current}> { <${weakWork}> ?p ?o } }`)).boolean).toBe(false);

  const forbiddenReceipt = `urn:rezics:p02:${nonce}:forbidden`;
  const response = await fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt: forbiddenReceipt, digest: 'forbidden', validations: [],
      update: `INSERT { GRAPH <urn:rezics:graph:unowned> { <urn:x> <urn:y> <urn:z> . } ${receiptTriples(forbiddenReceipt, 'forbidden', '2')} } WHERE { FILTER(true) }` }) });
  expect(response.status).toBe(400);
  expect((await response.json() as {status:string}).status).toBe('bad-request');

  const unguarded = await fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt: forbiddenReceipt, digest: 'unguarded', validations: [],
      update: `INSERT DATA { ${receiptTriples(forbiddenReceipt, 'unguarded', '2')} }` }) });
  expect(unguarded.status).toBe(400);

  const second = await fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt: forbiddenReceipt, digest: 'multi', validations: [],
      update: `INSERT DATA { ${receiptTriples(forbiddenReceipt, 'multi', '2')} }; INSERT DATA { GRAPH <${control}> { <${dataset}> <urn:unsafe> true } }` }) });
  expect(second.status).toBe(400);
});

test('SYS09: disposable QA Fuseki retains raw fixture updates', async () => {
  const graph = `urn:rezics:p02:${nonce}:fixture`;
  const response = await fetch(`${base}/update`, {method:'POST', headers:{'content-type':'application/sparql-update'},
    body:`INSERT DATA { GRAPH <${graph}> { <urn:fixture> <urn:probe> <urn:ok> } }`});
  expect(response.ok).toBe(true);
  expect((await query(`ASK { GRAPH <${graph}> { <urn:fixture> <urn:probe> <urn:ok> } }`)).boolean).toBe(true);
});

test('SYS02: product assembler has no raw write operation', async () => {
  const product = await Bun.file(new URL('../fuseki-text.ttl', import.meta.url)).text();
  const fixture = await Bun.file(new URL('../fuseki-text-qa.ttl', import.meta.url)).text();
  expect(product).not.toContain('fuseki:serviceUpdate');
  expect(product).not.toContain('fuseki:serviceReadWriteGraphStore');
  expect(fixture).toContain('fuseki:serviceUpdate "update"');
});
