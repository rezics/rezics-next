import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../kernel/src/route/route.ts';
import { passkeyFixture } from './passkeys.test.ts';

test('every own-human credential change and approval reads auth_time from the session and refuses stale authentication without changes', async () => {
  const f = await passkeyFixture();
  try {
    const person = await f.person();
    const cookie = await f.login(person);
    const registered = await f.register(cookie);
    const staged = [];
    for (const credential of [
      { kind: 'password', password: 'replacement password long enough' },
      { kind: 'password', password: null },
      { kind: 'passkey', id: registered.passkey.id, remove: true },
    ]) {
      const response = await f.request(
        '/credential-effects/stage',
        { key: randomUUID(), subjectId: person, credential },
        cookie,
      );
      expect(response.status).toBe(200);
      staged.push(await response.json());
    }
    await f.pool.query('UPDATE session SET "authTime"=$2 WHERE "userId"=$1', [
      person,
      Math.floor(Date.now() / 1000) - 601,
    ]);
    async function snapshot() {
      return {
        credential: (await f.pool.query('SELECT password FROM account WHERE "userId"=$1', [person])).rows,
        passkeys: (await f.pool.query('SELECT * FROM passkey WHERE "userId"=$1', [person])).rows,
        effects: (
          await f.pool.query('SELECT * FROM auth_effect_receipt WHERE account_id=$1 ORDER BY receipt_id', [person])
        ).rows,
        approvals: (await f.kernelPool.query('SELECT * FROM access.workflow_approval')).rows,
        floor: (
          await f.kernelPool.query('SELECT minimum_authn_epoch FROM access.account WHERE route=$1 AND account_id=$2', [
            routeOf(person),
            person,
          ])
        ).rows,
      };
    }
    const before = await snapshot();
    const attempts = [
      ...staged.map((body) => ['/credential-effects/approve', body] as const),
      [
        '/credential-effects/stage',
        {
          key: randomUUID(),
          subjectId: person,
          credential: { kind: 'password', password: 'new password long enough' },
        },
      ] as const,
      ['/passkeys/register/options', {}] as const,
      ['/passkeys/register', registered.body] as const,
      ['/passkeys/remove', { id: registered.passkey.id }] as const,
    ];
    for (const [path, body] of attempts) {
      const response = await f.request(path, body, registered.cookie);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'step_up_required', effect_status: 'not_applied' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await snapshot()).toEqual(before);
    }
    // A freshly created session with an old auth_time still fails; the immutable
    // authentication event, rather than session creation/update time, governs.
    await f.pool.query('UPDATE session SET "authTime"=$2 WHERE "userId"=$1', [
      person,
      Math.floor(Date.now() / 1000) - 599,
    ]);
    const approved = await f.request('/credential-effects/approve', staged[0], cookie);
    expect(approved.status).toBe(200);
  } finally {
    await f.close();
  }
}, 60000);
