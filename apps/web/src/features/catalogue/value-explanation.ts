import type { KernelClient, SubjectRead } from '@rezics/client';
import { candidateContext, candidateHasPayload, type CandidateSlot } from '../../subject/candidates';
import { originalLanguage } from '../../subject/language';
import { defaultReader, type Reader } from '../../subject/reader';
import { subjectHref } from '../../subject/subject-href';
import { bestRank, pageText, spoilerLevel } from '../pages/shared';
import { fetchGuideRelease, type GuideRelease } from './definition-guide';
import { readSubjectRevisionDetail, type RevisionDetailPort } from './subject-changes-detail';
import type { DetailRead } from './subject-changes';

export type ValueAddress = { id: string; property: string; statement: string; context?: string };
export type ValueRequest = ValueAddress & {
  locale: string;
  cursor?: string;
  session?: string;
  expectedReader?: string | null;
};
type Statement = SubjectRead['subject']['statements'][string][number];
type Label = ReturnType<typeof pageText>;
type Failure = { kind: 'denied' | 'missing' | 'invalid' | 'unavailable' };
export type ValueCompetition =
  | Failure
  | { kind: 'not-returned'; next: string | null }
  | {
      kind: 'returned';
      decision: 'accepted' | 'rejected' | 'abstained' | null;
      revision: number;
      release: string;
      adoption: 'inherit' | 'replace' | 'suppress' | null;
    };
export type ValuePage = {
  id: string;
  title: Label;
  typeLabel: Label;
  propertyLabel: Label;
  href: string;
  context: string;
  statement?: Statement;
  absence?: 'unresolved' | 'suppressed' | 'not-selected' | 'withheld';
  related: SubjectRead['related'];
  documents?: unknown;
  labels: Record<string, Label>;
  competition?: ValueCompetition;
  change?: DetailRead;
  reviewHref?: string;
};
export type ValueRead = Failure | { kind: 'ready'; page: ValuePage; session?: string };
export type ValueTransport = (cursor?: string, session?: string) => Promise<ValueRead>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function valueRequest(value: unknown): ValueRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid value address');
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    typeof input.statement !== 'string' ||
    !uuid.test(input.statement) ||
    (input.context !== undefined && (typeof input.context !== 'string' || !uuid.test(input.context))) ||
    typeof input.property !== 'string' ||
    !input.property ||
    input.property.length > 256 ||
    typeof input.locale !== 'string' ||
    input.locale.length > 35 ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384)) ||
    (input.expectedReader !== undefined &&
      input.expectedReader !== null &&
      (typeof input.expectedReader !== 'string' || !uuid.test(input.expectedReader)))
  )
    throw new Error('Invalid value address');
  return {
    id: input.id,
    statement: input.statement,
    property: input.property,
    locale: input.locale,
    ...(typeof input.context === 'string' ? { context: input.context } : {}),
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(typeof input.session === 'string' ? { session: input.session } : {}),
    ...(input.expectedReader !== undefined ? { expectedReader: input.expectedReader as string | null } : {}),
  };
}

export function valueExplanationHref(address: ValueAddress & { title: string }, locale: string): string {
  const query = new URLSearchParams({ property: address.property, statement: address.statement });
  if (address.context) query.set('context', address.context);
  return `${subjectHref({ id: address.id, label: address.title }, locale).href}/value?${query}`;
}

function failure(status: number): Failure {
  return {
    kind:
      status === 401 || status === 403
        ? 'denied'
        : status === 404
          ? 'missing'
          : status === 400 || status === 422
            ? 'invalid'
            : 'unavailable',
  };
}

/** Derive the exact native slot only from emitted metadata and this disclosed statement. */
function selectedSlot(statement: Statement, definitions: GuideRelease): CandidateSlot | undefined {
  const property = definitions.properties[statement.property.id];
  if (!property) return;
  const relation = property.relation;
  if (!relation || relation.group === 'classification') return {};
  if (statement.value.type === 'somevalue') {
    const sameAs = statement.qualifiers.find((part) => part.property.id === 'schema:sameAs');
    return sameAs?.value.type === 'value' && typeof sameAs.value.content === 'string'
      ? { sameAs: sameAs.value.content }
      : undefined;
  }
  if (
    statement.value.type !== 'value' ||
    typeof statement.value.content !== 'string' ||
    !uuid.test(statement.value.content)
  )
    return;
  const key = relation.slotKey && statement.qualifiers.find((part) => part.property.id === relation.slotKey);
  if (
    relation.slotKey &&
    (!key || key.value.type !== 'value' || typeof key.value.content !== 'string' || !uuid.test(key.value.content))
  )
    return;
  return {
    target: statement.value.content,
    ...(key && key.value.type === 'value' && typeof key.value.content === 'string' ? { key: key.value.content } : {}),
  };
}

