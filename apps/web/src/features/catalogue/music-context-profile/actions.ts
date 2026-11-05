import { expectedCandidateReader } from '../../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { isExploreId } from '../../pages/graph-browser';
import { exploreContext } from '../../pages/graph-browser/actions';
import { isMusicContextCursor, isMusicContextStream } from './navigation';
import { readMusicContext, type MusicContextRead } from './index';

export const readSubjectMusicContext = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid music context address');
    const input = value as Record<string, unknown>;
    if (
      typeof input.id !== 'string' ||
      !isExploreId(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      (input.context !== undefined && (typeof input.context !== 'string' || !isExploreId(input.context))) ||
      (input.stream !== undefined && !isMusicContextStream(input.stream)) ||
      (input.cursor !== undefined && (!isMusicContextCursor(input.cursor) || !input.stream))
    )
      throw new Error('Invalid music context address');
    return {
      expectedReader: input.expectedReader === null ? null : expectedCandidateReader(input),
      id: input.id,
      locale: input.locale,
      context: typeof input.context === 'string' ? input.context : undefined,
      stream: typeof input.stream === 'string' ? input.stream : undefined,
      cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
      session: typeof input.session === 'string' && input.session.length <= 16384 ? input.session : undefined,
    };
  })
  .handler(async ({ data }): Promise<MusicContextRead> => {
    const signal = getRequest().signal;
    const prepared = await exploreContext(data.locale, data.expectedReader, signal);
    signal.throwIfAborted();
    if (!prepared) return { ok: false, reason: 'denied' };
    const { fetchGuideRelease } = await import('../definition-guide');
    const headers = prepared.authorization ? { authorization: prepared.authorization } : {};
    let release;
    try {
      release = await fetchGuideRelease(prepared.client, undefined, headers, signal);
    } catch {
      signal.throwIfAborted();
      return { ok: false, reason: 'unavailable' };
    }
    return readMusicContext(prepared.client, prepared.authorization, release, data.id, data.locale, {
      ...data,
      signal,
    });
  });
