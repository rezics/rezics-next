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
import {
  readCanonicalIndexStatements,
  readCanonicalStatementCount,
  readCanonicalStatementPresenceSql,
  type CanonicalStatementInput,
} from '../semantic/identity-search-index-statements.ts';
import { withReadTransaction } from '../semantic/read.ts';
import readSubjects from '../semantic/search-source-subjects.sql';
import { readSearchCanonicalGeneration } from '../semantic/search-source.ts';
import type { CreditSearchProjection } from './credit-search.ts';
import { documentActions, type IndexAction, type SubjectDocument } from './document.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { subjectPartition, type IndexedSubject } from './source.ts';

type ListingCount = { subjectId: string; publicCollectionCount: number };

async function collectionCount(tx: CommandTransaction, partition: number, id: string) {
  const [listing] = (await nativeSourceQuery(tx, readListingCounts, {
    partition_no: partition,
    subject_ids: [id],
  })) as ListingCount[];
  return listing?.publicCollectionCount ?? 0;
}

async function currentSubject(tx: CommandTransaction, partition: number, id: string) {
  const [header] = (await nativeSourceQuery(tx, readSubjects, {
    partition_no: partition,
    routes: [routeOf(id)!],
    subject_ids: [id],
  })) as WorkHeader[];
  return header?.visibility === 'visible' &&
    !header.redirect &&
    header.currentRelease &&
    header.current_revision &&
    header.selection_ready
    ? header
    : null;
}

export async function verifyCanonicalIdentityDocumentAtDispatch(
  tx: CommandTransaction,
  document: SubjectDocument,
  configuration: SearchReceivingConfiguration,
  statementInput: CanonicalStatementInput | undefined,
) {
  const { id, partition } = document;
  if (!statementInput && (await tx.query(readCanonicalStatementPresenceSql, [routeOf(id), id])).rowCount) return false;
  const rating = await readNativeSearchPublicRating(tx, partition, id);
  const count = await collectionCount(tx, partition, id);
  const runtime = await activeRelease(tx, 'native');
  if (!runtime) return false;
  if (statementInput) {
    const header = await currentSubject(tx, partition, id);
    if (!header || header.currentRelease !== statementInput.release || header.type !== document.type) return false;
    const release =
      runtime.digest === statementInput.release ? runtime.release : await readRelease(tx, statementInput.release);
    if (!release) return false;
    const current = await readCanonicalIndexStatements(
      tx,
      configuration.pool,
      header,
      configuration.routeKey,
      statementInput.keys,
      release,
      runtime,
    );
    if (current?.proof.digest !== statementInput.digest) return false;
  }
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
  statementInput?: CanonicalStatementInput;
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
      const selectedExists = (await tx.query(readCanonicalStatementPresenceSql, [route, subject])).rowCount;
      const statementKeys = selectedExists ? await readCanonicalStatementCount(tx, subject) : 0;
      if (statementKeys === null) return null;

      const header = await currentSubject(tx, partition, subject);
      if (!header?.currentRelease) return null;
      const runtime = await activeRelease(tx, 'native');
      if (!runtime) return null;
      const release =
        runtime.digest === header.currentRelease ? runtime.release : await readRelease(tx, header.currentRelease);
      if (!release) return null;
      const selected = statementKeys
        ? await readCanonicalIndexStatements(tx, pool, header, configuration.routeKey, statementKeys, release, runtime)
        : null;
      if (statementKeys && !selected) return null;
      const publicRating = await readNativeSearchPublicRating(tx, partition, subject);
      const count = await collectionCount(tx, partition, subject);
      const creditProperties = creditSearchProperties(release, header.type);
      if (selected && creditProperties.some((property) => selected.properties.has(property))) return null;
      const credit: CreditSearchProjection = creditProperties.length
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
        statements: selected?.statements ?? [],
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
      return { epoch: home.epoch, position, runtime, actions, statementInput: selected?.proof };
    },
    deadline,
  );
  if (!input) return null;
  const [action] = await normalize(input.actions);
  if (action?.op !== 'index' || action.id !== subject)
    throw new TypeError('Canonical Search projection lost its original');
  return {
    document: action.document,
    ...(input.statementInput && { statementInput: input.statementInput }),
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
