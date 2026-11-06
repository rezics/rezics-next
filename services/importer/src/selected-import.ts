import type { SourceVocabularyBindings } from '@rezics/conversion';
import { planCrossMediaSeed, seedCrossMedia } from './cross-media-seed.ts';
import { importBangumiEpisodeFidelity as runBangumiEpisodeFidelity } from './bangumi-episode-fidelity.ts';
import { importShowcaseBooks as runShowcaseBooks } from './showcase-books.ts';
import { importShowcaseTags as runShowcaseTags } from './showcase-tags.ts';
import {
  seedShowcaseVndbReleases as runShowcaseVndbReleases,
  type ShowcaseVndbReleaseResult,
} from './showcase-vndb-releases.ts';
import { importVndbCharacterTraits as runVndbCharacterTraits } from './vndb-character-traits.ts';
import { importVndbPublicTags as runVndbPublicTags } from './vndb-public-tags.ts';
import { importVndbReleaseFidelity as runVndbReleaseFidelity } from './vndb-release-fidelity.ts';
import { importVndbReleaseIdentifiers as runVndbReleaseIdentifiers } from './vndb-release-identifiers.ts';
import { importVndbReleaseLanguage as runVndbReleaseLanguage } from './vndb-release-language.ts';
import { importVndbStaffCredits as runVndbStaffCredits } from './vndb-staff-credits.ts';
import type { CrossMediaPlan, CrossMediaTables } from './showcase-contract.ts';

type Seeded<T> = Omit<T, 'seed'>;

/** Ordinary callers bind seed once. Producer modules keep seed as an explicit argument. */
export async function importVndbStaffCredits(input: Seeded<Parameters<typeof runVndbStaffCredits>[0]>) {
  return runVndbStaffCredits({ ...input, seed: seedCrossMedia });
}

export async function importVndbCharacterTraits(input: Seeded<Parameters<typeof runVndbCharacterTraits>[0]>) {
  return runVndbCharacterTraits({ ...input, seed: seedCrossMedia });
}

export async function importVndbPublicTags(input: Seeded<Parameters<typeof runVndbPublicTags>[0]>) {
  return runVndbPublicTags({ ...input, seed: seedCrossMedia });
}

export async function importVndbReleaseFidelity(input: Seeded<Parameters<typeof runVndbReleaseFidelity>[0]>) {
  return runVndbReleaseFidelity({ ...input, seed: seedCrossMedia });
}

export async function importVndbReleaseLanguage(input: Seeded<Parameters<typeof runVndbReleaseLanguage>[0]>) {
  return runVndbReleaseLanguage({ ...input, seed: seedCrossMedia });
}

export async function importVndbReleaseIdentifiers(input: Seeded<Parameters<typeof runVndbReleaseIdentifiers>[0]>) {
  return runVndbReleaseIdentifiers({ ...input, seed: seedCrossMedia });
}

export async function importBangumiEpisodeFidelity(input: Seeded<Parameters<typeof runBangumiEpisodeFidelity>[0]>) {
  return runBangumiEpisodeFidelity({ ...input, seed: seedCrossMedia });
}

export async function importShowcaseTags(input: Seeded<Parameters<typeof runShowcaseTags>[0]>) {
  return runShowcaseTags({ ...input, seed: seedCrossMedia });
}

export async function importShowcaseBooks(input: Seeded<Parameters<typeof runShowcaseBooks>[0]>) {
  return runShowcaseBooks({ ...input, seed: seedCrossMedia });
}

export async function seedShowcaseVndbReleases(
  input: Omit<Parameters<typeof runShowcaseVndbReleases>[0], 'seed' | 'plan'> & {
    tables: CrossMediaTables;
    plan?: CrossMediaPlan;
    bindings?: SourceVocabularyBindings;
  },
): Promise<ShowcaseVndbReleaseResult> {
  const plan = input.plan ?? (await planCrossMediaSeed(input.tables));
  return runShowcaseVndbReleases({ ...input, plan, seed: seedCrossMedia });
}
