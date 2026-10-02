import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { NameRegistry } from '../src/modules/address/registry.ts';
import { canonicalAddresses } from '../src/modules/address/canonical.ts';
import { uuidToSid } from '@rezics/model/address/sid';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

test('G937: SQL owns every reserved web route and former authority word', () => {
  const migration = readFileSync('services/main/migrations/access/986_name_registry.sql', 'utf8');
  const words = new Set(
    [...migration.slice(0, migration.indexOf('-- Same frozen')).matchAll(/'([^']+)'/g)].map(
      (match) => match[1],
    ),
  );
  for (const root of ['apps/web/app', 'apps/web/app/[locale]']) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('[') && !entry.name.startsWith('('))
        expect(words.has(entry.name)).toBe(true);
    }
  }
  for (const word of [
    'admins',
    'mod',
    'mods',
    'moderators',
    'sign_in',
    'sign_out',
    'about',
    'user',
    'agent',
    'w',
    'onboarding',
    'rezics',
    'administrator',
    'staff',
    'support',
  ])
    expect(words.has(word)).toBe(true);
});

test('G937: summary current-name lookup uses one plain query without recovery locks', async () => {
  const calls: string[] = [];
  const registry = new NameRegistry({
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool);
  await registry.currents(['https://rezics.com/id/00000000-0000-0000-0000-000000000001']);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('name_registry');
  expect(calls[0]).not.toMatch(/BEGIN|FOR SHARE|recovery_fence|name_scope_policy/);
});

test('G937: summaries survive missing capability backlinks and an unavailable registry', async () => {
  const holder = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
  const env = {
    fuseki: {
      query: async () => {
        throw new Error('Backlink owner unavailable');
      },
    },
    addresses: {
      currents: async () => {
        throw new Error('Registry unavailable');
      },
    },
  } as unknown as WorkActivationEnvironment;
  const results = await canonicalAddresses(env, [
    { reference: holder, type: 'realm', name: { value: 'Community' } },
  ]);
  expect(results.get(holder)).toEqual({
    prefix: '/r/',
    key: uuidToSid(holder.slice(-36)),
    slugSource: 'Community',
  });
});
