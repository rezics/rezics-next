import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../../kernel/client';
import { fetchGuideRelease } from '../definition-guide';
import { readMusicRelease, validMusicReleaseAddress, type MusicReleaseAddress } from './model';

export const loadMusicRelease = createServerFn({ method: 'GET', strict: false })
  .validator((input: MusicReleaseAddress) => {
    if (!validMusicReleaseAddress(input)) throw new Error('Invalid music release window');
    return {
      id: input.id,
      context: input.context,
      ...(input.stream ? { stream: input.stream } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    const client = kernelClient(locale);
    return readMusicRelease(client, fetchGuideRelease(client), data, locale);
  });
