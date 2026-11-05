import { afterAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessUnavailableError } from '../../src/request/unavailable.ts';
import { CommandUnavailableError, runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { PROBLEMS, PROBLEM_TYPE_BASE } from '../../src/http/problem.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

const failures = [
  ['57014', 'deadline', 'deadline_exceeded'],
  ['40001', 'contention', 'transaction_retry_exhausted'],
  ['40P01', 'contention', 'transaction_retry_exhausted'],
  ['55P03', 'contention', 'transaction_retry_exhausted'],
  ['53300', 'overloaded', 'overloaded'],
  ['pool connect timeout', 'overloaded', 'overloaded'],
] as const;

const detail = {
  operationId: 'probe.read',
  'x-action': 'probe:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};

for (const [name, reason, code] of failures) {
  test(`${name} has the same retryable HTTP response as runCommand`, async () => {
    const error =
      name === 'pool connect timeout'
        ? new Error('timeout exceeded when trying to connect')
        : Object.assign(new Error('database failure with private details'), { code: name });
    const seam = Object.create(pool) as Pool;
    seam.connect = (async () => {
      throw error;
    }) as Pool['connect'];
    const app = createApp({ pool })
      .get('/read', { detail }, () => {
        throw error;
      })
      .get('/command', { detail: { ...detail, operationId: 'probe.command' } }, async () => {
        try {
          await runCommand(seam, { partition: 0, deadline: Date.now() + 100 }, async () => {
            throw new Error('A failed checkout must never reach the command body');
          });
          throw new Error('Expected command unavailability');
        } catch (unavailable) {
          expect(unavailable).toBeInstanceOf(CommandUnavailableError);
          expect(unavailable).toMatchObject({ reason, partition: 0, movedTo: null });
          throw unavailable;
        }
      });

    for (const path of ['/read', '/command']) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(response.headers.get('retry-after')).toBe(reason === 'deadline' ? null : '1');
      const body = await response.json();
      expect(body).toEqual({
        type: `${PROBLEM_TYPE_BASE}${code}`,
        title: PROBLEMS[code].title,
        status: 503,
        code,
        retryable: true,
        effect_status: 'not_applicable',
        request_id: expect.any(String),
      });
    }
  });
}

for (const [reason, code] of [
  ['deadline', 'deadline_exceeded'],
  ['contention', 'transaction_retry_exhausted'],
  ['overloaded', 'overloaded'],
] as const) {
  test(`Access ${reason} keeps its retryable HTTP mapping`, async () => {
    const app = createApp({ pool }).get('/read', { detail }, () => {
      throw new AccessUnavailableError(reason);
    });
    const response = await app.handle(new Request('http://localhost/read'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code, retryable: true });
    expect(response.headers.get('retry-after')).toBe(reason === 'deadline' ? null : '1');
  });
}
