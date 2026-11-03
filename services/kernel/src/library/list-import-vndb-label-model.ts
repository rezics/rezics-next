import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { t } from 'elysia';

export const VNDB_LABEL_LIMITS = {
  rows: 8, mappings: 8, items: 64, page: 8, selectionBytes: 16384, sourceNameBytes: 1024, applyMs: 5000,
} as const;
export const vndbLabelDigest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const closed = { additionalProperties: false } as const;
const uuid = t.String({ format: 'uuid' });
export const vndbLabelChoiceSchema = t.Object({
  rows: t.Array(t.Object({ ordinal: t.Integer({ minimum: 0, maximum: 4999 }), reviewId: uuid }, closed), { minItems: 1, maxItems: 8 }),
  mappings: t.Array(t.Object({
    source: t.String({ minLength: 1, maxLength: 1024 }),
    target: t.Union([
      t.Object({ labelId: uuid, revision: t.Integer({ minimum: 1, maximum: 2147483647 }) }, closed),
      t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }, closed),
    ]),
  }, closed), { minItems: 1, maxItems: 8 }),
}, closed);
export type VndbLabelChoice = typeof vndbLabelChoiceSchema.static;
export type LabelIdentity = { id: string; revision: number };
export type VndbLabelMapping = VndbLabelChoice['mappings'][number] & {
  label: LabelIdentity | null;
  creator?: VndbLabelOperand;
  admission: 'ready' | 'unsupported' | 'refused';
  reason: 'state-label' | 'name-occupied' | 'label-unavailable' | null;
};
export type VndbLabelOperand = {
  ordinal: number;
  reviewId: string;
  sourceDigest: string;
  subjectId: string | null;
  source: string | null;
  mapping: number;
};
export type VndbLabelStatus = 'ready' | 'applied' | 'already_present' | 'stale' | 'unsupported' | 'refused';
export type VndbLabelResult = {
  reason: string | null;
  retryable: boolean;
  label: LabelIdentity | null;
  assignment: LabelIdentity | null;
};
export type VndbLabelItem = { item_no: number; operand: VndbLabelOperand; status: VndbLabelStatus; result: VndbLabelResult | null };
export type VndbLabelPlan = {
  preview_id: string;
  state: 'reviewed' | 'applying' | 'cancelled';
  expires_at: Date;
  mappings: VndbLabelMapping[];
  item_count: number;
};
export const VNDB_STATE_LABELS = new Set(['Playing', 'Finished', 'Stalled', 'Dropped', 'Wishlist']);
