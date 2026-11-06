import type { KernelClient, SubjectRead } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import {
  SELECTED_SYNOPSIS_PROPERTY,
  selectedSynopsisMatchesCurrent,
  selectedSynopsisQuery,
  selectedSynopsisResponse,
  type SelectedSynopsisSelection,
} from './selected-synopsis-source';
import { synopsisVisit } from './subject-sources';
import { selectedEditorAttempt, type SelectedEditorLive } from './subject-editor-lifetime';

export type SelectedSynopsisEditorVisit =
  | { kind: 'ordinary' }
  | { kind: 'invalid' }
  | { kind: 'unsupported' }
  | { kind: 'selected'; selection: SelectedSynopsisSelection; query: string; returnTo: string };

export type SelectedSynopsisEditorInspection =
  | { kind: 'ordinary' }
  | { kind: 'invalid' }
  | { kind: 'unsupported' }
  | { kind: 'changed' }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'matched'; statement: string; context: string; release: string };

export type SelectedSynopsisEditorRead = {
  visit: ReturnType<typeof synopsisVisit>;
  inspection: SelectedSynopsisEditorInspection;
  query?: string;
  status?: number;
  data?: SubjectRead;
};

/** Admit via as return intent only. Non-Global Context or Realm stops before any editor or Global label read. */
export function inspectSelectedSynopsisVisit(
  via: string | undefined,
  id: string,
  locale: string,
  property?: string,
): SelectedSynopsisEditorVisit {
  const visit = synopsisVisit(via, id, locale);
  if (visit.kind === 'invalid') return { kind: 'invalid' };
  if (visit.kind !== 'selected') return { kind: 'ordinary' };
  if (visit.selection.realm || visit.selection.context !== PAGE_GLOBAL_CONTEXT) return { kind: 'unsupported' };
  if (property !== undefined && property !== SELECTED_SYNOPSIS_PROPERTY) return { kind: 'invalid' };
  const query = selectedSynopsisQuery(visit.selection);
  if (!query) return { kind: 'invalid' };
  return { kind: 'selected', selection: visit.selection, query, returnTo: visit.returnTo };
}

/** Closed native selected-slot result. Document operands never re-enter the inspection. */
export function inspectSelectedSynopsisRead(
  selection: SelectedSynopsisSelection,
  value: unknown,
  current?: SubjectRead,
): SelectedSynopsisEditorInspection {
  if (!selectedSynopsisResponse(value, selection)) return { kind: 'unavailable' };
  if (value.kind !== 'matched') return { kind: value.kind };
  if (
    value.fact.id !== selection.candidateId ||
    value.context !== selection.context ||
    value.release !== selection.subjectRelease
  )
    return { kind: 'unavailable' };
  if (current && !selectedSynopsisMatchesCurrent(current, selection, value)) return { kind: 'changed' };
  return { kind: 'matched', statement: value.fact.id, context: value.context, release: value.release };
}

export function authoredInspectionKind(
  inspection: SelectedSynopsisEditorInspection,
): 'changed' | 'unsupported' | 'invalid' | undefined {
  if (inspection.kind === 'ordinary' || inspection.kind === 'matched') return;
  if (inspection.kind === 'unsupported' || inspection.kind === 'invalid') return inspection.kind;
  return 'changed';
}

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
    const inspection = inspectSelectedSynopsisRead(admitted.selection, current.data.selectedSynopsis, current.data);
    return { visit, inspection, query: admitted.query, status: current.status, data: current.data };
  } catch {
    return { visit, inspection: { kind: 'unavailable' }, query: admitted.query };
  }
}

/** Current Global statement for a matched selected-slot fact. Sibling preferred language never substitutes. */
export function selectedSynopsisStatement(
  read: Pick<SubjectRead, 'subject'>,
  inspection: SelectedSynopsisEditorInspection,
): SubjectRead['subject']['statements'][string][number] | undefined {
  if (inspection.kind !== 'matched') return;
  return read.subject.statements[SELECTED_SYNOPSIS_PROPERTY]?.find(
    (statement) => statement.id === inspection.statement,
  );
}
