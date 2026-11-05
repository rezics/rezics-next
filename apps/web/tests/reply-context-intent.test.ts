import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { ReplyIntent } from '../src/threads/reply-context-intent';
import type { VoteCitation } from '../src/threads/post-writes';

type ThreadContext =
  | { kind: 'review'; subjectId: string; voteCitation?: VoteCitation }
  | { kind?: undefined; subjectId?: string };
const citation = { questionId: 'question', units: 14, revision: 8 };
const metadata: ThreadContext = { kind: 'review', subjectId: 'subject', voteCitation: citation };
const draft = { title: 'Review', body: fromPlainText('A careful review', 'blocks'), mediaIds: ['image'] };
const scope = JSON.stringify(['thread', 'board', 'actor', 'csrf']);
const edits: ThreadContext[] = [
  { subjectId: 'subject' },
  { ...metadata, subjectId: 'another-subject' },
  { ...metadata, voteCitation: { ...citation, questionId: 'another-question' } },
  { ...metadata, voteCitation: { ...citation, units: 0 } },
  { ...metadata, voteCitation: { ...citation, revision: 9 } },
  { kind: 'review', subjectId: 'subject' },
];

test('pending and uncertain review intents retain cloned metadata and reject every changed command', () => {
  const intent = new ReplyIntent<ThreadContext>('original-key');
  const originalDraft = { ...draft, submissionContext: structuredClone(metadata) };
  const original = intent.prepare(originalDraft, null, scope);
  intent.settle(false);
  expect(intent.unresolved).toBe(true);

  for (const submissionContext of edits) {
    const changed = { ...draft, submissionContext };
    expect(intent.canPrepare(changed, null, scope)).toBe(false);
    expect(() => intent.prepare(changed, null, scope)).toThrow('The original command outcome is unknown');
  }
  const selected = originalDraft.submissionContext;
  if (selected.kind !== 'review') throw new Error('Expected a review');
  selected.subjectId = 'changed-in-place';
  selected.voteCitation!.units = 0;
  expect(original.submissionContext).toEqual(metadata);
  intent.settle(false);
  expect(intent.prepare({ ...draft, submissionContext: structuredClone(metadata) }, null, scope)).toBe(original);
  expect(original.idempotencyKey).toBe('original-key');
});

test('a known not-applied refusal permits each changed metadata value only with a fresh key', () => {
  for (const submissionContext of edits) {
    const intent = new ReplyIntent<ThreadContext>('original-key');
    const originalDraft = { ...draft, submissionContext: metadata };
    const original = intent.prepare(originalDraft, null, scope);
    intent.settle(false);
    intent.settle(true);
    expect(intent.unresolved).toBe(false);
    expect(intent.prepare(originalDraft, null, scope)).toBe(original);
    const changed = intent.prepare({ ...draft, submissionContext }, null, scope);
    expect(changed.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(changed.submissionContext).toEqual(submissionContext);
  }
});

test('stable uncited reviews and ordinary replies preserve keys and current target/session isolation', () => {
  const intent = new ReplyIntent<ThreadContext>('review-key');
  const uncited = { ...draft, submissionContext: { kind: 'review' as const, subjectId: 'subject' } };
  const command = intent.prepare(uncited, null, scope);
  intent.settle(false);
  expect(intent.prepare(structuredClone(uncited), null, scope)).toBe(command);
  expect(command.submissionContext).not.toHaveProperty('voteCitation');
  expect(intent.canPrepare({ ...draft, submissionContext: metadata }, null, scope)).toBe(false);
  for (const changedScope of [
    ['another-thread', 'board', 'actor', 'csrf'],
    ['thread', 'another-board', 'actor', 'csrf'],
    ['thread', 'board', 'another-actor', 'csrf'],
    ['thread', 'board', 'actor', 'another-csrf'],
  ]) {
    expect(intent.canPrepare(uncited, null, JSON.stringify(changedScope))).toBe(false);
  }

  const reply = new ReplyIntent('reply-key');
  const original = reply.prepare(draft, 'parent', scope);
  reply.settle(false);
  expect(reply.selectParent('another-parent')).toBe(original.idempotencyKey);
  expect(reply.canPrepare(draft, 'another-parent', scope)).toBe(false);
  expect(reply.prepare(draft, 'parent', scope)).toBe(original);
  expect(original).not.toHaveProperty('submissionContext');
});
