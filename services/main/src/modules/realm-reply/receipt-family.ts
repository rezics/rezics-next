/** Access derives terminal receipt IDs from these owner-owned action families. */
export const receiptFamilies = {
  'reply.create': 'realm-reply-create-v1',
  'review.decide': 'realm-review-decision-v1',
  'reply.place': 'realm-reply-placement-v1',
} as const;
