import type { Database } from 'bun:sqlite';
import { createImportTransport } from './import-client.ts';
import type { RecordBindings } from './record-bindings.ts';
import {
  createReviewedCatalogueApplication,
  openReviewedCatalogueLedger,
  type ReviewedCatalogueApplication,
} from './reviewed-catalogue-application.ts';
import {
  type ReviewedCatalogueLedger,
  type ReviewedCataloguePort,
  type ReviewedCatalogueResult,
} from './reviewed-catalogue.ts';
import { releasedReviewedVocabulary, type ReviewedVocabularyPort } from './reviewed-vocabulary-port.ts';
import { prepareShowcaseVndbReleases, seedShowcaseVndbReleases } from './showcase-vndb-releases.ts';

export { releasedReviewedVocabulary, type ReviewedVocabularyPort } from './reviewed-vocabulary-port.ts';
export { openReviewedCatalogueLedger, createReviewedCatalogueApplication } from './reviewed-catalogue-application.ts';

export type ReviewedCatalogueHost = Readonly<{
  vocabulary: ReviewedVocabularyPort;
  transport: ReviewedCataloguePort;
  ledger?: ReviewedCatalogueLedger;
  application: ReviewedCatalogueApplication;
  seed(input?: { path?: Database | string; seeds?: unknown; signal?: AbortSignal }): Promise<ReviewedCatalogueResult>;
  lookup(
    bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
    options?: { preserveKeywordOnUnavailable?: boolean },
  ): ReturnType<ReviewedCatalogueApplication['lookup']>;
}>;

export type ShowcaseVndbReleaseHost = Readonly<{
  vocabulary: ReviewedVocabularyPort;
  prepare: typeof prepareShowcaseVndbReleases;
  seed: typeof seedShowcaseVndbReleases;
}>;

export function composeReviewedCatalogueHost(input: {
  transport: ReviewedCataloguePort;
  path?: string | Database;
  ledger?: ReviewedCatalogueLedger;
  vocabulary?: ReviewedVocabularyPort;
}): ReviewedCatalogueHost {
  const vocabulary = input.vocabulary ?? releasedReviewedVocabulary();
  const ledger = input.ledger;
  const application = createReviewedCatalogueApplication({ vocabulary });
  return {
    vocabulary,
    transport: input.transport,
    ...(ledger ? { ledger } : {}),
    application,
    seed(request = {}) {
      const path = request.path ?? input.path;
      if (path === undefined && !ledger) throw new TypeError('Reviewed catalogue seed requires a ledger or state path');
      return application.seed({
        path: path ?? input.path!,
        port: input.transport,
        vocabulary,
        ...(ledger ? { ledger } : {}),
        ...(Object.hasOwn(request, 'seeds') ? { seeds: request.seeds } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    },
    lookup(bindings, options) {
      return application.lookup(bindings, input.transport, options);
    },
  };
}

export function composeShowcaseVndbReleaseHost(
  input: {
    vocabulary?: ReviewedVocabularyPort;
  } = {},
): ShowcaseVndbReleaseHost {
  const vocabulary = input.vocabulary ?? releasedReviewedVocabulary();
  return {
    vocabulary,
    prepare: (request) => prepareShowcaseVndbReleases({ ...request, vocabulary: request.vocabulary ?? vocabulary }),
    seed: (request) => seedShowcaseVndbReleases({ ...request, vocabulary: request.vocabulary ?? vocabulary }),
  };
}

export function bindReviewedCatalogueTransport(
  input: Parameters<typeof createImportTransport>[0],
): ReviewedCataloguePort {
  return createImportTransport(input);
}

export function bindReviewedCatalogueLedger(path: string | Database): ReviewedCatalogueLedger {
  return openReviewedCatalogueLedger(path);
}

/** Ordinary CLI and seed host: released vocabulary, live transport, and the run ledger path. */
export function installReviewedCatalogueComposition(input: {
  path: string | Database;
  transport: ReviewedCataloguePort;
  vocabulary?: ReviewedVocabularyPort;
}): ReviewedCatalogueHost {
  return composeReviewedCatalogueHost({
    path: input.path,
    transport: input.transport,
    vocabulary: input.vocabulary ?? releasedReviewedVocabulary(),
  });
}
