import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { PublishedStructuredWorkSource } from '../src/modules/work/public-patterns.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runJava } from '../../../infra/jena/tests/tdb2-integrity/support.ts';

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
  const directory = mkdtempSync(join(parent, 'run-'));
  try {
    writeFileSync(join(directory, 'queries.json'), JSON.stringify(cases));
    const result = runJava('QueryDataset', ['/database/queries.json'], directory, '256m');
    if (result.status !== 0) throw new Error(`Publication query evaluation failed:\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout) as SparqlResult[];
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
