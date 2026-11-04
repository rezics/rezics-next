import { expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import {
  ownerMayChangeReading,
  readingAdviceFor,
  readingMutation,
  sendReading,
} from '../src/settings/reading-preferences';
import type { PreferenceChange, PreferenceWriteResult, SettingsPage } from '../src/settings/preferences';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    throw new Error('Unexpected session read');
  },
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { sessionQuery } = await import('../src/session/query');
const { SettingsSessionOwner } = await import('../src/settings/settings-session-owner');

const identity = { state: 'signed-in' as const, subject: 'alice', csrfToken: 'token' };

test('owner advice and session lifetime are both required to write, and retirement drops private drafts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, identity);
  const owner = new SettingsSessionOwner(client, identity.csrfToken, identity.subject);
  const release = owner.mount();
  const advice = readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' });
  const denied = readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' }, false);
  expect(owner.isCurrent() && ownerMayChangeReading(advice)).toBe(true);
  expect(owner.isCurrent() && ownerMayChangeReading(denied)).toBe(false);
  expect(owner.readCurrent() && !ownerMayChangeReading(denied)).toBe(true);
  owner.retire();
  expect(owner.isCurrent()).toBe(false);
  expect(owner.readCurrent()).toBe(false);
  expect(ownerMayChangeReading(advice)).toBe(true);
  release();
  client.clear();
});

test('a stale writable receipt cannot restore edit authority after the viewer retires', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, identity);
  const owner = new SettingsSessionOwner(client, identity.csrfToken, identity.subject);
  const release = owner.mount();
  let current = true;
  const input = readingMutation(
    {
      spoilerLevel: 0,
      suitability: 'blur',
      version: 0,
      advice: readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' }),
    },
    { spoilerLevel: 1, suitability: 'blur' },
  )!;
  const io = {
    async save(_change: Readonly<PreferenceChange>): Promise<PreferenceWriteResult> {
      owner.retire();
      current = owner.isCurrent();
      return {
        ok: true,
        preferences: {
          spoilerLevel: 1,
          suitability: 'blur',
          version: 1,
          advice: readingAdviceFor({ spoilerLevel: 1, suitability: 'blur' }),
        },
      };
    },
    async read(): Promise<SettingsPage> {
      throw new Error('stale read');
    },
  };
  const result = await sendReading(io, input, false, () => 0);
  expect(result.kind).toBe('confirmed');
  expect(current).toBe(false);
  expect(owner.isCurrent()).toBe(false);
  expect(
    ownerMayChangeReading(result.kind === 'confirmed' ? result.preferences.advice : undefined) && owner.isCurrent(),
  ).toBe(false);
  release();
  client.clear();
});
