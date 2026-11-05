import { expect, test } from 'bun:test';
import { createOperationCatalogue, LIBRARY_OPERATION_DECLARATIONS } from '../src/index.ts';

const record = LIBRARY_OPERATION_DECLARATIONS.find(
  (descriptor) => descriptor.operationId === 'progress_session.record',
)!;

test('the production Library descriptors form an immutable pure catalogue', () => {
  const catalogue = createOperationCatalogue(LIBRARY_OPERATION_DECLARATIONS);
  const operation = catalogue.get('progress_session.record');
  expect(operation).toMatchObject({
    method: 'POST',
    path: '/v1/progressSessions/:sessionId/$record',
    action: 'progress_session:update',
    audience: 'account',
    rateLimit: 'kernel.write.single',
  });
  expect(Object.isFrozen(operation)).toBe(true);
  expect(Object.isFrozen(operation?.contracts)).toBe(true);
  expect(catalogue.all().map(({ operationId }) => operationId)).toEqual([
    'library_continue.list',
    'progress_session.record',
  ]);
});

test('duplicate operation IDs fail with both route labels', () => {
  const duplicate = { ...record, path: '/v1/progressSessions/:sessionId/$retry' };
  expect(() => createOperationCatalogue([record, duplicate])).toThrow(
    /progress_session\.record.*duplicate operationId/,
  );
});

test('one action cannot declare conflicting security', () => {
  const publicAlias = {
    ...record,
    operationId: 'progress_session.retry',
    path: '/v1/progressSessions/:sessionId/$retry',
    audience: 'public' as const,
    security: [{ scheme: 'anonymous' as const }, { scheme: 'bearerAuth' as const }],
  };
  expect(() => createOperationCatalogue([record, publicAlias])).toThrow(
    /conflicting security for action progress_session:update/,
  );
});

test('shared route prefixes reject incompatible parameter names', () => {
  const changedParameter = {
    ...record,
    operationId: 'progress_session.changes',
    path: '/v1/progressSessions/:progressId/changes',
    action: 'progress_session:read',
    contracts: { response: 'library.progress-session.changes.response' },
  };
  expect(() => createOperationCatalogue([record, changedParameter])).toThrow(
    /inconsistent path parameter name at position/,
  );
});
