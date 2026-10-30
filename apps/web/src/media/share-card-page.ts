import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import {
  loadSubjectPage,
  pageContext,
  subjectBody,
  subjectPageTitle,
  PageReadError,
  type SubjectPageLoad,
} from '../features/pages/subject';
import { publicCover } from './public-card';
import { shareCardId, shareCardTitle, type ShareCardProjection, type ShareCardTarget } from './share-card';

const concealed = (status: number) => [401, 403, 404, 410, 451].includes(status);

/** Reuses the page's actual planned subject read and display-label fallback; it resolves no canonical identity. */
export function projectShareCardPage(loaded: SubjectPageLoad, target: ShareCardTarget): ShareCardProjection {
  if (loaded.kind === 'missing') return { kind: 'missing' };
  // An alias/account redirect has no original page projection. Its canonical owner must bind that surface.
  if (loaded.kind !== 'page') return { kind: 'unavailable' };
  const page = loaded.page;
  if (page.subject !== target.id) return { kind: 'unavailable' };
  const read = subjectBody(page);
  if (!read) {
    const planned = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
    const subject = Object.entries(planned).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
    const status = subject ? page.reads[subject[0]]?.status : undefined;
    return { kind: status !== undefined && concealed(status) ? 'missing' : 'unavailable' };
  }
  if (read.subject.id !== target.id) return { kind: 'unavailable' };
  const title = shareCardTitle(subjectPageTitle(page, target.locale));
  if (!title) return { kind: 'unavailable' };
  const cover = publicCover(read.summary?.cover);
  return {
    kind: 'ready',
    page: { ...target, title, types: [read.subject.type], ...(cover ? { cover } : {}) },
  };
}

/** Exactly one fresh public pages.read; no session, Realm, query cache, per-row reads or speculative native fields. */
export async function readShareCardPage(client: KernelClient, target: ShareCardTarget): Promise<ShareCardProjection> {
  if (!shareCardId.test(target.id)) return { kind: 'missing' };
  try {
    return projectShareCardPage(await loadSubjectPage(client, target.id, undefined, target.locale), target);
  } catch (error) {
    return { kind: error instanceof PageReadError && concealed(error.status) ? 'missing' : 'unavailable' };
  }
}
