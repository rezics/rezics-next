import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../../kernel/client';
import { fetchGuideRelease } from '../definition-guide';
import { readGameReader, validGameReaderAddress, type GameReaderAddress } from './model';

export const loadGameReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: GameReaderAddress) => {
    if (!validGameReaderAddress(input)) throw new Error('Invalid game reader window');
    return {
      id: input.id,
      context: input.context,
      type: input.type,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    const client = kernelClient(locale);
    return readGameReader(client, fetchGuideRelease(client), data, locale);
  });
