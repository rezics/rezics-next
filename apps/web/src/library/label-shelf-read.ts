import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { readSubjectSlotSession, type SubjectLabelUndo } from './subject-slot';
import { subjectOf, type LibrarySubject } from './reads';
import { readLibraryResult } from './reads';
import { progressView } from './progress-label';
import type { ProgressLabelInput } from './progress-label';
import type { LibraryLabelSummary } from './subject-labels.ts';
import { readRelease } from '../subject/definitions';
import { requestLocale } from '../kernel/client';
import { libraryStateLabel } from './profiles';
import { m } from '../paraglide/messages.js';

export type LabelShelfEntry = {
  id: string;
  labelId: string;
  subjectId: string;
  revision: number;
  removeKey?: string;
  subject: LibrarySubject | null;
  state?: string;
  stateLabel?: string;
  activeProgressSession?: ProgressLabelInput | null;
};

export type LabelShelfPageData =
  | { state: 'closed' }
  | { state: 'signed-out' }
  | { state: 'denied' }
  | { state: 'preparing' }
  | { state: 'unavailable' }
  | {
      state: 'loaded';
      label: LibraryLabelSummary;
      entries: LabelShelfEntry[];
      next: string | null;
      csrfToken: string | null;
      undoKey?: string;
      undo?: SubjectLabelUndo & { subjectId: string };
      labelResult?: string;
    };

/** One FULL assignment page supplies every tile, its page heading and next cursor. */
export async function loadLabelShelfPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: {
    labelId: string;
    cursor?: string;
    limit: number;
    undo?: SubjectLabelUndo & { subjectId: string };
    labelResult?: string;
    undoKey?: string;
  },
): Promise<LabelShelfPageData> {
  try {
    const identity = await readSubjectSlotSession(request, sessionEnv);
    if (identity.state === 'signed-out') return { state: 'signed-out' };
    if (identity.state !== 'signed-in') return { state: 'unavailable' };
    const authorization = identity.authorization;
    const exposure = await client.platform.exposure.get({ headers: { authorization } });
    const admitted = readLibraryResult(exposure).admitted;
    if (
      !admitted.includes('personal_library') ||
      !admitted.includes('reading_progress') ||
      !admitted.includes('library_label.assignment_list')
    )
      return { state: 'closed' };
    const result = await client.libraryLabelAssignments.get({
      query: {
        labelId: input.labelId,
        view: 'FULL',
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      headers: { authorization },
    });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { state: 'closed' };
    if (result.status === 401 || result.status === 403) return { state: 'denied' };
    if (result.error?.value?.code === 'index_not_ready' || result.error?.value?.code === 'semantic_not_ready')
      return { state: 'preparing' };
    const page = readLibraryResult(result);
    if (!('label' in page) || page.label.id !== input.labelId)
      throw new Error('FULL label shelf omitted its label summary');
    const locale = requestLocale() ?? 'en';
    const release = await readRelease().catch(() => undefined);
    return {
      state: 'loaded',
      label: page.label,
      entries: page.assignments.map((row) => {
        if (!('subject' in row) || !('libraryEntry' in row))
          throw new Error('FULL label shelf omitted its subject or entry');
        const subject = subjectOf(row.subject);
        const entry = row.libraryEntry;
        const state = entry?.state;
        const stateLabel =
          state && release && subject?.type
            ? (libraryStateLabel(release, subject.type, state, locale)?.text ?? m.library_other())
            : state
              ? m.library_other()
              : undefined;
        const progress = entry?.activeProgressSession;
        return {
          id: row.id,
          removeKey: crypto.randomUUID(),
          labelId: row.labelId,
          subjectId: row.subjectId,
          revision: row.revision,
          subject,
          ...(state ? { state } : {}),
          ...(stateLabel ? { stateLabel } : {}),
          ...(progress ? { activeProgressSession: progress } : {}),
        };
      }),
      next: page.next,
      csrfToken: identity.csrfToken,
      undoKey: input.undoKey ?? crypto.randomUUID(),
      ...(input.undo ? { undo: input.undo } : {}),
      ...(input.labelResult ? { labelResult: input.labelResult } : {}),
    };
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'closed' };
    if (error && typeof error === 'object' && 'isNotFound' in error) throw error;
    if (error instanceof Error && error.name === 'StaleCursorError') throw error;
    return { state: 'unavailable' };
  }
}

export function labelShelfProgress(entry: LabelShelfEntry, locale: string) {
  const view = progressView(entry.activeProgressSession ?? null, locale);
  return view ? { value: view.percent === null ? null : view.percent / 100, label: view.text } : undefined;
}
