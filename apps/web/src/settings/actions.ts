import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  changePreferences,
  loadSettingsPage,
  parsePreferenceChange,
  type PreferenceWriteResult,
  type SettingsPage,
} from './preferences';

export const readSettingsPage = createServerFn({ method: 'GET' }).handler(async (): Promise<SettingsPage> => {
  setResponseHeader('cache-control', 'private, no-store');
  return loadSettingsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>);
});

export const savePreferences = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const change = parsePreferenceChange(input);
    if (!change) throw new Error('Invalid preferences change');
    return change;
  })
  .handler(async ({ data }): Promise<PreferenceWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return changePreferences(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
