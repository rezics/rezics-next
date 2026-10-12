import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { personProfileErasureUpdate, personProfileGraphErased,
  type PersonProfileGraphInventory } from '../src/modules/agent/erasure.ts';
import type { PersonProfileErasureProof } from '../src/modules/access/person-profile-erasure.ts';
import { DATASET, GRAPHS, RV } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const resource = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const person = resource(1);
const provision = `https://rezics.com/id/${uuid(2)}-agent-revision`;
const head = resource(3);
const older = resource(4);
const work = resource(8);
const credit = resource(9);
const foreignWork = resource(10);
const foreignUnit = resource(11);
const authorUnit = resource(12);
const directUnit = 'urn:rezics:search:name:agent:00000000-0000-4000-8000-000000000001';
const prefixEntry = 'urn:rezics:search:directory:prefix:RXhhY3Q:*:1fixture';
const publicGraph = 'urn:rezics:search:public';
const manifest = `urn:rezics:sha256:${'a'.repeat(64)}`;
const proof: PersonProfileErasureProof = { person, provisionId: uuid(2), principalId: uuid(20),
  erasureId: uuid(21), accountErasureId: uuid(22), erasureEpoch: '7', deletionIntentId: uuid(23),
  deletionEnforcementEpoch: '1', subjectEpoch: '2' };
