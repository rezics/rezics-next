import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { createScreenProfile, readScreenProfile, type ScreenAddress, type ScreenCommand } from './screen-profile';
import { screenSeriesId } from './screen-episode-membership';
import { checkSubjectStructure } from '@rezics/definitions/validate';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const loadScreenProfile = createServerFn({ method: 'GET', strict: false })
  .validator((input?: ScreenAddress | string): ScreenAddress => {
    if (typeof input === 'string') {
      const id = screenSeriesId(input);
      return input ? { id: id ?? '' } : {};
    }
    const id = screenSeriesId(input?.id);
    const series = screenSeriesId(input?.series);
    if (input?.id && !id) return { id: '' };
    return { ...(id ? { id } : {}), ...(series ? { series } : {}) };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    if (data.id === '') return { ok: false as const, reason: 'concealed' as const };
    return readScreenProfile(kernelClient(), data);
  });
export const createCatalogueScreen = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: ScreenCommand) => {
      if (
        !input ||
        !uuid.test(input.key) ||
        !input.item ||
        checkSubjectStructure(input.item).violations.length ||
        !input.item.statements ||
        Object.keys(input).some((key) => !['item', 'key'].includes(key)) ||
        Object.keys(input.item).some(
          (key) => !['type', 'labels', 'descriptions', 'aliases', 'statements'].includes(key),
        )
      )
        throw new Error('Invalid screen profile creation');
      return { key: input.key, item: input.item };
    }),
  )
  .handler(async ({ data }) => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false as const, reason: 'denied' as const };
    setResponseHeader('cache-control', 'private, no-store');
    return createScreenProfile(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      authorization,
    );
  });
