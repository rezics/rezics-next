import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedSample } from './realm-membership-recorded-page.ts';

/** Labels select exact answers, including every supporting frame read. */
export function membershipSelections(record: AnswerRecord, persona: AnswerPersona, labels: readonly string[]): RecordedSelection[] {
  return labels.map(label => ({ label, state: recordedSample(record, persona, label).status >= 400 ? 'error' : 'populated' }));
}

export function membershipSessionLabels(persona: Exclude<AnswerPersona, 'visitor'>): string[] {
  const prefix = persona === 'owner' ? '' : persona === 'member' || persona === 'moderator' ? 'frame-' : 'join-';
  return ['session-agent', 'agent-choices', 'acting-contexts', 'acting-agent-profile'].map(label => prefix + label);
}

export function membershipRefusalLabels(persona: 'member' | 'moderator' | 'stranger' | 'operator'): string[] {
  return [...membershipSessionLabels(persona), 'requests-address-space-missing', 'requests-refused',
    'requests-address-settings-refused', 'requests-access-realm',
    ...persona === 'member' || persona === 'moderator' ? ['requests-access-settings-refused'] : [],
    'management-refused-realm-header', 'management-refused-realm-zone'];
}

export const membershipInvitationLabels = [
  ...membershipSessionLabels('owner'),
  'members-before-invitation', 'roles-before-invitation', 'outgoing-invitations-before-confirm',
  'members-before-invitation-name-stranger', 'members-before-invitation-name-operator',
  'management-realm-header', 'management-site-absent',
  'invitation-confirm-roster', 'invitation-confirm',
  'members-after-invitation', 'invitation-refresh-members', 'roles-after-invitation',
  'members-page-invitations-after-confirm', 'outgoing-invitations-after-confirm',
  'members-after-invitation-name-stranger', 'members-after-invitation-name-operator', 'members-after-invitation-name-member',
  'invitation-refresh-member-name-stranger', 'invitation-refresh-member-name-operator',
  'invitation-refresh-realm-header', 'invitation-refresh-realm-zone',
];
