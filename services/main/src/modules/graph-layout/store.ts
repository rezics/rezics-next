import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ContentConflict, type ContentCore, type ExactReadResult } from '../../../../content/src/core.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { GRAPH_LAYOUT_MODEL } from './schema.ts';

export class GraphLayoutDenied extends Error {}
export class GraphLayoutConflict extends Error {}
export class GraphLayoutStale extends Error {}
export class GraphLayoutMissing extends Error {}
export class GraphLayoutUnavailable extends Error {}

export const GRAPH_LAYOUT_SCOPE = 'graph-layout:write';
export const GRAPH_LAYOUT_ACTION = 'graph.layout.write';
const nativeIri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface GraphLayoutView { profile: string; anchor: string; context: string | null }
export interface GraphLayoutDocument {
  view: GraphLayoutView;
  nodes: { resource: string; x: number; y: number; group?: string; pinned: boolean }[];
  groups: { id: string; label: string; x: number; y: number; collapsed: boolean }[];
}
export interface GraphLayoutActor { principal: VerifiedPrincipal; actingSubject: string }
export interface GraphLayoutRevision {
  layout: string; owner: string; view: GraphLayoutView; revision: string; predecessor: string | null;
  byteDigest: string; body: GraphLayoutDocument; replayed?: boolean;
}

/** UUID-shaped identity derived from the caller's replay key, so a lost create response replays. */
function derivedId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Saved graph layouts: owner-private view state in Content, never graph relations.
 * Access authorizes the owner Agent; Content keeps revisions, receipts and outbox. */
export class GraphLayouts {
  constructor(private readonly access: Pool, private readonly contentPool: Pool,
    private readonly content: ContentCore) {}

  /** Active principal representing the owner Agent with a current layout grant. */
  private async authorize(actor: GraphLayoutActor): Promise<string> {
    if (!nativeIri.test(actor.actingSubject)) throw new GraphLayoutDenied('invalid acting subject');
    let rows: { id: string }[];
    try {
      const recovery = await this.access.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true');
      if (recovery.rows[0]?.open !== true) throw new GraphLayoutUnavailable('Access recovery is held');
      rows = (await this.access.query<{ id: string }>(`SELECT p.id FROM access.principal p
        JOIN access.representation r ON r.principal_id = p.id
        JOIN access.authority_subject s ON s.id = r.subject_id
        JOIN access.permission_grant g ON g.recipient_subject = s.id
        JOIN access.scope_gate gate ON gate.id = g.scope_id
        WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
          AND r.subject_id = $3 AND r.action = $4 AND r.active AND r.valid_until > clock_timestamp()
          AND s.active AND g.scope_id = $5 AND g.action = $4 AND g.active
          AND g.valid_until > clock_timestamp() AND gate.open
        LIMIT 1`, [actor.principal.issuer, actor.principal.subject, actor.actingSubject,
        GRAPH_LAYOUT_ACTION, GRAPH_LAYOUT_SCOPE])).rows;
    } catch (error) {
      if (error instanceof GraphLayoutUnavailable) throw error;
      throw new GraphLayoutUnavailable('Access owner is unavailable');
    }
    if (!rows[0]) throw new GraphLayoutDenied('graph layout authority is missing');
    return rows[0].id;
  }

  private async binding(layout: string): Promise<{ variant_id: string; owner_subject: string;
    view_profile: string; anchor: string; context: string | null; draft_head: string } | undefined> {
    try {
      return (await this.contentPool.query<{ variant_id: string; owner_subject: string; view_profile: string;
        anchor: string; context: string | null; draft_head: string }>(`SELECT g.variant_id, g.owner_subject,
          g.view_profile, g.anchor, g.context, v.draft_head::text
        FROM content.graph_layout g JOIN content.variant v ON v.id = g.variant_id WHERE g.id = $1`,
      [layout])).rows[0];
    } catch { throw new GraphLayoutUnavailable('Content owner is unavailable'); }
  }

