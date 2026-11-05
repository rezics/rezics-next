import { afterAll, expect, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accessEvidenceDeadline, ACCESS_EVIDENCE_TTL_MS } from '../../src/access/evidence-deadline.ts';
import { runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { deadlineFor, withRequestDeadline } from '../../src/request/deadline.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

const accessDirectory = resolve(import.meta.dir, '../../src/access');
const source = (name: string) => readFileSync(resolve(accessDirectory, name), 'utf8');

test('Access-owned deadline sites do not add inline budgets to Date.now', () => {
  const files = readdirSync(accessDirectory).filter((file) => file.endsWith('.ts'));
  const inlineBudgets = files
    // This credential capability is being converted by its parallel owner.
    .filter((file) => file !== 'auth-credential-capability.ts')
    .filter((file) => /Date\.now\(\)\s*\+\s*(?:\d[\d_]*|[A-Z][A-Z0-9_]*)/.test(source(file)));
  expect(inlineBudgets).toEqual([]);
});

test('request and Auth trust-port deadlines use the caller deadline', async () => {
  const detail = {
    operationId: 'access.deadline.probe',
    'x-action': 'deadline:read',
    'x-exposure': 'public',
    security: [{ bearerAuth: [] }, {}],
  };
  const app = createApp({ pool, requestDeadlineMs: 100 }).get('/deadline', { detail }, () => ({
    deadline: deadlineFor(60_000),
  }));
  const before = Date.now();
  const response = await app.handle(new Request('http://kernel.test/deadline'));
  const requestDeadline = ((await response.json()) as { deadline: number }).deadline;
  expect(response.status).toBe(200);
  expect(requestDeadline).toBeGreaterThanOrEqual(before + 100);
  expect(requestDeadline).toBeLessThan(before + 60_000);

  const callerDeadline = Date.now() + 200;
  await withRequestDeadline(callerDeadline, async () => {
    expect(deadlineFor(3_000)).toBe(callerDeadline);
  });
  expect(source('auth-barriers.ts')).toContain('deadlineFor(AUTH_BARRIER_BUDGET_MS)');
  expect(source('auth-session-capability.ts')).toContain('deadlineFor(AUTH_SESSION_BUDGET_MS)');
  expect(source('native-account-bindings.ts')).toContain('deadlineFor(COMMITTED_CONTINUATION_RESUME_BUDGET_MS)');
});

test('background work uses its named job deadline settings', () => {
  expect(source('membership-work.ts')).toContain('deadlineFor(MEMBERSHIP_WORK_DEADLINE_MS)');
  expect(source('membership-work-config.ts')).toContain('MEMBERSHIP_WORK_DEADLINE_MS = 30_000');
  expect(source('committed-continuations.ts')).toContain('deadlineFor(COMMITTED_CONTINUATION_RESUME_BUDGET_MS)');
  expect(source('bootstrap-governance.ts')).toContain('deadlineFor(BOOTSTRAP_GOVERNANCE_DEADLINE_MS)');
  expect(source('bootstrap-governance.ts')).toContain('BOOTSTRAP_GOVERNANCE_DEADLINE_MS = 10_000');
});

test('evidence deadlines use the shared one-second real-time window and caller cap', () => {
  const now = spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    expect(ACCESS_EVIDENCE_TTL_MS).toBe(1_000);
    expect(accessEvidenceDeadline(1_500)).toBe(1_500);
    expect(accessEvidenceDeadline(3_000)).toBe(2_000);
  } finally {
    now.mockRestore();
  }
  expect(source('permission.ts')).toContain('accessEvidenceDeadline(context.deadline, ACCESS_EVIDENCE_TTL_MS)');
  expect(source('operator.ts')).toContain('accessEvidenceDeadline(deadlineFor(ACCESS_EVIDENCE_TTL_MS))');
  expect(source('durable-identity.ts')).toContain('accessEvidenceDeadline(context.deadline, ACCESS_EVIDENCE_TTL_MS)');
});

test('an expired command deadline returns 503 before applying its body', async () => {
  let applied = false;
  const detail = {
    operationId: 'access.deadline.expired-command',
    'x-action': 'deadline:write',
    'x-exposure': 'public',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
    security: [{ bearerAuth: [] }, {}],
  };
  const app = createApp({ pool, writeRate: { spend: async () => ({ allowed: true }) } }).post(
    '/expired',
    { detail },
    async () => {
      await runCommand(pool, { partition: 0, deadline: Date.now() - 1 }, async () => {
        applied = true;
        return { value: true, events: [] };
      });
      return { ok: true };
    },
  );
  const response = await app.handle(new Request('http://kernel.test/expired', { method: 'POST' }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'deadline_exceeded', effect_status: 'not_applied' });
  expect(applied).toBe(false);
});
