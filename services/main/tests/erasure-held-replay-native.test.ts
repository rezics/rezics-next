import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHeldGraphErasureCommand, graphErasureReceipt } from '../src/modules/erasure/graph.ts';

const root = join(import.meta.dir, '../../..');
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

// Component interoperability only: the committed Java policy consumes the real
// TypeScript bytes in TDB2, without a fake HTTP handler or unloaned core hooks.
test('held caller exact bytes pass the lent native policy and keep the real TDB2 restore held at zero', () => {
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
  const command = buildHeldGraphErasureCommand(
    uuid(13),
    '7',
    held.revisionIds,
    held,
    [
      { graph: 'urn:rezics:search:public', unit: 'urn:rezics:held-caller:unit:1' },
      { graph: 'urn:rezics:search:private', unit: 'urn:rezics:held-caller:unit:2' },
    ],
    '3'.repeat(64),
    new Date(Date.now() + 240_000).toISOString(),
  );
  cpSync(join(root, 'infra/jena/command-module/pom.xml'), join(build, 'pom.xml'));
  cpSync(join(root, 'infra/jena/command-module/src/main'), join(build, 'src/main'), {
    recursive: true,
  });
  const java = join(build, 'src/test/java/com/rezics/jena');
  mkdirSync(java, { recursive: true });
  mkdirSync(join(build, 'tmp'));
  writeFileSync(join(build, 'command.json'), JSON.stringify(command));
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
  @Test public void typeScriptBodyReplaysExactHeldErasureAndPreservesControl() throws Exception {
    var body=JSON.parse(Files.readString(Path.of("command.json")));
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
    assertTrue(data.contains(iri(CommandPolicy.RECEIPTS),iri("${held.original.receipt}"),rv("sequence"),integer(9)));
    assertTrue(data.contains(iri(CommandPolicy.RECEIPTS),iri(receipt),rv("sequence"),integer(0)));
    assertFalse(data.contains(iri(CommandPolicy.PUBLIC_SEARCH),iri("urn:rezics:held-caller:unit:1"),Node.ANY,Node.ANY));
    assertFalse(data.contains(iri(CommandPolicy.PRIVATE_SEARCH),iri("urn:rezics:held-caller:unit:2"),Node.ANY,Node.ANY));
    data.end();data.close();
  }
}
`,
  );
  const name = `rezics-held-caller-native-${Date.now()}`;
  try {
    const result = spawnSync(
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
        'test',
      ],
      { cwd: root, encoding: 'utf8', timeout: 150_000 },
    );
    mkdirSync(join(root, '.temp/goal'), { recursive: true });
    writeFileSync(
      join(root, '.temp/goal/held-caller-native.log'),
      `${result.stdout}\n${result.stderr}`,
    );
    if (result.status !== 0)
      throw new Error(`Native caller interoperability failed: ${result.stdout}\n${result.stderr}`);
    expect(result.stdout).toContain('Tests run: 1, Failures: 0, Errors: 0');
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 30_000 });
    rmSync(build, { recursive: true, force: true });
  }
}, 185_000);
