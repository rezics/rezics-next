import { expect, test } from 'bun:test';
import { decodePreferencePage } from '@rezics/client';
import { readingFixture } from '../src/kernel/fake/settings-preferences-reading';
import {
  ownerMayChangeReading,
  readingAdviceFor,
  readingMutation,
  readingReset,
  readReading,
  sendReading,
} from '../src/settings/reading-preferences';
import { loadSettingsPage } from '../src/settings/preferences';
import { preferenceRetryDeadline } from '../src/settings/preference-failure-retry';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

const latest = () => 0;

test('Retry-After accepts delay-seconds and HTTP dates without guessing invalid delays', () => {
  const now = Date.UTC(2026, 10, 5), date = new Date(now + 5_000).toUTCString();
  expect(preferenceRetryDeadline('2', now)).toBe(now + 2_000); expect(preferenceRetryDeadline(date, now)).toBe(Date.parse(date));
  expect(preferenceRetryDeadline('later', now)).toBe(0);
});

test('malformed native reading choices do not become a guessed editor', async () => {
  const body = {
    spoilerLevel: 1,
    suitability: 'blur',
    version: 2,
    shelf: {},
    notifications: { reply: true, mention: true },
    viewerState: 'current',
    allowedActions: { read: { allowed: true }, update: { allowed: true } },
    reading: {
      supported: { spoilerLevels: [0, '1', 2], suitability: ['blur', 'show'] },
      effective: { spoilerLevel: 1, suitability: 'blur' },
      defaults: { spoilerLevel: 0, suitability: 'blur' },
    },
  };
  expect(decodePreferencePage(body)).toBeUndefined();
  const owner = {
    env: {
      SITE_ORIGINS: 'https://site.example.test',
      AUTH_ISSUER: 'https://auth.example.test',
      API_RESOURCE: 'https://api.rezics.test',
      WEBSITE_SCOPES: 'openid account:read account:update',
      WEBSITE_CLIENT_ID: 'web',
      WEBSITE_CLIENT_KEY: 'unused',
      SESSIONS: {
        idFromName: (name: string) => name,
        get: () => ({
          async credential() {
            return { status: 'active', subject: 'alice', accessToken: 'token', csrfToken: 'csrf' };
          },
        }),
      } as unknown as DurableObjectNamespace<SessionStore>,
    } as Partial<SessionEnv>,
    request: () =>
      new Request('https://site.example.test/en/settings', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      }),
  };
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json(body)) as typeof fetch,
  });
  const page = await loadSettingsPage(client, owner.request(), owner.env);
  expect(page).toMatchObject({ signedIn: true, preferences: { spoilerLevel: 1, suitability: 'blur', version: 2 } });
  if (!('preferences' in page)) throw new Error('expected values');
  expect(page.preferences.advice).toBeUndefined();
  expect(ownerMayChangeReading(page.preferences.advice)).toBe(false);
  expect(await readReading({ read: async () => page }, 0)).toMatchObject({ ok: false, reason: 'unavailable' });
});

test('shared-version interleaving keeps the original key and uses the newer reviewed version', async () => {
  const fixture = readingFixture('lost');
  const original = readingMutation(fixture.initial, { spoilerLevel: 1, suitability: 'blur' })!;
  expect(await sendReading(fixture.io, original, false, latest)).toMatchObject({ kind: 'uncertain' });
  fixture.concurrent({ spoilerLevel: 2 });
  const recovered = await sendReading(fixture.io, original, true, () => 2);
  expect(recovered).toMatchObject({
    kind: 'confirmed',
    receipt: { spoilerLevel: 1, version: 1 },
    preferences: { spoilerLevel: 2, version: 2 },
  });
  expect(fixture.calls[1]).toBe(original);
  if (recovered.kind !== 'confirmed') throw new Error('expected confirmation');
  const reviewed = readingMutation(recovered.preferences, { spoilerLevel: 1, suitability: 'show' })!;
  expect(reviewed.expectedVersion).toBe(2);
  expect(reviewed.idempotencyKey).not.toBe(original.idempotencyKey);
});

test('reset is an explicit native-default patch of the reviewed version', () => {
  const advice = readingAdviceFor({ spoilerLevel: 2, suitability: 'show' });
  advice.reading.defaults = { spoilerLevel: 1, suitability: 'blur' };
  const known = {
    spoilerLevel: 2 as const,
    suitability: 'show' as const,
    version: 9,
    advice,
  };
  const reset = readingReset(known)!;
  expect(reset).toMatchObject({ expectedVersion: 9, spoilerLevel: 1, suitability: 'blur' });
  const atDefaultsAdvice = readingAdviceFor({ spoilerLevel: 1, suitability: 'blur' });
  atDefaultsAdvice.reading.defaults = { spoilerLevel: 1, suitability: 'blur' };
  const atDefaults = { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 9, advice: atDefaultsAdvice };
  expect(readingReset(atDefaults)).toBeNull();
  expect(readingReset({ ...known, advice: undefined })).toBeNull();
});

test('a lost acknowledgement never becomes success without current readback', async () => {
  const fixture = readingFixture('unavailable');
  const input = readingMutation(fixture.initial, { spoilerLevel: 1, suitability: 'blur' })!;
  expect(await sendReading(fixture.io, input, false, latest)).toMatchObject({ kind: 'uncertain' });
  expect(await sendReading(fixture.io, input, true, latest)).toMatchObject({ kind: 'uncertain' });
  expect(fixture.calls[1]).toBe(input);
  expect(await readReading(fixture.io, 0)).toMatchObject({ ok: false, reason: 'unavailable' });
});
