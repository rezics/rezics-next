import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  reviewedVocabularyInventory,
  reviewedVocabularyRevision,
  reviewedVocabularyScheme,
} from '@rezics/definitions/reviewed-vocabulary';
import { preflightReviewedCatalogue, reviewedCatalogueRevision } from '../src/reviewed-catalogue.ts';
import { releasedReviewedVocabulary, reviewedSchemeIndex } from '../src/reviewed-vocabulary-port.ts';
import { composeReviewedCatalogueHost, composeShowcaseVndbReleaseHost } from '../src/showcase-cross-media.ts';
import { catalogueVndbReleaseGroups } from '../src/showcase-vndb-releases.ts';
import { developmentStatusSchemeUri, developmentStatusTaxonomy } from '../src/vndb-release-fidelity.ts';
import type { ReviewedCataloguePort } from '../src/reviewed-catalogue.ts';

test('released vocabulary is the complete inventory the catalogue preflight admits', () => {
  const vocabulary = releasedReviewedVocabulary();
  expect(vocabulary.revision).toBe(reviewedVocabularyRevision);
  expect(reviewedCatalogueRevision).toBe(reviewedVocabularyRevision);
  expect(preflightReviewedCatalogue(vocabulary, reviewedVocabularyInventory).map((row) => row.key)).toEqual(
    reviewedVocabularyInventory.map((row) => row.key),
  );
});

test('VNDB release groups bind development-status codes from the public inventory', () => {
  const vocabulary = releasedReviewedVocabulary();
  const scheme = reviewedVocabularyScheme(developmentStatusSchemeUri);
  const status = reviewedSchemeIndex(vocabulary.inventory, developmentStatusSchemeUri);
  expect(scheme?.key).toBe('vndb-development-status-scheme');
  expect([...status.literalMembers].sort()).toEqual(['0', '1', '2']);
  const schemeId = randomUUID();
  const conceptId = randomUUID();
  expect(
    catalogueVndbReleaseGroups(
      { [scheme!.key]: schemeId, 'vndb-development-status-1': conceptId },
      [{ taxonomy: developmentStatusTaxonomy, uri: developmentStatusSchemeUri, codes: ['1'] }],
      vocabulary,
    ),
  ).toEqual([
    {
      taxonomy: developmentStatusTaxonomy,
      uri: developmentStatusSchemeUri,
      schemeId,
      concepts: [{ code: '1', id: conceptId }],
    },
  ]);
});

test('CLI and seed composition install the released vocabulary without opening a ledger', () => {
  const vocabulary = releasedReviewedVocabulary();
  const port = {} as ReviewedCataloguePort;
  const catalogue = composeReviewedCatalogueHost({ transport: port, vocabulary });
  const releases = composeShowcaseVndbReleaseHost({ vocabulary });
  expect(catalogue.vocabulary.revision).toBe(reviewedVocabularyRevision);
  expect(catalogue.vocabulary.inventory).toBe(reviewedVocabularyInventory);
  expect(releases.vocabulary).toBe(vocabulary);
  expect(catalogue.ledger).toBeUndefined();
});