  /** Create (layout null) or revise one layout under its exact expected head. */
  async save(actor: GraphLayoutActor, layout: string | null, expectedHead: string | null,
    body: GraphLayoutDocument, replay: { idempotencyKey: string; requestDigest: string }): Promise<GraphLayoutRevision> {
    const principalId = await this.authorize(actor);
    const operationId = `graph-layout:${createHash('sha256')
      .update(`${principalId}\n${replay.idempotencyKey}`).digest('hex')}`;
    const id = layout ?? `https://rezics.com/id/${derivedId(operationId)}`;
    if (layout !== null && !nativeIri.test(layout)) throw new GraphLayoutMissing('layout is unavailable');
    const existing = await this.binding(id);
    if (layout !== null && !existing) throw new GraphLayoutMissing('layout is unavailable');
    if (existing) {
      // Only the owning Agent writes; a foreign layout is indistinguishable from a missing one.
      if (existing.owner_subject !== actor.actingSubject) throw new GraphLayoutMissing('layout is unavailable');
      if (existing.view_profile !== body.view.profile || existing.anchor !== body.view.anchor
        || existing.context !== body.view.context) {
        throw new GraphLayoutConflict('layout view identity is immutable');
      }
    }
    const variant = { id: existing?.variant_id ?? `urn:rezics:graph-layout:${id.slice(-36)}`, resourceId: id,
      language: { kind: 'zxx' as const }, direction: 'none' as const };
    let saved;
    try {
      saved = await this.content.saveDraft({ operationId, variant, expectedHead, model: GRAPH_LAYOUT_MODEL,
        sourceRevision: null, serializedJson: JSON.stringify(body),
        provenance: { kind: 'graph-layout-owner-v1', owner: actor.actingSubject,
          requestDigest: replay.requestDigest } });
    } catch (error) {
      if (error instanceof ContentConflict) throw new GraphLayoutConflict('replay key was used for another layout intent');
      throw new GraphLayoutUnavailable('Content owner is unavailable');
    }
    if (saved.outcome === 'stale_head') throw new GraphLayoutStale('layout head changed');
    if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new GraphLayoutUnavailable('layout save was cancelled');
    if (!existing) {
      // The binding follows the first save; a crash between them is repaired by replaying the same key.
      try {
        await this.contentPool.query(`INSERT INTO content.graph_layout
          (id, variant_id, owner_subject, view_profile, anchor, context, operation_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [id, variant.id, actor.actingSubject, body.view.profile, body.view.anchor, body.view.context, operationId]);
      } catch { throw new GraphLayoutUnavailable('Content owner is unavailable'); }
    }
    const revision = await this.exact(id, saved.revisionId);
    return { ...revision, replayed: saved.replayed };
  }

  private async exact(layout: string, revision: string): Promise<GraphLayoutRevision> {
    const binding = await this.binding(layout);
    if (!binding) throw new GraphLayoutMissing('layout is unavailable');
    let result: ExactReadResult | undefined;
    try {
      [result] = await this.content.readExactBatch([revision], async ids => new Set(ids));
    } catch { throw new GraphLayoutUnavailable('Content owner is unavailable'); }
    if (result?.status === 'unavailable' || result?.status === 'corrupt') {
      throw new GraphLayoutUnavailable('Content revision is unavailable');
    }
    if (result?.status !== 'available' || result.reference.variantId !== binding.variant_id
      || result.reference.model !== GRAPH_LAYOUT_MODEL) {
      throw new GraphLayoutMissing('layout revision is unavailable');
    }
    return { layout, owner: binding.owner_subject,
      view: { profile: binding.view_profile, anchor: binding.anchor, context: binding.context },
      revision, predecessor: result.reference.predecessor, byteDigest: result.reference.byteDigest,
      body: result.body as unknown as GraphLayoutDocument };
  }

  /** Current head, or one exact historical revision, for the owning Agent only. */
  async read(actor: GraphLayoutActor, layout: string, revision?: string): Promise<GraphLayoutRevision> {
    await this.authorize(actor);
    if (!nativeIri.test(layout)) throw new GraphLayoutMissing('layout is unavailable');
    const binding = await this.binding(layout);
    if (!binding || binding.owner_subject !== actor.actingSubject) throw new GraphLayoutMissing('layout is unavailable');
    return this.exact(layout, revision ?? binding.draft_head);
  }
}
