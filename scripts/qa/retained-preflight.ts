import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { retainedRequirementKinds, retainedRequirements } from './retained-requirements.ts';

export interface RetainedRequirement {
  source: string;
  build: string;
  check(): Promise<string> | string;
}
export interface RetainedPreflight {
  ok: boolean;
  elapsedMs: number;
  sources: { source: string; key?: string; reason?: string; repair: string; elapsedMs: number }[];
}

/** All selected sources are checked before the caller starts its first test.
 * A refusal never delegates to a producer or falls back to a different key. */
export async function preflightRetainedSources(root: string, files: readonly string[],
  requirements?: RetainedRequirement[], custodyRoot = process.env.REZICS_QA_RETAINED_ROOT ?? root): Promise<RetainedPreflight> {
  if (!requirements && resolve(root) !== resolve(import.meta.dir, '../..')
    && retainedRequirementKinds(root, files).length) {
    const frozen = await import(pathToFileURL(resolve(root, 'scripts/qa/retained-preflight.ts')).href) as {
      preflightRetainedSources: typeof preflightRetainedSources;
    };
    return frozen.preflightRetainedSources(root, files, undefined, custodyRoot);
  }
  requirements ??= retainedRequirements(root, files, custodyRoot);
  const started = performance.now();
  const sources: RetainedPreflight['sources'] = [];
  for (const requirement of requirements) {
    const at = performance.now();
    try {
      sources.push({ source: requirement.source, key: await requirement.check(),
        repair: requirement.build, elapsedMs: performance.now() - at });
    } catch (error) {
      sources.push({ source: requirement.source, reason: error instanceof Error ? error.message : String(error),
        repair: requirement.build, elapsedMs: performance.now() - at });
    }
  }
  return { ok: sources.every(source => !source.reason), sources, elapsedMs: performance.now() - started };
}

export function retainedPreflightSummary(result: RetainedPreflight): string {
  return [`Retained-source preflight: ${result.ok ? 'passed' : 'refused'} (${Math.round(result.elapsedMs)}ms; ${result.sources.length} sources)`,
    ...result.sources.map(source => source.reason
      ? `${source.source}: ${source.reason}\nBuild/repair: ${source.repair}` : `${source.source}: ${source.key}`)].join('\n');
}

export async function assertRetainedSources(root: string, files: readonly string[]): Promise<void> {
  const result = await preflightRetainedSources(root, files);
  if (!result.ok) throw new Error(retainedPreflightSummary(result));
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Provide the selected test files');
  const result = await preflightRetainedSources(resolve(import.meta.dir, '../..'), files);
  console.log(retainedPreflightSummary(result));
  process.exitCode = result.ok ? 0 : 1;
}
