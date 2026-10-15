import type { PoolClient } from 'pg';

export interface AnchorOrder { revision: string; key: string; eligible?: boolean }
/** The occurrence on one enclosing composition. `through` is the Structure whose
 * Work that composition holds: the member's own Structure, or an enclosing one
 * when the composition holds a series that holds the member. */
export interface MemberAnchor { structure: string; through: string; order: AnchorOrder | null }
/** What a write knows about its member's anchoring: the anchors it applies, and
 * whether the member is enclosed by more compositions than it keeps anchors
 * for. `unknown` is a failed derivation: the write stands and nothing is vouched. */
export type MemberAnchoring = { unknown: true } | { unknown?: false; anchors: MemberAnchor[]; overflow: boolean };

/** Vouch that a member Structure's anchors on one composition derive from
 * exactly these heads. */
export async function prepareAnchorScope(client: PoolClient, agent: string, member: string, parent: string,
  revision: string, parentRevision: string) {
  await client.query(`INSERT INTO structure.progress_anchor_scope
    (agent, structure, parent, revision, parent_revision, cursor)
    VALUES ($1,$2,$3,$4,$5,NULL)
    ON CONFLICT (agent, structure, parent)
    DO UPDATE SET revision = EXCLUDED.revision, parent_revision = EXCLUDED.parent_revision, cursor = NULL`,
  [agent, member, parent, revision, parentRevision]);
}

/** Index one occurrence on each enclosing Structure, or withdraw it there when
 * it is no longer complete or has no place in that order. Shared by the
 * reader's write and the background preparation of earlier completions. */
export async function applyAnchors(client: PoolClient, agent: string,
  source: string, occurrence: string, selectionKey: string, completed: boolean, anchors: readonly MemberAnchor[],
  only?: string) {
  for (const anchor of anchors) {
    if (anchor.structure === source || only !== undefined && anchor.structure !== only) continue;
    const identity = [agent, anchor.structure, occurrence, selectionKey];
    if (!anchor.order || !completed) {
      await client.query(`UPDATE structure.progress SET completed = false, resume_eligible = false,
        order_revision = NULL, order_key = NULL, version = version + 1, updated_at = clock_timestamp()
        WHERE agent = $1 AND structure = $2
          AND occurrence = $3 AND selection_key = $4 AND (completed OR order_key IS NOT NULL)`, identity);
      continue;
    }
    // A scope this anchor opens has nothing else to prepare. The compositions
    // that hold its Work are its own anchors, prepared for these heads.
    const opened = await client.query<{ ready: boolean }>(`INSERT INTO structure.progress_scope
      (agent, structure, order_revision, ready, version)
      SELECT $1,$2,$3,fresh,1
      FROM (SELECT NOT EXISTS (SELECT 1 FROM structure.progress
        WHERE agent = $1 AND structure = $2
          AND completed AND resume_eligible IS DISTINCT FROM false LIMIT 1) AS fresh) AS state
      ON CONFLICT DO NOTHING RETURNING ready`, [agent, anchor.structure, anchor.order.revision]);
    if (opened.rows[0]?.ready) {
      for (const outer of anchors) {
        if (outer.through === anchor.structure && outer.order) {
          await prepareAnchorScope(client, agent, anchor.structure, outer.structure, anchor.order.revision, outer.order.revision);
        }
      }
    }
    await client.query(`INSERT INTO structure.progress
      (agent, structure, occurrence, selection_key,
        completed, position, version, order_revision, order_key, resume_eligible)
      VALUES ($1,$2,$3,$4,true,NULL,1,$5,$6,$7)
      ON CONFLICT (agent, structure, occurrence, selection_key)
      DO UPDATE SET completed = true, position = NULL, order_revision = EXCLUDED.order_revision,
        order_key = EXCLUDED.order_key, resume_eligible = EXCLUDED.resume_eligible,
        version = structure.progress.version + 1, updated_at = clock_timestamp()`,
    [...identity, anchor.order.revision, anchor.order.key, anchor.order.eligible ?? true]);
  }
}
