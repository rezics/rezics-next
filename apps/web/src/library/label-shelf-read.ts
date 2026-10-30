import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { readSubjectSlotSession, type SubjectLabelUndo } from './subject-slot';
import { subjectOf, type LibrarySubject } from './reads';
import { readLibraryResult } from './reads';
import { progressView } from './progress-label';
import type { ProgressLabelInput } from './progress-label';
import { libraryLabelApi, type LibraryLabelSummary } from './subject-labels.ts';

export type LabelShelfEntry = {
  id: string;
  labelId: string;
  subjectId: string;
  revision: number;
  subject: LibrarySubject | null;
  state?: string;
  activeProgressSession?: ProgressLabelInput | null;
};

export type LabelShelfPageData =
  | { state: 'closed' }
  | { state: 'signed-out' }
  | {
      state: 'loaded';
      label: LibraryLabelSummary;
      entries: LabelShelfEntry[];
      next: string | null;
      csrfToken: string | null;
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
  },
): Promise<LabelShelfPageData> {
  try {
    const identity = await readSubjectSlotSession(request, sessionEnv);
    if (identity.state !== 'signed-in') return { state: identity.state === 'signed-out' ? 'signed-out' : 'closed' };
    const authorization = identity.authorization;
    const exposure = await client.platform.exposure.get({ headers: { authorization } });
    const admitted = exposure.data?.admitted ?? [];
    if (
      !admitted.includes('personal_library') ||
      !admitted.includes('reading_progress') ||
      !admitted.includes('library_label.assignment_list')
    )
      return { state: 'closed' };
    const api = libraryLabelApi(client);
    const result = await api.libraryLabelAssignments.get({
      query: {
        labelId: input.labelId,
        view: 'FULL',
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      headers: { authorization },
    });
    const page = readLibraryResult(result as never) as {
      assignments: {
        id: string;
        labelId: string;
        subjectId: string;
        revision: number;
        subject?: unknown;
        libraryEntry?: unknown;
      }[];
      label?: LibraryLabelSummary;
      next: string | null;
    };
    if (!page.label || page.label.id !== input.labelId) throw new Error('Label shelf page omitted its label summary');
    return {
      state: 'loaded',
      label: page.label,
      entries: page.assignments.map((row) => {
        const subject = subjectOf(row.subject as Parameters<typeof subjectOf>[0]);
        const entry =
          row.libraryEntry && typeof row.libraryEntry === 'object' && !Array.isArray(row.libraryEntry)
            ? (row.libraryEntry as { state?: unknown; activeProgressSession?: unknown })
            : null;
        const state = typeof entry?.state === 'string' ? entry.state : undefined;
        const progress = entry?.activeProgressSession;
        return {
          id: row.id,
          labelId: row.labelId,
          subjectId: row.subjectId,
          revision: row.revision,
          subject,
          ...(state ? { state } : {}),
          ...(progress && typeof progress === 'object'
            ? { activeProgressSession: progress as ProgressLabelInput }
            : {}),
        };
      }),
      next: page.next,
      csrfToken: identity.csrfToken,
      ...(input.undo ? { undo: input.undo } : {}),
      ...(input.labelResult ? { labelResult: input.labelResult } : {}),
    };
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'closed' };
    throw error;
  }
}

export function labelShelfProgress(entry: LabelShelfEntry, locale: string) {
  const view = progressView(entry.activeProgressSession ?? null, locale);
  return view ? { value: view.percent === null ? null : view.percent / 100, label: view.text } : undefined;
}
