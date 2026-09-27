import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startMediaStack } from './media-support.ts';
import { READING_SETTINGS_COST, ReadingSettingsStore }
  from '../../../services/main/src/modules/reading-settings/store.ts';
import { readingSettingsRoutes } from '../../../services/main/src/routes/reading-settings.ts';

test('Reader settings: principal privacy, bounded values, stale writes and exact retries', async () => {
  const stack = await startMediaStack('reader-settings');
  try {
    const a = await stack.member('settings-a');
    const b = await stack.member('settings-b');
    let readStatements = 0;
    let writeStatements = 0;
    const countedPool = new Proxy(stack.contentPool, { get(pool, key) {
      if (key === 'query') return (...args: unknown[]) => {
        readStatements++;
        return Reflect.apply(pool.query, pool, args);
      };
      if (key === 'connect') return async () => new Proxy(await pool.connect(), { get(client, field) {
        if (field === 'query') return (...args: unknown[]) => {
          writeStatements++;
          return Reflect.apply(client.query, client, args);
        };
        const value = Reflect.get(client, field);
        return typeof value === 'function' ? value.bind(client) : value;
      } });
      const value = Reflect.get(pool, key);
      return typeof value === 'function' ? value.bind(pool) : value;
    } }) as Pool;
    const app = readingSettingsRoutes({ readingSettings: new ReadingSettingsStore(countedPool),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.slice(7);
        if (token === a.token) return { ...a.principal, emailVerified: true };
        if (token === b.token) return { ...b.principal, emailVerified: true };
        throw new Error('unknown bearer');
      } },
      access: { canReadAsBaselineMember: async (principal, actor) =>
        principal.subject === a.principal.subject && actor === a.actor
        || principal.subject === b.principal.subject && actor === b.actor } as never } as never);
    const call = (method: string, token: string, actor: string, body?: object, key?: string) =>
      app.handle(new Request(`http://main.local/v1/reader/settings${method === 'GET'
        ? `?actingSubject=${encodeURIComponent(actor)}` : ''}`, { method,
        headers: { authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key ?? randomUUID() } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const initial = await call('GET', a.token, a.actor);
    expect(initial.status).toBe(200);
    expect(initial.headers.get('cache-control')).toBe('private, no-store');
    expect(await initial.json()).toMatchObject({ profile: 'reader-settings-v1', fontSize: 17, version: 0 });
    expect(readStatements).toBe(READING_SETTINGS_COST.readStatements);
    const body = { actingSubject: a.actor, expectedVersion: 0, fontSize: 22, lineWidth: 'wide',
      typeface: 'sans', paragraphIndent: true, theme: 'dark', cjkSpacing: 'none',
      cjkPunctuation: 'strict' };
    const key = randomUUID();
    const saved = await call('PUT', a.token, a.actor, body, key);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ fontSize: 22, cjkPunctuation: 'strict', version: 1 });
    expect(writeStatements).toBeLessThanOrEqual(READING_SETTINGS_COST.writeStatements);
    expect((await call('GET', b.token, a.actor)).status).toBe(403);
    const other = await call('GET', b.token, b.actor);
    expect(await other.json()).toMatchObject({ fontSize: 17, version: 0 });
    expect((await call('PUT', a.token, a.actor, body, randomUUID())).status).toBe(409);
    const replay = await call('PUT', a.token, a.actor, body, key);
    expect(await replay.json()).toMatchObject({ fontSize: 22, version: 1, replayed: true });
    expect((await call('PUT', a.token, a.actor, { ...body, fontSize: 19 }, key)).status).toBe(409);
    expect((await call('PUT', a.token, a.actor, { ...body, fontSize: 99 }, randomUUID())).status).toBe(422);
  } finally { await stack.stop(); }
}, 180_000);
