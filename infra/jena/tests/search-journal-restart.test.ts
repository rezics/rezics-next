import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fusekiImageTag } from '../../../scripts/dev/fuseki-image.ts';
import manifest from '../../../generated/model/manifest.json';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { buildPinnedContentPublicationUpdate, contentPublicationDecisionIri,
  contentPublicationDigest, contentPublicationReceiptIri,
  type PublishPinnedContentInput } from '../../../services/main/src/modules/content-publication/publish.ts';
import type { PublicationPreparation } from '../../../services/content/src/core.ts';

// A killed Fuseki process loses its in-memory search-journal baseline. The next
// process has to qualify the same volume, including a plain historical Jena
// body document or a newly admitted Content receipt with native source pins.

const root = resolve(import.meta.dir, '../../..');
const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
const builder = /^FROM (\S+) AS module$/m.exec(dockerfile)?.[1];
const fusekiVersion = /^ARG FUSEKI_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
if (!builder || !fusekiVersion) throw new Error('Fuseki Dockerfile no longer pins the builder and version');
const jarInImage = `/opt/apache-jena-fuseki-${fusekiVersion}/fuseki-server.jar`;
const PLAIN_UNIT = 'urn:rezics:match:restart';
const CONTENT_UNIT = `urn:rezics:content:match-unit:${'d'.repeat(64)}`;
const PUBLICATION_DATA_EPOCH = '00000000-0000-4000-8000-000000000004';

