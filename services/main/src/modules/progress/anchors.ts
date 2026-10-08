import type { PoolClient } from 'pg';

export interface AnchorOrder { revision: string; key: string; eligible?: boolean }
export interface MemberAnchor { structure: string; order: AnchorOrder | null }
export interface AnchorBasis { revision: string; parent: string; parentRevision: string }

/** The heads and enclosing Structure a member Structure's anchors derive from.
 * No enclosing Structure is the empty parent, which is a prepared answer too. */
export function anchorBasis(revision: string, anchors: readonly MemberAnchor[]): AnchorBasis {
  return { revision, parent: anchors[0]?.structure ?? '', parentRevision: anchors[0]?.order?.revision ?? '' };
}

/** Index one occurrence on each enclosing Structure, or withdraw it there when
 * it is no longer complete or has no place in that order. Shared by the
 * reader's write and the background preparation of earlier completions. */
export async function applyAnchors(client: PoolClient, principal: { issuer: string; subject: string },
  source: string, occurrence: string, selectionKey: string, completed: boolean, anchors: readonly MemberAnchor[]) {
  for (const [at, anchor] of anchors.entries()) {
    if (anchor.structure === source) continue;
    const identity = [principal.issuer, principal.subject, anchor.structure, occurrence, selectionKey];
    if (!anchor.order || !completed) {
      await client.query(`UPDATE structure.progress SET completed = false, resume_eligible = false,
        order_revision = NULL, order_key = NULL, version = version + 1, updated_at = clock_timestamp()
        WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3
          AND occurrence = $4 AND selection_key = $5 AND (completed OR order_key IS NOT NULL)`, identity);
      continue;
    }
    // A scope this anchor opens has nothing else to prepare. Its own enclosing
    // Structure is the next anchor.
    const next = anchorBasis(anchor.order.revision, anchors.slice(at + 1));
    await client.query(`INSERT INTO structure.progress_scope
      (principal_issuer, principal_subject, structure, order_revision, ready, version,
        anchor_revision, anchor_parent, anchor_parent_revision)
      SELECT $1,$2,$3,$4,fresh,1,CASE WHEN fresh THEN $5::text END,CASE WHEN fresh THEN $6::text END,CASE WHEN fresh THEN $7::text END
      FROM (SELECT NOT EXISTS (SELECT 1 FROM structure.progress
        WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3
          AND completed AND resume_eligible IS DISTINCT FROM false LIMIT 1) AS fresh) AS state
      ON CONFLICT DO NOTHING`, [principal.issuer, principal.subject, anchor.structure,
      anchor.order.revision, next.revision, next.parent, next.parentRevision]);
    await client.query(`INSERT INTO structure.progress
      (principal_issuer, principal_subject, structure, occurrence, selection_key,
        completed, position, version, order_revision, order_key, resume_eligible)
      VALUES ($1,$2,$3,$4,$5,true,NULL,1,$6,$7,$8)
      ON CONFLICT (principal_issuer, principal_subject, structure, occurrence, selection_key)
      DO UPDATE SET completed = true, position = NULL, order_revision = EXCLUDED.order_revision,
        order_key = EXCLUDED.order_key, resume_eligible = EXCLUDED.resume_eligible,
        version = structure.progress.version + 1, updated_at = clock_timestamp()`,
    [...identity, anchor.order.revision, anchor.order.key, anchor.order.eligible ?? true]);
  }
}
