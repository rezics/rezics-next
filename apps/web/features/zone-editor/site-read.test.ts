import { describe, expect, test, vi } from 'vitest';
import type { UiLocale } from '../../i18n/define.ts';
import type { ResolvedAddress } from '../address/client.ts';
import type { SiteResolution } from '../realm/read.ts';
import { readZoneAuthoringSite } from './read.ts';

const zone = '00000000-0000-4000-8000-000000000501';
const address = { profile: 'address-resolution-v1', status: 'resolved', scope: 'space',
  key: 'harbor', state: 'current', holder: `https://rezics.com/id/${zone}`,
  canonical: { prefix: '/z/', key: 'harbor', suffixSource: 'Harbor' },
  capabilities: { zone: `https://rezics.com/id/${zone}` } } as ResolvedAddress;
const ready: SiteResolution = { kind: 'site', zone, realm: null, address };

describe('Zone authoring address admission', () => {
  test('a recovered site refreshes a cached missing admission through the same owner', async () => {
    const resolve = vi.fn(async (_space: string, _locale: UiLocale, fresh = false): Promise<SiteResolution> =>
      fresh ? ready : { kind: 'missing' });
    expect(await readZoneAuthoringSite('harbor', 'en', resolve)).toBe(ready);
    expect(resolve.mock.calls).toEqual([['harbor', 'en'], ['harbor', 'en', true]]);
  });

  test('an admitted active address needs no second read', async () => {
    const resolve = vi.fn(async () => ready);
    expect(await readZoneAuthoringSite('harbor', 'en', resolve)).toBe(ready);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('a fresh missing result still refuses authoring without guessing a Zone', async () => {
    const resolve = vi.fn(async (): Promise<SiteResolution> => ({ kind: 'missing' }));
    expect(await readZoneAuthoringSite('harbor', 'en', resolve)).toEqual({ kind: 'missing' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test('unavailable and join-only admissions remain refused without a refresh loop', async () => {
    for (const answer of [{ kind: 'unavailable', failure: 'unavailable' }, { kind: 'join', page: {} }] as SiteResolution[]) {
      const resolve = vi.fn(async () => answer);
      expect(await readZoneAuthoringSite('harbor', 'en', resolve)).toBe(answer);
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  });

  test('a failed revalidation preserves its owner failure', async () => {
    const failure: SiteResolution = { kind: 'unavailable', failure: 'budget' };
    const resolve = vi.fn(async (_space: string, _locale: UiLocale, fresh = false): Promise<SiteResolution> =>
      fresh ? failure : { kind: 'missing' });
    expect(await readZoneAuthoringSite('harbor', 'en', resolve)).toBe(failure);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
