import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import type { SubmissionView } from '../src/modules/realm-submission/schema.ts';
import { receiptFamilyFor } from '../src/modules/access/receipt-families.ts';

test('Realm submission clients retain exact candidate, decision CAS and concrete author state pages', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const typedFlow = async () => {
    const realm = client.v1.realms({ realm: '00000000-0000-4000-8000-000000000002' });
    const offered = await realm.submissions.post({ actingSubject: actor, kind: 'contribution',
      work: actor, mainVersion: actor, contribution: actor, publicationDecision: actor,
      selectedDraft: actor, correctionOf: null }, { headers: { 'Idempotency-Key': 'submit-one' } });
    const revision: string | undefined = offered.data?.submission.revision;
    const decided = await realm.submissions({ submission: offered.data!.submission.id }).decisions.post({
      actingSubject: actor, expectedRevision: revision!, outcome: 'accept', expectedSelectionHead: null,
      publicReason: null, internalNote: null }, { headers: { 'Idempotency-Key': 'decide-one' } });
    const selection: string | null | undefined = decided.data?.submission.selection;
    const mine = await client.v1.my.submissions.get({ query: { actingSubject: actor, state: 'accepted' } });
    const state: SubmissionView['state'] | undefined = mine.data?.items[0]?.state;
    const pending = await realm.moderation.get({ query: { actingSubject: actor, type: 'correction_submission' } });
    const correctionOf: string | null | undefined = pending.data?.items[0]?.submission?.correctionOf;
    return { state, correctionOf, selection };
  };
  expect(typedFlow).toBeFunction();
  expect(receiptFamilyFor('submission.submit')).toBe('realm-submission-submit-v1');
  expect(receiptFamilyFor('submission.withdraw')).toBe('realm-submission-withdraw-v1');
});
