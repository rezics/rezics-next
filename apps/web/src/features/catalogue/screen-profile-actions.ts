import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { createScreenProfile, readScreenProfile, type ScreenCommand } from './screen-profile';
import { checkSubjectStructure } from '@rezics/definitions/validate';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const loadScreenProfile = createServerFn({ method: 'GET', strict: false })
  .validator((id?: string) => (id === undefined || (typeof id === 'string' && uuid.test(id)) ? id : ''))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    if (data === '') return { ok: false as const, reason: 'concealed' as const };
    return readScreenProfile(kernelClient(), data);
  });
export const createCatalogueScreen = createServerFn({ method: 'POST', strict: false })
  .validator((input: ScreenCommand) => {
    if (
      !input ||
      !uuid.test(input.key) ||
      !input.item ||
      checkSubjectStructure(input.item).violations.length ||
      !input.item.statements ||
      Object.keys(input).some((key) => !['item', 'key'].includes(key)) ||
      Object.keys(input.item).some((key) => !['type', 'labels', 'descriptions', 'aliases', 'statements'].includes(key))
    )
      throw new Error('Invalid screen profile creation');
    return { key: input.key, item: input.item };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return createScreenProfile(kernelClient(), getRequest(), env as Partial<SessionEnv>, data, requestLocale() ?? 'en');
  });