const lineage = { dataEpoch: 'person-native-fixture', routingEpoch: '1' };
const inventory: PersonProfileGraphInventory = { person, provisionId: uuid(2), head, profileHead: head,
  revisions: [{ revision: provision, manifest }, { revision: older, manifest: null },
    { revision: head, manifest: null }], objects: [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`],
  units: [{ graph: publicGraph, unit: directUnit }], authorUnits: [prefixEntry, authorUnit],
  creditedWorks: [work] };

// ARQ executes the exact TypeScript command and completion query. Native
// typed-footprint admission is a separate step; this test proves their RDF effect.
test('Person command and completion query execute against retained TDB2 data', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const build = mkdtempSync(join(root, '.temp/person-profile-native-'));
  const cache = join(root, '.temp/erasure-campaign-maven-cache');
  mkdirSync(cache, { recursive: true });
  const image = /^FROM (\S+) AS module$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!image) throw new Error('Pinned native builder missing');
  const module = join(root, 'infra/jena/command-module');
  cpSync(join(module, 'pom.xml'), join(build, 'pom.xml'));
  cpSync(join(module, 'src/main'), join(build, 'src/main'), { recursive: true });
  const java = join(build, 'src/test/java/com/rezics/jena');
  mkdirSync(java, { recursive: true });
  mkdirSync(join(build, 'tmp'));
  const cases: [string, PersonProfileGraphInventory][] = [
    ['complete', inventory],
    ['omitted', { ...inventory, revisions: inventory.revisions.filter(value => value.revision !== older) }],
    ['foreign', { ...inventory, units: [{ graph: publicGraph, unit: foreignUnit }] }],
  ];
  for (const [name, targets] of cases) {
    let completion = '';
    await personProfileGraphErased({ query: async query => {
      completion = query;
      return { boolean: false };
    } }, proof, targets);
    writeFileSync(join(build, `${name}.json`), JSON.stringify({
      update: personProfileErasureUpdate(lineage, proof, targets), completion,
    }));
  }
  writeFileSync(join(build, 'fixture.trig'), `@prefix rv: <${RV}> .
@prefix schema: <https://schema.org/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${GRAPHS.control}> { <${DATASET}> rv:dataEpoch "${lineage.dataEpoch}" ; rv:routingEpoch "1" ; rv:sequence 1 . }
<${GRAPHS.current}> {
  <${person}> a rv:Agent ; rv:agentKind rv:PersonAgent ; rv:head <${head}> ; rv:publicProfileHead <${head}> ;
    rdfs:label "Exact identifying name" ; schema:name "Exact identifying name" ; rv:profileBio "Identifying biography" .
  <${credit}> a rv:NativeAgentCredit ; rv:agent <${person}> ; rv:work <${work}> ; schema:roleName "author" .
  <${work}> a schema:CreativeWork ; rdfs:label "Surviving Work" .
  <${foreignWork}> a schema:CreativeWork ; rdfs:label "Unrelated Work" .
}
<${GRAPHS.revisions}> {
  <${provision}> a rv:RevisionAnchor ; rv:component <${person}> ;
    rv:modelRevision <https://rezics.com/definition/agent-provision-v1> ;
    rv:operation <urn:rezics:operation:agent-provision:${uuid(2)}> ; rv:manifest <${manifest}> ; rdfs:label "Original identifying name" .
  <${older}> a rv:RevisionAnchor, rv:AgentPublicProfileRevision ; rv:component <${person}> ;
    rv:modelRevision <https://rezics.com/definition/agent-profile-v2> ;
    rv:operation <urn:rezics:operation:agent-profile:${uuid(4)}> ; schema:name "Historical identifying name" ; rv:profileBio "Historical identifying biography" .
  <${head}> a rv:RevisionAnchor, rv:AgentPublicProfileRevision ; rv:component <${person}> ;
    rv:modelRevision <https://rezics.com/definition/agent-profile-v2> ;
    rv:operation <urn:rezics:operation:agent-profile:${uuid(3)}> ; schema:name "Exact identifying name" .
}
<${publicGraph}> {
  <${directUnit}> a rv:MatchUnit ; rv:nameResource <${person}> ; rv:publicTitle "Exact identifying name" .
  <${foreignUnit}> a rv:MatchUnit ; rv:resource <${foreignWork}> ; rv:publicTitle "Unrelated Work" .
  <${authorUnit}> a rv:MatchUnit ; rv:resource <${work}> ; rv:publicTitle "Surviving Work" .
}
`);
  writeFileSync(join(java, 'PersonProfileCallerContractTest.java'), `package com.rezics.jena;
import static org.junit.Assert.*;
import java.nio.file.*;
import java.util.*;
import org.apache.jena.atlas.json.*;
import org.apache.jena.graph.*;
import org.apache.jena.query.*;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.sparql.core.*;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;
public class PersonProfileCallerContractTest {
  private static Node iri(String v){return NodeFactory.createURI(v);}
  private static Node rv(String v){return iri("${RV}"+v);}
  private static Node text(String v){return NodeFactory.createLiteralString(v);}
  private static JsonObject body(String name) throws Exception {return JSON.parse(Files.readString(Path.of(name+".json")));}
  private static Dataset fixture() throws Exception {
    var data=TDB2Factory.connectDataset(Files.createTempDirectory(Path.of("tmp"),"person-").toString());
    data.begin(ReadWrite.WRITE);RDFDataMgr.read(data,"fixture.trig");data.commit();data.end();return data;
  }
  private static Set<Quad> snapshot(Dataset data){
    data.begin(ReadWrite.READ);try {var result=new HashSet<Quad>();data.asDatasetGraph().find().forEachRemaining(result::add);return result;}
    finally {data.end();}
  }
  private static void execute(Dataset data,String update){
    data.begin(ReadWrite.WRITE);try {UpdateAction.parseExecute(update,data);data.commit();}finally{data.end();}
  }
  private static boolean complete(Dataset data,JsonObject body){
    data.begin(ReadWrite.READ);try(var query=QueryExecutionFactory.create(body.get("completion").getAsString().value(),data)){return query.execAsk();}
    finally{data.end();}
  }
  private void refused(String name) throws Exception {
    var data=fixture();try {var before=snapshot(data);var command=body(name);
      execute(data,command.get("update").getAsString().value());
      assertEquals("refused UPDATE must leave every quad untouched",before,snapshot(data));
      assertFalse(complete(data,command));
    } finally {data.close();}
  }
  @Test public void omittedHistoricalRevisionRefusesBeforeAnyDeletion() throws Exception {refused("omitted");}
  @Test public void foreignSearchUnitRefusesBeforeAnyDeletion() throws Exception {refused("foreign");}
  @Test public void fullClosureRemovesProfileHistoryButRetainsAttributionAndUnrelatedWork() throws Exception {
    var data=fixture();try {var command=body("complete");assertFalse(complete(data,command));
      execute(data,command.get("update").getAsString().value());assertTrue(complete(data,command));
      var quads=snapshot(data);
      assertTrue(quads.contains(new Quad(iri("${GRAPHS.current}"),iri("${person}"),RDF.type.asNode(),rv("AgentTombstone"))));
      for(String revision:List.of("${provision}","${older}","${head}"))
        assertTrue(quads.contains(new Quad(iri("${GRAPHS.revisions}"),iri(revision),RDF.type.asNode(),rv("ErasedRevision"))));
      for(Quad q:quads) assertFalse("identifying literal survives: "+q,q.getObject().isLiteral()
        && (q.getObject().getLiteralLexicalForm().contains("identifying")||q.getObject().getLiteralLexicalForm().contains("Identifying")));
      assertFalse(quads.stream().anyMatch(q->q.getSubject().equals(iri("${directUnit}"))));
      assertTrue(quads.contains(new Quad(iri("${GRAPHS.current}"),iri("${credit}"),rv("agent"),iri("${person}"))));
      assertTrue(quads.contains(new Quad(iri("${GRAPHS.current}"),iri("${credit}"),rv("work"),iri("${work}"))));
      assertTrue(quads.contains(new Quad(iri("${publicGraph}"),iri("${foreignUnit}"),rv("publicTitle"),text("Unrelated Work"))));
      assertTrue(quads.contains(new Quad(iri("${publicGraph}"),iri("${authorUnit}"),rv("publicTitle"),text("Surviving Work"))));
    }finally {data.close();}
  }
  @Test public void creditedWorkPrefixBlocksCompletionUntilItsProjectionIsCleaned() throws Exception {
    var data=fixture();try {var command=body("complete");execute(data,command.get("update").getAsString().value());
      assertTrue(complete(data,command));
      execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${publicGraph}> { <${prefixEntry}> rv:prefixWork <${work}> ; rv:prefixUnit <${authorUnit}> ; rv:prefixField \\\"credit\\\" ; rv:publicTitle \\\"rezicsprefixdirectory\\\" } }");
      assertFalse("a prefix copy linked only through a surviving Work must block completion",complete(data,command));
      execute(data,"DELETE WHERE { GRAPH <${publicGraph}> { <${prefixEntry}> ?p ?o } }");
      assertTrue(complete(data,command));
    }finally {data.close();}
  }
}
`);
  const name = `rezics-person-profile-native-${Date.now()}`;
  try {
    const result = spawnSync('docker', ['run', '--rm', '--name', name,
      '--user', `${process.getuid!()}:${process.getgid!()}`, '--memory', '1g', '--cpus', '2',
      '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`,
      '--env', 'MAVEN_CONFIG=/maven-cache', '--env', 'MAVEN_OPTS=-Xmx128m',
      '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
      '-Djava.io.tmpdir=/build/tmp', '-DargLine=-Xmx384m', '-Dtest=PersonProfileCallerContractTest', 'test'],
    { cwd: root, encoding: 'utf8', timeout: 300_000, env: preserveReapEnvironment(process.env) });
    mkdirSync(join(root, '.temp/goal'), { recursive: true });
    writeFileSync(join(root, '.temp/goal/person-profile-native.log'), `${result.stdout}\n${result.stderr}`);
    if (result.status !== 0) throw new Error(`Native Person RDF proof failed: ${result.stdout}\n${result.stderr}`
      + `${result.error ? `\n${result.error.message}` : ''}`);
    expect(result.stdout).toContain('Tests run: 4, Failures: 0, Errors: 0');
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 30_000,
      env: preserveReapEnvironment(process.env) });
    rmSync(build, { recursive: true, force: true });
  }
}, 310_000);
