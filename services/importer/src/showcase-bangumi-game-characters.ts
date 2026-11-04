import type { SourceVocabularyBindings } from '@rezics/conversion';
import type { CrossMediaPlan, CrossMediaPort } from './cross-media-seed.ts';
import {
  prepareShowcaseBangumiCharacterVocabulary,
  readShowcaseBangumiCharacterVocabulary,
  type ShowcaseBangumiCharacterVocabulary,
} from './showcase-bangumi-characters.ts';
import type { ShowcaseJournal } from './showcase-publication.ts';

type PrepareInput = {
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'batch' | 'readReviewedSubject'>;
  journal: ShowcaseJournal;
  stage: 'schemes' | 'concepts';
};

type ReadInput = {
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'readReviewedSubject'>;
  journal: ShowcaseJournal;
};

/** Publish vocabulary for actual appearances on selected type-4 Games only. */
export function prepareShowcaseBangumiGameCharacterVocabulary(
  input: PrepareInput,
): Promise<ShowcaseBangumiCharacterVocabulary> {
  return prepareShowcaseBangumiCharacterVocabulary({ ...input, workTypes: [4] });
}

/** Read the current native bindings for actual selected Game associations. */
export function readShowcaseBangumiGameCharacterVocabulary(input: ReadInput): Promise<SourceVocabularyBindings> {
  return readShowcaseBangumiCharacterVocabulary({ ...input, workTypes: [4] });
}

/** The ordinary selected-family caller composes unchanged anime and new Game associations once. */
export function prepareShowcaseBangumiSelectedCharacterVocabulary(
  input: PrepareInput,
): Promise<ShowcaseBangumiCharacterVocabulary> {
  return prepareShowcaseBangumiCharacterVocabulary({ ...input, workTypes: [2, 4] });
}

/** Resolve one current binding set for the selected anime and Game association families. */
export function readShowcaseBangumiSelectedCharacterVocabulary(input: ReadInput): Promise<SourceVocabularyBindings> {
  return readShowcaseBangumiCharacterVocabulary({ ...input, workTypes: [2, 4] });
}
