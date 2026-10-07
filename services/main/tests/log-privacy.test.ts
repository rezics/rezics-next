import { expect, test } from 'bun:test';
import { logLineCarriesPersonalData, logWorkerFault, telemetryLog } from '@rezics/observability/log';

const email = 'reader@example.com';
const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const sql = `Key (agent)=(${agent})`;

function capture(write: () => void): string[] {
  const lines: string[] = [];
  const previous = { error: console.error, warn: console.warn, info: console.info };
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.error = take;
  console.warn = take;
  console.info = take;
  try { write(); }
  finally {
    console.error = previous.error;
    console.warn = previous.warn;
    console.info = previous.info;
  }
  return lines;
}

test('the sentinel rejects an email, a person or Agent IRI, and a raw SQL value', () => {
  expect(logLineCarriesPersonalData(`failed for ${email}`)).toBe(true);
  expect(logLineCarriesPersonalData(`agent ${agent}`)).toBe(true);
  expect(logLineCarriesPersonalData(`urn:rezics:agent:${agent}`)).toBe(true);
  expect(logLineCarriesPersonalData(sql)).toBe(true);
  expect(logLineCarriesPersonalData("VALUES ('hidden')")).toBe(true);
  expect(logLineCarriesPersonalData("= 'hidden'")).toBe(true);
  expect(logLineCarriesPersonalData(JSON.stringify({
    level: 'error', event: 'worker_fault', 'error.class': 'DatabaseError', 'error.code': '23505',
  }))).toBe(false);
});

test('operational log lines carry no email, person or Agent IRI, or raw SQL value', () => {
  class DatabaseError extends Error {
    constructor(message: string, readonly code: string, readonly detail: string) { super(message); }
  }
  const lines = capture(() => {
    logWorkerFault('main.library.backfill', new DatabaseError(
      `duplicate ${email} ${agent}`, '23505', sql,
    ));
    telemetryLog('library_backfill', 'info', {
      'rezics.backfill.examined': 2,
      'rezics.backfill.skipped': 0,
      'rezics.backfill.duration_ms': 8,
      agent,
      message: email,
      query: `SELECT agent FROM reader.library_status WHERE agent = '${agent}'`,
    });
    telemetryLog('worker_fault', 'error', {
      operation_id: email,
      causation_id: agent,
      'error.class': 'DatabaseError',
      'error.code': '23505',
    });
  });
  expect(lines.length).toBe(3);
  for (const line of lines) expect(logLineCarriesPersonalData(line)).toBe(false);
});
