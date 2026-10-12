import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHeldGraphErasureCommand, graphErasureReceipt, canonicalErasureTargets, suppressGraphContentRevisions } from '../src/modules/erasure/graph.ts';
import { FusekiClient, type CommandEnvelope, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { hash } from '../src/modules/work/activate.ts';

const root = join(import.meta.dir, '../../..');
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

// Component interoperability only: the committed Java policy consumes the real
// TypeScript bytes in TDB2, without a fake HTTP handler or unloaned core hooks.
async function nativeErasureReplay(replayFile: 'command.json' | 'command-closure.json') {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const build = mkdtempSync(join(root, '.temp/held-caller-native-'));
  const cache = join(root, '.temp/erasure-campaign-maven-cache');
  mkdirSync(cache, { recursive: true });
  const image = /^FROM (\S+) AS module$/m.exec(
    readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'),
  )?.[1];
  if (!image) throw new Error('Pinned native builder missing');
  const held = {
    cut: {
      dataEpoch: uuid(11),
      routingEpoch: '2',
      restoreCutover: `urn:rezics:restore:${uuid(11)}`,
      priorDataEpoch: uuid(12),
      priorSequence: '3',
    },
    accessHoldGeneration: '4',
    revisionIds: [uuid(1), uuid(2)],
    original: { receipt: graphErasureReceipt(uuid(13)), dataEpoch: uuid(12), sequence: '9' },
  };
  const closureDigest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId: uuid(13), epoch: '7',
    targets: canonicalErasureTargets(held.revisionIds) }));
  const expanded = { ...held, original: { ...held.original, receipt: graphErasureReceipt(uuid(13), closureDigest) } };
  const command = (proof = held) => buildHeldGraphErasureCommand(
    uuid(13),
    '7',
    held.revisionIds,
    proof,
    [
      { graph: 'urn:rezics:search:public', unit: 'urn:rezics:held-caller:unit:1' },
      { graph: 'urn:rezics:search:private', unit: 'urn:rezics:held-caller:unit:2' },
    ],
    '3'.repeat(64),
    new Date(Date.now() + 240_000).toISOString(),
  );
  const home = `https://rezics.com/id/${uuid(2)}`, addedHome = `https://rezics.com/id/${uuid(3)}`;
  const content = `urn:rezics:content:revision:${uuid(1)}`;
  const commands: CommandEnvelope[] = [], suppressed = new Set<string>(), receipts = new Set<string>();
  class NativeInputGraph extends FusekiClient {
    constructor() { super('http://native-delta-input.invalid'); }
    override async commandHealth() { return { moduleVersion: 'fixture', instanceId: 'fixture',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: { 'erasure-graph-v1': profileRegistry['erasure-graph-v1'].sha256 } }; }
    override async query(query: string): Promise<SparqlResult> {
      if (query.includes('SELECT DISTINCT ?graph ?unit')) return { results: { bindings: [] } };
      const selected = /VALUES \?target \{([^}]+)\}/.exec(query)?.[1] ?? '';
      const targets = [...selected.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
      if (query.includes('SELECT ?target ?erasedEpoch')) return { results: { bindings: targets.map(target => ({
        target: { type: 'uri', value: target }, ...(suppressed.has(target)
          ? { erasedEpoch: { type: 'literal', value: '7' } } : {}),
      })) } };
      return { results: { bindings: [...receipts].some(receipt => query.includes(`<${receipt}>`))
        ? targets.filter(target => suppressed.has(target)).map(target => ({ target: { type: 'uri', value: target } })) : [] } };
    }
    override async commandWithReceipt(envelope: CommandEnvelope) {
      commands.push(envelope); receipts.add(envelope.receipt);
      for (const target of envelope.validations.flatMap(validation => validation.focus)) suppressed.add(target);
      return { status: 'committed' as const, position: { datasetId: 'urn:rezics:dataset:product',
        dataEpoch: uuid(12), sequence: '7' } };
    }
  }
  const graph = new NativeInputGraph(), original = [uuid(1), home], expandedTargets = [...original, addedHome];
  await suppressGraphContentRevisions(graph, { dataEpoch: uuid(12), routingEpoch: '2' }, uuid(13), '7', original);
  const expandedDigest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId: uuid(13), epoch: '7',
    targets: canonicalErasureTargets(expandedTargets) }));
  await suppressGraphContentRevisions(graph, { dataEpoch: uuid(12), routingEpoch: '2' }, uuid(13), '7',
    expandedTargets, graphErasureReceipt(uuid(13), expandedDigest));
  expect(commands).toHaveLength(2);
  cpSync(join(root, 'infra/jena/command-module/pom.xml'), join(build, 'pom.xml'));
  cpSync(join(root, 'infra/jena/command-module/src/main'), join(build, 'src/main'), {
    recursive: true,
  });
  const java = join(build, 'src/test/java/com/rezics/jena');
  mkdirSync(java, { recursive: true });
  mkdirSync(join(build, 'tmp'));
  writeFileSync(
    join(java, 'ErasureHeldCallerContractTest.java'),
    `package com.rezics.jena;
import static org.junit.Assert.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.graph.*;
import org.apache.jena.query.*;
import org.apache.jena.sparql.core.*;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.update.*;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;
public class ErasureHeldCallerContractTest {
  private static Node iri(String v){return NodeFactory.createURI(v);}
  private static Node rv(String v){return iri("https://rezics.com/vocab/"+v);}
  private static Node text(String v){return NodeFactory.createLiteralString(v);}
  private static Node integer(int v){return NodeFactory.createLiteralByValue(java.math.BigInteger.valueOf(v),org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger);}
  @Test public void expandedHomeClosureNeverReactivatesAnErasedRevision() throws Exception {
    var data=TDB2Factory.connectDataset(Files.createTempDirectory(Path.of(System.getProperty("java.io.tmpdir")),"home-delta-").toString()).asDatasetGraph();
    data.begin(ReadWrite.WRITE);
    Node control=iri(CommandPolicy.CONTROL), product=iri("urn:rezics:dataset:product"),revisions=iri(CommandPolicy.REVISIONS);
    data.add(control,product,rv("dataEpoch"),text("${uuid(12)}"));data.add(control,product,rv("routingEpoch"),text("2"));data.add(control,product,rv("sequence"),integer(0));
    data.add(revisions,iri("${home}"),RDF.type.asNode(),rv("RevisionAnchor"));
    data.add(revisions,iri("${home}"),RDF.type.asNode(),rv("ZoneHomeRevision"));
    data.add(revisions,iri("${home}"),rv("publishedPage"),iri("urn:rezics:page:original"));
    data.add(revisions,iri("urn:rezics:page:original"),rv("contentRevision"),iri("${content}"));
    data.commit();data.end();
    for(String path : List.of("home-original.json", "home-expanded.json")) {
      if(path.equals("home-expanded.json")) {
        data.begin(ReadWrite.WRITE);
        data.add(revisions,iri("${addedHome}"),RDF.type.asNode(),rv("RevisionAnchor"));
        data.add(revisions,iri("${addedHome}"),RDF.type.asNode(),rv("ZoneHomeRevision"));
        data.add(revisions,iri("${addedHome}"),rv("publishedPage"),iri("urn:rezics:page:new"));
        data.add(revisions,iri("urn:rezics:page:new"),rv("contentRevision"),iri("${content}"));
        data.commit();data.end();
      }
      var body=JSON.parse(Files.readString(Path.of(path)));
      var request=UpdateFactory.create(body.get("update").getAsString().value());
      var modify=(UpdateModify)request.getOperations().getFirst();
      Set<String> graphs=new HashSet<>(),targets=new HashSet<>();
      List<Quad> all=new ArrayList<>(modify.getInsertQuads());all.addAll(modify.getDeleteQuads());
      for(Quad q:all){graphs.add(q.getGraph().getURI());if(q.getGraph().getURI().equals(CommandPolicy.REVISIONS))targets.add(q.getSubject().getURI());}
      var plan=new CommandPolicy.Plan(request,graphs,Set.of(),targets,Set.of(),false,false,true);
      data.begin(ReadWrite.WRITE);
      assertNull("native erasure must accept the expanded delta",ErasurePolicy.preflight(data,plan,body.get("receipt").getAsString().value()));
      UpdateAction.execute(request,DatasetFactory.wrap(data));data.commit();data.end();
    }
    data.begin(ReadWrite.READ);
    for(String target : List.of("${content}","${home}","${addedHome}")) assertTrue(data.contains(revisions,iri(target),RDF.type.asNode(),rv("ErasedRevision")));
    data.end();data.close();
  }
  @Test public void typeScriptBodyReplaysExactHeldErasureAndPreservesControl() throws Exception {
    for(String path : List.of("${replayFile}")) {
    var body=JSON.parse(Files.readString(Path.of(path)));
    String receipt=body.get("receipt").getAsString().value(),digest=body.get("digest").getAsString().value(),update=body.get("update").getAsString().value();
    var data=TDB2Factory.connectDataset(Files.createTempDirectory(Path.of(System.getProperty("java.io.tmpdir")),"held-caller-").toString()).asDatasetGraph();
    Node control=iri(CommandPolicy.CONTROL), product=iri("urn:rezics:dataset:product"),marker=iri("${held.cut.restoreCutover}");
    data.begin(ReadWrite.WRITE);
    data.add(control,product,rv("dataEpoch"),text("${held.cut.dataEpoch}"));data.add(control,product,rv("routingEpoch"),text("2"));data.add(control,product,rv("sequence"),integer(0));
    data.add(control,product,rv("restoreCutover"),marker);data.add(control,product,rv("restoreHold"),NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
    data.add(control,marker,RDF.type.asNode(),rv("RestoreCutover"));data.add(control,marker,rv("dataEpoch"),text("${held.cut.dataEpoch}"));
    data.add(control,marker,rv("priorDataEpoch"),text("${held.cut.priorDataEpoch}"));data.add(control,marker,rv("priorSequence"),integer(3));data.add(control,marker,rv("reconciledPriorSequence"),integer(5));
    for(int n=1;n<=2;n++){
      Node graph=iri(n==1?CommandPolicy.PUBLIC_SEARCH:CommandPolicy.PRIVATE_SEARCH),unit=iri("urn:rezics:held-caller:unit:"+n);
      data.add(graph,unit,RDF.type.asNode(),rv("MatchUnit"));data.add(graph,unit,rv("revision"),iri("urn:rezics:content:revision:00000000-0000-4000-8000-%012d".formatted(n)));
      data.add(graph,unit,rv(n==1?"searchBody":"privateSearchBody"),text("exact caller bytes"));
    }
    data.commit();data.end();
    var request=UpdateFactory.create(update);var modify=(UpdateModify)request.getOperations().getFirst();
    Set<String> graphs=new HashSet<>(),targets=new HashSet<>();List<Quad> all=new ArrayList<>(modify.getInsertQuads());all.addAll(modify.getDeleteQuads());
    for(Quad q:all){graphs.add(q.getGraph().getURI());if(q.getGraph().getURI().equals(CommandPolicy.REVISIONS))targets.add(q.getSubject().getURI());}
    // The unloaned parser's new-family hooks are not fabricated by this test.
    var plan=new CommandPolicy.Plan(request,graphs,Set.of(),targets,Set.of(),false,false,true);
    data.begin(ReadWrite.WRITE);
    var before=ErasureRestorePolicy.capture(data,plan,receipt,digest,update,body.get("titleAdmission"),"${'3'.repeat(64)}".getBytes(StandardCharsets.UTF_8));
    assertNull(before.error());var staged=new CommandOverlay(data);UpdateAction.execute(request,DatasetFactory.wrap(staged));
    assertNull(ErasureRestorePolicy.check(staged,before));staged.apply();data.commit();data.end();
    data.begin(ReadWrite.READ);
    var after=CommandInvariant.readControl(data);assertTrue(after.held());assertEquals(java.math.BigInteger.ZERO,after.sequence());assertEquals(java.math.BigInteger.valueOf(5),after.cursor());
    assertTrue(data.contains(iri(CommandPolicy.RECEIPTS),iri(path.equals("command.json") ? "${held.original.receipt}" : "${expanded.original.receipt}"),rv("sequence"),integer(9)));
    assertTrue(data.contains(iri(CommandPolicy.RECEIPTS),iri(receipt),rv("sequence"),integer(0)));
    assertFalse(data.contains(iri(CommandPolicy.PUBLIC_SEARCH),iri("urn:rezics:held-caller:unit:1"),Node.ANY,Node.ANY));
    assertFalse(data.contains(iri(CommandPolicy.PRIVATE_SEARCH),iri("urn:rezics:held-caller:unit:2"),Node.ANY,Node.ANY));
    data.end();data.close();
    }
  }
}
`,
  );
  const name = `rezics-held-caller-native-${Date.now()}`;
  try {
    const run = (goals: string[]) => spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--volume',
        `${build}:/build`,
        '--volume',
        `${cache}:/maven-cache`,
        '--env',
        'MAVEN_CONFIG=/maven-cache',
        '--workdir',
        '/build',
        image,
        'mvn',
        '-B',
        '-ntp',
        '-Dmaven.repo.local=/maven-cache',
        '-Djava.io.tmpdir=/build/tmp',
        '-Dtest=ErasureHeldCallerContractTest',
        ...goals,
      ],
      { cwd: root, encoding: 'utf8', timeout: 300_000, env: preserveReapEnvironment(process.env) },
    );
    const compiled = run(['-DskipTests', 'test-compile']);
    if (compiled.status !== 0) throw new Error(`Native caller compilation failed: ${compiled.stdout}\n${compiled.stderr}`);
    // Signing belongs after compilation: a slow cold build must not expire an
    // otherwise valid maintenance fixture before the native policy reads it.
    writeFileSync(join(build, 'command.json'), JSON.stringify(command()));
    writeFileSync(join(build, 'command-closure.json'), JSON.stringify(command(expanded)));
    writeFileSync(join(build, 'home-original.json'), JSON.stringify(commands[0]));
    writeFileSync(join(build, 'home-expanded.json'), JSON.stringify(commands[1]));
    const result = run(['surefire:test']);
    mkdirSync(join(root, '.temp/goal'), { recursive: true });
    writeFileSync(
      join(root, '.temp/goal/held-caller-native.log'),
      `${result.stdout}\n${result.stderr}`,
    );
    if (result.status !== 0)
      throw new Error(`Native caller interoperability failed: ${result.stdout}\n${result.stderr}`
        + `${result.error ? `\n${result.error.message}` : ''}`
        + `${result.signal ? `\nSignal: ${result.signal}` : ''}`);
    expect(result.stdout).toContain('Tests run: 2, Failures: 0, Errors: 0');
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 30_000, env: preserveReapEnvironment(process.env) });
    rmSync(build, { recursive: true, force: true });
  }
}

test('production erasure commands pass native delta suppression and held replay policies',
  () => nativeErasureReplay('command.json'), 310_000);

// fails until a later native image accepts re-asserting already erased targets of a home closure extension
test.failing('held home closure extension replays its replacement receipt through the native restore policy',
  () => nativeErasureReplay('command-closure.json'), 310_000);
