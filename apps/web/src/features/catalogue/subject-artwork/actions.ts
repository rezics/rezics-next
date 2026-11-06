import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { canonicalMediaId, artworkResponseBudget, readSubjectArtwork, type ArtworkResult } from './read';

async function readArtworkPage(data: {
  id: string;
  locale: string;
  expectedReader: string | null;
}): Promise<ArtworkResult> {
  const { env } = await import('cloudflare:workers');
  const { prepareSession, sessionSubject, viewerCredential } = await import('../../../session/request');
  const { kernelClient } = await import('../../../kernel/client');
  setResponseHeader('cache-control', 'private, no-store');
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
}

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
  .handler(({ data }): Promise<ArtworkResult> => readArtworkPage(data));
