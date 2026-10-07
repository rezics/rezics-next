import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  SafetyDecisionMail,
  SafetyNoticeContinuation,
  type SafetyNoticeMail,
} from '../src/modules/governance/notices-mail.ts';
import { graphNoticeParticipants } from '../src/modules/governance/effects.ts';
import { unrecordedReasons } from '../src/modules/governance/notices.ts';

const decision = '00000000-0000-4000-8000-000000000001';
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function mailbox(legacy = false, privateReasons = true, deliverable = true) {
  let cursor = {
    phase: 'parties',
    after_party: null as string | null,
    after_report_at: null as string | null,
    after_report: null as string | null,
  };
  const receipts = new Set<string>();
  const statements: string[] = [];
  const parties = [2, 3, 4].map((i) => ({
    id: uid(i),
    principal_id: uid(i),
    credential: 'a'.repeat(43),
    account_subject: `user-${i}`,
    deliverable,
  }));
  const reports = [5, 6, 7].map((i) => ({
    id: uid(i),
    received_at: '2026-10-01 00:00:00.123456+00',
    contact_email: `reporter-${i}@example.test`,
    account_subject: null,
    content_language: 'ja',
    deliverable,
  }));
  let rollback: { cursor: typeof cursor; receipts: string[] };
  const client = {
    release: () => {},
    query: async (sql: string, args: unknown[] = []) => {
      statements.push(sql);
      if (sql === 'BEGIN') rollback = { cursor: { ...cursor }, receipts: [...receipts] };
      if (sql === 'ROLLBACK') {
        cursor = rollback.cursor;
        receipts.clear();
        for (const id of rollback.receipts) receipts.add(id);
      }
      if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
      if (sql.includes('FROM access.moderation_decision d'))
        return {
          rows: [
            {
              case_id: decision,
              outcome: 'restrict',
              disclosure: privateReasons ? 'private' : 'parties',
              statement_of_reasons: legacy
                ? null
                : { ...unrecordedReasons, facts: 'Private facts.' },
            },
          ],
        };
      if (sql.includes('SELECT phase,after_party')) return { rows: [{ ...cursor }] };
      if (sql.includes('SELECT ordinal,target') || sql.includes('FROM access.safety_notice_job'))
        return { rows: [] };
      if (sql.includes('SELECT n.id'))
        return {
          rows: parties
            .filter((p) => !args[2] || p.principal_id > String(args[2]))
            .slice(0, Number(args[3])),
        };
      if (sql.includes('SELECT r.id,r.received_at')) {
        if (args[2]) expect(args[2]).toBe('2026-10-01 00:00:00.123456+00');
        return {
          rows: reports.filter((r) => !args[3] || r.id > String(args[3])).slice(0, Number(args[5])),
        };
      }
      if (sql.includes('SELECT 1 FROM access.safety_notice_mail_receipt'))
        return { rowCount: receipts.has(String(args[0])) ? 1 : 0, rows: [] };
      if (sql.includes('INSERT INTO access.safety_notice_mail_receipt'))
        receipts.add(String(args[0]));
      if (sql.includes('SET after_party')) {
        cursor.after_party = args[1] as string | null;
        cursor.phase = String(args[2]);
      }
      if (sql.includes('SET after_report_at')) {
        cursor.after_report_at = args[1] as string | null;
        cursor.after_report = args[2] as string | null;
        cursor.phase = String(args[3]);
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, receipts };
}

test('mail commits one recipient page and stable receipts across restart and lost intake acknowledgement', async () => {
  const f = mailbox();
  const accepted = new Map<string, SafetyNoticeMail>();
  let loseAck = true;
  const intake = async (mail: SafetyNoticeMail) => {
    const existing = accepted.get(mail.deliveryId);
    if (existing) expect(mail).toEqual(existing);
    accepted.set(mail.deliveryId, mail);
    if (loseAck) {
      loseAck = false;
      throw new Error('lost acknowledgement');
    }
  };
  await expect(
    new SafetyDecisionMail(f.pool, 'issuer', intake, undefined, 2).enqueuePage(decision),
  ).rejects.toThrow('lost acknowledgement');
  expect(accepted.size).toBe(1);
  expect(f.receipts.size).toBe(0);
  let complete = false;
  for (let step = 0; step < 6 && !complete; step++) {
    const before = accepted.size;
    complete = await new SafetyDecisionMail(f.pool, 'issuer', intake, undefined, 2).enqueuePage(
      decision,
    );
    expect(accepted.size - before).toBeLessThanOrEqual(2);
  }
  expect(complete).toBe(true);
  expect(accepted.size).toBe(6);
  expect(f.receipts.size).toBe(6);
  await new SafetyDecisionMail(
    f.pool,
    'issuer',
    async () => {
      throw new Error('duplicate intake');
    },
    undefined,
    2,
  ).enqueueDecision(decision);
  expect(
    [...accepted.values()]
      .filter((m) => 'userId' in m.recipient)
      .every((m) => m.credential && m.reasons?.facts === 'Private facts.'),
  ).toBe(true);
  expect(
    [...accepted.values()]
      .filter((m) => 'contactEmail' in m.recipient)
      .every((m) => !m.credential && !m.reasons && m.contentLanguage === 'ja'),
  ).toBe(true);
  expect(f.statements.filter((sql) => sql.includes('SELECT r.id,r.received_at'))).toHaveLength(2);
});

test('legacy reasons are explicit and incomplete pages retain the producer event', async () => {
  const f = mailbox(true, false);
  const sent: SafetyNoticeMail[] = [];
  const source = new SafetyDecisionMail(
    f.pool,
    'issuer',
    async (mail) => {
      sent.push(mail);
    },
    undefined,
    2,
  );
  await expect(source.enqueueDecision(decision)).rejects.toBeInstanceOf(SafetyNoticeContinuation);
  expect(sent).toHaveLength(2);
  expect(sent.every((mail) => mail.reasons?.facts === 'Reason not recorded.')).toBe(true);
  while (!(await source.enqueuePage(decision))) {
    /* Explicit worker invocations. */
  }
  expect(sent).toHaveLength(6);
  expect(sent.every((mail) => mail.reasons?.facts === 'Reason not recorded.')).toBe(true);
});

test('affected graph Agents use a keyset across all authors and owners without Account identities', async () => {
  let query = '';
  const resolver = graphNoticeParticipants({
    fuseki: {
      query: async (sql: string) => {
        query = sql;
        return { results: { bindings: [{ author: { value: 'urn:second-author' } }] } };
      },
    },
  } as never);
  const rows = await resolver.participants!(
    { owner: 'graph', resource: 'urn:rezics:work' } as never,
    'urn:first-author',
    1,
  );
  expect(rows).toEqual(['urn:second-author']);
  expect(query).toContain('rv:NativeAgentCredit');
  expect(query).toContain('rv:owner');
  expect(query).toContain('FILTER(STR(?author) > "urn:first-author")');
  expect(query).toContain('ORDER BY STR(?author) LIMIT 1');
  expect(query).not.toContain('account_subject');
});

test('unreachable parties and reporters consume raw pages without scanning ahead for deliverable recipients', async () => {
  const f = mailbox(false, true, false);
  let submitted = 0;
  const source = new SafetyDecisionMail(
    f.pool,
    'issuer',
    async () => {
      submitted++;
    },
    undefined,
    2,
  );
  expect(await source.enqueuePage(decision)).toBe(false);
  expect(submitted).toBe(0);
  let done = false;
  for (let step = 0; step < 4 && !done; step++) done = await source.enqueuePage(decision);
  expect(done).toBe(true);
  expect(submitted).toBe(0);
  const reads = f.statements.filter((sql) => sql.includes('WITH page AS MATERIALIZED'));
  expect(reads).toHaveLength(4);
  expect(reads.every((sql) => sql.indexOf('LIMIT') < sql.indexOf('AS deliverable'))).toBe(true);
});
