import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../../generated/model/manifest.json';
import { nativeFixtures } from './fixtures/native/index.ts';

const root = resolve(import.meta.dir, '../..');
const current = 'urn:rezics:graph:current';
const receipts = 'urn:rezics:graph:receipts';
const rv = 'https://rezics.com/vocab/';
const base = process.env.FUSEKI_URL?.replace(/\/$/, '');

type Outcome = { status: string; report?: string };
type Mismatch = { profile: string; case: string; expected: boolean; status: string; reason: string; report?: string };
type PathDifference = { profile: string; case: string; expectedPath: string; report?: string };

function evidencePath(id: string): string {
  const name = id === 'work-metadata-v1' ? 'work-profile' : `${id.slice(0, -3)}-profile`;
  return resolve(root, `model/tests/evidence/2026-09-24-${name}.json`);
}

function sparqlData(turtle: string): { prefixes: string; body: string } {
  const prefixes: string[] = [];
  const body: string[] = [];
  for (const line of turtle.split('\n')) {
    const match = /^@prefix\s+([A-Za-z][A-Za-z0-9_-]*):\s+<([^>]+)>\s*\.\s*$/.exec(line);
    if (match) prefixes.push(`PREFIX ${match[1]}: <${match[2]}>`);
    else body.push(line);
  }
  return { prefixes: prefixes.join('\n'), body: body.join('\n') };
}

async function update(baseUrl: string, sparql: string): Promise<void> {
  const response = await fetch(`${baseUrl}/update`, {
    method: 'POST', headers: { 'content-type': 'application/sparql-update' }, body: sparql,
  });
  if (!response.ok) throw new Error(`QA fixture update ${response.status}: ${await response.text()}`);
}

async function receiptExists(baseUrl: string, receipt: string): Promise<boolean> {
  const ask = `ASK { GRAPH <${receipts}> { <${receipt}> ?p ?o } }`;
  const response = await fetch(`${baseUrl}/query?query=${encodeURIComponent(ask)}`, {
    headers: { accept: 'application/sparql-results+json' },
  });
  if (!response.ok) throw new Error(`Receipt query ${response.status}: ${await response.text()}`);
  return Boolean((await response.json() as { boolean: boolean }).boolean);
}

function pathIri(hint: string): string {
  const [prefix, local] = hint.split(':');
  const namespace: Record<string, string> = {
    rv, rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    skos: 'http://www.w3.org/2004/02/skos/core#',
  };
  return namespace[prefix ?? ''] ? `${namespace[prefix!]}${local}` : hint;
}

/** This is a diagnostic until command validation can accept exact focus/link bindings. */
export async function runNativeEquivalence(baseUrl: string): Promise<{
  moduleVersion: string; mismatches: Mismatch[]; pathDifferences: PathDifference[];
}> {
  const healthResponse = await fetch(`${baseUrl}/command`);
  if (!healthResponse.ok) throw new Error(`Command health ${healthResponse.status}`);
  const health = await healthResponse.json() as { moduleVersion: string; profiles: Record<string, string> };
  const mismatches: Mismatch[] = [];
  const pathDifferences: PathDifference[] = [];
  const nonce = crypto.randomUUID();
  let index = 0;
  for (const fixture of nativeFixtures) {
    if (health.profiles[fixture.id] !== fixture.sha256) {
      throw new Error(`Command image has wrong ${fixture.id} digest: ${health.profiles[fixture.id]}`);
    }
    for (const [name, candidate] of Object.entries(fixture.cases)) {
      const receipt = `urn:rezics:model-equivalence:${nonce}:${index++}`;
      const digest = `${fixture.id}:${name}`;
      await update(baseUrl, `CLEAR SILENT GRAPH <${current}>`);
      const data = sparqlData(candidate.turtle);
      await update(baseUrl, `${data.prefixes}\nINSERT DATA { GRAPH <${current}> { ${data.body} } }`);
      const command = `PREFIX rv: <${rv}> INSERT { GRAPH <${receipts}> {
        <${receipt}> rv:requestDigest ${JSON.stringify(digest)} ;
          rv:datasetId <urn:rezics:model-equivalence:dataset> ; rv:dataEpoch "native-matrix" ; rv:sequence 0 .
      } } WHERE { FILTER NOT EXISTS { GRAPH <${receipts}> { <${receipt}> ?p ?o } } }`;
      const response = await fetch(`${baseUrl}/command`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ receipt, digest, update: command, deadlineMs: 10000,
          validations: candidate.focus.map(item => ({ profile: fixture.id, sha256: fixture.sha256,
            shape: item.shape, focus: [item.focus], graphs: [current] })) }),
      });
      const outcome = await response.json() as Outcome;
      const actual = response.ok && outcome.status === 'committed';
      const recorded = Boolean(candidate.expected);
      const exists = await receiptExists(baseUrl, receipt);
      let reason = '';
      if (actual !== recorded) reason = 'conformance outcome differs';
      else if (exists !== actual) reason = 'receipt does not match transaction outcome';
      if (reason) mismatches.push({ profile: fixture.id, case: name, expected: recorded,
        status: outcome.status, reason, report: outcome.report?.slice(0, 500) });
      if (!recorded && candidate.pathHint && outcome.status === 'invalid'
        && !outcome.report?.includes(pathIri(candidate.pathHint))) {
        pathDifferences.push({ profile: fixture.id, case: name,
          expectedPath: pathIri(candidate.pathHint), report: outcome.report?.slice(0, 500) });
      }
    }
  }
  return { moduleVersion: health.moduleVersion, mismatches, pathDifferences };
}

test('P0.3: TypeScript candidate fixtures preserve all recorded profile digests and outcomes', () => {
  expect(nativeFixtures).toHaveLength(12);
  let cases = 0;
  for (const fixture of nativeFixtures) {
    const evidence = JSON.parse(readFileSync(evidencePath(fixture.id), 'utf8')) as {
      profile_sha256: string; outcomes: Record<string, { conforms: boolean }>;
    };
    const published = manifest.profiles.find(item => item.id === fixture.id);
    expect(published?.sha256).toBe(evidence.profile_sha256);
    expect(fixture.sha256).toBe(evidence.profile_sha256);
    expect(Object.keys(fixture.cases).sort()).toEqual(Object.keys(evidence.outcomes).sort());
    for (const [name, candidate] of Object.entries(fixture.cases)) {
      expect(candidate.expected).toBe(evidence.outcomes[name]!.conforms);
      expect(candidate.focus.length).toBeGreaterThan(0);
      expect(candidate.turtle.length).toBeGreaterThan(0);
      cases++;
    }
  }
  expect(cases).toBe(66);
});

const nativeTest = process.env.MODEL_NATIVE_EQUIVALENCE === '1' && base ? test : test.skip;
nativeTest('P0.3 diagnostic: generated profiles through the native command module match recorded candidates', async () => {
  const result = await runNativeEquivalence(base!);
  const reportPath = resolve(root, '.temp/native-equivalence-result.json');
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`P0.3 native matrix ${result.moduleVersion}: ${66 - result.mismatches.length}/66 outcomes matched, ${result.pathDifferences.length} violation paths absent from bounded reports; ${reportPath}`);
  if (process.env.MODEL_NATIVE_EQUIVALENCE_STRICT === '1') {
    expect(result.mismatches).toEqual([]);
    expect(result.pathDifferences).toEqual([]);
  }
});
