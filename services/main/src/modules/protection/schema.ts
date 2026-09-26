// Owner-schema declarations for editorial protection. Content migration 130 and the
// protection-revision-v1 model profile remain the DDL owners; these types bind them.

export const PROTECTION_RULE = 'urn:rezics:protection-rule:independent-human-review-v1';
export const CONTENT_DRAFT_PROTECTION = 'content-draft-protection-v1';
export const PROTECTION_PROFILE = 'https://rezics.com/definition/protection-revision-v1';
/** The first graph target: one native Work English title slot in its Global adoption context. */
export const WORK_TITLE_TARGET = { slot: 'title:en', context: 'https://rezics.com/vocab/GlobalNative' } as const;
/** Explicit absence assertion for a protection or control head in graph records and receipts. */
export const ABSENT_HEAD = 'https://rezics.com/vocab/Absent';

export type ProtectionMode = 'open' | 'review-required';
export type ProtectionAction = 'tighten' | 'confirm' | 'relax';

/** `content.variant` protection binding. A NULL head is the profile's explicit absent head (effective open). */
export interface VariantProtectionRow { id: string; draft_head: string | null; protection_head: string | null }

/** `content.protection_revision`: append-only, linear per variant by `epoch`. */
export interface ProtectionRevisionRow {
  id: string; variant_id: string; predecessor: string | null; epoch: string;
  profile: typeof CONTENT_DRAFT_PROTECTION; action: ProtectionAction; mode: ProtectionMode;
  rule_revision: typeof PROTECTION_RULE; observed_head: string; reason: string;
  evidence: string[]; agent: string | null; operation_id: string; created_at: Date;
}

/** Content owner constraint names mapped to the planned API conflict reasons. */
export const PROTECTION_CONFLICTS = {
  protection_stale_basis: 'stale_protection',
  protection_stale_content: 'stale_content',
  protection_transition: 'unsupported_transition',
  variant_protection_append_only: 'stale_protection',
  variant_correction_required: 'correction_required',
} as const;
