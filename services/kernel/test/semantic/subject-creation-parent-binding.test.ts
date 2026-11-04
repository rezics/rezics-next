import { expect, test } from 'bun:test';
import { compileViewerActionBindings } from '../../src/access/viewer-actions.ts';
import type { MountedRoute } from '../../src/http/request.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const subjectCreateDetail = {
  operationId: 'subject.create',
  'x-exposure': 'public',
  'x-action': 'subject:create',
  'x-resource-types': ['semantic.subject', 'semantic.revision'],
  'x-authority-resource-types': ['semantic.context'],
  'x-authority-resource-id': GLOBAL_CONTEXT,
};

test('subject.create viewer binding is the seeded Global Context parent, not a created subject', () => {
  const bindings = compileViewerActionBindings([
    { method: 'POST', path: '/v1/subjects', hooks: { detail: subjectCreateDetail } } as MountedRoute,
  ]);
  expect(bindings.get('semantic.context')).toEqual([
    {
      action: 'subject:create',
      operationId: 'subject.create',
      exposure: { kind: 'public' },
      authority: 'resource',
      fixedResourceId: GLOBAL_CONTEXT,
    },
  ]);
  expect(bindings.get('semantic.subject')).toBeUndefined();
  expect(bindings.get('semantic.revision')).toBeUndefined();
});
