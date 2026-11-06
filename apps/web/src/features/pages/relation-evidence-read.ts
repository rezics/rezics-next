import type { KernelClient } from '@rezics/client';
import type { Stmt } from './shared';

/** Candidates per native window. A continuation reads the next window with its own cursor. */
export const RELATION_EVIDENCE_PAGE_LIMIT = 20;

export type RelationEvidenceRequest = {
  subject: string;
  locale: string;
  reader?: string | null | undefined;
  property: string;
  target: string;
  key?: string | undefined;
  cursor?: string | undefined;
};

/** One competing candidate of an exact slot. Release and source identifiers never leave the native reader. */
export type RelationEvidenceCandidate = {
  id: string;
  revision: number;
  decision: 'accepted' | 'rejected' | 'abstained' | null;
  rank: 'normal' | 'preferred' | 'deprecated' | null;
  retracted: boolean;
  statement: Stmt;
};

/** `next: null` ends the slot's candidates. A failure keeps what was shown and is never an end. */
export type RelationEvidenceRead =
  | { kind: 'ready'; candidates: RelationEvidenceCandidate[]; next: string | null }
  | { kind: 'failure'; status: number | undefined };

/** One native candidate window for an exact slot in the Global Context. */
export async function readRelationEvidence(
  client: KernelClient,
  input: RelationEvidenceRequest,
  authorization?: string | undefined,
  signal?: AbortSignal,
): Promise<RelationEvidenceRead> {
  try {
    const response = await client.subjects({ id: input.subject }).candidates.get({
      query: {
        property: input.property,
        target: input.target,
        ...(input.key ? { key: input.key } : {}),
        limit: RELATION_EVIDENCE_PAGE_LIMIT,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      headers: authorization ? { authorization } : {},
      fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
    });
    if (response.status !== 200 || !response.data) return { kind: 'failure', status: response.status };
    return {
      kind: 'ready',
      candidates: response.data.candidates.flatMap((row) =>
        'deleted' in row
          ? []
          : [
              {
                id: row.id,
                revision: row.revision,
                decision: row.decision,
                rank: row.rank,
                retracted: row.retracted !== null,
                // The native statement uses the same closed shape as every relation statement on the page.
                statement: row.statement as unknown as Stmt,
              },
            ],
      ),
      next: response.data.next,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: 'failure', status: undefined };
  }
}
