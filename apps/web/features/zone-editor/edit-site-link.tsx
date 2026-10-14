import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';
import type { MainClient } from '../discover/types.ts';
import { settle } from '../manage/read.ts';
import type { Loaded, ReadFailure } from '../manage/types.ts';
import { recordedReplayGap } from '../realm/zone-presentation-read.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { zoneEditorPath } from './routes.ts';

export interface ShowcaseEditorProblem {
  status: number;
  title: string;
  code: string;
}

export type ShowcaseEditorAuthority =
  | { ok: true }
  | { ok: false; failure: ReadFailure; problem: ShowcaseEditorProblem | null };

function editorProblem(status: number, value: unknown): ShowcaseEditorProblem | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== 'string' || typeof body.code !== 'string') return null;
  if (typeof body.status === 'number' && body.status !== status) return null;
  return { status, title: body.title, code: body.code };
}

/**
 * The showcase-editor read, on the caller's client. A refusal is no link.
 * Production caches it through the session token; a story supplies the replaying client.
 * A recorded gap stays a gap instead of becoming an ordinary unavailable read.
 */
export async function readShowcaseEditor(client: MainClient, zoneId: string, actingSubject: string): Promise<{
  loaded: Loaded<unknown>;
  problem: ShowcaseEditorProblem | null;
}> {
  let problem: ShowcaseEditorProblem | null = null;
  let gap: unknown;
  const loaded = await settle(async () => {
    try {
      const answer = await client.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } });
      if (recordedReplayGap(answer.error?.value)) gap = answer.error?.value;
      else if (answer.error) problem = editorProblem(answer.error.status, answer.error.value);
      return answer;
    } catch (error) {
      if (recordedReplayGap(error)) gap = error;
      throw error;
    }
  }, { management: true });
  if (gap) throw gap;
  return { loaded, problem: loaded.ok ? null : problem };
}

export function showcaseEditorAuthority(read: {
  loaded: Loaded<unknown>;
  problem: ShowcaseEditorProblem | null;
}): ShowcaseEditorAuthority {
  if (!read.loaded.ok) return { ok: false, failure: read.loaded.failure, problem: read.problem };
  return { ok: true };
}

/** The edit-site control. The label is the caller's already chosen translation. */
export function ZoneEditSiteLink({ space, className, children }: {
  space: string;
  className?: string;
  children: ReactNode;
}) {
  return <LocalizedLink href={zoneEditorPath(space)} documentNavigation
    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), className)}>
    {children}
  </LocalizedLink>;
}
