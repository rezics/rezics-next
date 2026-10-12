import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { graphErasureReceipt } from '../src/modules/erasure/graph.ts';
import type { OwnerOutboxEventHandler } from '../src/modules/outbox/event-handlers.ts';
import { OutboxIncomplete, readMainOutboxEnvelope, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { GRAPHS, RV } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const erasureId = '00000000-0000-4000-8000-000000000001';
const receipt = graphErasureReceipt(erasureId);
const work = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const eventPlaceholder = 'urn:rezics:event:erasure-work-set';
const batch: MainOutboxBatch = { dataEpoch: 'erasure-work-set', routingEpoch: '1', sequence: '2',
  batchId: 'urn:rezics:outbox:erasure-work-set', eventIds: [eventPlaceholder] };

async function queryTemplates(handler: OwnerOutboxEventHandler) {
  const queries: string[] = [];
  const graph = new FusekiClient('http://unused.invalid');
  const captured = new Error('query captured');
  graph.query = async query => { queries.push(query); throw captured; };
  await readMainOutboxEnvelope(graph, batch, eventPlaceholder, () => handler).then(
    () => { throw new Error('Relay query capture did not reject'); }, error => { expect(error).toBe(captured); });
  const values: Record<string, string> = { receipt, outcome: `${RV}Succeeded`,
    epoch: batch.dataEpoch, sequence: batch.sequence, digest: 'a'.repeat(64) };
  await handler.read({ fuseki: graph, batch, eventId: eventPlaceholder,
    ordinal: 0, value: name => values[name] }).then(
    () => { throw new Error('Handler query capture did not reject'); }, error => { expect(error).toBe(captured); });
  expect(queries).toHaveLength(2);
  return { relay: queries[0]!, facts: queries[1]! };
}

test('finding 7: graph erasure relay compares exact receipt and batch Work sets without multiplying event rows', async () => {
  const { outboxEventHandlers } = await import('../src/modules/erasure/outbox-event.ts');
  const handler = outboxEventHandlers.find(candidate => candidate.kind === `${RV}GraphErasureEvent`)!;
  const queries = await queryTemplates(handler);
  const cases = [
    { name: 'zero', receiptWorks: [], eventWorks: [[]], allowed: true },
    { name: 'one', receiptWorks: [work(2)], eventWorks: [[work(2)]], allowed: true },
    { name: 'two', receiptWorks: [work(2), work(3)], eventWorks: [[work(2)], [work(3)]], allowed: true },
    { name: 'reordered', receiptWorks: [work(3), work(2)], eventWorks: [[work(2)], [work(3)]], allowed: true },
    { name: 'extra-receipt-work', receiptWorks: [work(2), work(3), work(4)], eventWorks: [[work(2)], [work(3)]], allowed: false },
    { name: 'missing-receipt-work', receiptWorks: [work(2)], eventWorks: [[work(2)], [work(3)]], allowed: false },
    { name: 'extra-event-work', receiptWorks: [work(2), work(3)], eventWorks: [[work(2)], [work(3)], [work(4)]], allowed: false },
    { name: 'missing-event-work', receiptWorks: [work(2), work(3)], eventWorks: [[work(2)]], allowed: false },
    { name: 'different-members', receiptWorks: [work(2), work(4)], eventWorks: [[work(2)], [work(3)]], allowed: false },
    { name: 'no-receipt-work', receiptWorks: [], eventWorks: [[work(2)]], allowed: false },
    { name: 'no-event-work', receiptWorks: [work(2)], eventWorks: [[]], allowed: false },
    { name: 'detached-event-work', receiptWorks: [work(2), work(3)], eventWorks: [[work(2)]],
      foreignWorks: [work(3)], sharedEvent: false, allowed: false },
    { name: 'ambiguous-source-batch', receiptWorks: [work(2), work(3)], eventWorks: [[work(2)]],
      foreignWorks: [work(3)], sharedEvent: true, allowed: false },
  ];
  mkdirSync(join(root, '.temp'), { recursive: true });
  const build = mkdtempSync(join(root, '.temp/graph-erasure-relay-native-'));
  const cache = join(root, '.temp/graph-erasure-relay-maven-cache');
  mkdirSync(cache, { recursive: true });
  const image = /^FROM (\S+) AS module$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!image) throw new Error('Pinned native builder missing');
  const java = join(build, 'src/test/java/com/rezics/jena');
  mkdirSync(java, { recursive: true });
  mkdirSync(join(build, 'tmp'));
  cpSync(join(root, 'infra/jena/command-module/pom.xml'), join(build, 'pom.xml'));
  writeFileSync(join(build, 'cases.json'), JSON.stringify({ ...queries, cases }));
  writeFileSync(join(java, 'GraphErasureRelayContractTest.java'), `package com.rezics.jena;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import org.apache.jena.atlas.json.*;
import org.apache.jena.query.*;
import org.apache.jena.rdf.model.*;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;
public class GraphErasureRelayContractTest {
  private static final String RV="${RV}";
  private static Property p(String name){return ResourceFactory.createProperty(RV+name);}
  private static JsonObject select(Dataset data,String query){
    try(var execution=QueryExecution.create(query,data)){
      var bytes=new ByteArrayOutputStream();ResultSetFormatter.outputAsJSON(bytes,execution.execSelect());
      return JSON.parse(bytes.toString(StandardCharsets.UTF_8));
    }
  }
  @Test public void queryEachExactWorkSet() throws Exception {
    var input=JSON.parse(Files.readString(Path.of("cases.json")));var results=new JsonArray();
    for(var value:input.get("cases").getAsArray()){
      var fixture=value.getAsObject();var data=DatasetFactory.createTxnMem();
      try{
        data.begin(ReadWrite.WRITE);
        var receipts=data.getNamedModel("${GRAPHS.receipts}");var outbox=data.getNamedModel("${GRAPHS.outbox}");
        var receipt=receipts.createResource("${receipt}");
        receipt.addProperty(RDF.type,receipts.createResource(RV+"OperationReceipt"))
          .addProperty(p("outcome"),receipts.createResource(RV+"Succeeded"))
          .addLiteral(p("requestDigest"),"${'a'.repeat(64)}").addLiteral(p("dataEpoch"),"${batch.dataEpoch}")
          .addLiteral(p("sequence"),2).addLiteral(p("erasureId"),"${erasureId}").addLiteral(p("erasureEpoch"),7);
        for(var w:fixture.get("receiptWorks").getAsArray())receipt.addProperty(p("work"),receipts.createResource(w.getAsString().value()));
        var batch=outbox.createResource("${batch.batchId}");
        batch.addProperty(RDF.type,outbox.createResource(RV+"OutboxBatch"))
          .addLiteral(p("dataEpoch"),"${batch.dataEpoch}").addLiteral(p("sequence"),2);
        var ids=new JsonArray();int ordinal=0;
        for(var works:fixture.get("eventWorks").getAsArray()){
          String id="${eventPlaceholder}:"+ordinal;ids.add(id);var event=outbox.createResource(id);
          batch.addProperty(p("event"),event);
          event.addProperty(RDF.type,outbox.createResource(RV+"GraphErasureEvent"))
            .addLiteral(p("ordinal"),ordinal++).addLiteral(p("action"),"erasure.graph")
            .addProperty(p("receipt"),outbox.createResource("${receipt}"))
            .addLiteral(p("erasureId"),"${erasureId}").addLiteral(p("erasureEpoch"),7);
          for(var w:works.getAsArray())event.addProperty(p("work"),outbox.createResource(w.getAsString().value()));
        }
        if(fixture.get("foreignWorks")!=null){
          var foreignBatch=outbox.createResource("${batch.batchId}:foreign");
          foreignBatch.addProperty(RDF.type,outbox.createResource(RV+"OutboxBatch"))
            .addLiteral(p("dataEpoch"),"${batch.dataEpoch}").addLiteral(p("sequence"),2);
          var foreignEvent=outbox.createResource("${eventPlaceholder}:foreign");
          foreignBatch.addProperty(p("event"),foreignEvent);
          foreignEvent.addProperty(RDF.type,outbox.createResource(RV+"GraphErasureEvent"))
            .addProperty(p("receipt"),outbox.createResource("${receipt}"));
          for(var w:fixture.get("foreignWorks").getAsArray())foreignEvent.addProperty(p("work"),outbox.createResource(w.getAsString().value()));
          if(fixture.get("sharedEvent").getAsBoolean().value())foreignBatch.addProperty(p("event"),outbox.createResource("${eventPlaceholder}:0"));
        }
        data.commit();data.end();data.begin(ReadWrite.READ);
        var events=new JsonArray();for(var idValue:ids){String id=idValue.getAsString().value();var event=new JsonObject();
          event.put("id",id);event.put("relay",select(data,input.get("relay").getAsString().value().replace("${eventPlaceholder}",id)));
          event.put("facts",select(data,input.get("facts").getAsString().value().replace("${eventPlaceholder}",id)));events.add(event);
        }
        data.end();var result=new JsonObject();result.put("name",fixture.get("name"));result.put("eventIds",ids);result.put("events",events);results.add(result);
      }finally{if(data.isInTransaction())data.end();data.close();}
    }
    var result=new JsonObject();result.put("cases",results);Files.writeString(Path.of("results.json"),result.toString());
  }
}
`);
  const name = `rezics-graph-erasure-relay-${Date.now()}`;
  try {
    const native = spawnSync('docker', ['run', '--rm', '--name', name,
      '--user', `${process.getuid!()}:${process.getgid!()}`, '--memory', '1g', '--cpus', '2',
      '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`,
      '--env', 'MAVEN_CONFIG=/maven-cache', '--env', 'MAVEN_OPTS=-Xmx128m', '--workdir', '/build',
      image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache', '-Djava.io.tmpdir=/build/tmp',
      '-DargLine=-Xmx384m', '-Dtest=GraphErasureRelayContractTest', 'test'],
    { cwd: root, encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL', env: preserveReapEnvironment(process.env) });
    writeFileSync(join(root, '.temp/graph-erasure-relay-native.log'), `${native.stdout}\n${native.stderr}`);
    if (native.status !== 0) throw new Error(`Native erasure relay queries failed: ${native.stdout}\n${native.stderr}`);
    const actual = JSON.parse(readFileSync(join(build, 'results.json'), 'utf8')) as {
      cases: { name: string; eventIds: string[]; events: { id: string; relay: SparqlResult; facts: SparqlResult }[] }[];
    };
    expect(actual.cases.map(item => item.name)).toEqual(cases.map(item => item.name));
    for (const fixture of actual.cases) {
      const allowed = cases.find(item => item.name === fixture.name)!.allowed;
      for (const [ordinal, event] of fixture.events.entries()) {
        const graph = new FusekiClient('http://unused.invalid');
        graph.query = async query => {
          if (query === queries.relay.replaceAll(eventPlaceholder, event.id)) return event.relay;
          if (query === queries.facts.replaceAll(eventPlaceholder, event.id)) return event.facts;
          throw new Error(`Unexpected erasure relay query: ${query}`);
        };
        let handlerCalls = 0;
        const checkedHandler = { ...handler, read: async (...args: Parameters<typeof handler.read>) => {
          handlerCalls++;
          return handler.read(...args);
        } };
        if (allowed) expect(event.relay.results?.bindings).toHaveLength(1);
        const delivered = readMainOutboxEnvelope(graph, { ...batch, eventIds: fixture.eventIds }, event.id, () => checkedHandler);
        if (!allowed) {
          let refusal: unknown;
          try { await delivered; } catch (error) { refusal = error; }
          expect(refusal).toBeInstanceOf(OutboxIncomplete);
          expect(handlerCalls).toBe(0);
          continue;
        }
        const envelope = await delivered;
        expect(handlerCalls).toBe(1);
        expect(envelope.data.ordinal).toBe(ordinal);
        expect(envelope.data.receipt.id).toBe(receipt);
        if (!('systemProof' in envelope.data.receipt)) throw new Error('Erasure event lacks its system proof');
        expect(envelope.data.receipt.systemProof).toEqual({ kind: 'relay-erasure', erasureId, erasureEpoch: '7' });
      }
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
      env: preserveReapEnvironment(process.env) });
    rmSync(build, { recursive: true, force: true });
  }
}, 310_000);
