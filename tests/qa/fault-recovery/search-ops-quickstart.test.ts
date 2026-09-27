import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { fusekiImageTag } from '../../../scripts/dev/fuseki-image.ts';
import { docker, OFFLINE_INDEX_SCRIPT, sha256 } from '../../../scripts/operations/search-state.ts';
import { pinnedImage, requireFaultTier, root, standaloneFuseki } from './search-ops-support.ts';

const LABEL = 'REZICS launch atlas';
const SUBJECT = 'urn:rezics:smoke:book';
const GRAPH = 'urn:rezics:smoke';
const PREFIXES = `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX text: <http://jena.apache.org/text#>
`;
const QUICKSTART = 'infra/jena/fuseki-text-quickstart.ttl';

type Bindings = { [key: string]: { value: string; 'xml:lang'?: string } }[];

async function sparql(url: string, kind: 'query' | 'update', body: string): Promise<Bindings | boolean> {
  const response = await fetch(new URL(kind, url), { method: 'POST',
    headers: { 'content-type': `application/sparql-${kind}`, accept: 'application/sparql-results+json' },
    body: PREFIXES + body, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Fuseki ${kind} returned ${response.status}`);
  if (kind === 'update') return true;
  const json = await response.json() as { boolean?: boolean; results?: { bindings: Bindings } };
  return json.boolean ?? json.results!.bindings;
}

const graphLabels = (url: string) => sparql(url, 'query',
  `SELECT ?s ?label WHERE { GRAPH <${GRAPH}> { ?s rdfs:label ?label } }`) as Promise<Bindings>;
/** Joined text binding: masks a stale index entry whose RDF literal is gone. */
const joined = (url: string) => sparql(url, 'query', `SELECT ?s ?literal WHERE { GRAPH <${GRAPH}> {
  (?s ?score ?literal) text:query (rdfs:label "atlas" 10) . ?s rdfs:label ?literal . } }`) as Promise<Bindings>;
/** Independent deletion query: subject-bound, no RDF join and no global hit limit. */
const direct = (url: string) => sparql(url, 'query', `SELECT ?score ?literal WHERE { GRAPH <${GRAPH}> {
  (<${SUBJECT}> ?score ?literal) text:query (rdfs:label "atlas") . } }`) as Promise<Bindings>;
const anchor = (url: string) => sparql(url, 'query',
  `ASK { GRAPH <${GRAPH}> { <${SUBJECT}> <urn:rezics:smoke:probeAnchor> true } }`) as Promise<boolean>;

async function present(url: string) {
  const labels = await graphLabels(url);
  expect(labels).toHaveLength(1);
  expect(labels[0]).toMatchObject({ s: { value: SUBJECT }, label: { value: LABEL, 'xml:lang': 'en' } });
  const text = await joined(url);
  expect(text).toHaveLength(1);
  expect(text[0]).toMatchObject({ s: { value: SUBJECT }, literal: { value: LABEL } });
  expect(await direct(url)).toHaveLength(1);
  return { graphBindings: labels.length, joinedTextBindings: text.length };
}

async function deleted(url: string) {
  expect(await graphLabels(url)).toEqual([]);
  expect(await anchor(url)).toBe(true);
  expect(await joined(url)).toEqual([]);
  expect(await direct(url)).toEqual([]);
  return { remainingLabels: 0, anchorRetained: true, directTextBindings: 0 };
}

test('OPS14: pinned graph quickstart keeps RDF/text bindings across restart and an independent probe exposes stale deletion', async () => {
  const { runId, artifacts } = requireFaultTier();
  const env = loadDockerEnvironment();
  const image = pinnedImage();
  expect(image).toBe(fusekiImageTag(root));
  const volume = `rezics-qa-${runId}-quickstart`;
  const name = `rezics-qa-${runId}-quickstart`;
  const secrets = Object.fromEntries(['FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN',
    'FUSEKI_TITLE_ADMISSION_KEY'].map(key => [key, randomBytes(32).toString('hex')]));
  const evidence: Record<string, unknown> = { case: 'OPS14', image,
    assemblerSha256: sha256(readFileSync(join(root, QUICKSTART))), checks: {} };
  const checks = evidence.checks as Record<string, unknown>;
  docker(['volume', 'create', volume], env, 15_000);
  let server: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
  try {
    server = await standaloneFuseki(env, { name, image, volume, secrets,
      mounts: [`${join(root, QUICKSTART)}:/fuseki/quickstart.ttl:ro,Z`],
      command: ['/opt/apache-jena-fuseki-6.2.0/fuseki-server', '--port=3030', '--no-cors',
        '--timeout=10000', '--config=/fuseki/quickstart.ttl'] });
    const url = server.url;
    evidence.imageId = docker(['inspect', server.runner.container(), '--format', '{{.Image}}'], env, 10_000).trim();
    evidence.java = server.runner.exec('java -version 2>&1 | head -n 1').trim();
    expect(evidence.java).toMatch(/version "21\./);
    evidence.fusekiJarSha256 = server.runner.exec('sha256sum /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar').split(/\s+/)[0];
    expect(await direct(url)).toEqual([]);

    await sparql(url, 'update', `INSERT DATA { GRAPH <${GRAPH}> {
      <${SUBJECT}> rdfs:label "${LABEL}"@en ; <urn:rezics:smoke:probeAnchor> true . } }`);
    checks.insert = await present(url);

    server.runner.stop();
    await server.runner.start();
    checks.restart = await present(url);
    expect(server.runner.exec('ls -A /fuseki/databases/rezics')).not.toContain('lucene.uncertain');

    // Retain the pre-deletion index to manufacture a stale entry later.
    server.runner.stop();
    server.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock; flock -n 9
      rm -rf /fuseki/databases/stale-lucene && cp -a /fuseki/databases/rezics/lucene /fuseki/databases/stale-lucene`);
    await server.runner.start();

    await sparql(url, 'update', `DELETE DATA { GRAPH <${GRAPH}> { <${SUBJECT}> rdfs:label "${LABEL}"@en . } }`);
    checks.delete = await deleted(url);
    server.runner.stop();
    await server.runner.start();
    checks.deleteAfterRestart = await deleted(url);

    // Stale index, current RDF: the join hides the entry; the independent probe does not.
    server.runner.stop();
    server.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock; flock -n 9
      rm -rf /fuseki/databases/rezics/lucene && mv /fuseki/databases/stale-lucene /fuseki/databases/rezics/lucene`);
    await server.runner.start();
    expect(await graphLabels(url)).toEqual([]);
    expect(await joined(url)).toEqual([]);
    const stale = await direct(url);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.literal!.value).toBe(LABEL);
    checks.staleDetected = { joinedTextBindings: 0, directTextBindings: stale.length };

    // An empty-index offline rebuild from current RDF removes the stale entry.
    server.runner.stop();
    const rebuild = server.runner.offline(OFFLINE_INDEX_SCRIPT.replace('--desc=/fuseki/fuseki-text.ttl',
      '--desc=/fuseki/quickstart.ttl'));
    expect(rebuild).toMatch(/textindexer/);
    await server.runner.start();
    checks.rebuilt = await deleted(url);

    await sparql(url, 'update', `DROP SILENT GRAPH <${GRAPH}>`);
    expect(await anchor(url)).toBe(false);
    evidence.result = 'pass';
  } finally {
    server?.remove();
    spawnSync('docker', ['volume', 'rm', '-f', volume], { env, timeout: 60_000 });
    writeFileSync(join(artifacts, 'search-ops-quickstart.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}, 420_000);
