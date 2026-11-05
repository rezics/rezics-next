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

import {
  prepareShelfWorkContext,
  suppliedShelfFacts,
  type ShelfWorkContext,
  type ShelfEntryIdentity,
} from './shelf-work-context/context';

export type LabelShelfEntry = {
  entryIdentity?: ShelfEntryIdentity | null;
  workContext?: ShelfWorkContext | null;
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
  | { state: 'unavailable'; sessionUnavailable?: true }
  | { state: 'cursor-rejected'; labelId: string }
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

export type LabelShelfInput = {
  labelId: string;
  cursor?: string;
  limit: number;
  undo?: SubjectLabelUndo & { subjectId: string };
  labelResult?: string;
  undoKey?: string;
};

export type LabelShelfSource = {
  labelId: string;
  cursor: string | null;
  undo: (SubjectLabelUndo & { subjectId: string }) | null;
  labelResult: string | null;
  undoKey: string | null;
};

export function labelShelfSource(input: Omit<LabelShelfInput, 'limit'>): LabelShelfSource {
  return {
    labelId: input.labelId,
    cursor: input.cursor || null,
    undo: input.undo ?? null,
    labelResult: input.labelResult ?? null,
    undoKey: input.undoKey ?? null,
  };
}

/** Additive route envelope; the public page reader below retains its original result shape. */
export type CurrentLabelShelfData = LabelShelfPageData & {
  provenance: { subject: string | null; locale: string; source: LabelShelfSource };
};

export async function loadCurrentLabelShelfPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: LabelShelfInput,
): Promise<CurrentLabelShelfData> {
  const { result, provenance } = await readLabelShelfPage(client, request, sessionEnv, input);
  return { ...result, provenance };
}

/** One FULL assignment page supplies every tile, its page heading and next cursor. */
export async function loadLabelShelfPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: LabelShelfInput,
): Promise<LabelShelfPageData> {
  return (await readLabelShelfPage(client, request, sessionEnv, input)).result;
}

async function readLabelShelfPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: LabelShelfInput,
): Promise<{ result: LabelShelfPageData; provenance: CurrentLabelShelfData['provenance'] }> {
  const provenance: CurrentLabelShelfData['provenance'] = {
    subject: null,
    locale: requestLocale(request) ?? 'en',
    source: labelShelfSource(input),
  };
  const finish = (result: LabelShelfPageData) => ({ result, provenance });
  try {
    const identity = await readSubjectSlotSession(request, sessionEnv);
    if (identity.state === 'signed-out') return finish({ state: 'signed-out' });
    if (identity.state === 'unavailable')
      return finish({ state: 'unavailable', ...(identity.sessionUnavailable ? { sessionUnavailable: true } : {}) });
    if (!identity.subject.trim()) return finish({ state: 'unavailable' });
    provenance.subject = identity.subject;
    const authorization = identity.authorization;
    const exposure = await client.platform.exposure.get({ headers: { authorization } });
    const admitted = readLibraryResult(exposure).admitted;
    if (
      !admitted.includes('personal_library') ||
      !admitted.includes('reading_progress') ||
      !admitted.includes('library_label.assignment_list')
    )
      return finish({ state: 'closed' });
    let result: Awaited<ReturnType<typeof client.libraryLabelAssignments.get>>;
    try {
      result = await client.libraryLabelAssignments.get({
        query: {
          labelId: input.labelId,
          view: 'FULL',
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        headers: { authorization },
      });
    } catch (error) {
      if (input.cursor && error instanceof Error && error.name === 'StaleCursorError')
        return finish({ state: 'cursor-rejected', labelId: input.labelId });
      throw error;
    }
    if (isPlatformClosedProblem(result.status, result.error?.value)) return finish({ state: 'closed' });
    if (result.status === 401 || result.status === 403) return finish({ state: 'denied' });
    const problem: unknown = result.error?.value;
    const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
    if (
      input.cursor &&
      ((result.status === 400 && code === 'invalid_cursor') || (result.status === 409 && code === 'stale_cursor'))
    )
      return finish({ state: 'cursor-rejected', labelId: input.labelId });
    if (code === 'index_not_ready' || code === 'semantic_not_ready') return finish({ state: 'preparing' });
    const page = readLibraryResult(result);
    if (!('label' in page) || page.label.id !== input.labelId)
      throw new Error('FULL label shelf omitted its label summary');
    const locale = provenance.locale;
    const release = await readRelease().catch(() => undefined);
    return finish({
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
        const entryIdentity = entry
          ? {
              subjectId: entry.subjectId,
              revision: entry.revision,
              incarnationId: entry.incarnationId,
            }
          : null;
        return {
          id: row.id,
          removeKey: crypto.randomUUID(),
          labelId: row.labelId,
          subjectId: row.subjectId,
          revision: row.revision,
          subject,
          entryIdentity,
          workContext: prepareShelfWorkContext(
            { ...row, subject, entryIdentity, facts: suppliedShelfFacts(row) },
            release,
            locale,
          ),
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
    });
  } catch (error) {
    if (isPlatformClosedError(error)) return finish({ state: 'closed' });
    if (error && typeof error === 'object' && 'isNotFound' in error) throw error;
    if (error instanceof Error && error.name === 'StaleCursorError') throw error;
    return finish({ state: 'unavailable' });
  }
}

export function labelShelfProgress(entry: LabelShelfEntry, locale: string) {
  const view = progressView(entry.activeProgressSession ?? null, locale);
  return view ? { value: view.percent === null ? null : view.percent / 100, label: view.text } : undefined;
}
