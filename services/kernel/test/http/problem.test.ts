import { expect, test } from 'bun:test';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { RealmLastOwnerError } from '../../src/access/realm-ownership.ts';
import { ResourceAccessWriteDeniedError } from '../../src/access/resource-denials.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { ProblemError, problemResponse, problemSchema } from '../../src/http/problem.ts';

test('RealmLastOwnerError has an exact evidence-free nonretryable409 response and schema', async () => {
  const error = Object.assign(new RealmLastOwnerError(), {
    message: 'private holder evidence',
    owner: 'private account',
    code: 'forbidden',
  });
  const response = problemResponse(error, { method: 'POST', id: 'realm-leave' });
  const body = await response.json();
  expect(response.status).toBe(409);
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  expect(response.headers.has('retry-after')).toBe(false);
  expect(body).toEqual({
    type: 'https://rezics.com/problems/realm_last_owner',
    title: 'Realm Ownership Transfer Required',
    status: 409,
    code: 'realm_last_owner',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'realm-leave',
  });
  const schema = problemSchema('realm_last_owner');
  expect(Value.Check(schema, body)).toBe(true);
  for (const field of ['detail', 'owner', 'role', 'account', 'member', 'grant', 'errors'])
    expect(Value.Check(schema, { ...body, [field]: 'private' })).toBe(false);
  expect(Value.Check(schema, { ...body, effect_status: 'not_applicable' })).toBe(false);
  expect(Value.Check(problemSchema('realm_last_owner', { owner: t.String() }), { ...body, owner: 'private' })).toBe(
    false,
  );
});

test('annotation correction limit keeps its published nonretryable conflict title', async () => {
  const response = problemResponse(new ProblemError('library_entry_annotation_correction_limit'), {
    method: 'PATCH',
    id: 'entry-annotation',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    title: 'Library Entry Annotation Correction Limit Reached',
    code: 'library_entry_annotation_correction_limit',
    retryable: false,
  });
});

test('last-owner mapping cannot acquire evidence or a read effect status from problem options', async () => {
  const response = problemResponse(
    new ProblemError('realm_last_owner', {
      detail: 'private',
      extensions: { owner: 'private' },
      effectStatus: 'not_applicable',
      errors: [{ pointer: '/owner', code: 'required' }],
    }),
    { method: 'GET', action: 'realm:read', id: 'fixed' },
  );
  expect(await response.json()).toEqual({
    type: 'https://rezics.com/problems/realm_last_owner',
    title: 'Realm Ownership Transfer Required',
    status: 409,
    code: 'realm_last_owner',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'fixed',
  });
});

test('generic errors and unavailability never acquire the last-owner discriminator from a name or code', async () => {
  for (const error of [
    new ResourceAccessWriteDeniedError(),
    Object.assign(new Error('private'), { name: 'RealmLastOwnerError', code: 'realm_last_owner' }),
    new AccessUnavailableError('overloaded'),
  ]) {
    const response = problemResponse(error, { method: 'POST', id: 'generic' });
    const body = await response.json();
    expect(body.code).toBe(error instanceof AccessUnavailableError ? 'overloaded' : 'internal_error');
    expect(body.effect_status).toBe('not_applied');
    expect(body).not.toHaveProperty('detail');
  }
});
