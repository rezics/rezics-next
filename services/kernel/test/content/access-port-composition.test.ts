import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { composeContentReading } from '../../src/composition/content.ts';
import { accessCheck, actorOf } from '../../src/content/access-port.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { AuthenticationError } from '../../src/access/contract/authentication.ts';
import { AuthenticationError as RequestAuthenticationError } from '../../src/request/authentication-error.ts';
import { AuthenticationError as CompatibilityAuthenticationError } from '../../src/request/access.ts';

// The composed helper must prepare the original opaque evidence, rather than rebuilding a boolean check.
test('native Content composition retains Access evidence and authentication failures', async () => {
  composeContentReading();
  const actor: Actor = { kind: 'anonymous' };
  const resource = { route: 0, id: '00000000-0000-4000-8000-000000000001' };
  const context = { pool: {} as Pool, deadline: 1234 };
  const evidence = Object.freeze({});
  const client = {} as Parameters<Access['authorize']>[0];
  const failure = new AuthenticationError(401, 'Bearer error="invalid_token"');
  const access: Access = {
    async authenticate() {
      throw failure;
    },
    async prepare(selectedActor, action, selectedResource, selectedContext) {
      expect(selectedActor).toBe(actor);
      expect(action).toBe('board:read');
      expect(selectedResource).toBe(resource);
      expect(selectedContext).toBe(context);
      return evidence;
    },
    async authorize(selectedClient, selectedActor, action, selectedResource, proof) {
      expect(selectedClient).toBe(client);
      expect(selectedActor).toBe(actor);
      expect(action).toBe('board:read');
      expect(selectedResource).toBe(resource);
      expect(proof).toBe(evidence);
      return false;
    },
  };
  const check = await accessCheck(access, actor, 'board:read', resource, context);
  expect(await check(client)).toBe(false);
  await expect(
    actorOf(access, new Request('https://rezics.test', { headers: { authorization: 'Bearer credential' } }), context),
  ).rejects.toBe(failure);
  expect(RequestAuthenticationError).toBe(AuthenticationError);
  expect(CompatibilityAuthenticationError).toBe(AuthenticationError);
  expect(failure).toBeInstanceOf(CompatibilityAuthenticationError);
});
