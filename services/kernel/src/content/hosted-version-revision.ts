import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

export type HostedVersionGenerationKind = 'draft' | 'candidate';

/** Structural subset of the temporal store's immutable snapshot returned by its writer. */
export type HostedVersionRevisionSnapshot<Kind extends HostedVersionGenerationKind = HostedVersionGenerationKind> =
  Readonly<{
    route: number;
    catalogueId: string;
    generationId: string;
    generationKind: Kind;
    sequence: bigint;
  }>;

export type HostedVersionRevisionResolution =
  | Readonly<{
      kind: 'ordered';
      revisionId: string;
      revisionKind: 'structure' | 'publication';
      sourceRevisionId: string | null;
      snapshot: HostedVersionRevisionSnapshot;
    }>
  | Readonly<{
      kind: 'compatibility';
      revisionId: string;
      revisionKind: 'structure' | 'publication';
      sourceRevisionId: string | null;
    }>
  | Readonly<{ kind: 'missing' }>;

type RevisionBase = Readonly<{
  revisionId: string;
  snapshot: HostedVersionRevisionSnapshot;
  recordedTransactionId: string;
  recordedAt: string;
}>;

export type HostedVersionRevisionWrite =
  | (RevisionBase &
      Readonly<{
        revisionKind: 'structure';
        snapshot: HostedVersionRevisionSnapshot<'draft'>;
        expectedDraftRevisionId: string;
      }>)
  | (RevisionBase &
      Readonly<{
        revisionKind: 'publication';
        snapshot: HostedVersionRevisionSnapshot<'candidate'>;
        expectedDraftRevisionId: string;
        expectedPublicationId: string | null;
      }>);

export class HostedVersionRevisionPointerChangedError extends Error {
  constructor() {
    super('Hosted Book draft or publication pointer changed before revision binding');
    this.name = 'HostedVersionRevisionPointerChangedError';
  }
}

type RevisionRow = Readonly<{
  revision_id: string;
  revision_kind: 'structure' | 'publication';
  source_revision_id: string | null;
  descriptor_revision_id: string | null;
  generation_id: string;
  generation_kind: HostedVersionGenerationKind;
  sequence: string;
}>;

/** Resolves only this route, catalogue and immutable Book revision. */
export async function resolveHostedVersionRevision(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
): Promise<HostedVersionRevisionResolution> {
  const route = routeOf(catalogueId);
  if (route === null || routeOf(revisionId) !== route) return { kind: 'missing' };

  const row = (
    await client.query<RevisionRow>(
      `SELECT r.revision_id,r.kind AS revision_kind,r.source_revision_id,
        d.revision_id AS descriptor_revision_id,d.generation_id,d.generation_kind,d.sequence::text AS sequence
       FROM content.hosted_structure_revision r
       LEFT JOIN content.hosted_version_revision d
         ON d.route=r.route AND d.catalogue_id=r.catalogue_id AND d.revision_id=r.revision_id
       WHERE r.route=$1 AND r.catalogue_id=$2 AND r.revision_id=$3`,
      [route, catalogueId, revisionId],
    )
  ).rows[0];

  if (!row) return { kind: 'missing' };
  if (row.descriptor_revision_id === null)
    return {
      kind: 'compatibility',
      revisionId: row.revision_id,
      revisionKind: row.revision_kind,
      sourceRevisionId: row.source_revision_id,
    };

  return {
    kind: 'ordered',
    revisionId: row.revision_id,
    revisionKind: row.revision_kind,
    sourceRevisionId: row.source_revision_id,
    snapshot: {
      route,
      catalogueId,
      generationId: row.generation_id,
      generationKind: row.generation_kind,
      sequence: BigInt(row.sequence),
    },
  };
}

/**
 * Writes the immutable revision and generation descriptor, then advances the caller-selected pointer by CAS.
 * The caller supplies its existing owner transaction and keeps authorization, receipts, events and finalization.
 */
export async function commitHostedVersionRevision(
  client: AccessClient,
  write: HostedVersionRevisionWrite,
): Promise<void> {
  const { snapshot } = write;
  const isPublication = write.revisionKind === 'publication';
  const revisionKind = write.revisionKind;
  const sourceRevisionId = isPublication ? write.expectedDraftRevisionId : null;

  await client.query(
    `INSERT INTO content.hosted_structure_revision
       (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      snapshot.route,
      snapshot.catalogueId,
      write.revisionId,
      revisionKind,
      sourceRevisionId,
      write.recordedTransactionId,
      write.recordedAt,
    ],
  );
  await client.query(
    `INSERT INTO content.hosted_version_revision
       (route,catalogue_id,revision_id,revision_kind,generation_id,generation_kind,sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      snapshot.route,
      snapshot.catalogueId,
      write.revisionId,
      revisionKind,
      snapshot.generationId,
      snapshot.generationKind,
      snapshot.sequence.toString(),
    ],
  );

  const advanced = isPublication
    ? await client.query(
        `UPDATE content.hosted_catalogue SET publication_id=$4
         WHERE route=$1 AND catalogue_id=$2 AND head_revision_id=$3
           AND publication_id IS NOT DISTINCT FROM $5::uuid
         RETURNING catalogue_id`,
        [
          snapshot.route,
          snapshot.catalogueId,
          write.expectedDraftRevisionId,
          write.revisionId,
          write.expectedPublicationId,
        ],
      )
    : await client.query(
        `UPDATE content.hosted_catalogue SET head_revision_id=$4
         WHERE route=$1 AND catalogue_id=$2 AND head_revision_id=$3
         RETURNING catalogue_id`,
        [snapshot.route, snapshot.catalogueId, write.expectedDraftRevisionId, write.revisionId],
      );

  if (advanced.rows.length === 0) throw new HostedVersionRevisionPointerChangedError();
}
