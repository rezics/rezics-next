import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { PublishedStructuredWorkSource } from '../src/modules/work/public-patterns.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const uri = (value: string) => ({ type: 'uri' as const, value });

export const structuredWorkSourceRow = (source: PublishedStructuredWorkSource, includeCandidate = false) => ({
  ...(includeCandidate ? { work: uri(source.work), main: uri(source.mainVersion) } : {}),
  structuredDecision: uri(source.decision), structuredSource: uri(source.source),
  structuredStructure: uri(source.structure), structuredProfile: uri(source.structureProfile),
  structuredRevision: uri(source.structureRevision), structuredGeneration: uri(source.selectedGeneration),
  structuredRoot: uri(source.sourceRoot),
  structuredExact: { type: 'literal' as const, value: 'true' },
});

/** Owner fakes share the exact-source projection instead of letting broad
 * Work-head handlers accidentally answer publication queries. */
export function structuredWorkPublicationAnswer(query: string,
  sources: readonly PublishedStructuredWorkSource[] = []): SparqlResult | undefined {
  if (query.includes('SELECT ?work ?main ?structuredDecision')) {
    const works = [...(query.match(/VALUES \?work \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
      .map(match => match[1]!);
    return { results: { bindings: works.flatMap((work): NonNullable<SparqlResult['results']>['bindings'] => {
      const published = sources.filter(source => source.work === work);
      return published.length ? published.map(source => structuredWorkSourceRow(source, true)) : [{ work: uri(work) }];
    }) } };
  }
  if (query.includes('SELECT ?structuredDecision ?structuredSource')) {
    return { results: { bindings: sources.filter(source => query.includes(`<${source.work}>`)
      && query.includes(`<${source.mainVersion}>`)).map(source => structuredWorkSourceRow(source)) } };
  }
  return undefined;
}

/** Batch real SPARQL evaluations into one pinned Jena turn; no server or
 * persistent graph is needed for the owner read's semantic proof. */
export function evaluatePublicationQueries(cases: readonly { dataset: string; query: string }[]): SparqlResult[] {
  const parent = resolve('.temp/structured-work-publication-query');
  mkdirSync(parent, { recursive: true });
  // In-memory ARQ needs the upstream Jena jar, not the product's native TDB2
  // command module. Reuse the distribution checksum and JDK from its build.
  const dockerfile = readFileSync(new URL('../../../infra/jena/Dockerfile', import.meta.url), 'utf8');
  const builder = /^FROM (\S+) AS module$/m.exec(dockerfile)?.[1];
  const version = /^ARG FUSEKI_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1];
  const checksum = /^ARG FUSEKI_SHA512=([a-f0-9]{128})$/m.exec(dockerfile)?.[1];
  if (!builder || !version || !checksum) throw new Error('Publication evaluator needs the pinned Jena distribution and JDK');
  const cache = join(parent, `jena-${checksum.slice(0, 12)}`);
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(parent, 'run-'));
  try {
    writeFileSync(join(directory, 'queries.json'), JSON.stringify(cases));
    const script = [
      'set -eu',
      'jar=/cache/apache-jena-fuseki-$1/fuseki-server.jar',
      'if [ ! -f "$jar" ]; then',
      '  curl --fail --silent --show-error --location --retry 3 "https://archive.apache.org/dist/jena/binaries/apache-jena-fuseki-$1.tar.gz" --output /cache/fuseki.tar.gz',
      '  printf "%s  /cache/fuseki.tar.gz\\n" "$2" | sha512sum --check >&2',
      '  tar -xzf /cache/fuseki.tar.gz -C /cache "apache-jena-fuseki-$1/fuseki-server.jar"',
      '  rm /cache/fuseki.tar.gz',
      'fi',
      'mkdir /tmp/classes',
      'javac -nowarn -cp "$jar" -d /tmp/classes /sources/QueryDataset.java',
      'exec java -Xmx256m -cp "$jar:/tmp/classes" QueryDataset /database/queries.json',
    ].join('\n');
    const sources = resolve(import.meta.dir, '../../../infra/jena/tests/tdb2-integrity');
    const result = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh',
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--volume', `${cache}:/cache`, '--volume', `${sources}:/sources:ro`,
      '--volume', `${directory}:/database:ro`, builder, '-c', script, 'publication-query', version, checksum],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Publication query evaluation failed:\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout) as SparqlResult[];
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
