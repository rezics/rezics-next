import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import creation from '../../../../tests/qa/fixtures/outcomes/realm/create-a-realm.json';
import { initialCommunitySettings, type CommunityCreationIntent } from './create-form.tsx';

const recorded = creation as AnswerRecord;
export const foundingPersonas = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type CreationStoryState = 'created' | 'replayed' | 'loading' | 'pending' | 'quota' | 'conflict' | 'expired' | 'owned' | 'taken';
export function creationSample(persona: AnswerPersona, label: string): AnswerSample {
  const sample = recorded.personas[persona].find(sample => sample.label === label);
  if (!sample) throw new Error(`Missing creation answer ${persona}/${label}`);
  return sample;
}

/** These requests are the production form's private admission policy. The
 * recorded outcome uses a different initial policy, so they need recording in
 * the prove phase. Receipt/refusal bodies below remain unchanged. */
export function creationStoryInputs(persona: typeof foundingPersonas[number], state: CreationStoryState = 'created') {
  const label = state === 'quota' ? 'creation-quota-denied' : state === 'conflict' ? 'creation-intent-conflict'
    : state === 'expired' ? 'creation-sign-in-required' : state === 'replayed' ? 'creation-replayed' : 'creation-receipt';
  const source = creationSample(state === 'quota' ? 'owner' : state === 'expired' ? 'visitor' : persona, label);
  const receipt = creationSample(persona, 'creation-receipt');
  const intent = receipt.body as CommunityCreationIntent;
  const body: CommunityCreationIntent = { ...intent, topics: [], initialSettings: initialCommunitySettings('private', []) };
  const command: AnswerSample = {
    ...source, label: 'form-creation', body,
    ...(state === 'pending' ? { status: 202, answer: {
      operationId: 'creation-pending', status: 'reconciling', phase: 'realm-initialization', result: null,
      retry: { allowed: true, afterMs: 1000 },
    } } : {}),
    ...(state === 'owned' || state === 'taken' ? { status: 409, answer: {
      type: 'about:blank', status: 409, title: 'The handle is already in use', code: 'alias_conflict',
    } } : {}),
  };
  const preferences = creationSample('stranger', 'reading-preferences');
  const preferenceRead: AnswerSample = { ...preferences, path: `/v1/me/person-preferences?actingSubject=${encodeURIComponent(body.actingSubject)}` };
  const answer = receipt.answer as { realm: string; owner: string };
  const profileRefusal: AnswerSample = {
    label: 'private-profile-unavailable', operationId: 'putV1RealmsByRealmProfile', method: 'PUT',
    path: `/v1/realms/${answer.realm.slice(-36)}/profile`,
    body: { profile: 'realm-public-profile-v2', expectedHead: null, actingSubject: body.actingSubject,
      publication: { name: { original: 'en', labels: { en: body.name } },
        description: { original: 'en', labels: { en: 'Original description by the founding fixture Person.' } },
        iconSelection: null, bannerSelection: null, replyPolicy: 'moderated',
        count: { kind: 'exact', value: null }, moderators: [] } },
    status: 404, answer: { type: 'about:blank', status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' },
    headers: { 'content-type': 'application/json' },
  };
  const existingReads: AnswerSample[] = state === 'owned' || state === 'taken' ? [
    creationSample(persona, 'founder-address'),
    state === 'owned' ? creationSample(persona, 'founder-managed-realms') : {
      label: 'moderated-realm', operationId: 'getV1MeManaged-realms', method: 'GET',
      path: `/v1/me/managed-realms?actingSubject=${encodeURIComponent(body.actingSubject)}`,
      status: 200, headers: { 'content-type': 'application/json' },
      answer: { items: [{ realm: answer.realm, permissions: ['governance.moderate'],
        openCount: { kind: 'exact', value: 0 }, escalatedCount: { kind: 'exact', value: 0 }, latestActivity: null }],
        nextCursor: null, complete: true },
    },
  ] : [];
  const profileWrites = state === 'created' || state === 'replayed' ? [profileRefusal] : [];
  const samples = [command, preferenceRead, creationSample('stranger', 'topic-choices'), ...profileWrites, ...existingReads];
  const record: AnswerRecord = { version: 1, row: 'realm/create-a-realm',
    personas: { visitor: [], stranger: [], member: [], owner: [], moderator: [], operator: [], [persona]: samples } };
  return { record, persona, body, answer, command,
    // Exact requests are exposed without presenting constructed inputs as captures.
    missingRecordedStates: [command, ...(persona === 'stranger' ? [] : [preferenceRead]), ...profileWrites,
      ...existingReads.filter(sample => sample.label === 'moderated-realm')],
  };
}
