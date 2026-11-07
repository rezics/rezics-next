import { createReviewedCatalogueApplication } from './reviewed-catalogue-application.ts';
import {
  releasedReviewedVocabulary,
  type ReviewedVocabularyPort,
} from './reviewed-vocabulary-port.ts';
import type { RecordBindings } from './record-bindings.ts';
import type {
  ReviewedBangumiBindingStatus,
  ReviewedBangumiTagBinding,
  ReviewedBangumiTagCurrentRead,
  ReviewedCataloguePort,
  ReviewedCatalogueResult,
  ReviewedCatalogueSeedInput,
} from './reviewed-catalogue-contract.ts';

export * from './reviewed-catalogue-contract.ts';
export type { ReviewedCatalogueApplication } from './reviewed-catalogue-application.ts';

function application(vocabulary?: ReviewedVocabularyPort) {
  return createReviewedCatalogueApplication({ vocabulary: vocabulary ?? releasedReviewedVocabulary() });
}

/** Explicit trusted operator tool; transport and ledger are supplied by its caller. */
export async function seedReviewedCatalogue(input: ReviewedCatalogueSeedInput): Promise<ReviewedCatalogueResult> {
  return application(input.vocabulary).seed(input);
}

/** Current native proof, using local journal IDs only as read anchors, never as editorial receipts. */
export async function inspectReviewedBangumiBinding(
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
  signal?: AbortSignal,
  vocabulary?: ReviewedVocabularyPort,
): Promise<ReviewedBangumiBindingStatus> {
  return application(vocabulary).inspect(bindings, port, signal);
}

export async function readReviewedBangumiBinding(
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
  signal?: AbortSignal,
  vocabulary?: ReviewedVocabularyPort,
): Promise<{ sourceConcept: string; canonicalConcept: string } | null> {
  return application(vocabulary).readBinding(bindings, port, signal);
}

/** Independent current reads of a bound Bangumi tag pair before membership publication. */
export async function resolveCurrentReviewedBangumiTagSubjects(
  port: Pick<ReviewedCataloguePort, 'readReviewedSubject'>,
  binding: ReviewedBangumiTagBinding,
  signal?: AbortSignal,
): Promise<ReviewedBangumiTagCurrentRead> {
  return application().resolveCurrentReviewedBangumiTagSubjects(port, binding, signal);
}

export function createReviewedCatalogueLookup(
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
  options: { preserveKeywordOnUnavailable?: boolean; vocabulary?: ReviewedVocabularyPort } = {},
) {
  return application(options.vocabulary).lookup(bindings, port, options);
}
