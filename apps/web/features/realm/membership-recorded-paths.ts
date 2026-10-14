import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import type { MembershipReplayPhase } from './membership-recorded-transition.ts';
import { recordedSample } from './realm-membership-recorded-page.ts';

function select(record: AnswerRecord, persona: AnswerPersona, labels: readonly string[]): RecordedSelection[] {
  return labels.map(label => ({ label, state: recordedSample(record, persona, label).status >= 400 ? 'error' : 'populated' }));
}

export const ownerSessionLabels = ['session-agent', 'agent-choices', 'acting-contexts', 'acting-agent-profile'] as const;
const ownerFrameLabels = ['management-realm-header', 'management-site-absent'] as const;
const addressLabel = 'request-address-space-missing';
const requesterLabel = 'requester-name-stranger';

export function withdrawalPhases(record: AnswerRecord, persona: 'stranger' | 'operator'): MembershipReplayPhase[] {
  const route = select(record, persona, ['join-session-agent', 'join-agent-choices', 'join-acting-contexts',
    'join-acting-agent-profile', 'join-address', 'join-public-realm', 'join-realm', 'join-landing']);
  return [
    { selections: [...route, ...select(record, persona, ['withdraw-confirm-own-request', 'withdraw-confirm'])], advanceOn: 'withdraw-confirm' },
    { selections: [...route, ...select(record, persona, ['withdraw-confirm-own-request-after'])] },
  ];
}

export function decisionPhases(record: AnswerRecord, decision: 'accepted' | 'declined'): MembershipReplayPhase[] {
  const common = select(record, 'owner', [...ownerSessionLabels, ...ownerFrameLabels, addressLabel, requesterLabel]);
  const inbox = `decision-confirm-inbox-${decision}`;
  const selected = `decision-confirm-selected-refreshed-${decision}`;
  const command = `decision-confirm-${decision}`;
  return [
    { selections: [...common, ...select(record, 'owner', [inbox])], advanceOn: inbox },
    { selections: [...common, ...select(record, 'owner', [selected, command])], advanceOn: command },
    { selections: [...common, ...select(record, 'owner', [`decision-confirm-inbox-after-${decision}`])] },
  ];
}

export function refusedSelections(record: AnswerRecord, persona: 'member' | 'moderator' | 'stranger' | 'operator'): RecordedSelection[] {
  const session = persona === 'member' || persona === 'moderator' ? 'frame' : 'join';
  return select(record, persona, [`${session}-session-agent`, `${session}-agent-choices`, `${session}-acting-contexts`,
    `${session}-acting-agent-profile`, 'requests-address-space-missing', 'requests-refused',
    'requests-address-settings-refused', 'requests-access-realm',
    ...(persona === 'member' || persona === 'moderator' ? ['requests-access-settings-refused'] : []),
    'management-refused-realm-header', 'management-refused-realm-zone']);
}

export function invitationPhases(record: AnswerRecord): MembershipReplayPhase[] {
  return [
    { selections: select(record, 'owner', [...ownerSessionLabels, ...ownerFrameLabels, 'members-before-invitation',
      'roles-before-invitation', 'outgoing-invitations-before-confirm', 'members-before-invitation-name-stranger',
      'members-before-invitation-name-operator', 'invitation-confirm-roster', 'invitation-confirm']), advanceOn: 'invitation-confirm' },
    // Next's refresh reruns the server route and frame. Its anonymous names are
    // distinct from the BFF's personalized member/name and invitation refreshes.
    { selections: select(record, 'owner', ['invitation-refresh-realm-header', 'invitation-refresh-realm-zone',
      'members-after-invitation', 'roles-after-invitation', 'members-page-invitations-after-confirm',
      'members-after-invitation-name-stranger', 'members-after-invitation-name-operator', 'members-after-invitation-name-member']),
      advanceOn: 'members-page-invitations-after-confirm' },
    { selections: select(record, 'owner', ['invitation-refresh-realm-header', 'invitation-refresh-realm-zone',
      'invitation-refresh-members', 'outgoing-invitations-after-confirm',
      'members-after-invitation-name-stranger', 'members-after-invitation-name-operator', 'members-after-invitation-name-member',
      'invitation-refresh-member-name-stranger', 'invitation-refresh-member-name-operator']) },
  ];
}
