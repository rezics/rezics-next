import type { KernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { readWorkParts } from '../../features/catalogue/work-parts';
import {
  EPISODE_INSPECT_CAP,
  EPISODE_MEMBERSHIP_SEAM,
  EPISODE_READ_SEAM,
  preserveInspectOrder,
  projectRow,
  type ChecklistRow,
  type ChecklistViewerBinding,
  type ChecklistVisit,
} from './contract';
import { labelledRows, projectMembership, type MembershipPage } from './membership';
import { episodeCommandsAvailable, episodeChecklistMethods, inspectEpisodes } from './native';
import { emptyChecklistWork, finishChecklistWork, observeChecklistWork, type ChecklistWork } from './cost';
import { preparingVisit, readyVisit, unavailableVisit } from './controller';

export type EpisodeLoad =
  | { state: 'signed-out'; work: ChecklistWork; visit: ChecklistVisit }
  | { state: 'denied'; work: ChecklistWork; visit: ChecklistVisit }
  | { state: 'unavailable'; work: ChecklistWork; visit: ChecklistVisit }
  | { state: 'ready'; work: ChecklistWork; visit: ChecklistVisit; membership: MembershipPage };

async function bearer(request: Request, env: Partial<SessionEnv>): Promise<string | null> {
  if (await prepareSession(request, env)) return null;
  return viewerCredential(request);
}

export type IndexViewerEnvelope = {
  viewer: string | null;
  requested: { subjectId: string; cursor: string | null };
  locale: string;
};

export function bindFromIndex(
  envelope: IndexViewerEnvelope,
  sessionId: string,
  revision: number,
): ChecklistViewerBinding | null {
  if (!envelope.viewer) return null;
  return {
    viewer: envelope.viewer,
    locale: envelope.locale,
    subjectId: envelope.requested.subjectId,
    sessionId,
    revision,
    cursor: envelope.requested.cursor,
  };
}

export function bindFromDetail(input: {
  viewer: string | null;
  locale: string;
  subjectId: string;
  sessionId: string;
  revision: number;
}): ChecklistViewerBinding | null {
  if (!input.viewer) return null;
  return {
    viewer: input.viewer,
    locale: input.locale,
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    revision: input.revision,
  };
}

function completenessOf(value: { completeness?: number } | undefined): number | 'unavailable' {
  return typeof value?.completeness === 'number' ? value.completeness : 'unavailable';
}

export async function loadEpisodeChecklist(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  binding: ChecklistViewerBinding | null,
  release: Pick<Release, 'types' | 'properties'> | Promise<Pick<Release, 'types' | 'properties'>>,
): Promise<EpisodeLoad> {
  const calls: string[] = [];
  const observed = observeChecklistWork(client, (name) => calls.push(name));
  const unsigned = (): EpisodeLoad => ({
    state: 'signed-out',
    work: emptyChecklistWork(),
    visit: { ...preparingVisit(null), kind: 'denied' },
  });
  if (!binding) return unsigned();
  if (!episodeCommandsAvailable(observed)) {
    const methods = episodeChecklistMethods(client);
    const visit = unavailableVisit(binding, methods.seam);
    return { state: 'unavailable', work: emptyChecklistWork(), visit };
  }
  const authorization = await bearer(request, env);
  if (!authorization) return unsigned();
  try {
    const definitions = await release;
    const parts = await readWorkParts(
      observed,
      authorization,
      definitions,
      binding.subjectId,
      binding.locale,
      'inverse:schema:isPartOf',
    );
    const membership = projectMembership(parts, definitions);
    if (membership.state !== 'admitted') {
      const work = finishChecklistWork(calls, [], { membership: membership.state }, 0, 0);
      return {
        state: 'ready',
        work,
        membership,
        visit: {
          ...readyVisit(binding, [], { membership: 'unavailable' }),
          kind: 'ready',
          membership: 'unavailable',
        },
      };
    }
    const ids = membership.candidates.map((candidate) => candidate.id).slice(0, EPISODE_INSPECT_CAP);
    if (!ids.length) {
      const work = finishChecklistWork(calls, [], { membership: 'empty' }, 0, 0);
      return {
        state: 'ready',
        work,
        membership,
        visit: readyVisit(binding, [], { membership: 'empty' }),
      };
    }
    const inspected = await inspectEpisodes(observed, binding.sessionId, authorization, { ids });
    if (!inspected.ok) {
      const kind = inspected.kind === 'not_found' ? 'retired' : inspected.kind === 'denied' ? 'denied' : 'unavailable';
      const visit = unavailableVisit(binding, inspected.seam ?? EPISODE_READ_SEAM, kind);
      return {
        state: inspected.kind === 'denied' || inspected.kind === 'not_found' ? 'denied' : 'unavailable',
        work: finishChecklistWork(calls, [], null, membership.candidates.length, 0),
        visit,
      };
    }
    const rows = labelledRows(preserveInspectOrder(ids, inspected.view.episodes), membership.candidates);
    const retained = {
      revision: inspected.view.revision,
      ids,
      rows: rows.map((row) => ({
        episodeSubjectId: row.episodeSubjectId,
        completed: row.completed,
        membership: row.membership,
        ordinal: row.ordinal,
      })),
    };
    const work = finishChecklistWork(calls, rows, retained, membership.candidates.length, ids.length);
    return {
      state: 'ready',
      work,
      membership,
      visit: readyVisit(binding, rows, {
        membership: 'admitted',
        inspectRevision: inspected.view.revision,
        completeness: completenessOf(inspected.view),
      }),
    };
  } catch (error) {
    if (isPlatformClosedError(error)) {
      return {
        state: 'unavailable',
        work: finishChecklistWork(calls, [], null, 0, 0),
        visit: unavailableVisit(binding, EPISODE_MEMBERSHIP_SEAM),
      };
    }
    return {
      state: 'unavailable',
      work: finishChecklistWork(calls, [], null, 0, 0),
      visit: unavailableVisit(binding, EPISODE_READ_SEAM),
    };
  }
}

export async function continueRetainedEpisodes(
  client: KernelClient,
  sessionId: string,
  authorization: string,
  cursor?: string,
): Promise<
  | { rows: ChecklistRow[]; next: string | null; revision: number }
  | { kind: 'stale' | 'unavailable' | 'retired' | 'denied' }
> {
  const inspected = await inspectEpisodes(client, sessionId, authorization, {
    ...(cursor ? { cursor } : {}),
    limit: EPISODE_INSPECT_CAP,
  });
  if (!inspected.ok) {
    if (inspected.kind === 'stale_cursor') return { kind: 'stale' };
    if (inspected.kind === 'not_found') return { kind: 'retired' };
    if (inspected.kind === 'denied') return { kind: 'denied' };
    return { kind: 'unavailable' };
  }
  return {
    rows: inspected.view.episodes.map((row) => projectRow(row, 'retained')),
    next: inspected.view.next,
    revision: inspected.view.revision,
  };
}

export async function readbackInspect(
  client: KernelClient,
  sessionId: string,
  authorization: string,
  ids: readonly string[],
): Promise<{ rows: ChecklistRow[]; revision: number } | { kind: 'unavailable' | 'retired' | 'denied' }> {
  const inspected = await inspectEpisodes(client, sessionId, authorization, { ids });
  if (!inspected.ok) {
    if (inspected.kind === 'not_found') return { kind: 'retired' };
    if (inspected.kind === 'denied') return { kind: 'denied' };
    return { kind: 'unavailable' };
  }
  return { rows: preserveInspectOrder(ids, inspected.view.episodes), revision: inspected.view.revision };
}
