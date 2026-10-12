import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { inventoryPersonProfileGraph, personProfileErasureUpdate, personProfileGraphErased,
  type PersonProfileGraphInventory } from '../src/modules/agent/erasure.ts';
import type { PersonProfileErasureProof } from '../src/modules/access/person-profile-erasure.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { graphErasureReceipt } from '../src/modules/erasure/graph.ts';
import { outboxEventHandlers } from '../src/modules/erasure/outbox-event.ts';
import { readMainOutboxEnvelope, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { DATASET, GRAPHS, RV, prepareComponent } from '../src/modules/work/activate.ts';

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
const coauthor = resource(30);
const coauthorHead = resource(31);
const coauthorCredit = resource(32);
const coauthorRevision = resource(33);
const main = resource(34);
const selection = resource(35);
const contribution = resource(36);
const decision = resource(37);
const draft = resource(38);
const sharedPrefix = `urn:rezics:search:directory:prefix:ZXhhY3Q:*:1${uuid(34).replaceAll('-', '')}${uuid(12).replaceAll('-', '')}`;
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
const eventPlaceholder = 'urn:rezics:event:person-fixture-placeholder';
const receiptPlaceholder = graphErasureReceipt(proof.erasureId);
const handler = outboxEventHandlers[0]!;

async function eventQueryTemplates(): Promise<{ relay: string; facts: string }> {
  const graph = new FusekiClient('http://unused.invalid');
  const captured: string[] = [];
  const stop = new Error('query captured');
  graph.query = async query => { captured.push(query); throw stop; };
  const batch: MainOutboxBatch = { ...lineage, batchId: 'urn:rezics:outbox:fixture',
    sequence: '2', eventIds: [eventPlaceholder] };
  try { await readMainOutboxEnvelope(graph, batch, eventPlaceholder, () => handler); }
  catch (error) { if (error !== stop) throw error; }
  const fields: Record<string, string> = { receipt: receiptPlaceholder, outcome: `${RV}Succeeded`,
    epoch: lineage.dataEpoch, sequence: '2', digest: 'a'.repeat(64) };
  try { await handler.read({ fuseki: graph, batch, eventId: eventPlaceholder,
    value: name => fields[name], ordinal: 0 }); }
  catch (error) { if (error !== stop) throw error; }
  expect(captured).toHaveLength(2);
  return { relay: captured[0]!, facts: captured[1]! };
}

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
  const objectDirectory = join(build, 'objects');
  const model = 'https://rezics.com/definition/agent-provision-v1';
  const objectManifest = `urn:rezics:sha256:${prepareComponent(objectDirectory, person,
    { kind: 'person', displayName: 'Exact identifying name', disclosure: 'public' }, model)}`;
  let authorInventory = '';
  let workInventory = '';
  const binding = (value: string) => ({ type: 'uri', value });
  await inventoryPersonProfileGraph({ query: async query => {
    if (query.includes('SELECT ?kind')) return { results: { bindings: [{
      kind: binding(`${RV}PersonAgent`), head: binding(provision) }] } };
    if (query.includes('SELECT ?p ?o')) return { results: { bindings: [
      { p: binding(`${RV}head`), o: binding(provision) }] } };
    if (query.includes('SELECT DISTINCT ?revision')) return { results: { bindings: [{
      revision: binding(provision), model: binding(model),
      operation: binding(`urn:rezics:operation:agent-provision:${proof.provisionId}`),
      manifest: binding(objectManifest), anchor: { type: 'literal', value: 'true' } }] } };
    if (query.includes('SELECT ?revision ?component')) return { results: { bindings: [{
      revision: binding(provision), component: binding(person) }] } };
    if (query.includes('SELECT DISTINCT ?work')) workInventory = query;
    else if (query.includes('SELECT DISTINCT ?unit')) authorInventory = query;
    else if (!query.includes('SELECT DISTINCT ?graph')) throw new Error(`Unexpected inventory query: ${query}`);
    return { results: { bindings: [] } };
  } }, objectDirectory, { ...proof, requestDigest: 'ab'.repeat(32),
    graphDataEpoch: lineage.dataEpoch, graphSequence: '1' }, { bytesLeft: 8 * 1024 * 1024,
    graphRevisionsLeft: 64, indexedUnitsLeft: 64, journalTargetsLeft: 256,
    signal: new AbortController().signal });
  const cases: [string, PersonProfileGraphInventory][] = [
    ['complete', inventory],
    ['omitted', { ...inventory, revisions: inventory.revisions.filter(value => value.revision !== older) }],
    ['foreign', { ...inventory, units: [{ graph: publicGraph, unit: foreignUnit }] }],
    ['coauthor', { ...inventory, authorUnits: [sharedPrefix, authorUnit] }],
  ];
  for (const [name, targets] of cases) {
    let completion = '';
    await personProfileGraphErased({ query: async query => {
      completion = query;
      return { boolean: false };
    } }, proof, targets);
    writeFileSync(join(build, `${name}.json`), JSON.stringify({
      update: personProfileErasureUpdate(lineage, proof, targets), completion, authorInventory, workInventory,
    }));
  }
  const queries = await eventQueryTemplates();
  for (const count of [0, 1, 2]) {
    const creditedWorks = [work, resource(14)].slice(0, count);
    writeFileSync(join(build, `events-${count}.json`), JSON.stringify({ ...queries,
      update: personProfileErasureUpdate(lineage, proof, { ...inventory, creditedWorks }),
      expectedReceipt: receiptPlaceholder, works: creditedWorks }));
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
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
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
  private static JsonObject select(Dataset data,String query){
    try(var execution=QueryExecutionFactory.create(query,data)){
      var output=new ByteArrayOutputStream();ResultSetFormatter.outputAsJSON(output,execution.execSelect());
      return JSON.parse(output.toString(StandardCharsets.UTF_8));
    }
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
  @Test public void mixedPersonAndForeignWorkUnitRefusesBeforeAnyDeletion() throws Exception {
    var data=fixture();try {var command=body("complete");
      execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${publicGraph}> { <${directUnit}> rv:resource <${foreignWork}> } }");
      var before=snapshot(data);execute(data,command.get("update").getAsString().value());
      assertEquals("a Person reference cannot authorize destruction of a shared foreign Work unit",before,snapshot(data));
      assertFalse(complete(data,command));
    }finally{data.close();}
  }
  @Test public void fullClosureRemovesProfileHistoryButRetainsAttributionAndUnrelatedWork() throws Exception {
    var data=fixture();try {var command=body("complete");assertFalse(complete(data,command));
      execute(data,command.get("update").getAsString().value());assertTrue(complete(data,command));
      var quads=snapshot(data);
      assertTrue(quads.contains(new Quad(iri("${GRAPHS.current}"),iri("${person}"),RDF.type.asNode(),rv("AgentTombstone"))));
      assertFalse("Person erasure must not introduce the compensation profile",quads.stream().anyMatch(q->q.getPredicate().equals(rv("compensatedFrom"))));
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
      execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${publicGraph}> { <${prefixEntry}> rv:prefixAuthor <${person}> ; rv:prefixWork <${work}> ; rv:prefixUnit <${authorUnit}> ; rv:prefixField \\\"credit\\\" ; rv:publicTitle \\\"rezicsprefixdirectory\\\" } }");
      assertFalse("the erased author's prefix copy on a surviving Work must block completion",complete(data,command));
      execute(data,"DELETE WHERE { GRAPH <${publicGraph}> { <${prefixEntry}> ?p ?o } }");
      assertTrue(complete(data,command));
    }finally {data.close();}
  }
  @Test public void unexpectedCreditedWorkPrefixOnNewUnitBlocksCompletion() throws Exception {
    var data=fixture();try {var command=body("complete");execute(data,command.get("update").getAsString().value());
      assertTrue(complete(data,command));
      execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${publicGraph}> { <urn:rezics:search:directory:prefix:RXhhY3Q:*:1fresh> rv:prefixAuthor <${person}> ; rv:prefixWork <${work}> ; rv:prefixUnit <${resource(16)}> ; rv:prefixField \\\"credit\\\" ; rv:publicTitle \\\"rezicsprefixdirectory\\\" . <${resource(16)}> a rv:MatchUnit ; rv:resource <${work}> ; rv:publicTitle \\\"Surviving Work\\\" } }");
      assertFalse("a new Work unit outside the sealed author-unit list still carries an identifying prefix",complete(data,command));
      execute(data,"DELETE WHERE { GRAPH <${publicGraph}> { <urn:rezics:search:directory:prefix:RXhhY3Q:*:1fresh> ?p ?o } }");
      assertTrue(complete(data,command));
    }finally{data.close();}
  }
  @Test public void unsealedManifestRevisionBlocksCompletionReplay() throws Exception {
    var data=fixture();try {var command=body("complete");execute(data,command.get("update").getAsString().value());
      assertTrue(complete(data,command));
      execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${GRAPHS.revisions}> { <${resource(17)}> a rv:RevisionAnchor ; rv:component <${person}> ; rv:manifest <urn:rezics:sha256:${'c'.repeat(64)}> } }");
      assertFalse("an unsealed manifest revision may retain identifying object bytes without RDF profile literals",complete(data,command));
      execute(data,"DELETE WHERE { GRAPH <${GRAPHS.revisions}> { <${resource(17)}> ?p ?o } }");
      assertTrue(complete(data,command));
    }finally{data.close();}
  }
  @Test public void detachedAuthorPrefixBlocksCompletionWithoutWorkOrUnitLinks() throws Exception {
    var data=fixture();try {var command=body("complete");execute(data,command.get("update").getAsString().value());
      assertTrue(complete(data,command));
      execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${publicGraph}> { <${prefixEntry}> rv:prefixAuthor <${person}> } }");
      assertFalse("a detached identifying author edge cannot evade the absence probe",complete(data,command));
      execute(data,"DELETE WHERE { GRAPH <${publicGraph}> { <${prefixEntry}> ?p ?o } }");
      assertTrue(complete(data,command));
    }finally{data.close();}
  }
  private void coauthorProjection(Dataset data) {
    data.begin(ReadWrite.WRITE);try {var graph=data.asDatasetGraph();
      Node current=iri("${GRAPHS.current}"),revisions=iri("${GRAPHS.revisions}"),pub=iri("${publicGraph}"),work=iri("${work}"),
        main=iri("${main}"),selection=iri("${selection}"),contribution=iri("${contribution}"),decision=iri("${decision}"),draft=iri("${draft}"),unit=iri("${authorUnit}");
      graph.add(current,work,rv("mainVersion"),main);
      graph.add(current,main,RDF.type.asNode(),rv("MainVersion"));
      graph.add(current,main,rv("work"),work);graph.add(current,main,rv("selectionHead"),selection);
      graph.add(current,contribution,rv("work"),work);graph.add(current,contribution,rv("publicationHead"),decision);
      graph.add(revisions,selection,RDF.type.asNode(),rv("PublicationSelection"));
      for(var field:Map.of("work",work,"mainVersion",main,"context",main,"contribution",contribution,
        "publicationDecision",decision,"selectedDraft",draft,"language",text("en")).entrySet())
        graph.add(revisions,selection,rv(field.getKey()),field.getValue());
      graph.add(revisions,selection,rv("matchUnit"),unit);
      graph.add(revisions,decision,RDF.type.asNode(),rv("PublicationDecision"));
      for(var field:Map.of("component",contribution,"contribution",contribution,"work",work,"selectedDraft",draft,"disclosure",rv("Public")).entrySet())
        graph.add(revisions,decision,rv(field.getKey()),field.getValue());
      graph.add(revisions,draft,RDF.type.asNode(),rv("RevisionAnchor"));graph.add(revisions,draft,rv("component"),contribution);
      for(var field:Map.of("work",work,"mainVersion",main,"context",main,"selection",selection,"contribution",contribution,
        "revision",draft,"language",text("en"),"disclosure",rv("Public")).entrySet())graph.add(pub,unit,rv(field.getKey()),field.getValue());
      for(Node author:List.of(iri("${person}"),iri("${coauthor}"))) {
        boolean erased=author.equals(iri("${person}"));Node head=iri(erased?"${provision}":"${coauthorHead}"),
          credit=iri(erased?"${credit}":"${coauthorCredit}"),revision=iri(erased?"${resource(39)}":"${coauthorRevision}");
        graph.deleteAny(current,author,rv("head"),Node.ANY);graph.add(current,author,rv("head"),head);
        graph.add(current,author,RDF.type.asNode(),rv("Agent"));graph.add(current,author,rv("agentKind"),rv("PersonAgent"));
        graph.add(current,author,rv("profileDisclosure"),rv("Public"));
        if(!erased)graph.add(current,author,iri("http://www.w3.org/2000/01/rdf-schema#label"),text("Exact surviving coauthor"));
        graph.add(revisions,head,RDF.type.asNode(),rv("RevisionAnchor"));graph.add(revisions,head,rv("component"),author);
        graph.add(revisions,head,rv("modelRevision"),iri("https://rezics.com/definition/agent-provision-v1"));
        graph.add(current,credit,RDF.type.asNode(),rv("NativeAgentCredit"));graph.add(current,credit,rv("agent"),author);
        graph.add(current,credit,rv("work"),work);graph.add(current,credit,rv("creditRevision"),revision);
        graph.add(current,credit,iri("https://schema.org/roleName"),text("author"));
        graph.add(revisions,revision,RDF.type.asNode(),rv("NativeAgentCreditRevision"));
        graph.add(revisions,revision,rv("component"),credit);graph.add(revisions,revision,rv("agent"),author);
      }
      PublicNameProjection.refreshPrefixUnit(graph,unit);
      graph.deleteAny(current,iri("${person}"),rv("head"),Node.ANY);graph.add(current,iri("${person}"),rv("head"),iri("${head}"));
      data.commit();
    }finally{data.end();}
  }
  @Test public void survivingCoauthorPrefixesAndUnitsPermitCompletionAndReplay() throws Exception {
    var data=fixture();try {var command=body("coauthor");coauthorProjection(data);
      Set<Quad> before=snapshot(data);Node pub=iri("${publicGraph}"),shared=iri("${sharedPrefix}"),a=iri("${person}"),b=iri("${coauthor}");
      assertTrue("the prefix is shared by both authors",before.contains(new Quad(pub,shared,rv("prefixAuthor"),a)));
      assertTrue(before.contains(new Quad(pub,shared,rv("prefixAuthor"),b)));
      Set<Node> bEntries=new HashSet<>();for(Quad q:before)if(q.getGraph().equals(pub)&&q.getPredicate().equals(rv("prefixAuthor"))&&q.getObject().equals(b))bEntries.add(q.getSubject());
      assertFalse(bEntries.isEmpty());
      data.begin(ReadWrite.READ);try {var rows=select(data,command.get("authorInventory").getAsString().value()).get("results").getAsObject().get("bindings").getAsArray();
        Set<String> selected=new HashSet<>();for(var row:rows)selected.add(row.getAsObject().get("unit").getAsObject().get("value").getAsString().value());
        assertTrue(selected.contains(shared.getURI()));assertTrue(selected.contains("${authorUnit}"));
        for(Node entry:bEntries)if(!before.contains(new Quad(pub,entry,rv("prefixAuthor"),a)))assertFalse("inventory must exclude B-only prefixes",selected.contains(entry.getURI()));
      }finally{data.end();}
      execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${publicGraph}> { <${prefixEntry}> rv:prefixAuthor <${person}> ; rv:prefixWork <${foreignWork}> . <urn:rezics:search:directory:prefix:Y29hdXRob3I:*:1foreign> rv:prefixAuthor <${coauthor}> ; rv:prefixWork <${resource(40)}> } }");
      data.begin(ReadWrite.READ);try {var rows=select(data,command.get("workInventory").getAsString().value()).get("results").getAsObject().get("bindings").getAsArray();
        Set<String> selected=new HashSet<>();for(var row:rows)selected.add(row.getAsObject().get("work").getAsObject().get("value").getAsString().value());
        assertEquals("prefix-only Work inventory must be keyed to its author",Set.of("${work}","${foreignWork}"),selected);
      }finally{data.end();}
      execute(data,"DELETE WHERE { GRAPH <${publicGraph}> { <${prefixEntry}> ?p ?o } }");
      assertFalse(complete(data,command));execute(data,command.get("update").getAsString().value());
      assertFalse("A's retained prefixes still block completion before native projection refresh",complete(data,command));
      data.begin(ReadWrite.WRITE);try {PublicNameProjection.refresh(data.asDatasetGraph(),a);data.commit();}finally{data.end();}
      Set<Quad> after=snapshot(data);
      for(Node entry:bEntries)assertTrue("B's prefix identity must survive",after.contains(new Quad(pub,entry,rv("prefixAuthor"),b)));
      assertFalse(after.stream().anyMatch(q->q.getGraph().equals(pub)&&q.getPredicate().equals(rv("prefixAuthor"))&&q.getObject().equals(a)));
      assertTrue(after.contains(new Quad(pub,iri("${authorUnit}"),rv("publicTitle"),text("Surviving Work"))));
      assertTrue(after.contains(new Quad(iri("${GRAPHS.current}"),iri("${coauthorCredit}"),rv("agent"),b)));
      assertTrue("a shared sealed prefix retained for B must permit completion",complete(data,command));
      execute(data,command.get("update").getAsString().value());
      assertTrue("same-inventory replay completes with B's projection present",complete(data,command));assertEquals(after,snapshot(data));
    }finally{data.close();}
  }
  private void eventContract(int count) throws Exception {
    var data=fixture();try {var command=body("events-"+count);
      if(count==0)execute(data,"DELETE WHERE { GRAPH <${GRAPHS.current}> { <${credit}> ?p ?o } }");
      if(count==2)execute(data,"PREFIX rv: <${RV}> INSERT DATA { GRAPH <${GRAPHS.current}> { <${resource(15)}> a rv:NativeAgentCredit ; rv:agent <${person}> ; rv:work <${resource(14)}> . <${resource(14)}> a <https://schema.org/CreativeWork> } }");
      execute(data,command.get("update").getAsString().value());
      var quads=snapshot(data);Node outbox=iri("${GRAPHS.outbox}"),receipts=iri("${GRAPHS.receipts}");
      Node receipt=iri(command.get("expectedReceipt").getAsString().value());
      assertTrue("Person event must use the relay's canonical graph erasure receipt",quads.contains(new Quad(receipts,receipt,RDF.type.asNode(),rv("OperationReceipt"))));
      Set<Node> expectedWorks=new HashSet<>();for(var value:command.get("works").getAsArray())expectedWorks.add(iri(value.getAsString().value()));
      Set<Node> receiptWorks=new HashSet<>();for(Quad q:quads)if(q.getGraph().equals(receipts)&&q.getSubject().equals(receipt)&&q.getPredicate().equals(rv("work")))receiptWorks.add(q.getObject());
      assertEquals("terminal receipt retains the exact affected Work set",expectedWorks,receiptWorks);
      Node batch=quads.stream().filter(q->q.getGraph().equals(outbox)&&q.getPredicate().equals(RDF.type.asNode())&&q.getObject().equals(rv("OutboxBatch"))).findFirst().orElseThrow().getSubject();
      List<Node> events=quads.stream().filter(q->q.getGraph().equals(outbox)&&q.getSubject().equals(batch)&&q.getPredicate().equals(rv("event"))).map(Quad::getObject).sorted(Comparator.comparing(Node::getURI)).toList();
      assertEquals("one event per affected Work, or one Person-only event",Math.max(1,count),events.size());
      assertEquals(Math.max(1,count),Integer.parseInt(quads.stream().filter(q->q.getGraph().equals(outbox)&&q.getSubject().equals(batch)&&q.getPredicate().equals(rv("eventCount"))).findFirst().orElseThrow().getObject().getLiteralLexicalForm()));
      var result=new JsonObject();result.put("batchId",batch.getURI());var ids=new JsonArray();var rows=new JsonArray();Set<Node> eventWorks=new HashSet<>();
      data.begin(ReadWrite.READ);try {for(Node event:events){
        Set<Node> works=new HashSet<>();for(Quad q:quads)if(q.getGraph().equals(outbox)&&q.getSubject().equals(event)&&q.getPredicate().equals(rv("work")))works.add(q.getObject());
        assertEquals(count==0?0:1,works.size());eventWorks.addAll(works);ids.add(event.getURI());
        var row=new JsonObject();row.put("id",event.getURI());
        row.put("relay",select(data,command.get("relay").getAsString().value().replace("${eventPlaceholder}",event.getURI())));
        row.put("facts",select(data,command.get("facts").getAsString().value().replace("${eventPlaceholder}",event.getURI())));rows.add(row);
      }}finally{data.end();}
      assertEquals(expectedWorks,eventWorks);result.put("eventIds",ids);result.put("events",rows);
      Files.writeString(Path.of("events-"+count+"-result.json"),result.toString());
    }finally{data.close();}
  }
  @Test public void personOnlyEventUsesCanonicalReceipt() throws Exception {eventContract(0);}
  @Test public void singleWorkEventMatchesItsReceipt() throws Exception {eventContract(1);}
  @Test public void multipleWorksEachHaveOneMatchingEvent() throws Exception {eventContract(2);}
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
    expect(result.stdout).toContain('Tests run: 12, Failures: 0, Errors: 0');
    for (const count of [0, 1, 2]) {
      const actual = JSON.parse(readFileSync(join(build, `events-${count}-result.json`), 'utf8')) as {
        batchId: string; eventIds: string[]; events: { id: string; relay: SparqlResult; facts: SparqlResult }[];
      };
      const batch: MainOutboxBatch = { ...lineage, batchId: actual.batchId, sequence: '2', eventIds: actual.eventIds };
      for (const event of actual.events) {
        const graph = new FusekiClient('http://unused.invalid');
        graph.query = async query => {
          if (query === queries.relay.replaceAll(eventPlaceholder, event.id)) return event.relay;
          if (query === queries.facts.replaceAll(eventPlaceholder, event.id)) return event.facts;
          throw new Error(`Unexpected relay query: ${query}`);
        };
        const delivered = await readMainOutboxEnvelope(graph, batch, event.id, () => handler)
          .catch((error: unknown) => { throw new Error(`Person ${count}-Work event relay proof failed`, { cause: error }); });
        expect(delivered.data.receipt.id).toBe(receiptPlaceholder);
        const receipt = delivered.data.receipt;
        if (!('systemProof' in receipt)) throw new Error('Person event lacks its system proof');
        expect(receipt.systemProof).toEqual({ kind: 'relay-erasure',
          erasureId: proof.erasureId, erasureEpoch: proof.erasureEpoch });
      }
      console.log(`Person graph event relay proof passed for ${count} credited Works`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 30_000,
      env: preserveReapEnvironment(process.env) });
    rmSync(build, { recursive: true, force: true });
  }
}, 310_000);
