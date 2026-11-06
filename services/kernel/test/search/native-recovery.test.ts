import { expect, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem-error.ts';
import {
  SEARCH_VISIT_OPERAND_BUDGET,
  searchNativeAuthoredBytes,
  searchNativeOperandRecovery,
  searchNativePageTransition,
  searchNativeProblemRecovery,
  searchNativeRecoveryFamily,
  searchNativeRetainOrRestart,
} from '../../src/search/http/native-recovery.ts';
import { searchHttpExecute, searchHttpPrincipal } from '../../src/search/http/search.ts';
import { executedRatingPair, executedSearchOperands } from '../../src/search/canonical-keyset-admit.ts';

test('native Search, suggest and facet problems share one typed family before ready', () => {
  expect(searchNativeRecoveryFamily({ status: 200 })).toBe('ready');
  expect(searchNativeRecoveryFamily({ status: 401 })).toBe('session');
  expect(searchNativeRecoveryFamily({ status: 403, code: 'platform_closed' })).toBe('closed');
  expect(searchNativeRecoveryFamily({ status: 403, code: 'forbidden' })).toBe('denied');
  expect(searchNativeRecoveryFamily({ status: 404, code: 'not_found' })).toBe('denied');
  expect(searchNativeRecoveryFamily({ status: 409, code: 'search_restart_required' })).toBe('restart');
  expect(searchNativeRecoveryFamily({ status: 422, code: 'unsupported_query' })).toBe('invalid');
  expect(searchNativeRecoveryFamily({ status: 400, code: 'invalid_request' })).toBe('invalid');
  expect(searchNativeRecoveryFamily({ status: 400, code: 'invalid_request', cursorPointer: true })).toBe(
    'invalid-cursor',
  );
  expect(searchNativeRecoveryFamily({ status: 503, code: 'index_not_ready' })).toBe('index-not-ready');
  expect(searchNativeRecoveryFamily({ status: 503, code: 'semantic_not_ready' })).toBe('source-not-ready');
  expect(searchNativeRecoveryFamily({ status: 503, code: 'overloaded' })).toBe('unavailable');
});

test('generation or identity change restarts; preparation is never a successful empty page', () => {
  expect(searchNativePageTransition({ family: 'ready' })).toBe('ready');
  expect(searchNativePageTransition({ family: 'ready', generationChanged: true })).toBe('restart');
  expect(searchNativePageTransition({ family: 'unavailable', identityChanged: true })).toBe('restart');
  expect(searchNativePageTransition({ family: 'restart' })).toBe('restart');
  expect(searchNativePageTransition({ family: 'index-not-ready' })).toBe('preparing');
  expect(searchNativePageTransition({ family: 'source-not-ready' })).toBe('preparing');
  expect(searchNativePageTransition({ family: 'unavailable' })).toBe('retry');
  expect(searchNativePageTransition({ family: 'invalid' })).toBe('retry');
});

test('invalid HTTP operands retain correction pointers within the visit budget', () => {
  const recovery = searchNativeOperandRecovery({
    status: 400,
    code: 'invalid_request',
    errors: [{ pointer: '/text', code: 'invalid_format' }],
    extensions: { textDiagnostic: { reason: 'unclosed_phrase' } },
    authoredBytes: 24,
  });
  expect(recovery).toEqual({
    family: 'invalid',
    corrections: [{ pointer: '/text', code: 'invalid_format' }],
    textDiagnostic: { reason: 'unclosed_phrase' },
    reusableRequest: false,
  });
  expect(
    searchNativeOperandRecovery({
      status: 400,
      code: 'invalid_request',
      errors: [{ pointer: '/cursor', code: 'invalid_format' }],
      authoredBytes: 40,
    }).family,
  ).toBe('invalid-cursor');
});

test('over-budget authored operands restart without echoing the payload', () => {
  const recovery = searchNativeOperandRecovery({
    status: 422,
    code: 'unsupported_query',
    errors: [{ pointer: '/text', code: 'out_of_range' }],
    authoredBytes: SEARCH_VISIT_OPERAND_BUDGET + 1,
  });
  expect(recovery).toEqual({ family: 'restart', reusableRequest: false });
  const error = new ProblemError('unsupported_query', {
    errors: [{ pointer: '/text', code: 'out_of_range' }],
    extensions: { textDiagnostic: { reason: 'byte_limit' } },
  });
  const restarted = searchNativeRetainOrRestart(error, 'x'.repeat(SEARCH_VISIT_OPERAND_BUDGET + 1));
  expect(restarted).toBeInstanceOf(ProblemError);
  expect(restarted.code).toBe('search_restart_required');
  expect(restarted.errors).toBeUndefined();
});

test('temporary source and index failure keep the executed operands for retry', () => {
  for (const code of ['index_not_ready', 'semantic_not_ready', 'overloaded'] as const) {
    const error = new ProblemError(code, { headers: { 'retry-after': '1' } });
    const recovery = searchNativeProblemRecovery(error, { text: 'lantern', sort: 'name' });
    expect(recovery.reusableRequest).toBe(true);
    expect(searchNativeRetainOrRestart(error, { text: 'lantern', sort: 'name' })).toBe(error);
  }
});

test('HTTP principal is the current reader and rating order travels with population', () => {
  expect(searchHttpPrincipal({ kind: 'anonymous' })).toBe('anonymous');
  expect(
    searchHttpPrincipal({
      kind: 'account',
      accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
      clientId: 'reader',
      scopes: [],
      requestedBy: null,
      authnEpoch: 1,
    }),
  ).toBe('account:019a1b2c-3d4e-7f00-8a00-5ab1ec700001');
  expect(
    executedRatingPair(
      executedSearchOperands({ sort: 'rating', population: { realm: '11111111-1111-4111-8111-111111111111' } }),
    ),
  ).toEqual({ sort: 'rating', population: { realm: '11111111-1111-4111-8111-111111111111' } });
  expect(executedRatingPair({})).toEqual({ sort: null, population: null });
});

test('HTTP execution rewrites only over-budget invalid problems', async () => {
  await expect(
    searchHttpExecute({ text: 'ok' }, async () => {
      throw new ProblemError('invalid_request', { errors: [{ pointer: '/limit', code: 'out_of_range' }] });
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(searchHttpExecute({ text: 'ok' }, async () => 'ready')).resolves.toBe('ready');
  expect(searchNativeAuthoredBytes({ text: 'lantern' })).toBeLessThan(SEARCH_VISIT_OPERAND_BUDGET);
});
