import { expect, test } from 'bun:test';
import {
  createGovernanceOutputRedactor,
  redactGovernanceOutput,
  verifyPlatformGovernance,
} from '../bootstrap/platform-grant.ts';

const database = 'postgres://operator:real-db-secret@db.internal/access';
const postgresDatabase = 'PostgreSQL://operator:real-db-secret@db.internal/access';
const token = 'real-bearer-token';

test('a database URL directly after an ANSI sequence is redacted', () => {
  const text = redactGovernanceOutput(`\x1b[31m${database} ${postgresDatabase}`);
  expect(text).toBe('\x1b[31m[database] [database]');
  expect(text).not.toContain('real-db-secret');
});

test('a database URL inside an ANSI color span is redacted', () => {
  const text = redactGovernanceOutput(`\x1b[31m${database}\x1b[0m`);
  expect(text).toBe('\x1b[31m[database]\x1b[0m');
  expect(text).not.toContain('real-db-secret');
});

test('a database URL immediately before an ANSI sequence keeps the sequence and the following text', () => {
  const text = redactGovernanceOutput(`${database}\x1b[0mnear-miss-value`);
  expect(text).toBe('[database]\x1b[0mnear-miss-value');
  expect(text).not.toContain('real-db-secret');
});

test('a bearer token directly after an ANSI sequence is redacted', () => {
  const text = redactGovernanceOutput(`\x1b[31mBearer ${token}`);
  expect(text).toBe('\x1b[31mBearer [token]');
  expect(text).not.toContain(token);
});

test('a bearer token inside an ANSI color span is redacted', () => {
  const text = redactGovernanceOutput(`\x1b[31mbEARER ${token}\x1b[0m`);
  expect(text).toBe('\x1b[31mBearer [token]\x1b[0m');
  expect(text).not.toContain(token);
});

test('a bearer token immediately before an ANSI sequence keeps the sequence and the following text', () => {
  const text = redactGovernanceOutput(`Bearer ${token}\x1b[0mkept-word`);
  expect(text).toBe('Bearer [token]\x1b[0mkept-word');
  expect(text).not.toContain(token);
});

test('a database URL split across chunks is redacted', () => {
  const redactor = createGovernanceOutputRedactor();
  const head = redactor.push('connect \x1b[31mpost');
  const tail = redactor.push('gres://operator:real-db-secret@db.internal/access failed');
  const rest = redactor.finish();
  expect(head).toBe('connect \x1b[31m');
  for (const part of [head, tail, rest]) expect(part).not.toContain('real-db-secret');
  expect(head + tail + rest).toBe('connect \x1b[31m[database] failed');
});

test('a bearer token split across chunks is redacted', () => {
  const redactor = createGovernanceOutputRedactor();
  const head = redactor.push('see \x1b[3');
  const middle = redactor.push('1mBea');
  const tail = redactor.push(`rer ${token}\x1b[0mkept-word`);
  const rest = redactor.finish();
  for (const part of [head, middle, tail, rest]) expect(part).not.toContain(token);
  expect(head + middle + tail + rest).toBe('see \x1b[31mBearer [token]\x1b[0mkept-word');
});

test('a database value split before a following color sequence keeps that sequence', () => {
  const redactor = createGovernanceOutputRedactor();
  const head = redactor.push('postgres://operator:real-db-');
  const tail = redactor.push('secret@db.internal/access\x1b[0mnear-miss-value');
  const rest = redactor.finish();
  for (const part of [head, tail, rest]) expect(part).not.toContain('real-db-secret');
  expect(head + tail + rest).toBe('[database]\x1b[0mnear-miss-value');
});

test('a near-miss beside a colored secret stays', () => {
  const text = redactGovernanceOutput(
    [
      'notpostgres://operator:near-db-secret@db.internal/access',
      'Bearers near-bearer-token',
      'xBearer near-bearer-token',
      `${database}\x1b[0mnear-miss-value`,
      `Bearer ${token}\x1b[0mkept-word`,
    ].join(' '),
  );
  expect(text).toBe(
    [
      'notpostgres://operator:near-db-secret@db.internal/access',
      'Bearers near-bearer-token',
      'xBearer near-bearer-token',
      '[database]\x1b[0mnear-miss-value',
      'Bearer [token]\x1b[0mkept-word',
    ].join(' '),
  );
  expect(text).not.toContain('real-db-secret');
  expect(text).not.toContain(token);
});

test('platform governance failure redacts colored secrets from both streams', async () => {
  let message = '';
  try {
    await verifyPlatformGovernance('.temp/production.env', async () => ({
      code: 1,
      stderr: `\x1b[31m${database}\x1b[0m`,
      stdout: `Bearer ${token}\x1b[0mkept-word`,
    }));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('Platform governance verification failed');
  expect(message).toContain('\x1b[31m[database]\x1b[0m');
  expect(message).toContain('Bearer [token]\x1b[0mkept-word');
  expect(message).not.toContain('real-db-secret');
  expect(message).not.toContain(token);
  expect(message.length).toBeLessThanOrEqual('Platform governance verification failed: '.length + 400);
});

test('platform governance failure stays bounded when the secret sits in a long stream', async () => {
  let message = '';
  try {
    await verifyPlatformGovernance('.temp/production.env', async () => ({
      code: 2,
      stderr: `\x1b[31m${database} Bearer ${token} ${'word '.repeat(300)}`,
      stdout: '',
    }));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message.startsWith('Platform governance verification failed: ')).toBe(true);
  expect(message.length).toBeLessThanOrEqual('Platform governance verification failed: '.length + 400);
  expect(message).toContain('[database]');
  expect(message).toContain('Bearer [token]');
  expect(message).not.toContain('real-db-secret');
  expect(message).not.toContain(token);
});
