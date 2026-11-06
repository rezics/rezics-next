import { documentRead, planReads, platformRegistry, readCost } from '@rezics/composition';
import { parseFilter, type FilterDocument } from '@rezics/filter';
import canonicalize from 'canonicalize';
import { isDeepStrictEqual } from 'node:util';
import { admitGroup } from '../access/gates/admission.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { ProblemError, PROBLEMS } from '../http/problem.ts';
import { createBuiltinRuntime } from '../library/builtin-runtime.ts';
import { activeProfile } from '../presentation/profiles.ts';
import { semanticPageView } from '../presentation/semantic-page.ts';
import { PageReadBudget, preparePageRead, readPage } from '../presentation/reads.ts';
import { admitObservedMembersPage, admitObservedSearchPage, uniqueCanonicalRows } from '../presentation/slot-bodies.ts';
import type { Actor } from '../request/access.ts';
import { validateHitOptions } from '../search/hits.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { readSubjectSummaries, type SubjectSummary } from '../semantic/summaries.ts';
import { decodeSession, type SessionComponent } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ZonePageRequest, ZonePageResponse } from './contract.ts';
import { createZoneReads } from './resource-reads.ts';
import {
  createZoneMembership,
  zoneDigest,
  zoneUnavailable,
  zoneWork,
  type ZoneMembership,
  type ZoneSourceDependencies,
} from './membership.ts';
import { advanceZoneUnion, initialUnionPosition, revalidateZoneUnion, type ZoneUnionPosition } from './union.ts';
import { zonePageWork, type ZonePagePosition } from './page-work.ts';

