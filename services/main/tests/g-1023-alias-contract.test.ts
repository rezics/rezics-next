import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { normalizeAddressAlias } from '@rezics/model/address/aliases';
import { deriveAddressSuffix } from '@rezics/model/address/suffix';
import { ALIAS_POLICIES } from '../src/modules/address/policy.ts';
import { AliasRegistry, AliasInvalid, AliasCooldown } from '../src/modules/address/registry.ts';
import { addressError, addressRoutes } from '../src/routes/addresses.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const holder = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('G1023: aliases expose one normalized key and suffixes remain independent display words', () => {
  const alias = normalizeAddressAlias('Cafe\u0301 Au Lait', 'unicode-title');
  expect(alias).toEqual({ key: 'café-au-lait', skeleton: expect.any(String) });
  expect(normalizeAddressAlias('CAFÉ AU LAIT', 'unicode-title')).toEqual(alias);
  expect(deriveAddressSuffix('日本語の作品')).toBe('日本語の作品');
  for (const policy of Object.values(ALIAS_POLICIES)) expect(policy.canonical).toBe('alias');
});

test('G1023: alias failures use alias problem codes and messages', async () => {
  expect(await addressError(new AliasInvalid('Alias is reserved')).json()).toMatchObject({
    code: 'invalid_alias',
    title: 'Alias is reserved',
  });
  const response = addressError(new AliasCooldown('2026-11-01T00:00:00Z'));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'alias_cooldown' });
});

test('G1023: availability accepts alias and the former name command contract is rejected', async () => {
  const registry = new AliasRegistry({} as Pool);
  const calls: string[] = [];
  registry.withRead = async (operation) => operation();
  registry.availability = async (_scope, value) => {
    calls.push(value);
    return { available: true, reason: 'available' as const };
  };
  const app = new Elysia().use(
    addressRoutes({ environment: { addresses: registry } } as MainWorkDependencies),
  );
  const response = await app.handle(
    new Request('http://main.local/v1/addresses/availability?scope=work&alias=New%20Work'),
  );
  expect(response.status).toBe(200);
  expect(calls).toEqual(['New Work']);
  expect(
    (
      await app.handle(
        new Request('http://main.local/v1/addresses/availability?scope=work&name=New%20Work'),
      )
    ).status,
  ).toBe(422);
  for (const body of [
    { profile: 'name-write-v1', name: 'New Work' },
    { profile: 'alias-write-v1', name: 'New Work' },
    { profile: 'alias-write-v1', alias: 'New Work', display: 'New Work' },
  ]) {
    const invalid = await app.handle(
      new Request('http://main.local/v1/addresses/claims', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'claim' },
        body: JSON.stringify({
          scope: 'work',
          holder,
          actingSubject: holder,
          operation: 'claim',
          expectedRevision: null,
          ...body,
        }),
      }),
    );
    expect(invalid.status).toBe(422);
  }
});
