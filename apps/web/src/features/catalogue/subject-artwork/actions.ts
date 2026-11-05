import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { canonicalMediaId, artworkResponseBudget, readSubjectArtwork, type ArtworkResult } from './read';

/** Anonymous-capable metadata read. The expected reader partitions a visit; it grants no media authority. */
export const loadSubjectArtwork = createServerFn({ method: 'POST', strict: false })
  .validator((input: { id: string; locale: string; expectedReader: string | null }) => {
    if (
      !input ||
      !canonicalMediaId(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      (input.expectedReader !== null && (typeof input.expectedReader !== 'string' || input.expectedReader.length > 128))
    )
      throw new Error('Invalid artwork reading');
    return { id: input.id, locale: input.locale, expectedReader: input.expectedReader };
  })
  .handler(async ({ data }): Promise<ArtworkResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ env }, { prepareSession, sessionSubject, viewerCredential }, { kernelClient }] = await Promise.all([
      import('cloudflare:workers'),
      import('../../../session/request'),
      import('../../../kernel/client'),
    ]);
    const request = getRequest();
    await prepareSession(request, env);
    if ((sessionSubject(request) ?? null) !== data.expectedReader) return { kind: 'unavailable' };
    const budget = artworkResponseBudget();
    const authorization = viewerCredential(request) ?? undefined;
    return readSubjectArtwork(
      kernelClient(data.locale, authorization, budget.decorate),
      data.id,
      authorization,
      budget.reason,
    );
  });
