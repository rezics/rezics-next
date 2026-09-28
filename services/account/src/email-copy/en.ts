import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { one?: string; other: string }> = {
  reply: { one: '{n} reply', other: '{n} replies' },
  mention: { one: '{n} mention', other: '{n} mentions' },
  'post-vote': { one: '{n} vote on your posts', other: '{n} votes on your posts' },
  'followed-chapter': { one: '{n} new chapter', other: '{n} new chapters' },
  'review-helpful': { one: '{n} helpful vote on your reviews', other: '{n} helpful votes on your reviews' },
  review: { one: '{n} review', other: '{n} reviews' },
  'submission-decision': { one: '{n} decision on a submission', other: '{n} decisions on submissions' },
  'moderation-outcome': { one: '{n} moderation outcome', other: '{n} moderation outcomes' },
  'realm-role-change': { one: '{n} role change', other: '{n} role changes' },
  'realm-membership-change': { one: '{n} membership change', other: '{n} membership changes' },
  'realm-invitation': { one: '{n} Realm invitation', other: '{n} Realm invitations' },
  'claim-correction': { one: '{n} claim correction', other: '{n} claim corrections' },
  notification: { one: '{n} notification', other: '{n} notifications' },
};

const copy: EmailCopy = {
  verify: { subject: 'Verify your email address', body: 'Confirm this email address for your REZICS account.', action: 'Verify email' },
  reset: { subject: 'Reset your password', body: 'Choose a new password for your REZICS account. This link expires in 30 minutes.', action: 'Reset password' },
  'change-email': { subject: 'Confirm your email change', body: 'Confirm the request to change your REZICS email address. You will then need to verify the new address.', action: 'Confirm email change' },
  notice: { subject: 'A message about your REZICS account', body: 'The REZICS team sent you this message about your account:', action: 'Open your REZICS account' },
  digest: { subject: 'Your REZICS notification digest', body: 'Here is your daily notification digest.', action: 'Open REZICS' },
  ignore: 'If you did not request this, you can ignore this email.',
  digestMore: 'More notifications are waiting in REZICS.',
  digestLine: (topic, count) => plural('en', count, topics[topic] ?? topics.notification!),
};

export default copy;
