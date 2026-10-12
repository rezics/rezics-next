import type { PoolClient } from 'pg';
import { GLOBAL_CONTEXT } from '../governance/schema.ts';
import { chunkDisclosureSubmission } from './contract-batching.ts';
import { DISCLOSURE_CHANNELS, DisclosureUnavailable,
  type DisclosureChannel, type DisclosureSelection } from './read.ts';

/** Correlated to `wanted` from the policy reader's requested relation; $2 is the
 * channel's effects and $3 the global context. Embed in that owner statement so
 * policy and its token share a snapshot. Only indexed owner/resource probes
 * reach enforcement; there is no global change-log or descendant traversal.
 * Released rows remain in the basis to detect restrict/restore between reads.
 * One token per selection also permits a fence to regroup captured chunks. */
export const SCOPED_ENFORCEMENT_BASIS_SQL = `(
  WITH parent_refs AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(wanted.parents) AS parent(
      kind text, resource text, head text, "protectedRevision" text)
  ), refs AS (
    SELECT DISTINCT resource, owner FROM unnest(ARRAY[wanted.resource, right(wanted.resource, 36)]) resource
      CROSS JOIN unnest(ARRAY[wanted.owner, CASE
        WHEN wanted.component = 'body' AND wanted.owner = 'graph' THEN 'content'
        WHEN wanted.component = 'body' AND wanted.owner = 'content' THEN 'graph'
        ELSE wanted.owner END]) owner
    UNION SELECT resource, 'graph' FROM parent_refs
  ), matched AS (
    SELECT DISTINCT e.id, e.fence_epoch, e.decision_id, e.decision_ordinal, e.state
    FROM refs CROSS JOIN LATERAL (
      SELECT e.* FROM access.governance_enforcement e
      WHERE e.owner = refs.owner AND e.resource = refs.resource
      OFFSET 0
    ) e
    WHERE (
      e.effect = ANY($2::text[]) AND e.context = ANY(ARRAY[$3::text, wanted.context]) AND (
        (e.resource = wanted.resource OR e.owner IN ('media', 'review')
          AND e.resource = right(wanted.resource, 36)) AND (
          e.owner = wanted.owner OR wanted.component = 'body' AND wanted.owner IN ('graph', 'content')
            AND e.owner IN ('graph', 'content') AND e.component IN ('body', 'record', 'publication')
        ) AND (
          e.component = wanted.component OR e.component IN ('record', 'publication')
          OR wanted.component IN ('title', 'name') AND e.component IN ('title', 'name')
          OR wanted.owner = 'media' AND e.component IN ('cover', 'media_use', 'body')
        ) AND (
          e.revision IS NULL OR wanted.revision IS NULL OR e.revision = wanted.revision
          OR wanted.component = 'body' AND e.owner IN ('graph', 'content')
            AND replace(e.revision, 'urn:rezics:content:revision:', '')
              = replace(wanted.revision, 'urn:rezics:content:revision:', '')
        )
        OR e.owner = 'graph' AND e.component IN ('title', 'name', 'record', 'publication')
          AND EXISTS (SELECT 1 FROM parent_refs parent WHERE parent.resource = e.resource
            AND (e.revision IS NULL OR e.revision = parent.head OR e.revision = parent."protectedRevision"
              OR parent."protectedRevision" IS NULL AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(wanted.parents) p
                WHERE p->>'resource' = parent.resource AND p ? 'protectedRevision')))
      )
    ) OR (
      e.owner = 'graph' AND e.component = 'record' AND e.revision IS NULL
      AND e.effect = 'disclosure' AND e.context = $3::text
      AND e.authority_scope_id = 'governance:platform'
      AND (wanted."resourceKind" = 'realm' AND e.resource = wanted.resource
        OR EXISTS (SELECT 1 FROM parent_refs parent WHERE parent.kind = 'realm' AND parent.resource = e.resource))
      AND EXISTS (SELECT 1 FROM access.moderation_decision d
        JOIN access.moderation_decision_target t ON t.decision_id = d.id AND t.ordinal = e.decision_ordinal
        WHERE d.id = e.decision_id AND d.authority_kind = 'platform'
          AND d.authority_scope_id = 'governance:platform' AND d.context = $3::text
          AND t.owner = 'graph' AND t.resource = e.resource AND t.component = 'record'
          AND t.locator IS NULL AND t.scope_kind = 'component' AND t.revision IS NULL AND t.effect = 'disclosure')
    )
  )
  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(
    id, fence_epoch::text, decision_id, decision_ordinal, state) ORDER BY id)::text, '[]'), 'UTF8')), 'hex')
  FROM matched
)`;

/** Internal owner-established selections only. Capture records results[index]
 * alongside the global recovery generation; fence recomputes the same token on
 * its fresh snapshot. The SQL expression above allows both to stay in the policy
 * statement; this direct entry exposes the same computation and measured cost. */
export async function scopedEnforcementBasis(client: Pick<PoolClient, 'query'>,
  selections: readonly DisclosureSelection[], channel: DisclosureChannel = 'read') {
  if (!DISCLOSURE_CHANNELS.includes(channel)) {
    throw new DisclosureUnavailable('Disclosure channel is invalid');
  }
  const effects = ['disclosure',
    ...(['search', 'typeahead', 'count', 'sitemap', 'seo'].includes(channel) ? ['search'] : []),
    ...(['email', 'push', 'digest'].includes(channel) ? ['raw_delivery'] : []),
    ...(channel === 'media' ? ['media_delivery', 'raw_delivery'] : []),
    ...(channel === 'export' ? ['export'] : [])];
  return chunkDisclosureSubmission(selections, async chunk => {
    if (chunk.some(selection => selection.ancestry.parents.length > 2)) {
      throw new DisclosureUnavailable('Disclosure parent bound is invalid');
    }
    const rows = (await client.query<{ ordinal: number; basis: string }>(`
      WITH requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS wanted(
        ordinal int, owner text, resource text, component text, revision text, context text,
        "resourceKind" text, parents jsonb))
      SELECT wanted.ordinal, ${SCOPED_ENFORCEMENT_BASIS_SQL} AS basis
      FROM requested wanted ORDER BY wanted.ordinal`, [JSON.stringify(chunk.map((selection, ordinal) => {
      const { target, ancestry } = selection;
      const identity = target.owner === 'graph' && ancestry.relationshipBasis.owner === 'graph'
        && ancestry.relationshipBasis.kind === 'identity' && ancestry.relationshipBasis.resource === target.resource;
      const nameHead = identity ? ancestry.relationshipBasis.revision
        : ancestry.parents.find(parent => parent.kind === 'work' && parent.resource === target.resource)?.head;
      return { ...target, ordinal, context: target.context ?? GLOBAL_CONTEXT,
        revision: target.revision ?? (target.owner === 'graph' && ['name', 'title'].includes(target.component)
          ? nameHead ?? null : null), resourceKind: ancestry.resourceKind, parents: ancestry.parents };
    })), effects, GLOBAL_CONTEXT])).rows;
    if (rows.length !== chunk.length || rows.some((row, index) => row.ordinal !== index
      || !/^[0-9a-f]{64}$/.test(row.basis))) {
      throw new DisclosureUnavailable('Disclosure scoped enforcement basis is incomplete');
    }
    return { results: rows.map(row => row.basis), cost: { enforcementBasisStatements: 1 } };
  });
}
