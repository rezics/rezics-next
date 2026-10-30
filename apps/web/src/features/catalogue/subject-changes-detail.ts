import type { KernelClient } from '@rezics/client';
import type { DetailRead } from './subject-changes';

export type RevisionDetailPort = (
  client: KernelClient,
  input: {
    locale: string;
    id: string;
    revision: number;
    authorization?: string | undefined;
    session?: string | undefined;
  },
) => Promise<DetailRead>;

/** Temporary consumer port until Semantic's closed revision-detail DTO lands.
 * The generated client in this checkout exposes revisions.get only. Bind the actual
 * producer here during integration; do not guess wire tags or fetch a snapshot API.
 * A missing implementation is unavailable, never an empty or successful detail.
 */
export const readSubjectRevisionDetail: RevisionDetailPort = async () => ({ kind: 'unavailable' });
