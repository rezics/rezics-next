import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { parseIdentifierCurrentVisit } from './identifier-current-visit';
import { identifierEvidenceFromPage, type IdentifierEvidenceRead } from './identifier-current-visit-evidence';

/** Hydrated public origin read. No root Context selector or correction address enters this request. */
export const readIdentifierOrigin = createServerFn({ method: 'POST', strict: false })
  .validator((input: { id: string; locale: string; search: string; expectedReader: string | null }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[0-9a-f-]{36}$/iu.test(input.id) ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      typeof input.search !== 'string' ||
      (input.expectedReader !== null && (typeof input.expectedReader !== 'string' || input.expectedReader.length > 128))
    )
      throw new Error('Invalid Identifier origin request');
    const visit = parseIdentifierCurrentVisit(input.search);
    if (!visit) throw new Error('Invalid Identifier origin visit');
    return { ...input, visit };
  })
  .handler(async ({ data }): Promise<IdentifierEvidenceRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    if (data.visit.origin?.kind === 'unsupported') return { kind: 'unsupported' };
    const { loadSubjectPage, PageReadError } = await import('../pages/subject');
    const { subjectKernelClient } = await import('../pages/subject-queries');
    try {
      const realm = data.visit.origin?.realm;
      const { client, authorization } = await subjectKernelClient(data.locale, realm, data.expectedReader);
      const loaded = await loadSubjectPage(client, data.id, undefined, data.locale, { realm, authorization });
      if (loaded.kind === 'missing') return loaded;
      if (loaded.kind === 'redirect') return { kind: 'changed' };
      return identifierEvidenceFromPage(loaded.page, data.id, data.visit.origin);
    } catch (error) {
      if (!(error instanceof PageReadError)) throw error;
      return { kind: error.status === 401 || error.status === 403 ? 'refused' : 'unavailable' };
    }
  });
