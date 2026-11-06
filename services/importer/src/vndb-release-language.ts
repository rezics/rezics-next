import type { SourceVocabularyBindings } from '@rezics/conversion';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import {
  type CrossMediaPort,
  type CrossMediaTables,
} from './showcase-contract.ts';
import type {
  seedCrossMedia,
  CrossMediaSeedResult,
} from './cross-media-seed.ts';
import {
  planVndbReleaseFidelity,
  vndbReleaseVocabularyAdmission,
  type VndbReleaseFidelityResult,
} from './vndb-release-fidelity.ts';

export type VndbReleaseLanguageResult = VndbReleaseFidelityResult;

/** Production caller: selected-family COPY releases share convertCrossMediaEntity for original language. */
export async function importVndbReleaseLanguage(input: {
  seed: typeof seedCrossMedia;

  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings: SourceVocabularyBindings;
  destination?: { origin: string };
}): Promise<VndbReleaseLanguageResult> {
  const plan = await planVndbReleaseFidelity(input.tables);
  const result = await input.seed(plan, input.path, input.port, input.destination, {
    vocabularyAdmission: vndbReleaseVocabularyAdmission(input.bindings, plan.facts),
    recordConcurrency: 1,
  });
  return { ...result, converterRevision: entityRevision };
}

export { planVndbReleaseFidelity as planVndbReleaseLanguage };
export type { CrossMediaSeedResult, CrossMediaTables };
