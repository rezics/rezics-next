import { expect, test } from 'bun:test';
import { SeedApiError } from './api.ts';
import { officialThemeSelection, seedOfficialThemes } from './official-theme-step.ts';
import type { SeedState } from './state.ts';

function themeState(options: {
  realms?: string[];
  catalogueZones?: readonly ('anime' | 'manga')[];
  token?: () => Promise<string>;
} = {}): SeedState {
  const findings = new Set<string>();
  return {
    findings,
    createdRealms: (options.realms ?? ['fiction']).map(id => ({ id })),
    catalogueZones: options.catalogueZones,
    sessions: [{ id: 'daniel', accountId: 'daniel-account',
      actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' }],
    operatorInput: {
      accessDatabaseUrl: 'https://example.com/db', accountSubject: 'operator-account',
      actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    },
    operatorSession: { cookie: 'cookie', token: '', issuedAt: 0,
      api: { token: options.token ?? (async () => { throw new Error('stop'); }) } },
    api: { getPublic: async () => { throw new SeedApiError('presentation', 404, 'missing'); } },
    optional: async (label, operation) => {
      try { return await operation(); }
      catch (error) {
        findings.add(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  } as unknown as SeedState;
}

function labels(state: SeedState): string[] {
  return [...state.findings].map(finding => finding.slice(0, finding.indexOf(':'))).sort();
}

test('the default theme selection adds catalogue Zones only when this seed recorded them', () => {
  const recorded = { createdRealms: [{ id: 'fiction' }, { id: 'kitchen' }],
    catalogueZones: ['anime', 'manga'] as const };
  expect(officialThemeSelection(recorded as Pick<SeedState, 'createdRealms' | 'catalogueZones'>))
    .toEqual(['fiction', 'kitchen', 'anime', 'manga']);
  expect(officialThemeSelection({ createdRealms: recorded.createdRealms }))
    .toEqual(['fiction', 'kitchen']);
  expect(officialThemeSelection({ createdRealms: recorded.createdRealms, catalogueZones: ['manga'] }))
    .toEqual(['fiction', 'kitchen', 'manga']);
});

test('an explicit theme selection is used unchanged', () => {
  const state = { createdRealms: [{ id: 'fiction' }], catalogueZones: ['anime', 'manga'] as const };
  expect(officialThemeSelection(state as Pick<SeedState, 'createdRealms' | 'catalogueZones'>, ['franchise-wiki']))
    .toEqual(['franchise-wiki']);
  expect(officialThemeSelection(state as Pick<SeedState, 'createdRealms' | 'catalogueZones'>, [])).toEqual([]);
});

test('the default pass attempts recorded catalogue Zones and skips Realms with no package', async () => {
  const state = themeState({ realms: ['fiction', 'kitchen'], catalogueZones: ['anime', 'manga'] });
  await seedOfficialThemes(state);
  expect(labels(state)).toEqual(['Official anime theme', 'Official fiction theme', 'Official manga theme']);
});

test('an explicit package is attempted, and a missing presentation is not treated as success', async () => {
  const state = themeState({
    realms: ['fiction'], catalogueZones: ['anime', 'manga'], token: async () => 'token',
  });
  await seedOfficialThemes(state, ['franchise-wiki']);
  expect(labels(state)).toEqual(['Official franchise-wiki theme']);
  expect([...state.findings][0]).toContain('loopback database');
});
