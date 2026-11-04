import type { PageRead } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import type { SubjectSummary } from '../../../media/summary';
import type { OverviewValue, Section } from '../../pages/overview';
import { isRecord, type Snak, type Stmt } from '../../pages/shared';
import { candidateContext } from '../../../subject/candidates';
import { subjectViewHref } from '../../../subject/subject-href';
import {
  relationDraft,
  relationSlotMatches,
  validRelationSlot,
  type RelationRead,
  type RelationSlot,
} from '../../../subject/relation-candidates';

export type CreditAssertion = {
  holder: string;
  statement: Stmt & { rezics: { release: string; revision: number } };
  related: Record<string, NonNullable<SubjectSummary>>;
  slot?: RelationSlot;
};

/** In-memory visit identity. The descriptor and its opaque cursor never become a return URL. */
export type CreditVisit = {
  person: string;
  node: string;
  stream: PageRead;
  context: string;
  reader: string | null;
  release: string;
  propertyLabel: string;
  realm?: string | undefined;
};

export function creditVisit(
  value: OverviewValue,
  node: string,
  section: Section,
  view: string,
): CreditVisit | undefined {
  if (view !== 'works' || !value.subject || !section.ok || section.read.kind !== 'links') return;
  const property = section.read.property;
  const admission = value.relationDirections?.find(
    (entry) => entry.state === 'admitted' && entry.property === property && entry.direction === 'inverse',
  );
  if (admission?.state !== 'admitted') return;
  return {
    person: value.subject,
    node,
    stream: section.read,
    context: value.context?.id ?? candidateContext,
    reader: value.cacheReader ?? null,
    release: admission.release,
    propertyLabel: (property && value.relations[property]?.forwardLabel) || property || '',
    realm: value.realm,
  };
}

/** Refresh only the native original window, never an arbitrary return address or a replacement candidate. */
export function creditWindowHref(visit: CreditVisit, locale: string): string {
  const cursor = visit.stream.kind === 'links' ? visit.stream.cursor : undefined;
  const query = new URLSearchParams({
    node: visit.node,
    ...(cursor ? { cursor } : {}),
    ...(visit.realm ? { realm: visit.realm } : {}),
  });
  return `${subjectViewHref({ id: visit.person, label: '' }, locale, 'works')}?${query}`;
}

function snak(value: unknown): value is Snak & Record<string, unknown> {
  return (
    isRecord(value) &&
    isRecord(value.property) &&
    typeof value.property.id === 'string' &&
    typeof value.property.data_type === 'string' &&
    isRecord(value.value) &&
    typeof value.value.type === 'string'
  );
}

/** A row is inspected only under its delivered holder/property/statement identity. */
export function creditAssertion(row: Record<string, unknown>): CreditAssertion | undefined {
  const assertion = row.assertion;
  if (
    typeof row.subject !== 'string' ||
    !isRecord(assertion) ||
    !snak(assertion) ||
    assertion.id !== row.statement ||
    assertion.property.id !== row.property ||
    !Array.isArray(assertion.qualifiers) ||
    !assertion.qualifiers.every(snak) ||
    !Array.isArray(assertion.references) ||
    !assertion.references.every(
      (reference) => isRecord(reference) && Array.isArray(reference.parts) && reference.parts.every(snak),
    ) ||
    !isRecord(assertion.rezics) ||
    typeof assertion.rezics.release !== 'string' ||
    !Number.isSafeInteger(assertion.rezics.revision) ||
    Number(assertion.rezics.revision) < 1
  )
    return;
  const rawSlot = row.creditSlot;
  const slot =
    isRecord(rawSlot) &&
    validRelationSlot(rawSlot as RelationSlot) &&
    rawSlot.property === row.property &&
    assertion.value.type === 'value' &&
    rawSlot.target === assertion.value.content
      ? (rawSlot as RelationSlot)
      : undefined;
  const related = Object.fromEntries(
    Object.entries(isRecord(row.related) ? row.related : {}).filter(
      ([id, summary]) => isRecord(summary) && summary.id === id,
    ),
  );
  return {
    holder: row.subject,
    statement: assertion as CreditAssertion['statement'],
    related: related as CreditAssertion['related'],
    ...(slot ? { slot } : {}),
  };
}

/** Adapt only supplied current labels to the lossless shared value renderer. */
export function creditRelated(credit: CreditAssertion): SubjectRead['related'] {
  return Object.fromEntries(
    Object.entries(credit.related).flatMap(([id, summary]) => {
      const label = summary.label;
      return label && typeof label !== 'string' && label.value && label.language
        ? [[id, { labels: { [label.language]: label.value } }]]
        : [];
    }),
  );
}

function publicIdentity(value: unknown): string {
  return JSON.stringify(value, (_key, part: unknown) =>
    isRecord(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part,
  );
}

export type CreditCorrection =
  | { state: 'unavailable' | 'denied' | 'stale' }
  | {
      state: 'ready';
      read: Extract<RelationRead, { ok: true }>;
      composition: {
        statement: ReturnType<typeof relationDraft>;
        slot: RelationSlot;
        positionEditable: false;
        qualifiersEditable: true;
        session?: string | undefined;
      };
    };

/** One bounded native page; never search continuation pages for a matching candidate. */
export function creditCorrection(credit: CreditAssertion, visit: CreditVisit, read: RelationRead): CreditCorrection {
  if (!read.ok)
    return { state: read.reason === 'denied' ? 'denied' : read.reason === 'stale' ? 'stale' : 'unavailable' };
  if (
    !credit.slot ||
    visit.context !== candidateContext ||
    read.public.subject.id !== credit.holder ||
    read.public.subject.context !== visit.context
  )
    return { state: 'unavailable' };
  const statement = credit.statement;
  const current = read.public.subject.statements[statement.property.id]?.find((entry) => entry.id === statement.id);
  if (
    !current ||
    current.rezics.revision !== statement.rezics.revision ||
    current.rezics.release !== statement.rezics.release ||
    publicIdentity(current) !== publicIdentity(statement)
  )
    return { state: 'stale' };
  const field = read.fields.find((entry) => entry.id === statement.property.id);
  const candidate = read.page?.candidates.find((entry) => entry.id === statement.id && !entry.retracted);
  // Only the authorized payload supplies a draft. Public filtering can omit facts a correction must preserve.
  if (!field || !candidate || !relationSlotMatches(candidate.statement, credit.slot, field))
    return { state: 'unavailable' };
  const authority = read.authority;
  if (
    read.viewer !== 'signed-in' ||
    !authority ||
    authority.disclosure !== 'available' ||
    authority.actions.state !== 'available' ||
    authority.actions.context !== visit.context
  )
    return { state: 'unavailable' };
  if (!authority.actions.operations.includes('subject.propose')) return { state: 'denied' };
  const subjectAdvice = authority.viewerActions?.subjects[credit.holder];
  if (
    subjectAdvice?.state !== 'available' ||
    !subjectAdvice.actions.some(
      (entry) => entry.action === 'subject:read' && entry.operations.includes('subject.list_candidates'),
    )
  )
    return { state: 'denied' };
  return {
    state: 'ready',
    read,
    composition: {
      statement: relationDraft(candidate.statement),
      slot: credit.slot,
      positionEditable: false,
      qualifiersEditable: true,
      session: read.session,
    },
  };
}
