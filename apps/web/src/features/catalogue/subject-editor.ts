import type { KernelClient, SubjectRead } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { synopsisVisit } from '../pages/subject-summary-reading/visit';
import {
  inspectSelectedSynopsisRead,
  inspectSelectedSynopsisVisit,
  type SelectedSynopsisEditorInspection,
} from './selected-synopsis-source';
import { selectedEditorAttempt, type SelectedEditorLive } from './subject-editor-lifetime';

export {
  authoredInspectionKind,
  inspectSelectedSynopsisRead,
  inspectSelectedSynopsisVisit,
  selectedSynopsisStatement,
  type SelectedSynopsisEditorInspection,
  type SelectedSynopsisEditorVisit,
} from './selected-synopsis-source';

export type SelectedSynopsisEditorRead = {
  visit: ReturnType<typeof synopsisVisit>;
  inspection: SelectedSynopsisEditorInspection;
  query?: string;
  status?: number;
  data?: SubjectRead;
};

/**
 * One Subject operation per attempt. A replaced visit, including A/B/A, cannot revive an earlier
 * matched payload. Inspection never proposes, accepts or drafts.
 */
export async function readSelectedSynopsisEditor(
  client: KernelClient,
  address: { id: string; locale: string; via?: string; property?: string; session?: string },
  live: SelectedEditorLive = selectedEditorAttempt().start(),
): Promise<SelectedSynopsisEditorRead> {
  const visit = synopsisVisit(address.via, address.id, address.locale);
  const admitted = inspectSelectedSynopsisVisit(address.via, address.id, address.locale, address.property);
  if (admitted.kind === 'ordinary') return { visit, inspection: { kind: 'ordinary' } };
  if (admitted.kind === 'invalid' || admitted.kind === 'unsupported')
    return { visit, inspection: { kind: admitted.kind } };
  if (!live.live()) return { visit, inspection: { kind: 'unavailable' }, query: admitted.query };
  try {
    const current = await client.subjects({ id: address.id }).get({
      query: { language: address.locale, selectedSynopsis: admitted.query },
      ...(address.session ? { headers: { 'rezics-session-token': address.session } } : {}),
      fetch: { redirect: 'manual', cache: 'no-store' },
    });
    if (!live.live()) return { visit, inspection: { kind: 'unavailable' }, query: admitted.query };
    if (current.status === 308) return { visit, inspection: { kind: 'changed' }, query: admitted.query, status: 308 };
    if (current.status !== 200 || !current.data)
      return {
        visit,
        inspection: {
          kind: current.status === 404 ? 'missing' : current.status === 409 ? 'unsupported' : 'unavailable',
        },
        query: admitted.query,
        status: current.status,
      };
    if (current.data.subject.id !== address.id || current.data.subject.context !== PAGE_GLOBAL_CONTEXT)
      return {
        visit,
        inspection: { kind: 'unavailable' },
        query: admitted.query,
        status: current.status,
        data: current.data,
      };
    const inspection = inspectSelectedSynopsisRead(admitted.selection, current.data.selectedSynopsis);
    return { visit, inspection, query: admitted.query, status: current.status, data: current.data };
  } catch {
    return { visit, inspection: { kind: 'unavailable' }, query: admitted.query };
  }
}
