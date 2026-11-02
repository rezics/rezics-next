import { expect, test } from 'bun:test';
import { createAppealResolutionIntent } from '../src/moderation/appeal-resolution/intent';

test('An admitted moderator can resolve the intended appeal and recover a lost response; switching appeals or losing admission cannot expose or submit the previous private form.', () => {
  const form = createAppealResolutionIntent('appeal');
  form.synchronize('appeal', 'reviewer-session', true);
  form.edit('  Private review.  ');
  expect(form.needsDecision).toBe(true);
  const command = form.begin('uphold')!;
  expect(command).toMatchObject({ id: 'appeal', outcome: 'uphold', statement: 'Private review.' });
  expect(form.begin('reverse')).toBeNull();
  form.uncertain();
  expect(form.edit('Contrary decision.')).toBe(false);
  expect(form.retry()).toBe(command);
  form.settle({ state: 'resolved', outcome: command.outcome, statement: command.statement });
  expect(form.result).toEqual({ state: 'resolved', outcome: 'uphold', statement: 'Private review.' });
  expect(form.needsDecision).toBe(false);
  form.synchronize('another-appeal', 'reviewer-session', true);
  expect(form.statement).toBe('');
  expect(form.result).toBeNull();
  expect(form.command).toBeNull();
  expect(form.begin('reverse')).toBeNull();

  const pending = createAppealResolutionIntent('appeal');
  pending.synchronize('appeal', 'reviewer-session', true);
  pending.edit('Private reversal.');
  pending.begin('reverse');
  pending.synchronize('appeal', 'reviewer-session', false);
  pending.uncertain();
  pending.settle({ state: 'resolved', outcome: 'reverse', statement: 'Private reversal.' });
  pending.synchronize('appeal', 'reviewer-session', true);
  expect(pending.statement).toBe('');
  expect(pending.result).toBeNull();
  expect(pending.command).toBeNull();
  expect(pending.retry()).toBeNull();
});

test('Session hydration can admit an empty form but cannot adopt an existing private draft', () => {
  const draft = createAppealResolutionIntent('appeal');
  draft.synchronize('appeal', null, true);
  draft.edit('Private fixture draft.');
  draft.synchronize('appeal', 'reviewer-session', true);
  expect(draft.statement).toBe('');
  expect(draft.edit('Restored draft.')).toBe(false);
  expect(draft.begin('uphold')).toBeNull();
  const empty = createAppealResolutionIntent('appeal');
  empty.synchronize('appeal', null, false);
  empty.synchronize('appeal', 'reviewer-session', true);
  expect(empty.needsDecision).toBe(false);
  empty.edit('   ');
  expect(empty.needsDecision).toBe(false);
  expect(empty.edit('New admitted draft.')).toBe(true);
  expect(empty.begin('reverse')?.statement).toBe('New admitted draft.');
});
