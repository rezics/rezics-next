import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../../kernel/client';
import { fetchGuideRelease } from '../definition-guide';
import { readAlbumTracks, validAlbumTrackAddress, type AlbumTrackAddress } from './model';

export const loadAlbumTracks = createServerFn({ method: 'GET', strict: false })
  .validator((input: AlbumTrackAddress) => {
    if (!validAlbumTrackAddress(input)) throw new Error('Invalid album window');
    return {
      id: input.id,
      context: input.context,
      ...(input.stream ? { stream: input.stream } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const locale = requestLocale() ?? 'en';
    const client = kernelClient(locale);
    return readAlbumTracks(client, fetchGuideRelease(client), data, locale);
  });