const seed = `
package com.rezics.jena;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.*;
import org.apache.jena.query.*;
import org.apache.jena.query.text.Entity;
import org.apache.jena.rdf.model.*;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.system.Txn;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.document.*;
import org.apache.lucene.index.IndexOptions;
import org.apache.lucene.index.Term;

public class SearchJournalSeed {
  static final String RV = "https://rezics.com/vocab/";
  static final String CONTROL = "urn:rezics:graph:control";
  static final String CURRENT = "urn:rezics:graph:current";
  static final String REVISIONS = "urn:rezics:graph:revisions";
  static final String RECEIPTS = "urn:rezics:graph:receipts";
  static final String PUBLIC = "urn:rezics:search:public";
  static final String PRODUCT = "urn:rezics:dataset:product";
  static final String ANCHOR = "urn:rezics:search:public:anchor";
  static final String DATA_EPOCH = "${PUBLICATION_DATA_EPOCH}";
  static final String GENERATION = "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111";
  static final String CONTENT = "${CONTENT_UNIT}";
  static final String VARIANT = "urn:rezics:test:content:variant";
  static final String RESOURCE = "urn:rezics:test:content:work";
  static final String PUBLICATION = "urn:rezics:test:content:publication";
  static final String ELIGIBILITY = "urn:rezics:test:content:eligibility";
  static final String REVISION = "urn:rezics:content:revision:00000000-0000-4000-8000-000000000001";
  static final String PROJECTION = "urn:rezics:test:content:projection:1";
  static final String RECEIPT = "urn:rezics:test:content:receipt:1";

  public static void main(String[] args) throws Exception {
    CommandModule.registerTextAssembler();
    Model config = RDFDataMgr.loadModel("/fuseki/fuseki-text.ttl");
    Resource kind = config.createResource("http://jena.apache.org/text#TextDataset");
    Resource root = config.listSubjectsWithProperty(RDF.type, kind).next();
    Dataset dataset = DatasetFactory.assemble(root);
    try {
      Txn.executeWrite(dataset, () -> {
        write(dataset.asDatasetGraph(), args[0]);
        if (args[0].equals("publication-delete"))
          SearchDeltaJournal.retainContentReceiptSource(dataset.asDatasetGraph(), RECEIPT);
      });
      if (args[0].equals("legacy")) {
        installLegacyBody(dataset.asDatasetGraph());
        markRankSchema(dataset.asDatasetGraph());
      }
    } finally { dataset.close(); }
  }

  static void write(org.apache.jena.sparql.core.DatasetGraph data, String mode) {
    String dataEpoch = mode.equals("publication-delete") ? DATA_EPOCH : "epoch";
    data.add(uri(CONTROL), uri(PRODUCT), uri(RV + "dataEpoch"), NodeFactory.createLiteralString(dataEpoch));
    data.add(uri(CONTROL), uri(PRODUCT), uri(RV + "routingEpoch"), NodeFactory.createLiteralString("routing"));
    data.add(uri(CONTROL), uri(PRODUCT), uri(RV + "sequence"),
      NodeFactory.createLiteralByValue(0, XSDDatatype.XSDinteger));
    iri(data, CONTROL, PRODUCT, RV + "textIndexGeneration", GENERATION);
    iri(data, PUBLIC, ANCHOR, RDF.type.getURI(), RV + "SearchGraphAnchor");
    if (mode.equals("plain")) {
      iri(data, PUBLIC, "${PLAIN_UNIT}", RDF.type.getURI(), RV + "MatchUnit");
      data.add(uri(PUBLIC), uri("${PLAIN_UNIT}"), uri(RV + "searchBody"),
        NodeFactory.createLiteralLang("restarttoken selected body", "en"));
      return;
    }
    if (!mode.equals("legacy") && !mode.equals("publication-delete")) throw new IllegalArgumentException(mode);
    if (mode.equals("publication-delete")) {
      iri(data, CURRENT, RESOURCE, RDF.type.getURI(), "https://schema.org/CreativeWork");
      iri(data, CURRENT, RESOURCE, RV + "head", "urn:rezics:test:content:work-head");
    }
    iri(data, CURRENT, VARIANT, RDF.type.getURI(), RV + "ContentVariant");
    iri(data, CURRENT, VARIANT, RV + "resource", RESOURCE);
    iri(data, CURRENT, VARIANT, RV + "contentPublicationHead", PUBLICATION);
    iri(data, CURRENT, VARIANT, RV + "publicSearchEligibilityHead", ELIGIBILITY);
    iri(data, REVISIONS, PUBLICATION, RDF.type.getURI(), RV + "ContentPublicationDecision");
    iri(data, REVISIONS, PUBLICATION, RV + "component", VARIANT);
    iri(data, REVISIONS, PUBLICATION, RV + "resource", RESOURCE);
    iri(data, REVISIONS, PUBLICATION, RV + "contentRevision", REVISION);
    data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "byteDigest"), NodeFactory.createLiteralString("b".repeat(64)));
    data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "ownerDataEpoch"),
      NodeFactory.createLiteralString("00000000-0000-4000-8000-000000000002"));
    iri(data, REVISIONS, ELIGIBILITY, RDF.type.getURI(), RV + "ContentSearchEligibilityDecision");
    iri(data, REVISIONS, ELIGIBILITY, RV + "variant", VARIANT);
    iri(data, REVISIONS, ELIGIBILITY, RV + "resource", RESOURCE);
    iri(data, REVISIONS, ELIGIBILITY, RV + "publicationDecision", PUBLICATION);
    iri(data, REVISIONS, ELIGIBILITY, RV + "disclosure", RV + "Public");
    iri(data, REVISIONS, PROJECTION, RDF.type.getURI(), RV + "ContentProjection");
    iri(data, REVISIONS, PROJECTION, RV + "matchUnit", CONTENT);
    iri(data, REVISIONS, PROJECTION, RV + "component", VARIANT);
    iri(data, REVISIONS, PROJECTION, RV + "resource", RESOURCE);
    iri(data, REVISIONS, PROJECTION, RV + "contentRevision", REVISION);
    iri(data, REVISIONS, PROJECTION, RV + "publicationDecision", PUBLICATION);
    iri(data, REVISIONS, PROJECTION, RV + "eligibility", ELIGIBILITY);
    iri(data, REVISIONS, PROJECTION, RV + "modelRevision", "https://rezics.com/definition/content-match-unit-v1");
    if (mode.equals("publication-delete")) {
      iri(data, REVISIONS, PUBLICATION, RDF.type.getURI(), RV + "RevisionAnchor");
      iri(data, REVISIONS, PUBLICATION, RV + "operation", "urn:rezics:operation:" + "a".repeat(64));
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "contentPreparation"), NodeFactory.createLiteralString("prepared"));
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "contentFormat"), NodeFactory.createLiteralString("rezics-content-json-v1"));
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "contentModel"), NodeFactory.createLiteralString("plain-text-v1"));
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "contentLanguageKind"), NodeFactory.createLiteralString("missing"));
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "contentDirection"), NodeFactory.createLiteralString("none"));
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "ownerSequence"), NodeFactory.createLiteralString("1"));
      iri(data, REVISIONS, PUBLICATION, RV + "modelRevision", "https://rezics.com/definition/content-publication-v1");
      iri(data, REVISIONS, PUBLICATION, RV + "shapeRevision", "https://rezics.com/definition/content-publication-v1");
      iri(data, REVISIONS, PUBLICATION, RV + "datasetId", PRODUCT);
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "dataEpoch"), NodeFactory.createLiteralString(DATA_EPOCH));
      data.add(uri(REVISIONS), uri(PUBLICATION), uri(RV + "sequence"),
        NodeFactory.createLiteralByValue(1, XSDDatatype.XSDinteger));

      iri(data, REVISIONS, ELIGIBILITY, RDF.type.getURI(), RV + "RevisionAnchor");
      iri(data, REVISIONS, ELIGIBILITY, RV + "component", VARIANT);
      iri(data, REVISIONS, ELIGIBILITY, RV + "rightsBasis", RV + "OriginalContribution");
      data.add(uri(REVISIONS), uri(ELIGIBILITY), uri(RV + "admissionId"),
        NodeFactory.createLiteralString("00000000-0000-4000-8000-000000000003"));
      data.add(uri(REVISIONS), uri(ELIGIBILITY), uri(RV + "authorityEpoch"), NodeFactory.createLiteralString("0"));
      data.add(uri(REVISIONS), uri(ELIGIBILITY), uri(RV + "admittedScope"),
        NodeFactory.createLiteralString("content:search-eligibility:" + VARIANT));
      iri(data, REVISIONS, ELIGIBILITY, RV + "actingSubject", "urn:rezics:test:actor");
      iri(data, REVISIONS, ELIGIBILITY, RV + "modelRevision", "https://rezics.com/definition/content-search-eligibility-v1");
      iri(data, REVISIONS, ELIGIBILITY, RV + "shapeRevision", "https://rezics.com/definition/content-search-eligibility-v1");
      iri(data, REVISIONS, ELIGIBILITY, RV + "datasetId", PRODUCT);
      data.add(uri(REVISIONS), uri(ELIGIBILITY), uri(RV + "dataEpoch"), NodeFactory.createLiteralString(DATA_EPOCH));
      data.add(uri(REVISIONS), uri(ELIGIBILITY), uri(RV + "sequence"),
        NodeFactory.createLiteralByValue(1, XSDDatatype.XSDinteger));

      iri(data, REVISIONS, PROJECTION, RDF.type.getURI(), RV + "RevisionAnchor");
      iri(data, REVISIONS, PROJECTION, RV + "shapeRevision", "https://rezics.com/definition/content-match-unit-v1");
      iri(data, REVISIONS, PROJECTION, RV + "datasetId", PRODUCT);
      data.add(uri(REVISIONS), uri(PROJECTION), uri(RV + "ownerDataEpoch"),
        NodeFactory.createLiteralString("00000000-0000-4000-8000-000000000002"));
      data.add(uri(REVISIONS), uri(PROJECTION), uri(RV + "ownerSequence"), NodeFactory.createLiteralString("7"));
      data.add(uri(REVISIONS), uri(PROJECTION), uri(RV + "dataEpoch"), NodeFactory.createLiteralString(DATA_EPOCH));
      data.add(uri(REVISIONS), uri(PROJECTION), uri(RV + "sequence"),
        NodeFactory.createLiteralByValue(1, XSDDatatype.XSDinteger));
    }
    iri(data, PUBLIC, CONTENT, RDF.type.getURI(), RV + "MatchUnit");
    iri(data, PUBLIC, CONTENT, RV + "field", RV + "Body");
    iri(data, PUBLIC, CONTENT, RV + "disclosure", RV + "Public");
    data.add(uri(PUBLIC), uri(CONTENT), uri(RV + "language"), NodeFactory.createLiteralString("en"));
    iri(data, PUBLIC, CONTENT, RV + "variant", VARIANT);
    iri(data, PUBLIC, CONTENT, RV + "resource", RESOURCE);
    iri(data, PUBLIC, CONTENT, RV + "revision", REVISION);
    iri(data, PUBLIC, CONTENT, RV + "publicationDecision", PUBLICATION);
    iri(data, PUBLIC, CONTENT, RV + "eligibility", ELIGIBILITY);
    iri(data, PUBLIC, CONTENT, RV + "projection", PROJECTION);
    data.add(uri(PUBLIC), uri(CONTENT), uri(RV + "searchBody"),
      NodeFactory.createLiteralLang("legacytoken selected body", "en"));
    iri(data, RECEIPTS, RECEIPT, RDF.type.getURI(), RV + "OperationReceipt");
    iri(data, RECEIPTS, RECEIPT, RV + "outcome", RV + "Succeeded");
    iri(data, RECEIPTS, RECEIPT, RV + "variant", VARIANT);
    iri(data, RECEIPTS, RECEIPT, RV + "resource", RESOURCE);
    iri(data, RECEIPTS, RECEIPT, RV + "publicationDecision", PUBLICATION);
    iri(data, RECEIPTS, RECEIPT, RV + "eligibility", ELIGIBILITY);
    iri(data, RECEIPTS, RECEIPT, RV + "projection", PROJECTION);
    iri(data, RECEIPTS, RECEIPT, RV + "matchUnit", CONTENT);
    iri(data, RECEIPTS, RECEIPT, RV + "contentRevision", REVISION);
  }

  static void installLegacyBody(org.apache.jena.sparql.core.DatasetGraph data) throws Exception {
    var text = (org.apache.jena.query.text.DatasetGraphText) data;
    var lucene = ((FilteredGraphTextIndex) text.getTextIndex()).lucene();
    // Today's assembler decorates new documents with rank/source fields. The
    // historical compatibility case must actually contain the old plain row.
    lucene.getIndexWriter().deleteDocuments(new Term("uri", CONTENT));
    var body = new Entity(CONTENT, PUBLIC, "en", null);
    body.put("body", "legacytoken selected body");
    lucene.addEntity(body);
    lucene.commit();
  }

  static void markRankSchema(org.apache.jena.sparql.core.DatasetGraph data) throws Exception {
    if (!(data instanceof org.apache.jena.query.text.DatasetGraphText text)
      || !(text.getTextIndex() instanceof FilteredGraphTextIndex filtered))
      throw new IllegalStateException("assembled index is not the filtered text index");
    FieldType keyword = new FieldType();
    keyword.setTokenized(false);
    keyword.setStored(true);
    keyword.setIndexOptions(IndexOptions.DOCS);
    keyword.setOmitNorms(false);
    keyword.freeze();
    FieldType unstored = new FieldType(keyword);
    unstored.setStored(false);
    unstored.freeze();
    var neighbor = new Document();
    neighbor.add(new Field("uri", "urn:rezics:rank-schema-neighbor", keyword));
    neighbor.add(new Field("graph", PUBLIC, keyword));
    neighbor.add(new Field(FilteredGraphTextIndex.RANK_SCHEMA, "1", unstored));
    filtered.lucene().getIndexWriter().addDocument(neighbor);
    filtered.lucene().commit();
  }

  static void iri(org.apache.jena.sparql.core.DatasetGraph data, String graph, String subject, String predicate, String object) {
    if (object == null) return;
    data.add(uri(graph), uri(subject), uri(predicate), uri(object));
  }
  static Node uri(String value) { return NodeFactory.createURI(value); }
}
`;

