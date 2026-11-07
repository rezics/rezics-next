import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIRST_PUBLIC_JOURNEYS } from '../scripts/semantic-first-public-inventory.ts';

const walk = resolve(import.meta.dir, '../scripts/semantic-first-public-walk.ts');

test('the first-public walk names each of the 31 catalogue and Zone journeys once', () => {
  expect(FIRST_PUBLIC_JOURNEYS).toHaveLength(31);
  expect(new Set(FIRST_PUBLIC_JOURNEYS.map((row) => row.id)).size).toBe(31);
  expect(new Set(FIRST_PUBLIC_JOURNEYS.map((row) => row.name)).size).toBe(31);
});

test('editor website credentials POST the issuer Origin and keep native JWKS plus seed transport', () => {
  const source = readFileSync(walk, 'utf8');
  expect(source).toContain('`${stack.issuer}/signin`');
  expect(source).toContain('`${stack.issuer}/token`');
  expect(source).toContain('origin: stack.issuer');
  expect(source).not.toContain('`${stack.native}/signin`');
  expect(source).not.toContain('`${stack.native}/token`');
  expect(source).toContain('`${stack.native}/.well-known/jwks.json`');
  expect(source).toContain('AUTH_ORIGIN: stack.native');
  expect(source).toContain("typedProbe(`${stack.native}/.well-known/jwks.json`, 'identity')");
  expect(source).toContain("typedProbe(`${stack.kernel}/v1/definitions`, 'kernel')");
});
