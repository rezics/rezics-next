import { isDeepStrictEqual } from 'node:util';
import { admitGroup } from '../access/gates/admission.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { ProblemError, PROBLEMS } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { readSubjectSummaryObservation } from '../semantic/summaries.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SearchService } from '../search/service-scope.ts';
import type { Pool } from 'pg';
import {
  createZoneMembership,
  zoneDigest,
  zoneUnavailable,
  zoneWork,
  type ZoneSourceDependencies,
} from './membership.ts';
import { advanceZoneUnion, initialUnionPosition, revalidateZoneUnion } from './union.ts';
import { zonePageWork } from './page-work.ts';
import { createZoneReads } from './resource-reads.ts';
import type { ZoneSubjectListItem, ZoneSubjectListResponse } from './contract.ts';

const LIST_ROUTE = 'GET /v1/zones/:id/subjects';

export type ZoneSubjectListResult =
  | {
      value: ZoneSubjectListResponse;
      status: 200;
      component: SessionComponent;
      components: SessionComponent[];
    }
  | {
      value: { next: string };
      status: 202;
      component: SessionComponent;
      components: SessionComponent[];
    };

async function composeZoneSubjects(
  dependencies: ZoneSourceDependencies & { tokens: KeyRing; search?: SearchService },
  input: {
    actor: Actor;
    id: string;
    limit?: number;
    cursor?: string;
    deadline: number;
    clientAction: string;
  },
): Promise<ZoneSubjectListResult> {
  const limit = input.limit ?? 20;
  requireAccessDeadline(input.deadline);
  const reads = createZoneReads(dependencies);
  const selected = await reads.page(input.actor, input.id, null, input.deadline);
  await admitGroup({
    pool: dependencies.pool,
    access: () => dependencies.access,
    actor: input.actor,
    group: 'zone_sources',
    clientAction: input.clientAction,
    deadline: input.deadline,
    clock: dependencies.clock,
  });
  const work = zoneWork(input.deadline);
  work.select('list', 'id', limit);
  const membership = await createZoneMembership(dependencies, {
    actor: input.actor,
    at: selected.time,
    deadline: input.deadline,
    sources: selected.sources,
    work,
  });
  const basis = zoneDigest({
    operation: LIST_ROUTE,
    sources: selected.sources,
    streams: membership.streams.map((stream) => stream.basis),
    profile: selected.zone.revision,
  });
  const preparation = await zonePageWork(dependencies, {
    id: input.id,
    actor: input.actor,
    body: { operation: LIST_ROUTE, limit },
    work,
    basis,
    route: LIST_ROUTE,
    profile: 'default',
    query: { zone: input.id, limit },
    unusable: 'stale',
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  const position = structuredClone(preparation.position);
  const saved = position.reads.list;
  const before = saved?.basis === membership.basis ? saved : initialUnionPosition(membership.basis);
  const step = await advanceZoneUnion(membership, before, limit, () => work.allowance().remaining.candidateKeys);
  position.reads.list = step.position;
  if (!step.complete) {
    if (!step.advanced) return zoneUnavailable();
    return {
      status: 202,
      value: { next: await preparation.progress(position) },
      component: selected.component,
      components: [],
    };
  }
  work.select('list', 'id', limit);
  const prior = zoneDigest(step.position);
  if (!(await revalidateZoneUnion(membership, step.position))) {
    if (zoneDigest(step.position) === prior) return zoneUnavailable();
    position.reads.list = step.position;
    return {
      status: 202,
      value: { next: await preparation.progress(position) },
      component: selected.component,
      components: [],
    };
  }
  const ids = [...new Set(step.position.rows.map((row) => row.id))];
  const observation = await readSubjectSummaryObservation(
    { ...dependencies, actor: input.actor, deadline: input.deadline },
    ids,
  );
  for (const id of ids) if (!observation.summaries.get(id)) return zoneUnavailable();
  if (!(await observation.current())) return zoneUnavailable();
  const current = await reads.page(input.actor, input.id, null, input.deadline);
  if (!isDeepStrictEqual(current.sources, selected.sources)) return zoneUnavailable();
  requireAccessDeadline(input.deadline);
  const subjects: ZoneSubjectListItem[] = step.position.rows.map((row) => {
    const summary = observation.summaries.get(row.id)!;
    return {
      id: row.id,
      type: summary.type,
      labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
      summary,
    };
  });
  let next: string | null = null;
  if (!step.position.exhausted) {
    const following = structuredClone(position);
    following.reads.list = { ...step.position, rows: [], exhausted: false };
    next = await preparation.progress(following);
  } else await preparation.finish();
  return {
    status: 200,
    value: { subjects, next },
    component: selected.component,
    components: [...observation.components],
  };
}

export async function readZoneSubjects(
  dependencies: {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock: () => Date;
    routeKey: Uint8Array;
    search?: SearchService;
  },
  input: Parameters<typeof composeZoneSubjects>[1],
): Promise<ZoneSubjectListResult> {
  try {
    return await composeZoneSubjects(dependencies, input);
  } catch (error) {
    if (!(error instanceof ProblemError) || PROBLEMS[error.code].status !== 503) throw error;
    throw new ProblemError(error.code, {
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errors === undefined ? {} : { errors: error.errors }),
      ...(error.extensions === undefined ? {} : { extensions: error.extensions }),
      ...(error.effectStatus === undefined ? {} : { effectStatus: error.effectStatus }),
      headers: { 'retry-after': '1', ...error.headers, 'cache-control': 'private, no-store' },
    });
  }
}