/** The sole mounted composition. Static routes need neither exposure nor owner-source construction. */
async function composeZonePage(
  dependencies: ZoneSourceDependencies & { tokens: KeyRing },
  input: {
    actor: Actor;
    id: string;
    body: ZonePageRequest;
    request: Request;
    dispatch: (request: Request) => Promise<Response>;
    deadline: number;
    clientAction: string;
  },
): Promise<{
  value: ZonePageResponse | { next: string };
  status: 200 | 202;
  component: SessionComponent;
  components: SessionComponent[];
}> {
  const route = 'route' in input.body.target ? input.body.target.route : null;
  if (route?.split('/')[0] === 'subjects')
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/target/route', code: 'invalid_format' }] });
  const { languages } = validateHitOptions({ languages: input.body.languages });
  requireAccessDeadline(input.deadline);
  const reads = createZoneReads(dependencies);
  const selected = await reads.page(input.actor, input.id, route, input.deadline);
  let document = selected.document;
  let plan = document === null ? null : planReads(platformRegistry, document, { subject: null });
  const dependent = document === null || plan === null || Object.keys(plan.reads).length > 0;
  if (dependent)
    await admitGroup({
      pool: dependencies.pool,
      access: () => dependencies.access,
      actor: input.actor,
      group: 'zone_sources',
      clientAction: input.clientAction,
      deadline: input.deadline,
      clock: dependencies.clock,
    });
  // Exposure never supplies source permission or a source for an empty union.
  if (document === null && !selected.sources.scopes.length && !selected.sources.mounts.length)
    throw new ProblemError('not_found');
  const active = await activeProfile(dependencies.pool);
  requireAccessDeadline(input.deadline);
  if (!active) return zoneUnavailable();
  const session = {
    ring: dependencies.tokens,
    scope: input.actor.kind === 'account' ? `account:${input.actor.accountId}` : 'anonymous',
  };
  const budget = new PageReadBudget();
  if (!dependent) {
    const page = await readPage({
      dispatch: input.dispatch,
      incoming: input.request,
      reads: plan!.reads,
      session,
      ...(languages ? { languages } : {}),
    });
    return {
      status: 200,
      value: {
        profile: active.digest,
        template: { scope: 'route', key: route },
        document: selected.document,
        reads: page.results,
        zone: selected.zone,
      },
      component: selected.component,
      components: [],
    };
  }
  const work = zoneWork(
    input.deadline,
    plan
      ? Object.values(plan.reads)
          .filter((read) => read.kind === 'search')
          .map(readCost)
      : [128],
  );
  const base = { actor: input.actor, at: selected.time, deadline: input.deadline, sources: selected.sources, work };
  const observed = new Map<string, { status: number; body: unknown }>();
  let subject: string | undefined;
  let views: readonly string[] | undefined;
  let template: ZonePageResponse['template'] = { scope: 'route', key: route };
  const components: SessionComponent[] = [];
  let direct: ZoneMembership | undefined;
  let directPending: import('./membership.ts').ZonePending | undefined;
  const preparation = await zonePageWork(dependencies, {
    id: input.id,
    actor: input.actor,
    body: input.body,
    work,
    basis: zoneDigest({ sources: selected.sources, profile: active.digest }),
    ...(new URL(input.request.url).searchParams.get('cursor')
      ? { cursor: new URL(input.request.url).searchParams.get('cursor')! }
      : {}),
  });
  const position: ZonePagePosition = structuredClone(preparation.position);
  if ('subject' in input.body.target) {
    work.select('target', 'id', 1);
    direct = await createZoneMembership(dependencies, base);
    const prior = position.reads.target;
    const result = await direct.contains(
      input.body.target.subject,
      prior?.basis === direct.basis ? prior.pending : undefined,
    );
    if (result.value === false) throw new ProblemError('not_found');
    if (result.value === 'not_proven') {
      directPending = result.pending;
      if (!directPending) return zoneUnavailable();
      position.reads.target = { ...initialUnionPosition(direct.basis), pending: directPending };
      return {
        status: 202,
        value: { next: await preparation.progress(position) },
        component: selected.component,
        components,
      };
    }
    // The common Subject reader supplies its actual canonical target and current type, never a Source ID hint.
    const probe = await readPage({
      dispatch: input.dispatch,
      incoming: input.request,
      reads: { target: { kind: 'subject', id: input.body.target.subject } },
      session,
      budget,
      ...(languages ? { languages } : {}),
    });
    if (probe.session) components.push(...(decodeSession(dependencies.tokens, session.scope, probe.session) ?? []));
    const resultBody = probe.results.target;
    if (resultBody?.status !== 200) {
      if (resultBody?.status === 404) throw new ProblemError('not_found');
      return zoneUnavailable();
    }
    const entity = (resultBody.body as { subject?: { id: string; type: string } }).subject;
    if (!entity || typeof entity.id !== 'string' || typeof entity.type !== 'string') return zoneUnavailable();
    subject = entity.id;
    const release = await activeRelease(dependencies.pool);
    const page = semanticPageView(active.profile, release?.release, entity.type, input.body.target.view ?? 'overview');
    if (!page) throw new ProblemError('not_found');
    document = page.resolved.document;
    views = page.views;
    template = { scope: page.resolved.scope, key: page.resolved.key };
    observed.set(canonicalize({ kind: 'subject', id: subject })!, resultBody);
    plan = planReads(platformRegistry, document, { subject });
  }
  if (!document || !plan) return zoneUnavailable();
  // Admission includes native list slots even though their result locators are supplied internally to readPage.
  const outstanding = Object.values(plan.reads).filter((read) => !observed.has(canonicalize(read)!));
  budget.admit(
    outstanding.length,
    outstanding.reduce((sum, read) => sum + readCost(read), 0),
  );
  const prepared: {
    key: string;
    membership: ZoneMembership;
    position: ZoneUnionPosition;
    kind: 'search' | 'members';
  }[] = [];
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    if (descriptor.kind !== 'search' && descriptor.kind !== 'members') continue;
    budget.charge(readCost(descriptor));
    work.select(key, descriptor.kind === 'search' ? descriptor.body.sort : 'id', readCost(descriptor));
    let membership: ZoneMembership;
    if (descriptor.kind === 'search') {
      membership = await createZoneMembership(dependencies, {
        ...base,
        order: descriptor.body.sort,
        filter: parseFilter(descriptor.body.filter),
        pageSize: descriptor.body.limit,
      });
    } else {
      const source =
        descriptor.source.kind === 'collection'
          ? { id: descriptor.source.id }
          : await createBuiltinRuntime({ pool: dependencies.pool }).resolve(
              input.actor,
              descriptor.source,
              input.deadline,
            );
      if (!source) {
        observed.set(canonicalize(descriptor)!, { status: 404, body: { code: 'not_found' } });
        continue;
      }
      const union = await createZoneMembership(dependencies, base);
      const sourceMembership = await createZoneMembership(dependencies, {
        ...base,
        sources: { ...selected.sources, scopes: [], mounts: [source.id] },
        ...(descriptor.filter ? { filter: parseFilter(JSON.parse(descriptor.filter) as FilterDocument) } : {}),
      });
      // MemberSource is an essential conjunct, not another OR arm. Its ordinary native provider retains
      // occurrence/fact truth. Only canonical browsing locators enter this page's disposable preparation.
      const streams = sourceMembership.streams.map((stream) => ({
        ...stream,
        async member(id: string, pending?: import('./membership.ts').ZonePending) {
          const own = await stream.member(id, pending?.conjunct === 'zone' ? undefined : pending);
          if (own.value !== true)
            return {
              ...own,
              ...(own.pending ? { pending: { ...own.pending, source: 0, conjunct: 'source' as const } } : {}),
            };
          const match = await union.contains(
            id,
            pending?.conjunct === 'zone' ? { ...pending, source: pending.zoneSource ?? -1 } : undefined,
          );
          return {
            ...match,
            ...(match.pending
              ? {
                  pending: { ...match.pending, source: 0, zoneSource: match.pending.source, conjunct: 'zone' as const },
                }
              : {}),
          };
        },
      }));
      membership = {
        ...sourceMembership,
        streams,
        basis: zoneDigest([sourceMembership.basis, union.basis]),
        async contains(id, pending, _preferred) {
          if (!streams[0]) return { value: false };
          const match = await streams[0].member(id, pending);
          return { ...match, source: 0 };
        },
      };
    }
    const saved = position.reads[key];
    const before = saved?.basis === membership.basis ? saved : initialUnionPosition(membership.basis);
    const step = await advanceZoneUnion(
      membership,
      before,
      readCost(descriptor),
      () => work.allowance().remaining.candidateKeys,
    );
    position.reads[key] = step.position;
    if (!step.complete) {
      if (!step.advanced) return zoneUnavailable();
      // No partial document or native-readiness token; only a changed retained frontier can produce 202.
      return {
        status: 202,
        value: { next: await preparation.progress(position) },
        component: selected.component,
        components,
      };
    }
    prepared.push({ key, membership, position: step.position, kind: descriptor.kind });
  }
  // One native summaries batch over actual selected canonical IDs. It is not a Search page surrogate.
  const ids = [...new Set(prepared.flatMap((read) => read.position.rows.map((row) => row.id)))];
  const summaries = await readSubjectSummaries(
    { ...dependencies, actor: input.actor, deadline: input.deadline },
    ids,
    languages ? { languages } : {},
  );
  for (const read of prepared) {
    const descriptor = plan.reads[read.key]!;
    if (read.position.rows.some((row) => !summaries.get(row.id))) {
      // A retained locator can cease to be readable. Only the native current verdict can repair it;
      // missing summary evidence itself says nothing about membership or exhaustion.
      work.select(read.key, descriptor.kind === 'search' ? descriptor.body.sort : 'id', readCost(descriptor));
      const prior = zoneDigest(read.position);
      if (!(await revalidateZoneUnion(read.membership, read.position)) && zoneDigest(read.position) !== prior) {
        position.reads[read.key] = read.position;
        return {
          status: 202,
          value: { next: await preparation.progress(position) },
          component: selected.component,
          components,
        };
      }
      return zoneUnavailable();
    }
    const mapped: { id: string; type: string; labels: Record<string, string>; summary: SubjectSummary }[] = [];
    for (const row of read.position.rows) {
      const summary = summaries.get(row.id);
      if (!summary) return zoneUnavailable();
      mapped.push({
        id: row.id,
        type: summary.type,
        labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
        summary,
      });
    }
    const rows = uniqueCanonicalRows(mapped);
    const next = null;
    const body =
      read.kind === 'search'
        ? { subjects: rows, next }
        : {
            members: uniqueCanonicalRows(
              rows.map((row) => ({ kind: 'dynamic' as const, subjectId: row.id, summary: row.summary })),
            ),
            next,
          };
    const admitted =
      descriptor.kind === 'search'
        ? admitObservedSearchPage(descriptor, body)
        : admitObservedMembersPage(descriptor, body);
    if (!admitted) return zoneUnavailable();
    const prepared = preparePageRead(descriptor, languages);
    observed.set(prepared.canonical, {
      status: 200,
      body: admitted,
    });
  }
  const properties = subject
    ? Object.keys(
        (observed.get(canonicalize({ kind: 'subject', id: subject })!)?.body as { subject?: { statements?: object } })
          ?.subject?.statements ?? {},
      )
    : [];
  const documents = documentRead(document, subject ?? null, properties);
  const page = await readPage({
    dispatch: input.dispatch,
    incoming: input.request,
    reads: plan.reads,
    session,
    observed,
    budget,
    ...(documents ? { documents } : {}),
    ...(languages ? { languages } : {}),
  });
  if (subject)
    for (const [key, descriptor] of Object.entries(plan.reads)) {
      const result = page.results[key];
      if (
        descriptor.kind === 'subject' &&
        descriptor.id === subject &&
        result?.status === 200 &&
        result.body &&
        typeof result.body === 'object'
      )
        page.results[key] = { ...result, body: { ...result.body, documents: page.documents, account: null } };
    }
  if (page.session) components.push(...(decodeSession(dependencies.tokens, session.scope, page.session) ?? []));
  if (dependent) {
    const current = await reads.page(input.actor, input.id, route, input.deadline);
    if (
      !isDeepStrictEqual(current.sources, selected.sources) ||
      !isDeepStrictEqual(current.document, selected.document)
    )
      return zoneUnavailable();
    if ((await activeProfile(dependencies.pool))?.digest !== active.digest) return zoneUnavailable();
    if (direct && 'subject' in input.body.target) {
      work.select('target', 'id', 1);
      if ((await direct.contains(input.body.target.subject)).value !== true) return zoneUnavailable();
    }
  }
  // Recheck retained rows after ordinary reads and before cursor publication. Unknown final work can itself advance.
  for (const read of prepared) {
    const descriptor = plan.reads[read.key]!;
    work.select(read.key, descriptor.kind === 'search' ? descriptor.body.sort : 'id', readCost(descriptor));
    const prior = zoneDigest(read.position);
    if (!(await revalidateZoneUnion(read.membership, read.position))) {
      if (zoneDigest(read.position) === prior) return zoneUnavailable();
      position.reads[read.key] = read.position;
      return {
        status: 202,
        value: { next: await preparation.progress(position) },
        component: selected.component,
        components,
      };
    }
  }
  let continuation: string | null = null;
  if (prepared.some((read) => !read.position.exhausted)) {
    const following = structuredClone(position);
    for (const read of prepared)
      if (!read.position.exhausted) following.reads[read.key] = { ...read.position, rows: [], exhausted: false };
    continuation = await preparation.progress(following);
  }
  for (const read of prepared) {
    const result = page.results[read.key];
    if (result?.status === 200 && result.body && typeof result.body === 'object')
      page.results[read.key] = {
        ...result,
        body: { ...result.body, next: read.position.exhausted ? null : continuation },
      };
  }
  requireAccessDeadline(input.deadline);
  if (prepared.every((read) => read.position.exhausted)) await preparation.finish();
  const value: ZonePageResponse = {
    profile: active.digest,
    template,
    document,
    reads: page.results,
    zone: selected.zone,
    ...(subject ? { subject } : {}),
    ...(views ? { views: [...views] } : {}),
  };
  return { value, status: 200, component: selected.component, components };
}

/** Preserve native failure reasons while giving every native 503 the page transport's retry profile. */
export async function readZonePage(...args: Parameters<typeof composeZonePage>): ReturnType<typeof composeZonePage> {
  try {
    return await composeZonePage(...args);
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

// Retain the original internal import while every route uses the one composition.
export const readStaticZonePage = readZonePage;
