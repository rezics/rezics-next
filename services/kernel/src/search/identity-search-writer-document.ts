import { facetProperties, relationFacetProperty } from '@rezics/filter';
import type { CommandTransaction } from '../command/command.ts';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import readListingCounts from '../library/listing-counts.sql';
import { readPartition } from '../partition/partition.ts';
import { readNativeSearchPublicRating } from '../rating/public-rating-source.ts';
import { routeOf } from '../route/route.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { observationOf, type WorkHeader } from '../semantic/credit-search-cut.ts';
import { creditSearchProperties } from '../semantic/credit-search-selection.ts';
import { activeRelease, readRelease } from '../semantic/definition-release-read.ts';
import { withReadTransaction } from '../semantic/read.ts';
import readSubjects from '../semantic/search-source-subjects.sql';
import { readSearchCanonicalGeneration } from '../semantic/search-source.ts';
import type { CreditSearchProjection } from './credit-search.ts';
import { documentActions, type IndexAction, type SubjectDocument } from './document.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { subjectPartition, type IndexedSubject } from './source.ts';

// One seek over the active selection index proves whether statement assembly is required.
export const readCanonicalStatementPresenceSql = `SELECT 1 FROM semantic.search_selected
 WHERE (route,subject_id)=($1,$2) AND active LIMIT 1`;

type ListingCount = { subjectId: string; publicCollectionCount: number };

async function collectionCount(tx: CommandTransaction, partition: number, id: string) {
  const [listing] = (await nativeSourceQuery(tx, readListingCounts, {
    partition_no: partition,
    subject_ids: [id],
  })) as ListingCount[];
  return listing?.publicCollectionCount ?? 0;
}

export async function verifyCanonicalIdentityDocumentAtDispatch(tx: CommandTransaction, document: SubjectDocument) {
  const { id, partition } = document;
  if ((await tx.query(readCanonicalStatementPresenceSql, [routeOf(id), id])).rowCount) return false;
  const rating = await readNativeSearchPublicRating(tx, partition, id);
  const count = await collectionCount(tx, partition, id);
  const runtime = await activeRelease(tx, 'native');
  if (!runtime) return false;
  const relations = facetProperties(runtime.release, [document.type]).filter((property) =>
    relationFacetProperty(runtime.release, property),
  );
  return (
    document.rating_score === rating?.score &&
    document.rating_prior_epoch === rating?.priorEpoch &&
    document.public_collection_count === count &&
    JSON.stringify(document.relation_facet_overflow ?? []) === JSON.stringify(relations)
  );
}

type Terms = Pick<IndexedSubject, 'labels' | 'aliases' | 'descriptions'>;
export type PreparedIdentityIndexDocument = Readonly<{
  document: SubjectDocument;
  compare(tx: CommandTransaction): Promise<void>;
}>;

export async function prepareCanonicalIdentityDocument(
  configuration: SearchReceivingConfiguration,
  subject: string,
  loadTerms: (tx: CommandTransaction) => Promise<Terms | null>,
  deadline: number,
  normalize: (actions: readonly IndexAction[]) => Promise<IndexAction[]>,
): Promise<PreparedIdentityIndexDocument | null> {
  const { pool } = configuration;
  const partition = subjectPartition(subject);
  const route = routeOf(subject)!;
  const input = await withReadTransaction(
    pool,
    async (tx) => {
      const home = await readPartition(tx, partition);
      if (!home || home.writeState !== 'active') return null;
      const terms = await loadTerms(tx);
      if (!terms) return null;
      if ((await tx.query(readCanonicalStatementPresenceSql, [route, subject])).rowCount) return null;

      const [header] = (await nativeSourceQuery(tx, readSubjects, {
        partition_no: partition,
        routes: [route],
        subject_ids: [subject],
      })) as WorkHeader[];
      if (
        !header ||
        header.visibility !== 'visible' ||
        header.redirect ||
        !header.currentRelease ||
        !header.current_revision
      )
        return null;
      const runtime = await activeRelease(tx, 'native');
      if (!runtime) return null;
      const release =
        runtime.digest === header.currentRelease ? runtime.release : await readRelease(tx, header.currentRelease);
      if (!release) return null;
      const publicRating = await readNativeSearchPublicRating(tx, partition, subject);
      const count = await collectionCount(tx, partition, subject);
      const credit: CreditSearchProjection = creditSearchProperties(release, header.type).length
        ? {
            state: 'complete',
            workId: subject,
            names: [],
            observation: observationOf({
              work: header,
              ready: true,
              generation: await readSearchCanonicalGeneration(tx),
            }),
          }
        : { state: 'unsupported' };
      const indexed: IndexedSubject = {
        id: subject,
        type: header.type,
        visibility: 'visible',
        redirect: null,
        securityRevision: Number(header.securityRevision),
        ...terms,
        statements: [],
        relationFacetOverflow: facetProperties(runtime.release, [header.type]).filter((property) =>
          relationFacetProperty(runtime.release, property),
        ),
        ...(publicRating && { publicRating }),
      };
      const position = home.position;
      const actions = documentActions(
        { partition, position, subjects: [indexed], creditSearch: new Map([[subject, credit]]) },
        [subject],
        new Map([[subject, count]]),
      );
      return { epoch: home.epoch, position, runtime, actions };
    },
    deadline,
  );
  if (!input) return null;
  const [action] = await normalize(input.actions);
  if (action?.op !== 'index' || action.id !== subject)
    throw new TypeError('Canonical Search projection lost its original');
  return {
    document: action.document,
    async compare(tx) {
      const current = await readPartition(tx, partition);
      const release = await activeRelease(tx, 'native');
      if (
        current?.writeState !== 'active' ||
        current.epoch !== input.epoch ||
        current.position !== input.position ||
        release?.digest !== input.runtime.digest ||
        release.head !== input.runtime.head
      )
        throw new IdentityEpochStoreError(
          'identity_epoch_unavailable',
          'Canonical Search document changed before preparation',
        );
    },
  };
}
