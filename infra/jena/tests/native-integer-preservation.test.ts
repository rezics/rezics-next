import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fusekiImageTag } from '../../../scripts/dev/fuseki-image.ts';

// Physical proof for the ThriftConvert patch in infra/jena/Dockerfile: TDB2 files written by one JVM
// are read by a NEW JVM, because the writer's node cache would otherwise answer from memory.
// The unpatched behaviour is the pinned upstream class placed ahead of the image's jar.

const root = resolve(import.meta.dir, '../../..');
const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
const builder = /^FROM (\S+) AS module$/m.exec(dockerfile)?.[1];
const fuseki = /^ARG FUSEKI_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
const pinned = /^ARG THRIFT_CONVERT_SHA256=([0-9a-f]{64})$/m.exec(dockerfile)?.[1];
if (!builder || !fuseki || !pinned) throw new Error('Fuseki Dockerfile no longer pins builder, version and class hash');
const jarInImage = `/opt/apache-jena-fuseki-${fuseki}/fuseki-server.jar`;
const arqJar = `https://repo1.maven.org/maven2/org/apache/jena/jena-arq/${fuseki}/jena-arq-${fuseki}.jar`;
const thriftClass = 'org/apache/jena/riot/thrift/ThriftConvert.class';

const pow = (exponent: number) => 2n ** BigInt(exponent);
const long = pow(63) - 1n;
type Case = { id: string; type: 'integer' | 'long' | 'int'; lexical: string };
const cases: Case[] = [
  { id: 'digits120', type: 'integer', lexical: '1'.repeat(120) },
  { id: 'negative110', type: 'integer', lexical: `-${'9'.repeat(110)}` },
  { id: 'two64plus1', type: 'integer', lexical: String(pow(64) + 1n) },
  { id: 'negativeTwo64', type: 'integer', lexical: String(-pow(64) - 1n) },
  { id: 'longMaxPlus1', type: 'integer', lexical: String(long + 1n) },
  { id: 'longMinMinus1', type: 'integer', lexical: String(-long - 2n) },
  { id: 'longMax', type: 'integer', lexical: String(long) },
  { id: 'longMin', type: 'integer', lexical: String(-long - 1n) },
  { id: 'two55', type: 'integer', lexical: String(pow(55)) },
  { id: 'negativeTwo55Minus1', type: 'integer', lexical: String(-pow(55) - 1n) },
  { id: 'two62', type: 'integer', lexical: String(pow(62)) },
  { id: 'inline', type: 'integer', lexical: '123' },
  { id: 'inlineBoundary', type: 'integer', lexical: String(pow(55) - 1n) },
  { id: 'paddedInteger', type: 'integer', lexical: '+000000000000000000012' },
  { id: 'longTypeMax', type: 'long', lexical: String(long) },
  { id: 'longTypeMin', type: 'long', lexical: String(-long - 1n) },
  { id: 'longTypeTwo55', type: 'long', lexical: String(pow(55)) },
  { id: 'longTypePadded', type: 'long', lexical: '+0000000000000000000012' },
  { id: 'intMax', type: 'int', lexical: '2147483647' },
  { id: 'intMin', type: 'int', lexical: '-2147483648' },
  { id: 'intPadded', type: 'int', lexical: '0000000000000000000000012' },
];
// Fits TDB2's signed-56-bit inline policy (and 19 characters): stored in the index, not the node table.
const inlined = (c: Case) => c.lexical.length <= 19 && BigInt(c.lexical) >= -pow(55) && BigInt(c.lexical) < pow(55);
// Plain xsd:integer whose value is a canonical signed 64-bit number: stored identically by both writers.
const validLong = (c: Case) => c.type === 'integer' && BigInt(c.lexical) >= -long - 1n && BigInt(c.lexical) <= long
  && String(BigInt(c.lexical)) === c.lexical;

