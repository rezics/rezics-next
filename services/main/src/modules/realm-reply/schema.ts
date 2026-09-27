import type { OwnerColumns } from '../commerce/owner-columns.ts';

/** Content database tables from migration 060. Reply bodies and revisions are
 * the existing `content.variant`/`content.revision` rows; Realm acceptance is a
 * graph publication decision that references these exact records. */
export const realmReplySchema = 'content';

export const realmReplyColumns = {
  reply_author: { reply: 'text', variant_id: 'text', author: 'text', root_target: 'text',
    root_revision: 'text', operation_id: 'text' },
  reply: { id: 'text', variant_id: 'text', author: 'text', root_target: 'text',
    root_revision: 'text', parent_reply: 'text?', parent_variant: 'text?',
    parent_revision: 'uuid?', context_revision: 'text?', operation_id: 'text',
    created_at: 'timestamptz' },
  realm_review_decision: { id: 'uuid', realm: 'text', variant_id: 'text', revision_id: 'uuid',
    review_generation: 'int8', supersedes: 'uuid?', outcome: 'text', policy: 'text',
    policy_revision: 'text', method: 'text', method_revision: 'text', reviewer: 'text',
    revision_digest: 'text', dependency_digest: 'text', reason_reference: 'text?',
    operation_id: 'text', created_at: 'timestamptz' },
  realm_placement_preparation: { operation_id: 'text', realm: 'text', variant_id: 'text',
    revision_id: 'uuid', review_decision_id: 'uuid', direct_policy_revision: 'text?', created_at: 'timestamptz' },
} as const satisfies OwnerColumns;
