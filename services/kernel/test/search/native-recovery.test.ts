import { expect, test } from 'bun:test';
import { searchNativePageTransition, searchNativeRecoveryFamily } from '../../src/search/http/native-recovery.ts';

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