function run(command: string, args: string[], timeout = 120_000) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function token() { return randomBytes(32).toString('hex'); }

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('no free port')); return; }
      server.close(() => resolvePort(address.port));
    });
  });
}

let queue = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job, job);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function restart(mode: 'plain' | 'legacy' | 'publication-delete', word: string, unit: string) {
  const image = fusekiImageTag(root);
  const inspect = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
  if (inspect.status !== 0) throw new Error(`build ${image} first`);
  const work = mkdtempSync(join(root, `.temp/search-journal-restart-${mode}-`));
  const databases = join(work, 'databases');
  mkdirSync(join(databases, 'rezics/tdb2'), { recursive: true });
  mkdirSync(join(databases, 'rezics/lucene'), { recursive: true });
  chmodSync(databases, 0o777);
  const name = `search-journal-restart-${process.pid}-${mode}`;
  const user = `${process.getuid!()}:${process.getgid!()}`;
  const logs = () => {
    const recorded = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
    return `${recorded.stdout ?? ''}${recorded.stderr ?? ''}`;
  };
  try {
    writeFileSync(join(work, 'SearchJournalSeed.java'), seed);
    const created = `search-journal-jars-${process.pid}-${mode}`;
    run('docker', ['create', '--name', created, image]);
    try {
      run('docker', ['cp', `${created}:${jarInImage}`, join(work, 'fuseki-server.jar')]);
      run('docker', ['cp', `${created}:/fuseki/extra/fuseki-command.jar`, join(work, 'fuseki-command.jar')]);
    } finally { spawnSync('docker', ['rm', created]); }
    mkdirSync(join(work, 'classes'));
    run('docker', ['run', '--rm', '--user', user, '--entrypoint', 'javac', '--volume', `${work}:/work`, builder!,
      '--release', '21', '-cp', '/work/fuseki-server.jar:/work/fuseki-command.jar', '-d', '/work/classes',
      '/work/SearchJournalSeed.java']);
    run('docker', ['run', '--rm', '--user', user, '--entrypoint', 'java', '--workdir', '/fuseki',
      '--volume', `${databases}:/fuseki/databases`, '--volume', `${join(work, 'classes')}:/classes:ro`,
      '--env', 'FUSEKI_BASE=/fuseki', image,
      '-cp', `/classes:/fuseki/extra/fuseki-command.jar:${jarInImage}`, 'com.rezics.jena.SearchJournalSeed', mode]);

    const start = async () => {
      const port = await freePort();
      const commandToken = token();
      run('docker', ['run', '-d', '--name', name, '--user', user, '--memory', '1536m', '--memory-swap', '1536m',
        '--pids-limit', '256', '--publish', `127.0.0.1:${port}:3030`,
        '--volume', `${databases}:/fuseki/databases`,
        '--env', 'JVM_ARGS=-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m',
        '--env', `FUSEKI_MAINTENANCE_TOKEN=${token()}`,
        '--env', `FUSEKI_COMMAND_TOKEN=${commandToken}`,
        '--env', `FUSEKI_TITLE_ADMISSION_KEY=${token()}`,
        image]);
      return { port, commandToken };
    };
    const available = async (port: number) => {
      const deadline = Date.now() + 90_000;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/rezics/command?deltaSince=-1`);
          last = await response.text();
          if ((JSON.parse(last) as { available?: boolean }).available === true) return;
        } catch { /* the process is still opening the port */ }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
      }
      throw new Error(`qualification stayed closed:\n${last}\n${logs()}`);
    };
    const searchHits = async (port: number) => {
      const query = `PREFIX text: <http://jena.apache.org/text#>
PREFIX rv: <https://rezics.com/vocab/>
SELECT ?unit WHERE { GRAPH <urn:rezics:search:public> { (?unit ?score ?literal) text:query (rv:searchBody "${word}" 10) . } }`;
      const response = await fetch(`http://127.0.0.1:${port}/rezics/query`, {
        method: 'POST',
        headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/sparql-query' },
        body: query,
      });
      const payload = await response.text();
      if (!response.ok) throw new Error(`text query failed (${response.status}): ${payload}\n${logs()}`);
      const bindings = (JSON.parse(payload) as { results?: { bindings?: { unit?: { value?: string } }[] } })
        .results?.bindings ?? [];
      return bindings.map(binding => binding.unit?.value);
    };

    const seen = async (port: number) => expect(await searchHits(port)).toEqual([unit]);
    const noLongerIndexed = async (port: number) => expect(await searchHits(port)).toEqual([]);
    const ask = async (port: number, sparql: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/rezics/query`, {
        method: 'POST', headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/sparql-query' },
        body: sparql,
      });
      const payload = await response.text();
      if (!response.ok) throw new Error(`ASK failed (${response.status}): ${payload}\n${logs()}`);
      return (JSON.parse(payload) as { boolean?: boolean }).boolean === true;
    };
    const deleteReplacedPublication = async (port: number, commandToken: string) => {
      const input: PublishPinnedContentInput = { preparationId: `restart-publication-${randomUUID()}`,
        revisionId: randomUUID(), expectedDigest: 'e'.repeat(64),
        expectedContentEpoch: '00000000-0000-4000-8000-000000000002',
        resourceId: 'urn:rezics:test:content:work', variantId: 'urn:rezics:test:content:variant',
        expectedPublicationHead: 'urn:rezics:test:content:publication' };
      const requestDigest = contentPublicationDigest(input);
      const admissionId = randomUUID();
      const admission = { id: admissionId, principalId: randomUUID(), actingSubject: 'urn:rezics:test:actor',
        scope: `content:publish:${input.variantId}`, action: 'content.publish',
        idempotencyKey: `restart-publication-${admissionId}`, requestDigest,
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'registered' as const, dispatchEligible: true, replayed: false };
      const preparation: PublicationPreparation = { operationId: input.preparationId,
        reference: { owner: 'content', resourceId: input.resourceId, variantId: input.variantId,
          revisionId: input.revisionId, format: 'rezics-content-json-v1', model: 'plain-text-v1',
          byteDigest: input.expectedDigest, byteLength: 32,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
          sourceRevision: null, predecessor: null, provenance: { author: 'restart test' } },
        position: { owner: 'content', dataEpoch: input.expectedContentEpoch, sequence: '9' },
        status: 'pending', pinActive: true, replayed: false };
      const decision = contentPublicationDecisionIri(admissionId);
      const receipt = contentPublicationReceiptIri(admissionId);
      const env = { fuseki: new FusekiClient(`http://127.0.0.1:${port}/rezics`),
        lineage: { dataEpoch: PUBLICATION_DATA_EPOCH, routingEpoch: 'routing' }, objectDirectory: work };
      const update = buildPinnedContentPublicationUpdate(env, admission, input, preparation);
      const profile = manifest.profiles.find(entry => entry.id === 'content-publication-v1')!;
      const validations = [
        { profile: profile.id, sha256: profile.sha256,
          shape: 'https://rezics.com/definition/content-publication-v1/variant-shape',
          focus: [input.variantId], graphs: ['urn:rezics:graph:current'] },
        { profile: profile.id, sha256: profile.sha256,
          shape: 'https://rezics.com/definition/content-publication-v1/decision-shape',
          focus: [decision], graphs: ['urn:rezics:graph:revisions'] },
      ];
      const response = await fetch(`http://127.0.0.1:${port}/rezics/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${commandToken}` },
        body: JSON.stringify({ receipt, digest: requestDigest, update, validations, deadlineMs: 10_000 }),
      });
      const payload = await response.text();
      if (!response.ok) throw new Error(`publication command failed (${response.status}): ${payload}\n${logs()}`);
      const result = JSON.parse(payload) as { status?: string; report?: string };
      if (result.status !== 'committed')
        throw new Error(`publication command returned ${JSON.stringify(result)}\n${logs()}`);
      expect(await ask(port, `ASK { GRAPH <urn:rezics:search:public> { <${unit}> ?p ?o } }`)).toBe(false);
      expect(await ask(port, `ASK { GRAPH <urn:rezics:graph:current> {
        <urn:rezics:test:content:variant> <https://rezics.com/vocab/contentPublicationHead> <${decision}> ;
          <https://rezics.com/vocab/publicSearchEligibilityHead> <urn:rezics:test:content:eligibility> } }`)).toBe(true);
    };

    const first = await start();
    await available(first.port);
    await seen(first.port);
    if (mode === 'publication-delete') {
      await deleteReplacedPublication(first.port, first.commandToken);
      await noLongerIndexed(first.port);
    }
    run('docker', ['kill', '--signal', 'KILL', name]);
    run('docker', ['wait', name]);
    run('docker', ['rm', name]);
    const second = await start();
    await available(second.port);
    if (mode === 'publication-delete') {
      await noLongerIndexed(second.port);
      expect(await ask(second.port, `ASK { GRAPH <urn:rezics:search:public> { <${unit}> ?p ?o } }`)).toBe(false);
    } else await seen(second.port);
    const recorded = logs();
    expect(recorded).toContain('search journal baseline installed:');
    expect(recorded).not.toContain('original Content receipt source differs');
  } finally {
    spawnSync('docker', ['rm', '-f', name]);
    rmSync(work, { recursive: true, force: true });
  }
}

test('a killed Fuseki requalifies a public text unit and a text query still sees it', () =>
  exclusive(() => restart('plain', 'restarttoken', PLAIN_UNIT)), 240_000);

test('a killed Fuseki qualifies an unpinned content receipt whose stored body matches RDF', () =>
  exclusive(() => restart('legacy', 'legacytoken', CONTENT_UNIT)), 240_000);

test('a replacement publication deletion remains certified after Fuseki crashes and reopens', () =>
  exclusive(() => restart('publication-delete', 'legacytoken', CONTENT_UNIT)), 240_000);
