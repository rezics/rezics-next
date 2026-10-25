import { expect, test } from 'bun:test';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { ACCESS_EVENTS } from '../../src/access/events.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { newId } from '../../src/route/route.ts';

const account = newId(0xffff);
const organization = newId(0);
const request = newId(0xffff);
const subjects = [
  { kind: 'account', id: account },
  { kind: 'organization', id: organization, role: 'owner' },
  { kind: 'organization', id: organization, role: 'member' },
  { kind: 'active_accounts' },
];
const base = { resource: PLATFORM_RESOURCE, actions: ['access:grant'], valid: '(,)' };
const direct = subjects.map((subject) => ({ ...base, subject }));
const legacy = ['', 'owner', 'member'].map((subjectRole) => ({ ...base, subjectId: account, subjectRole }));
const roles = subjects.map((subject) => ({
  resource: PLATFORM_RESOURCE,
  subject,
  role: 'platform.governance',
  valid: '[2030-01-01,2031-01-01)',
}));
const assignment = { requestedBy: `urn:rezics:request:${account}:${request}` };
const cases = [
  ...['create', 'change', 'revoke'].map((operation) => ({
    type: `com.rezics.access.grant.${operation}.v1`,
    values: [...direct, ...legacy],
  })),
  ...['create', 'change', 'revoke'].map((operation) => ({
    type: `com.rezics.access.role-grant.${operation}.v1`,
    values: roles,
  })),
  ...['create', 'revoke'].map((operation) => ({
    type: `com.rezics.access.assignment.${operation}.v1`,
    values: [assignment],
  })),
];
function schema(type: string) {
  const value = (ACCESS_EVENTS as Record<string, TSchema>)[type];
  expect(value).toBeDefined();
  expect((EVENT_TYPES as Record<string, TSchema>)[type]).toBe(value);
  return value!;
}

test('all eight concrete helper events have registered schemas for every return representation', () => {
  expect(cases).toHaveLength(8);
  for (const { type, values } of cases) {
    const definition = schema(type);
    for (const value of values) expect(Value.Check(definition, value)).toBe(true);
  }
  expect(Object.keys(ACCESS_EVENTS).sort()).toEqual(
    [...cases.map(({ type }) => type), 'com.rezics.access.governance.bootstrapped.v1'].sort(),
  );
});

test('payloads are exact, exclude command and private data, and reject wrong event families', () => {
  for (const { type, values } of cases) {
    const definition = schema(type);
    for (const value of values) {
      for (const field of ['extra', 'key', 'token', 'credentials', 'privateProfile', 'context', 'previous'])
        expect(Value.Check(definition, { ...value, [field]: 'must not be disclosed' })).toBe(false);
      for (const field of Object.keys(value)) {
        const missing = { ...value } as Record<string, unknown>;
        delete missing[field];
        expect(Value.Check(definition, missing)).toBe(false);
      }
    }
    for (const value of [null, {}, [], 'grant']) expect(Value.Check(definition, value)).toBe(false);
    for (const other of cases.filter((other) => other.type.split('.')[3] !== type.split('.')[3]))
      expect(Value.Check(definition, other.values[0])).toBe(false);
  }
});

test('grant and role-grant schemas reject invalid or mixed subjects and malformed resources', () => {
  const nil = '00000000-0000-0000-0000-000000000000';
  for (const { type } of cases.filter(({ type }) => !type.includes('.assignment.'))) {
    const definition = schema(type);
    const value = type.includes('.role-grant.') ? roles[0]! : direct[0]!;
    for (const subject of [
      { kind: 'account', id: nil },
      { kind: 'account', id: account.toUpperCase() },
      { kind: 'account', id: 'not-a-uuid' },
      { kind: 'account', id: account, role: '' },
      { kind: 'organization', id: organization, role: 'admin' },
      { kind: 'organization', id: organization },
      { kind: 'active_accounts', id: nil },
      { kind: 'active_accounts', token: 'secret' },
      { kind: 'unknown' },
    ])
      expect(Value.Check(definition, { ...value, subject })).toBe(false);
    expect(Value.Check(definition, { ...value, subjectId: account, subjectRole: '' })).toBe(false);
    for (const resource of [
      { route: -1, id: account },
      { route: 65536, id: account },
      { route: 0.5, id: account },
      { route: 0, id: nil },
      { ...PLATFORM_RESOURCE, token: 'secret' },
    ])
      expect(Value.Check(definition, { ...value, resource })).toBe(false);
    expect(Value.Check(definition, { ...value, valid: null })).toBe(false);
    if (type.includes('.role-grant.')) {
      for (const role of ['', 'Admin', 'role:owner', 1])
        expect(Value.Check(definition, { ...value, role })).toBe(false);
    } else {
      for (const actions of [[], [''], ['access.grant'], ['access:grant', 1], 'access:grant'])
        expect(Value.Check(definition, { ...value, actions })).toBe(false);
      for (const subjectRole of ['admin', null])
        expect(Value.Check(definition, { ...base, subjectId: account, subjectRole })).toBe(false);
      expect(Value.Check(definition, { ...base, subjectId: nil, subjectRole: '' })).toBe(false);
    }
  }
});

test('assignments require only the exact native request URN with routable UUIDs', () => {
  for (const { type } of cases.filter(({ type }) => type.includes('.assignment.'))) {
    const definition = schema(type);
    for (const requestedBy of [
      account,
      `urn:rezics:account:${account}:${request}`,
      `${assignment.requestedBy}:extra`,
      `${assignment.requestedBy}\n`,
      assignment.requestedBy.toUpperCase(),
      `urn:rezics:request:00000000-0000-0000-0000-000000000000:${request}`,
      null,
    ])
      expect(Value.Check(definition, { requestedBy })).toBe(false);
  }
  expect(Object.hasOwn(EVENT_TYPES, 'com.rezics.access.grant.unknown.v1')).toBe(false);
});