/** What unpatched Jena 6.2.0 persists: the low 64 bits as xsd:integer, unless TDB2 inlined the value. */
function unpatched(c: Case): { type: string; lexical: string } {
  if (inlined(c)) return { type: c.type, lexical: String(BigInt(c.lexical)) };
  return { type: 'integer', lexical: String(BigInt.asIntN(64, BigInt(c.lexical))) };
}

const probe = `
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.*;
import org.apache.jena.riot.thrift.ThriftConvert;
import org.apache.jena.system.Txn;
import org.apache.jena.tdb2.TDB2Factory;

public class NativeIntegerProbe {
  public static void main(String[] args) throws Exception {
    String mode = args[0];
    Node graph = NodeFactory.createURI("urn:test:graph"), subject = NodeFactory.createURI("urn:test:subject");
    var dataset = TDB2Factory.connectDataset(args[1]);
    List<String[]> cases = new ArrayList<>();
    for (String line : Files.readAllLines(Path.of(args[2]))) cases.add(line.split("\\t", 3));
    if (mode.equals("write")) {
      Txn.executeWrite(dataset, () -> { for (String[] c : cases) dataset.asDatasetGraph().add(graph, subject,
        NodeFactory.createURI("urn:test:" + c[0]),
        NodeFactory.createLiteralDT(c[2], type(c[1]))); });
    } else {
      Txn.executeRead(dataset, () -> { for (String[] c : cases) {
        var found = dataset.asDatasetGraph().find(graph, subject, NodeFactory.createURI("urn:test:" + c[0]), Node.ANY);
        Node object = found.next().getObject();
        if (found.hasNext()) throw new IllegalStateException("duplicate " + c[0]);
        System.out.println("TERM\\t" + c[0] + "\\t" + object.getLiteralDatatypeURI().replaceAll(".*#", "") + "\\t" + object.getLiteralLexicalForm());
      } });
    }
    byte[] bytes;
    try (var in = ThriftConvert.class.getResourceAsStream("ThriftConvert.class")) { bytes = in.readAllBytes(); }
    System.out.println("CLASS\\t" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))
      + "\\t" + ThriftConvert.class.getProtectionDomain().getCodeSource().getLocation());
    dataset.close();
  }
  static org.apache.jena.datatypes.RDFDatatype type(String name) {
    return switch (name) { case "integer" -> XSDDatatype.XSDinteger; case "long" -> XSDDatatype.XSDlong;
      case "int" -> XSDDatatype.XSDint; default -> throw new IllegalArgumentException(name); };
  }
}
`;

