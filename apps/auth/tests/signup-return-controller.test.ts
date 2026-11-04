import { expect, test } from 'bun:test';
import { SignupAttemptController } from '../src/signup-attempt';
import { SignupReturnController, summarizeSignupOutcome } from '../src/signup-return';

test('only unresolved dispatches and confirmed creation survive as secret-free summaries', () => {
  const attempt = new SignupAttemptController(1);
  attempt.updateDraft('password', 'private-password');
  expect(summarizeSignupOutcome(attempt.phase)).toBeNull();
  attempt.updateDraft('handle', 'reader_1');
  attempt.updateDraft('email', 'reader@example.test');
  const dispatch = attempt.dispatch('private-token')!;
  const summary = summarizeSignupOutcome(attempt.phase)!;
  expect(summary).toEqual({ kind: 'unresolved' });
  expect(JSON.stringify(summary)).not.toMatch(/private-password|reader@example|reader_1|private-token/);

  attempt.resolve(dispatch.attempt, {
    ok: false,
    failure: { kind: 'uncertain', status: 503, code: 'unavailable', retryAfter: null, message: 'Unavailable.' },
  });
  expect(summarizeSignupOutcome(attempt.phase)).toEqual({ kind: 'unresolved' });
  attempt.retire();

  const created = new SignupAttemptController(2);
  created.updateDraft('handle', 'reader_2');
  created.updateDraft('email', 'reader@example.test');
  created.updateDraft('password', 'private-password');
  const createdDispatch = created.dispatch('private-token')!;
  created.resolve(createdDispatch.attempt, { ok: true });
  expect(summarizeSignupOutcome(created.phase)).toEqual({ kind: 'created' });
  created.beginSignIn();
  created.finishSignIn(false, 'Unavailable.');
  expect(summarizeSignupOutcome(created.phase)).toEqual({ kind: 'created' });
});

test('known terminal refusals and handle correction do not become return warnings', () => {
  const refused = new SignupAttemptController(1);
  refused.updateDraft('handle', 'reader_1');
  refused.updateDraft('email', 'reader@example.test');
  refused.updateDraft('password', 'private-password');
  const refusedDispatch = refused.dispatch('token')!;
  refused.resolve(refusedDispatch.attempt, {
    ok: false,
    failure: {
      kind: 'conflict',
      status: 409,
      code: 'registration_conflict',
      retryAfter: null,
      message: 'Unavailable.',
    },
  });
  expect(refused.phase.kind).toBe('refused');
  expect(summarizeSignupOutcome(refused.phase)).toBeNull();

  const correction = new SignupAttemptController(2);
  correction.updateDraft('handle', 'Reader_1');
  correction.updateDraft('email', 'reader@example.test');
  correction.updateDraft('password', 'private-password');
  const correctionDispatch = correction.dispatch('token')!;
  correction.resolve(correctionDispatch.attempt, {
    ok: false,
    failure: {
      kind: 'handle-unavailable',
      status: 409,
      code: 'handle_unavailable',
      retryAfter: null,
      message: 'Taken.',
    },
  });
  expect(summarizeSignupOutcome(correction.phase)).toBeNull();
  correction.updateDraft('handle', 'Reader_2');
  expect(correction.useDifferentHandle('new-key')).toBe(true);
  expect(correction.phase.kind).toBe('draft');
});

test('restoration reads are single-flight, stale reads are fenced, and acknowledgement retires history', () => {
  const attempt = new SignupAttemptController(1);
  attempt.updateDraft('handle', 'reader_1');
  attempt.updateDraft('email', 'reader@example.test');
  attempt.updateDraft('password', 'private-password');
  attempt.dispatch('token')!;
  const result = new SignupReturnController();
  result.retain(attempt.phase);

  const first = result.beginRestoration()!;
  expect(result.beginRestoration()).toBeNull();
  expect(result.adviceReturned(first)).toBe(true);
  expect(result.state.status).toBe('ready');
  expect(result.beginRestoration()).toBeNull();
  result.suspend(true);
  expect(result.state.summary).toEqual({ kind: 'unresolved' });
  const repeated = result.beginRestoration()!;
  expect(result.adviceReturned(repeated)).toBe(true);
  const refresh = result.beginRefresh()!;
  result.noteAuthorityChange('account:first', 'account:second');
  expect(result.state.currentViewerChanged).toBe(true);
  expect(result.acknowledge()).toBe(true);
  expect(result.adviceReturned(refresh)).toBe(false);
  expect(result.state.summary).toBeNull();
  expect(result.state.currentViewerChanged).toBe(false);

  attempt.retire();
  expect(summarizeSignupOutcome(attempt.phase)).toBeNull();
});
