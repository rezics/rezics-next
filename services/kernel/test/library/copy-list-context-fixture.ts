import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { cookies, password } from '../access/native-account-bindings-fixture.ts';
import type { GrowthDatabase } from '../support/growth.ts';
import { createCollectionListFactsFixture } from './support/collection-list-facts-fixture.ts';

export const copyListScopes = ['subject:read', 'copy:create', 'copy:list', 'copy:update', 'copy:delete'];

export async function createCopyListContextFixture(options: { db?: GrowthDatabase } = {}) {
  const native = await createCollectionListFactsFixture(options);
  try {
    await native.checked('POST', '/v1/platform/exposure/personal_library:open', {}, 'operator');
    const editor = await native.deps('editor');
    if (editor.actor.kind !== 'account') throw new Error('Copy context fixture requires an account editor');

    async function credential(account: 'editor' | 'reader') {
      const signed = await native.auth.request('/signin', {
        account_id: native.accounts[account],
        password,
        client_id: editor.actor.kind === 'account' ? editor.actor.clientId : '',
        scope: copyListScopes,
      });
      expect(signed.status).toBe(200);
      const token = await native.auth.request('/token', {}, cookies(signed));
      expect(token.status).toBe(200);
      return ((await token.json()) as { access_token: string }).access_token;
    }

    const ownerToken = await credential('editor');
    const otherToken = await credential('reader');
    async function send(token: string | null, method: string, path: string, body?: unknown) {
      return native.kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    async function copy(token: string, subjectId: string, note: string) {
      const response = await send(token, 'POST', '/v1/copies', {
        subjectId,
        kind: 'physical',
        status: 'owned',
        acquiredOn: '2019-06-01',
        note,
      });
      expect([201], `POST /v1/copies: ${response.status} ${await response.clone().text()}`).toContain(response.status);
      return (await response.json()).copy as {
        id: string;
        subjectId: string;
        kind: string;
        status: string;
        revision: number;
        acquiredOn: string;
        note: string;
      };
    }
    async function page(token: string | null, view = 'FULL', limit = 100) {
      return send(token, 'GET', `/v1/copies?limit=${limit}&view=${view}`);
    }
    async function suspend(accountId: string) {
      const operator = await native.deps('operator');
      if (operator.actor.kind !== 'account') throw new Error('Copy context fixture requires an account operator');
      await createSuspensionCommands({ pool: native.pool, access: native.access }).suspend(
        { pool: native.pool, actor: operator.actor, deadline: deadlineFor(30_000) },
        { accountId, key: randomUUID() },
      );
    }
    return { ...native, ownerToken, otherToken, send, copy, page, suspend };
  } catch (error) {
    await native.close();
    throw error;
  }
}
