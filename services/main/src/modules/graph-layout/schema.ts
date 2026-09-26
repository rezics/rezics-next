// Typed declarations for saved graph layouts (Content migration 140). A layout
// body is an ordinary Content variant revision with this model; positions and
// display groups are view state and never create or change graph relations.
import { t } from 'elysia';
import { declareTable } from '../recommendation/generation-schema.ts';

export const GRAPH_LAYOUT_MODEL = 'graph-layout-v1';
const MAX_GRAPH_LAYOUT_NODES = 2_000;
const MAX_GRAPH_LAYOUT_GROUPS = 200;

const nativeIri = t.String({ pattern: '^https://rezics[.]com/id/[0-9a-f-]{36}$' });
const coordinate = t.Number({ minimum: -1_000_000, maximum: 1_000_000 });
const groupId = t.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' });

/** Serialized body bytes of one layout revision. */
export const GraphLayoutBody = t.Object({
  view: t.Object({
    profile: t.String({ pattern: '^https://rezics[.]com/definition/[a-z0-9-]+-v[0-9]+$' }),
    anchor: nativeIri,
    context: t.Union([nativeIri, t.Null()]),
  }, { additionalProperties: false }),
  nodes: t.Array(t.Object({
    resource: nativeIri,
    x: coordinate,
    y: coordinate,
    group: t.Optional(groupId),
    pinned: t.Boolean(),
  }, { additionalProperties: false }), { maxItems: MAX_GRAPH_LAYOUT_NODES }),
  groups: t.Array(t.Object({
    id: groupId,
    label: t.String({ minLength: 1, maxLength: 200 }),
    x: coordinate,
    y: coordinate,
    collapsed: t.Boolean(),
  }, { additionalProperties: false }), { maxItems: MAX_GRAPH_LAYOUT_GROUPS }),
}, { additionalProperties: false });

export interface GraphLayoutRow {
  id: string;
  variant_id: string;
  owner_subject: string;
  view_profile: string;
  anchor: string;
  context: string | null;
  operation_id: string;
  created_at: Date;
}

export const graphLayoutTable = declareTable<GraphLayoutRow>()('content', 'graph_layout',
  ['id', 'variant_id', 'owner_subject', 'view_profile', 'anchor', 'context', 'operation_id', 'created_at']);
