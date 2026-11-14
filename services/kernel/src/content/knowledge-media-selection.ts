import type { AccessClient } from '../request/access.ts';
import type { QueryResultRow } from 'pg';
import { knowledgePublicSelection } from './knowledge-store.ts';
import authoring from './knowledge-media-authoring-selection.sql';
import published from './knowledge-media-public-selection.sql';
import reservationLock from './knowledge-media-reservation-lock.sql';
import reservationAnchor from './knowledge-media-reservation-anchor.sql';
import reservation from './knowledge-media-reservation-selection.sql';
import retention from './knowledge-media-retention-selection.sql';

export type KnowledgeMediaSelection = Readonly<{
  owner_account_id: string | null;
  subject_id: string | null;
  subject_ids: string[];
  media_ids: string[];
  body_sha256: Buffer;
  publication_id: string | null;
  lifecycle_generation: string;
}>;
export type KnowledgeMediaReservationSelection = Readonly<{
  owner_account_id: string;
  notebook_id: string;
  lifecycle_generation: string;
}>;
export type KnowledgeMediaRetentionSelection = Readonly<{
  disposition: 'retained' | 'pending' | 'erased';
  lifecycle_generation: string;
}>;

async function first<Row extends QueryResultRow>(
  client: AccessClient,
  query: Readonly<{ sql: string; params: readonly string[] }>,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Row | null> {
  const result = await client.query<Row>(
    query.sql,
    query.params.map((name) => parameters[name]),
  );
  return result.rows[0] ?? null;
}

/** Exact metadata only. Actor/account and current Subject authority stay with the Media adapter. */
export async function knowledgeMediaSelection(
  client: AccessClient,
  route: number,
  documentId: string,
  revisionId: string,
  representation: 'authoring' | 'public',
  publicationId?: string,
): Promise<KnowledgeMediaSelection | null> {
  let row: KnowledgeMediaSelection | null;
  if (representation === 'authoring') {
    row = await first(client, authoring, { route, document_id: documentId, revision_id: revisionId });
  } else {
    const selected = await knowledgePublicSelection(
      client as Parameters<typeof knowledgePublicSelection>[0],
      route,
      documentId,
      revisionId,
    );
    if (!selected || (publicationId !== undefined && selected.publication_id !== publicationId)) return null;
    row = await first(client, published, {
      route,
      document_id: documentId,
      revision_id: revisionId,
      publication_id: selected.publication_id,
      generation: selected.lifecycle_generation,
    });
  }
  return row === null ? null : { ...row, body_sha256: Buffer.from(row.body_sha256) };
}

/** Write admission takes the existing Notebook fence; metadata-only reads never acquire a row lock. */
export async function knowledgeMediaReservationSelection(
  client: AccessClient,
  route: number,
  documentId: string,
  forUpdate = false,
): Promise<KnowledgeMediaReservationSelection | null> {
  const locked = await first<{ notebook_id: string }>(client, forUpdate ? reservationLock : reservationAnchor, {
    route,
    document_id: documentId,
  });
  if (!locked) return null;
  return first(client, reservation, { route, document_id: documentId, notebook_id: locked.notebook_id });
}

/** Hidden ancestry is not terminal disposition: reversible trash and holds remain pending. */
export function knowledgeMediaRetentionSelection(
  client: AccessClient,
  route: number,
  documentId: string,
): Promise<KnowledgeMediaRetentionSelection | null> {
  return first(client, retention, { route, document_id: documentId });
}
