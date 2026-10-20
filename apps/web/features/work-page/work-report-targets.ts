import type { ReportMenuTarget } from '../safety/report-action.tsx';
import { iriOf, type WorkAt } from './route.ts';
import type { WorkHeader } from './types.ts';

/** Every visible Work component keeps its selected revision in the subject's one menu. */
export function workReportTargets(work: WorkHeader, at: WorkAt): ReportMenuTarget[] {
  const realm = typeof at === 'string' ? null : iriOf(at.realm);
  return [
    { target: work.id, kind: 'work', realm },
    ...work.description ? [{ target: work.id, kind: 'text' as const, realm,
      selection: { component: 'synopsis' as const, revision: work.metadataRevision ?? work.revision, locator: null } }] : [],
    ...work.cover.kind === 'image' ? [{ target: work.id, kind: 'cover' as const, realm,
      selection: { component: 'cover' as const, revision: work.cover.selection, locator: null } }] : [],
  ];
}
