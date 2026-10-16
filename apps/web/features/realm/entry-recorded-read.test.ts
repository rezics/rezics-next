import { expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import admission from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import closure from '../../../../tests/qa/fixtures/outcomes/realm/closure-threads-and-replies.json';
import { readMembership } from './membership-state.ts';
import { recordedRealmEntry } from './entry-recorded-read.ts';

const personas: AnswerPersona[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];
for (const persona of personas) {
  test(`closed Realm entry is ordinarily missing for ${persona}, using unchanged HTTP records`, async () => {
    const record = closure as AnswerRecord;
    const replay = recordedRealmEntry(record, persona, record.personas[persona].filter(sample => sample.label.startsWith('discussion-') && !sample.label.includes('@')).map(sample => ({
      label: sample.label, state: sample.status >= 400 ? 'error' : 'populated',
    })), 'discussion-space-address', persona === 'visitor' ? undefined : 'discussion-session-agent');
    try { expect((await replay.read('en')).resolved).toEqual({ kind: 'missing' }); }
    finally { replay.dispose(); }
  });
}

for (const persona of ['visitor', 'stranger', 'operator'] as const) {
  test(`${persona} sees only the recorded admission landing, without private membership`, async () => {
    const record = admission as AnswerRecord;
    const labels = persona === 'visitor' ? ['request-landing', 'private-realm-hidden', 'join-address']
      : ['join-address', 'join-public-realm', 'join-realm', 'join-landing', 'join-session-agent'];
    const replay = recordedRealmEntry(record, persona, labels.map(label => ({ label,
      state: record.personas[persona].find(sample => sample.label === label)!.status >= 400 ? 'error' : 'populated',
    })), 'join-address', persona === 'visitor' ? undefined : 'join-session-agent');
    try {
      const { resolved, actingSubject } = await replay.read('en');
      expect(resolved.kind).toBe('join');
      if (resolved.kind !== 'join') throw new Error('Admission landing missing');
      const label = persona === 'visitor' ? 'request-landing' : 'join-landing';
      expect<unknown>(resolved.page).toEqual(record.personas[persona].find(sample => sample.label === label)!.answer);
      expect(actingSubject === undefined).toBe(persona === 'visitor');
    } finally { replay.dispose(); }
  });
}

for (const persona of ['member', 'moderator'] as const) {
  test(`${persona} reads its recorded private Realm and membership without an admission inbox`, async () => {
    const record = admission as AnswerRecord;
    const labels = ['frame-address', 'frame-public-realm', 'frame-realm', 'frame-session-agent', 'frame-joining', 'frame-follow'];
    const replay = recordedRealmEntry(record, persona, labels.map(label => ({ label,
      state: label === 'frame-public-realm' ? 'error' : 'populated',
    })), 'frame-address', 'frame-session-agent');
    try {
      const { resolved, actingSubject } = await replay.read('en');
      expect(resolved.kind).toBe('realm');
      if (resolved.kind !== 'realm' || !actingSubject) throw new Error('Recorded membership missing');
      expect<unknown>(resolved.header).toEqual(record.personas[persona].find(sample => sample.label === 'frame-realm')!.answer);
      expect((await readMembership(replay.personal, resolved.header.id, actingSubject)).policy?.state).toBe('joined');
    } finally { replay.dispose(); }
  });
}
