import { expectedCandidateReader } from '../../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { isExploreId } from '../../pages/graph-browser';
import { exploreContext } from '../../pages/graph-browser/actions';
import { readQuotationPage, type QuotationRead } from './index';

export const readSubjectQuotations = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid quotation address');
    const input = value as Record<string, unknown>;
    if (
      typeof input.id !== 'string' ||
      !isExploreId(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35
    )
      throw new Error('Invalid quotation address');
    if (input.quote !== undefined && (typeof input.quote !== 'string' || !isExploreId(input.quote)))
      throw new Error('Invalid quotation address');
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192))
      throw new Error('Invalid quotation address');
    return {
      expectedReader: input.expectedReader === null ? null : expectedCandidateReader(input),
      id: input.id,
      locale: input.locale,
      quote: input.quote as string | undefined,
      cursor: input.cursor as string | undefined,
      session: typeof input.session === 'string' && input.session.length <= 16384 ? input.session : undefined,
    };
  })
  .handler(async ({ data }): Promise<QuotationRead> => {
    const prepared = await exploreContext(data.locale, data.expectedReader);
    if (!prepared) return { ok: false, reason: 'denied' };
    const { fetchGuideRelease } = await import('../definition-guide');
    const headers = prepared.authorization ? { authorization: prepared.authorization } : {};
    let release;
    try {
      release = await fetchGuideRelease(prepared.client, undefined, headers);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    return readQuotationPage(prepared.client, prepared.authorization, release, data.id, data.locale, data);
  });
