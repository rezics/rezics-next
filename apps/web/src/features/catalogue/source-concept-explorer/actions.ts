import { expectedCandidateReader } from '../../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { isExploreId } from '../../pages/graph-browser';
import { exploreContext } from '../../pages/graph-browser/actions';
import { readSourceConcept, type ConceptRead } from './index';

export const readSubjectConcept = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid concept address');
    const input = value as Record<string, unknown>;
    if (
      typeof input.id !== 'string' ||
      !isExploreId(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35
    )
      throw new Error('Invalid concept address');
    return {
      expectedReader: input.expectedReader === null ? null : expectedCandidateReader(input),
      id: input.id,
      locale: input.locale,
      cursor: typeof input.cursor === 'string' && input.cursor.length <= 8192 ? input.cursor : undefined,
      role: typeof input.role === 'string' && input.role.length <= 128 ? input.role : undefined,
      pin: typeof input.pin === 'string' && input.pin.length <= 128 ? input.pin : undefined,
      session: typeof input.session === 'string' && input.session.length <= 16384 ? input.session : undefined,
    };
  })
  .handler(async ({ data }): Promise<ConceptRead> => {
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
    return readSourceConcept(prepared.client, prepared.authorization, release, data.id, data.locale, data);
  });