function run(command: string, args: string[], timeout = 240_000) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('physical TDB2 files keep every xsd:integer across a new JVM, and unpatched Jena truncates them', async () => {
  const image = fusekiImageTag(root);
  const inspect = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
  if (inspect.status !== 0) throw new Error(`build ${image} first (docker compose -f infra/dev/compose.yaml build fuseki)`);

  const cache = join(root, '.temp/native-integer-preservation-cache');
  mkdirSync(cache, { recursive: true });
  const jena = join(cache, `jena-arq-${fuseki}.jar`);
  if (!existsSync(jena)) {
    const response = await fetch(arqJar);
    if (!response.ok) throw new Error(`cannot fetch ${arqJar}: HTTP ${response.status}`);
    writeFileSync(jena, new Uint8Array(await response.arrayBuffer()));
  }
  mkdirSync(join(root, '.temp'), { recursive: true });
  const work = mkdtempSync(join(root, '.temp/native-integer-preservation-'));
  const user = `${process.getuid!()}:${process.getgid!()}`;
  const docker = (image: string, args: string[], extra: string[] = []) => run('docker',
    ['run', '--rm', '--user', user, '--volume', `${work}:/work`, ...extra, image, ...args]);
  const java = (classpath: string[], mode: string, db: string, file: string) => {
    const output = docker(image, ['-cp', classpath.join(':'), 'NativeIntegerProbe', mode, `/work/${db}`, `/work/${file}`],
      ['--entrypoint', 'java', '--workdir', '/work']);
    const terms = new Map<string, { type: string; lexical: string }>();
    for (const line of output.split('\n')) {
      const [kind, id, type, lexical] = line.split('\t');
      if (kind === 'TERM') terms.set(id!, { type: type!, lexical: lexical! });
    }
    return { terms, sha: /^CLASS\t([0-9a-f]{64})\t/m.exec(output)?.[1] };
  };
  try {
    writeFileSync(join(work, 'NativeIntegerProbe.java'), probe);
    const tsv = (list: Case[]) => list.map(c => `${c.id}\t${c.type}\t${c.lexical}`).join('\n');
    writeFileSync(join(work, 'all.tsv'), tsv(cases));
    writeFileSync(join(work, 'valid.tsv'), tsv(cases.filter(validLong)));
    run('docker', ['create', '--name', `native-integer-${process.pid}`, image]);
    try {
      run('docker', ['cp', `native-integer-${process.pid}:${jarInImage}`, join(work, 'fuseki-server.jar')]);
    } finally {
      spawnSync('docker', ['rm', `native-integer-${process.pid}`]);
    }
    mkdirSync(join(work, 'original'));
    mkdirSync(join(work, 'classes'));
    copyFileSync(jena, join(work, 'jena-arq.jar'));
    docker(builder!, ['sh', '-c', `cd /work/original && jar xf /work/jena-arq.jar ${thriftClass}`]);
    docker(builder!, ['javac', '--release', '21', '-cp', '/work/fuseki-server.jar', '-d', '/work/classes',
      '/work/NativeIntegerProbe.java']);

    const patchedPath = ['/work/classes', jarInImage];
    const unpatchedPath = ['/work/classes', '/work/original', jarInImage];
    const originalHash = run('sha256sum', [join(work, 'original', thriftClass)]).split(' ')[0];
    // The upstream jar and the shaded Fuseki jar carry the same class the Dockerfile pins.
    expect(originalHash).toBe(pinned);

    // Unpatched Jena: the actual counterexample, read back by a new JVM.
    java(unpatchedPath, 'write', 'old', 'all.tsv');
    const old = java(unpatchedPath, 'read', 'old', 'all.tsv');
    expect(old.sha).toBe(pinned);
    for (const c of cases) expect({ id: c.id, ...old.terms.get(c.id)! }).toEqual({ id: c.id, ...unpatched(c) });
    const changed = cases.filter(c => old.terms.get(c.id)!.lexical !== c.lexical || old.terms.get(c.id)!.type !== c.type);
    expect(changed.map(c => c.id)).toEqual(expect.arrayContaining(['digits120', 'negative110', 'two64plus1',
      'longMaxPlus1', 'longTypeMax', 'paddedInteger']));

    // Patched image jar: exact datatype and lexical form for every case, from a separate writer and reader.
    java(patchedPath, 'write', 'new', 'all.tsv');
    const fixed = java(patchedPath, 'read', 'new', 'all.tsv');
    expect(fixed.sha).not.toBe(pinned);
    for (const c of cases) {
      const expected = inlined(c) ? unpatched(c) : { type: c.type, lexical: c.lexical };
      expect({ id: c.id, ...fixed.terms.get(c.id)! }).toEqual({ id: c.id, ...expected });
    }
    for (const id of ['digits120', 'negative110', 'two64plus1', 'longMaxPlus1', 'longTypeMax', 'paddedInteger'])
      expect(fixed.terms.get(id)).not.toEqual(old.terms.get(id)!);

    // Files an unpatched Jena wrote stay readable and unchanged under the patched jar: no healing, no guessing
    // of original terms from truncated bytes.
    const reread = java(patchedPath, 'read', 'old', 'all.tsv');
    expect(Object.fromEntries(reread.terms)).toEqual(Object.fromEntries(old.terms));
    java(unpatchedPath, 'write', 'valid64', 'valid.tsv');
    const valid = java(patchedPath, 'read', 'valid64', 'valid.tsv');
    for (const c of cases.filter(validLong)) expect(valid.terms.get(c.id)).toEqual({ type: 'integer', lexical: c.lexical });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 420_000);
