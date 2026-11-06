import type { CompositionDocument } from '@rezics/composition';
import { planReads, platformRegistry } from '@rezics/composition';
import { slug } from '@rezics/definitions/slug';
import type { ReceivedRead, ReceivedZonePage } from './receive.ts';
import { receiveSlotContinuation, withheldSlotRow } from './receive.ts';
import { zoneListHref, zoneMemberHref, zoneVisitHref, type ZoneVisit } from './visit.ts';

export type ZoneSlotProjection = {
  currentHref: string;
  listHref: (node: string, cursor?: string) => string | undefined;
  memberHref: (subject: { id: string; label: string }) => string;
  canonicalHref: (subject: { id: string; label: string }) => string;
  reads: Record<string, ReceivedRead>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueSlotBody(body: unknown): unknown {
  const continuation = receiveSlotContinuation(body);
  if (!continuation || !isRecord(body)) return body;
  if (Array.isArray(body.subjects)) {
    const seen = new Set<string>();
    const subjects = body.subjects.filter((row) => {
      if (!isRecord(row) || typeof row.id !== 'string') return false;
      const key = row.id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      ...body,
      subjects: subjects.map((row) => (withheldSlotRow(row) && isRecord(row) ? { ...row, summary: null } : row)),
      next: continuation.next,
    };
  }
  if (Array.isArray(body.members)) {
    const seen = new Set<string>();
    const members = body.members.filter((row) => {
      if (!isRecord(row) || typeof row.subjectId !== 'string') return false;
      const key = row.subjectId.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      ...body,
      members: members.map((row) => (withheldSlotRow(row) && isRecord(row) ? { ...row, summary: null } : row)),
      next: continuation.next,
    };
  }
  return body;
}

/** Project native Zone reads onto existing TypeList/Members slots without a second scope engine. */
export function projectZoneSlots(page: ReceivedZonePage, visit: ZoneVisit): ZoneSlotProjection {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject ?? null,
  });
  const reads: Record<string, ReceivedRead> = {};
  for (const [key, result] of Object.entries(page.reads)) {
    const descriptor = plan.reads[key];
    if (!descriptor || result.status !== 200) {
      reads[key] = result;
      continue;
    }
    if (descriptor.kind === 'search' || descriptor.kind === 'members') {
      reads[key] = { ...result, body: uniqueSlotBody(result.body) };
      continue;
    }
    reads[key] = result;
  }
  const routeVisit =
    visit.target.kind === 'route' ? visit : { ...visit, target: { kind: 'route' as const, route: '' } };
  return {
    currentHref: zoneVisitHref(visit),
    listHref: (node, cursor) => {
      if (visit.target.kind !== 'route') return undefined;
      void node;
      return zoneListHref(routeVisit, cursor);
    },
    memberHref: (subject) => zoneMemberHref(visit, subject),
    canonicalHref: (subject) =>
      `/${encodeURIComponent(visit.locale)}/subjects/${encodeURIComponent(subject.id)}/${slug(subject.label)}`,
    reads,
  };
}

/** Search TypeList stays on Global configured pages; Zone lists never become `{ route: '/' }` Search targets. */
export function zoneTypeListTarget(_page: ReceivedZonePage): undefined {
  return undefined;
}
