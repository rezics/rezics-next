import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomBytes } from 'node:crypto';
import { developmentEnv } from '../scripts/database.ts';
import { newId } from '../src/route/route.ts';
import { ConfigError, readConfig, startServer } from '../src/server.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const key = (bytes = 32) => randomBytes(bytes).toString('base64url');
const routeKey = key();
const current = key();
const previous = key(48);
const env = {
  DATABASE_URL: databaseUrl,
  KERNEL_ROUTE_KEY: routeKey,
  KERNEL_SESSION_KEYS: `7:${current},3:${previous}`,
};
const parse = (text: string) =>
  Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );

function refusal(variable: string, value: string | undefined) {
  const changed = { ...env, [variable]: value };
  if (value === undefined) delete changed[variable as keyof typeof env];
  let error: unknown;
  try {
    readConfig(changed);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(variable);
  if (value) expect((error as Error).message).not.toContain(value);
}

test('the server reads its configuration from the environment and names, never echoes, what is wrong', () => {
  const config = readConfig(env);
  expect(config).toMatchObject({ databaseUrl, hostname: '127.0.0.1', port: 4100 });
  expect(Buffer.from(config.routeKey).toString('base64url')).toBe(routeKey);
  expect(config.tokens.current).toBe(7);
  expect([...config.tokens.keys.keys()]).toEqual([7, 3]);
  expect(Buffer.from(config.tokens.keys.get(3)!).toString('base64url')).toBe(previous);
  expect(readConfig({ ...env, KERNEL_HOSTNAME: '0.0.0.0', KERNEL_PORT: '0' })).toMatchObject({
    hostname: '0.0.0.0',
    port: 0,
  });

  refusal('DATABASE_URL', undefined);
  refusal('KERNEL_ROUTE_KEY', undefined);
  refusal('KERNEL_ROUTE_KEY', key(31));
  refusal('KERNEL_ROUTE_KEY', `${routeKey}=`);
  refusal('KERNEL_SESSION_KEYS', undefined);
  refusal('KERNEL_SESSION_KEYS', `1:${key(31)}`);
  refusal('KERNEL_SESSION_KEYS', `1:${current},1:${previous}`);
  refusal('KERNEL_SESSION_KEYS', `256:${current}`);
  refusal('KERNEL_SESSION_KEYS', `one:${current}`);
  refusal('KERNEL_SESSION_KEYS', `1:${current},`);
  refusal('KERNEL_PORT', '65536');
  refusal('KERNEL_PORT', '80a');
});

test('a started server answers health and the subject routes over HTTP, then stops', async () => {
  const server = await startServer(readConfig({ ...env, KERNEL_PORT: '0' }));
  const origin = server.url.href.replace(/\/$/, '');
  try {
    expect(server.url.hostname).toBe('127.0.0.1');
    expect(DBOS.isInitialized()).toBe(false);
    const health = await fetch(`${origin}/health`);
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
    const missing = await fetch(`${origin}/v1/subjects/${newId(0x0042)}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/problem+json');
    const anonymous = await fetch(`${origin}/v1/subjects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': '"k-1"' },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Kokoro' } }),
    });
    expect(anonymous.status).toBe(401);
  } finally {
    await server.stop();
  }
  await expect(fetch(`${origin}/health`)).rejects.toThrow();
});

test('a server with a missing Turnstile secret serves public reads while reports fail closed', async () => {
  const server = await startServer(readConfig({ ...env, KERNEL_PORT: '0' }));
  const origin = server.url.href.replace(/\/$/, '');
  try {
    const publicRead = await fetch(`${origin}/v1/subjects/${newId(0x0042)}`);
    expect(publicRead.status).toBe(404);
    const report = await fetch(`${origin}/v1/reports`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({
        target: { kind: 'board', id: newId(0x0042) },
        reason: 'spam',
        botToken: 'cannot-pass-without-a-provider-secret',
      }),
    });
    expect(report.status).toBe(404);
  } finally {
    await server.stop();
  }
});

test('db up writes development secrets once and keeps them across restarts', () => {
  const first = developmentEnv('', 'postgres://rezics:rezics@127.0.0.1:54329/rezics');
  const values = parse(first);
  expect(Object.keys(values).sort()).toEqual(['DATABASE_URL', 'KERNEL_ROUTE_KEY', 'KERNEL_SESSION_KEYS']);
  expect(readConfig(values).databaseUrl).toBe('postgres://rezics:rezics@127.0.0.1:54329/rezics');
  expect(developmentEnv('', values.DATABASE_URL!)).not.toBe(first);

  const edited = `${first}KERNEL_PORT=4200\n`;
  const again = parse(developmentEnv(edited, 'postgres://rezics:rezics@127.0.0.1:54330/rezics'));
  expect(again).toEqual({
    ...values,
    DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:54330/rezics',
    KERNEL_PORT: '4200',
  });
});
