import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDeletionFixture } from './support/deletion-fixture.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const f = await createDeletionFixture();
beforeAll(f.setup);
afterAll(f.close);

function correctionOperations(body: Record<string, unknown>): string[] {
  const component = body.viewerActions as
    | { state?: string; actions?: { action: string; operations: string[] }[] }
    | undefined;
  expect(component?.state).toBe('available');
  return (component?.actions ?? [])
    .filter((entry) => entry.action === 'statement:propose')
    .flatMap((entry) => entry.operations);
}

test('current correction actions use mounted subject and terms operations and current Global Access', async () => {
  const subject = await f.person();
  const path = `/v1/subjects/${subject}?includeViewerActions=true`;
  const permitted = await f.call('GET', path, 'owner');
  f.status(permitted, 200);
  expect(correctionOperations(permitted.body)).toEqual(
    expect.arrayContaining(['subject.propose', 'subject.terms']),
  );

  const grant = {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: f.accounts.owner },
    actions: ['statement:propose'],
    valid: '(,)',
  };
  f.status(await f.call('POST', '/v1/grants:revoke', 'platform', grant), 200);
  try {
    const denied = await f.call('GET', path, 'owner');
    f.status(denied, 200);
    expect(correctionOperations(denied.body)).not.toContain('subject.propose');
    expect(correctionOperations(denied.body)).not.toContain('subject.terms');
    expect(denied.body.subject.id).toBe(subject);
  } finally {
    f.status(await f.call('POST', '/v1/grants', 'platform', grant), 201);
  }
});