/** One current read establishes the fact. One bounded slot page can add metadata, never replace it. */
export async function readValueExplanation(
  client: KernelClient,
  input: ValueRequest,
  options: {
    authorization?: string;
    reader?: Reader | Promise<Reader>;
    definitions?: (digest: string) => Promise<GuideRelease>;
    detail?: RevisionDetailPort;
  } = {},
): Promise<ValueRead> {
  try {
    valueRequest(input);
    const headers = {
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(input.session ? { 'rezics-session-token': input.session } : {}),
    };
    const endpoint = client.subjects({ id: input.id });
    const current = await endpoint.get({ headers, fetch: { cache: 'no-store', redirect: 'manual' } });
    if (current.status !== 200 || !current.data) return failure(current.status);
    const { subject, related } = current.data;
    if (subject.id !== input.id) return { kind: 'unavailable' };
    // An editorial/Realm link cannot silently turn into a different Global reading.
    // The owning Realm resolver must bind that journey before it can be offered here.
    if (input.context && input.context !== subject.context) return { kind: 'unavailable' };
    const title = pageText(subject.labels, input.locale, originalLanguage(subject));
    const page: ValuePage = {
      id: subject.id,
      title,
      typeLabel: pageText(undefined, input.locale),
      propertyLabel: pageText(related[input.property]?.labels, input.locale),
      href: subjectHref({ id: subject.id, label: title.text }, input.locale).href,
      context: subject.context,
      related,
      labels: {},
    };
    const statement = bestRank(subject.statements[input.property] ?? []).find((item) => item.id === input.statement);
    if (!statement) {
      page.absence = subject.resolution[input.property] ?? 'not-selected';
      return { kind: 'ready', page };
    }
    // A link is not permission to reveal a spoiler that the current reader has not opened.
    const reader = await Promise.resolve(options.reader ?? defaultReader).catch(() => defaultReader);
    if (spoilerLevel(statement) > reader.spoilerLevel) {
      page.absence = 'withheld';
      return { kind: 'ready', page };
    }
    const selected = subject.statements[input.property]!.find((item) => item.id === statement.id)!;
    page.statement = selected;
    // No document point reads or parser: only the current response's authorized representation is eligible.
    page.documents = Reflect.get(current.data, 'documents');
    const session = new Headers(current.headers).get('rezics-session-token') ?? input.session;
    const boundHeaders = { ...headers, ...(session ? { 'rezics-session-token': session } : {}) };
    const [definitions, detail] = await Promise.all([
      (options.definitions
        ? options.definitions(selected.rezics.release)
        : fetchGuideRelease(client, selected.rezics.release, boundHeaders)
      ).catch(() => undefined),
      (options.detail ?? readSubjectRevisionDetail)(client, {
        id: subject.id,
        revision: selected.rezics.revision,
        locale: input.locale,
        ...(options.authorization ? { authorization: options.authorization } : {}),
        ...(session ? { session } : {}),
      }).catch((): DetailRead => ({ kind: 'unavailable' })),
    ]);
    if (detail.kind !== 'ready' && detail.scope === 'subject')
      return {
        kind:
          detail.kind === 'denied' || detail.kind === 'missing' || detail.kind === 'invalid'
            ? detail.kind
            : 'unavailable',
      };
    let continuationSession = detail.kind === 'ready' ? (detail.session ?? session) : session;
    page.typeLabel = pageText(definitions?.types[subject.type]?.labels, input.locale);
    page.propertyLabel = pageText(
      related[input.property]?.labels ?? definitions?.properties[input.property]?.labels,
      input.locale,
    );
    for (const part of [...selected.qualifiers, ...selected.references.flatMap((reference) => reference.parts)])
      page.labels[part.property.id] = pageText(
        related[part.property.id]?.labels ?? definitions?.properties[part.property.id]?.labels,
        input.locale,
      );
    const summary = detail.kind === 'ready' ? detail.detail.summary : undefined;
    page.change =
      detail.kind !== 'ready'
        ? detail
        : detail.detail.id === subject.id &&
            detail.detail.revision === selected.rezics.revision &&
            (summary?.kind === 'limited' ||
              ((summary?.kind === 'candidate' || summary?.kind === 'decision') &&
                summary.candidate === selected.id &&
                summary.property === input.property &&
                (summary.context === undefined || summary.context === subject.context)) ||
              (summary?.kind === 'adoption' &&
                summary.property === input.property &&
                summary.context === subject.context &&
                summary.selection?.some((entry) => entry.candidate === selected.id)))
          ? { ...detail, detail: { ...detail.detail, propertyLabel: page.propertyLabel } }
          : { kind: 'unavailable' };
    const slot = definitions && selectedSlot(selected, definitions);
    if (!slot) page.competition = { kind: 'unavailable' };
    else {
      const query = new URLSearchParams({ candidateField: input.property });
      if (subject.context === candidateContext) {
        if (Object.keys(slot).length) {
          const relationQuery = new URLSearchParams({ property: input.property, ...slot });
          page.reviewHref = `${page.href}/relation-edit?${relationQuery}`;
        } else page.reviewHref = `${page.href}/details?${query}#candidate-review`;
      }
      const candidates = await endpoint.candidates
        .get({
          headers: boundHeaders,
          fetch: { cache: 'no-store', redirect: 'manual' },
          query: {
            property: input.property,
            context: subject.context,
            ...slot,
            limit: 20,
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          },
        })
        .catch(() => null);
      if (!candidates) page.competition = { kind: 'unavailable' };
      else if (candidates.status !== 200 || !candidates.data) page.competition = failure(candidates.status);
      else {
        continuationSession = new Headers(candidates.headers).get('rezics-session-token') ?? continuationSession;
        const candidate = candidates.data.candidates.find((row) => row.id === selected.id);
        // Never serialize unrelated candidates, actors, Source tuples or write heads into this view.
        page.competition =
          candidate && candidateHasPayload(candidate)
            ? {
                kind: 'returned',
                decision: candidate.decision,
                revision: candidate.revision,
                release: candidate.release,
                adoption: candidates.data.adoption?.mode ?? null,
              }
            : { kind: 'not-returned', next: candidates.data.next };
      }
    }
    return { kind: 'ready', page, ...(continuationSession ? { session: continuationSession } : {}) };
  } catch {
    return { kind: 'unavailable' };
  }
}
