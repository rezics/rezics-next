import { expect, test } from 'bun:test';
import { agentName, agentOptions, resolveSessionAgent } from '../features/auth/acting-identity.ts';
import { isSessionKey } from '../features/auth/cookies.ts';
import { messages } from '../features/auth/messages.ts';
import { decodeSessionRecord, encodeSessionRecord, isAgentIri, tokenSubject } from '../features/auth/session-state.ts';

const A = 'https://rezics.com/id/1e1489d5-6994-402c-99f2-50547eeaef4d';
const B = 'https://rezics.com/id/b8df6385-cec9-4fa0-8b89-71def5fa82b5';
const C = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const described = (actingSubject: string) => ({ actingSubject,
  displayName: actingSubject === A ? 'Ada Lovelace' : null,
  handle: actingSubject === A ? 'ada' : null,
  kind: actingSubject === A ? 'person' as const : null });
const discovery = (represented: string[], direct: string[] = []) => ({
  contexts: represented.map(described),
  directContexts: direct.map(described),
});

test('IAM03: Agent options list each eligible Agent once with its authority path', () => {
  expect(agentOptions(discovery([A, B], [B, C]))).toEqual([
    { iri: A, label: 'Ada Lovelace', handle: 'ada', kind: 'person', path: 'represented-agent' },
    { iri: B, label: null, handle: null, kind: null, path: 'represented-agent' },
    { iri: C, label: null, handle: null, kind: null, path: 'direct-principal' }]);
});

test('IAM03: a session Agent that lost eligibility is reported, never silently replaced', () => {
  const options = agentOptions(discovery([A, B]));
  expect(resolveSessionAgent(options, B)).toEqual({ status: 'selected', agent: options[1]! });
  expect(resolveSessionAgent(options, C)).toEqual({ status: 'ineligible', previous: C });
  expect(resolveSessionAgent(options.slice(0, 1), null)).toEqual({ status: 'unselected' });
  expect(resolveSessionAgent([], C)).toEqual({ status: 'ineligible', previous: C });
  expect(resolveSessionAgent([], null)).toEqual({ status: 'none' });
  // Main could not answer: keep what was chosen, unverified; commands still recheck it.
  expect(resolveSessionAgent(null, A)).toEqual({ status: 'unverified', previous: A });
});

test('IAM03: Agents without a label show a short, stable name', () => {
  expect(agentName({ iri: B, label: null }, messages.en)).toBe('Agent b8df6385');
  expect(agentName({ iri: B, label: null }, messages['zh-CN'])).toBe('身份 b8df6385');
  expect(agentName({ iri: B, label: 'Ada Lovelace' }, messages.en)).toBe('Ada Lovelace');
  expect(agentName(agentOptions(discovery([A]))[0]!, messages.en)).toBe('Ada Lovelace');
  expect(isAgentIri(B)).toBe(true);
  for (const value of ['https://rezics.com/id/B8DF6385-cec9-4fa0-8b89-71def5fa82b5', 'https://evil.test/id/x', '', null]) {
    expect(isAgentIri(value)).toBe(false);
  }
  expect(isSessionKey(crypto.randomUUID())).toBe(true);
  expect(isSessionKey('invalid')).toBe(false);
});

test('IAM01: the session record round-trips and a tampered or partial one reads as signed out', () => {
  const record = { user: { id: 'u1', name: 'Ada', email: 'ada@example.test', image: null },
    expiresAt: '2026-10-27T00:00:00.000Z' };
  expect(decodeSessionRecord(encodeSessionRecord(record))).toEqual(record);
  for (const value of [undefined, '', 'not-base64-json', Buffer.from('{"user":{"id":1}}').toString('base64url'),
    Buffer.from(JSON.stringify({ ...record, expiresAt: 'never' })).toString('base64url')]) {
    expect(decodeSessionRecord(value)).toBeNull();
  }
  const claims = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
  expect(tokenSubject(`h.${claims}.s`)).toBe('u1');
  expect(tokenSubject('opaque')).toBeNull();
  expect(tokenSubject('h.%%%.s')).toBeNull();
});
