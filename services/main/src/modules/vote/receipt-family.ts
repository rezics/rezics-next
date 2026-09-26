/** Access actions share a receipt family even when several vote operations use that action. */
export const receiptFamilies = {
  'governance.poll.administer': 'vote-poll',
  'governance.seat.manage': 'vote-seat',
  'governance.ballot.operate': 'vote-ballot',
  'governance.ballot.invalidate': 'vote-invalidation',
} as const;
