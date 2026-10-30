import { afterAll, expect, test } from 'bun:test';
import { t } from 'elysia';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { bodyWireBytes } from '../../src/http/body.ts';
import { ProblemError } from '../../src/http/problem.ts';

// These transport cases must never connect to a database.
const pool = createPool('postgres://kernel.invalid/bodyless-json');
afterAll(() => pool.end());
const detail = {
  operationId: 'probe.bodyless',
  'x-action': 'probe:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};

test('an absent JSON body reaches optional and bodyless routes without default-parser fallback', async () => {
  const handler = ({ body, request }: { body: unknown; request: Request }) => {
    expect(body).toBeUndefined();
    expect(bodyWireBytes(request)).toBe(0);
    return { accepted: true };
  };
  const app = createApp({ pool })
    .put('/optional', { body: t.Optional(t.Never()), detail }, handler)
    .delete('/bodyless', { detail }, handler);
  for (const [method, path] of [
    ['PUT', '/optional'],
    ['DELETE', '/bodyless'],
  ]) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
  }
});

test('absence does not satisfy a required body or admit a present body to an optional never schema', async () => {
  const app = createApp({ pool })
    .post('/required', { body: t.Object({ value: t.String() }), detail }, () => 'unexpected')
    .put('/optional', { body: t.Optional(t.Never()), detail }, () => 'unexpected');
  for (const [method, path, body] of [
    ['POST', '/required', undefined],
    ['PUT', '/optional', '{}'],
    ['PUT', '/optional', 'null'],
    ['PUT', '/optional', ''],
  ]) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  }
});

test('trusted own-account declarations retain credential refusals before domain-state refusals', async () => {
  let scopes: string[] = [];
  const app = createApp({
    pool,
    access: {
      async authenticate() {
        return {
          kind: 'account',
          accountId: '019a1b2c-3d4e-7000-8000-000000000001',
          clientId: 'bodyless-json',
          requestedBy: null,
          authnEpoch: 1,
          scopes,
        };
      },
      async authorize() {
        throw new Error('The domain command owns the permission formula');
      },
    },
  }).delete(
    '/personal',
    {
      detail: {
        ...detail,
        security: [{ bearerAuth: [] }],
        'x-authority-anchor': 'own-account',
      },
    },
    () => {
      throw new ProblemError('conflict');
    },
  );
  for (const [credential, allowedScopes, status, code] of [
    [null, [], 401, 'authentication_required'],
    ['Bearer verified', [], 403, 'forbidden'],
    ['Bearer verified', ['probe:read'], 409, 'conflict'],
  ] as const) {
    scopes = [...allowedScopes];
    const response = await app.handle(
      new Request('http://kernel.test/personal', {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          ...(credential === null ? {} : { authorization: credential }),
        },
      }),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
});
