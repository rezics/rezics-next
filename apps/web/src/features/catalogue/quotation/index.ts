import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkDocument } from '@rezics/document';
import { candidateFailure, type CandidateFailure, type CandidateViewerActions } from '../../../subject/candidates';
import { readCorrectionActions } from '../statement-editor';
import { personBounds, personEvidenceFits } from '../person-reader/model';
import { typeExtends, QUOTATION_PAGE_CAP } from '../../pages/graph-browser';
import { spoilerLevel, webUrl } from '../../pages/shared';
import { readAuthoredBody, type AuthoredBody, type AuthoredDocument } from '../authored-field';

export const quotationRequested = {
  type: 'schema:Quotation',
  speaker: ['schema:spokenByCharacter'] as const,
  credited: ['schema:creator'] as const,
  work: ['schema:isPartOf', 'schema:about'] as const,
  voice: ['schema:recordedBy', 'schema:actor'] as const,
  text: ['schema:text', 'schema:abstract'] as const,
};

export type QuotationContextKind = 'speaker' | 'credited' | 'work' | 'voice';
export type QuotationContextStatus =
  | 'current'
  | 'unknown'
  | 'concealed'
  | 'restricted'
  | 'missing'
  | 'withheld'
  | 'unsupported';
export type QuotationAssertion = {
  holder: string;
  context: string;
  release: string;
  revision: number;
  statement: Statement;
};
export type QuotationContext = {
  assertion?: QuotationAssertion | undefined;
  spoiler?: boolean | undefined;
  qualifiers?: QuotationPart[] | undefined;
  references?: QuotationReference[] | undefined;
  kind: QuotationContextKind;
  status: QuotationContextStatus;
  property?: string | undefined;
  statementId?: string | undefined;
  id?: string | undefined;
  label?: string | undefined;
};
export type QuotationPart = {
  property: string;
  label: string;
  status: QuotationContextStatus;
  value?: string | undefined;
  language?: string | undefined;
  id?: string | undefined;
  href?: string | undefined;
};
export type QuotationReference = {
  statementId: string;
  hash: string;
  status: 'current' | 'unknown' | 'withheld' | 'unsupported';
  parts: QuotationPart[];
};
export type QuotationText = {
  assertion?: QuotationAssertion | undefined;
  statementId?: string | undefined;
  property: string;
  status: 'current' | 'missing' | 'withheld' | 'unsupported' | 'unavailable' | 'stale';
  text?: string | undefined;
  language?: string | undefined;
  body?: AuthoredBody | undefined;
  qualifiers: QuotationPart[];
  references: QuotationReference[];
  sourceStatus: 'current' | 'unknown' | 'withheld' | 'unsupported';
  spoiler: boolean;
};
export type QuotationRow = {
  id: string;
  state: 'pending' | 'current';
  observation?: string | undefined;
  contexts: QuotationContext[];
  statements: QuotationText[];
};
export type QuotationViewer = { kind: 'anonymous' } | { kind: 'account' };
export type QuotationActionState = 'allowed' | 'denied' | 'unavailable' | 'unsupported' | 'absent' | 'withheld';
export type QuotationAction = { action: string; operationId: string; state: QuotationActionState };
export type QuotationPage = {
  subject?: string | undefined;
  reads: Record<string, { status: number; body?: unknown }>;
  viewer?: QuotationViewer | undefined;
  actions?: QuotationAction[] | undefined;
};
export type QuotationRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      admitted: boolean;
      rows: QuotationRow[];
      selected: QuotationRow | null;
      next: string | null;
      observation: string;
      unsupportedCount: number;
      session?: string | undefined;
      viewer?: QuotationViewer | undefined;
      actions?: QuotationAction[] | undefined;
      viewerActions?: CandidateViewerActions | undefined;
    };

type Definitions = Pick<Release, 'types' | 'properties'>;
type Statement = SubjectRead['subject']['statements'][string][number];
type Snak = Statement['qualifiers'][number];
type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;

function headersOf(authorization?: string, session?: string) {
  return {
    ...(authorization ? { authorization } : {}),
    ...(session ? { 'rezics-session-token': session } : {}),
  };
}

function tokenOf(result: { headers?: HeadersInit | undefined }) {
  return new Headers(result.headers ?? {}).get('rezics-session-token') || undefined;
}

function admittedProperties(release: Definitions, type: string, ids: readonly string[]) {
  const admitted = release.types[type]?.properties ?? [];
  return ids.filter((id) => admitted.includes(id) && !!release.properties[id]);
}

export function quotationTypeAdmitted(release: Definitions): boolean {
  return admittedProperties(release, quotationRequested.type, quotationRequested.text).length > 0;
}

export function quotationProperty(release: Definitions, type: string, ids: readonly string[]) {
  return admittedProperties(release, type, ids)[0];
}

function propertyLabel(release: Definitions, property: string, locale: string) {
  const label = pickText(release.properties[property]?.labels ?? {}, locale).text;
  return label || property;
}

function relatedLabel(related: SubjectRead['related'], id: string, locale: string) {
  const summary = related[id];
  if (!summary || !('labels' in summary)) return;
  return pickText(summary.labels ?? {}, locale).text;
}

function ranked(statements: readonly Statement[]) {
  const preferred = statements.filter((statement) => statement.rank === 'preferred');
  return preferred.length ? preferred : statements.filter((statement) => statement.rank === 'normal');
}

function assertionFor(subject: SubjectRead, statement: Statement): QuotationAssertion {
  return {
    holder: subject.subject.id,
    context: subject.subject.context,
    release: subject.subject.release,
    revision: subject.subject.revision,
    statement,
  };
}

function contextsFor(
  subject: SubjectRead,
  release: Definitions,
  kind: QuotationContextKind,
  candidates: readonly string[],
  locale: string,
): QuotationContext[] {
  const properties = admittedProperties(release, subject.subject.type, candidates);
  if (!properties.length) return [{ kind, status: 'unknown' }];
  const contexts = properties.flatMap((property): QuotationContext[] => {
    const statements = ranked(subject.subject.statements[property] ?? []).filter(
      (statement) => statement.property.id === property,
    );
    if (!statements.length)
      return [{ kind, property, status: kind === 'speaker' || kind === 'credited' ? 'missing' : 'unknown' }];
    return statements.map((statement): QuotationContext => {
      const base = {
        kind,
        property,
        statementId: statement.id,
        assertion: assertionFor(subject, statement),
        spoiler: spoilerLevel(statement) > 0,
        qualifiers: projectQualifiers(statement, release, subject.related, locale),
        references: projectReferences(statement, release, subject.related, locale),
      };
      if (statement.value.type === 'somevalue') return { ...base, status: 'withheld' };
      if (statement.value.type === 'novalue') return { ...base, status: 'missing' };
      const id = statement.value.content;
      if (typeof id !== 'string' || !id) return { ...base, status: 'unsupported' };
      if (!Object.hasOwn(subject.related, id)) return { ...base, status: 'concealed' };
      const label = relatedLabel(subject.related, id, locale);
      if (!label) return { ...base, status: 'restricted' };
      return { ...base, status: 'current', id, label };
    });
  });
  return contexts;
}

function projectPart(release: Definitions, snak: Snak, related: SubjectRead['related'], locale: string): QuotationPart {
  const property = snak.property.id;
  const definition = release.properties[property];
  const label = propertyLabel(release, property, locale);
  if (!definition) return { property, label, status: 'unsupported' };
  if (snak.value.type === 'somevalue') return { property, label, status: 'withheld' };
  if (snak.value.type === 'novalue') return { property, label, status: 'missing' };
  const content = snak.value.content;
  if (definition.datatype === 'wikibase-item') {
    if (typeof content !== 'string' || !content) return { property, label, status: 'unsupported' };
    if (!Object.hasOwn(related, content)) return { property, label, status: 'concealed' };
    const itemLabel = relatedLabel(related, content, locale);
    return itemLabel
      ? { property, label, id: content, value: itemLabel, status: 'current' }
      : { property, label, status: 'restricted' };
  }
  if (definition.datatype === 'url') {
    if (typeof content !== 'string') return { property, label, status: 'unsupported' };
    return webUrl(content)
      ? { property, label, value: content, href: content, status: 'current' }
      : { property, label, value: content, status: 'unsupported' };
  }
  if (definition.datatype === 'monolingualtext') {
    if (!isRecord(content) || typeof content.text !== 'string') return { property, label, status: 'unsupported' };
    return {
      property,
      label,
      value: content.text,
      ...(typeof content.language === 'string' && content.language ? { language: content.language } : {}),
      status: 'current',
    };
  }
  if (typeof content === 'string') return { property, label, value: content, status: 'current' };
  return { property, label, status: 'unsupported' };
}

function sourceStatus(references: QuotationReference[]): QuotationText['sourceStatus'] {
  if (!references.length) return 'unknown';
  if (references.some((reference) => reference.status === 'current')) return 'current';
  if (references.some((reference) => reference.status === 'withheld')) return 'withheld';
  if (references.some((reference) => reference.status === 'unknown')) return 'unknown';
  return 'unsupported';
}

function projectReferences(
  statement: Statement,
  release: Definitions,
  related: SubjectRead['related'],
  locale: string,
): QuotationReference[] {
  return statement.references.map((reference) => {
    const parts = reference.parts.map((part) => projectPart(release, part, related, locale));
    const status: QuotationReference['status'] = parts.some((part) => part.status === 'current')
      ? 'current'
      : parts.some((part) => part.status === 'withheld' || part.status === 'concealed' || part.status === 'restricted')
        ? 'withheld'
        : parts.length
          ? 'unsupported'
          : 'unknown';
    return { statementId: statement.id, hash: reference.hash, status, parts };
  });
}

function projectQualifiers(
  statement: Statement,
  release: Definitions,
  related: SubjectRead['related'],
  locale: string,
): QuotationPart[] {
  return statement.qualifiers
    .filter((qualifier) => qualifier.property.id !== 'rezics:spoilerLevel')
    .map((qualifier) => projectPart(release, qualifier, related, locale));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textState(statement: Statement, property: string): QuotationText['status'] {
  if (statement.value.type === 'novalue') return 'missing';
  if (statement.value.type === 'somevalue') return 'withheld';
  if (statement.property.id !== property) return 'unsupported';
  return 'current';
}

function pageDocumentBody(documents: unknown, subjectId: string, statement: Statement): AuthoredBody {
  const content: unknown = statement.value.type === 'value' ? statement.value.content : null;
  if (
    !isRecord(documents) ||
    !isRecord(content) ||
    typeof content.document !== 'string' ||
    typeof content.digest !== 'string' ||
    typeof content.language !== 'string'
  )
    return candidateFailure(503);
  const document = documents[statement.id];
  if (
    !isRecord(document) ||
    document.id !== content.document ||
    document.subjectId !== subjectId ||
    document.candidateId !== statement.id ||
    document.digest !== content.digest ||
    document.language !== content.language ||
    !['available', 'erased'].includes(String(document.availability))
  )
    return candidateFailure(503);
  if (document.availability === 'available' && !checkDocument(document.body)) return candidateFailure(400);
  return { ok: true, document: document as AuthoredDocument };
}

async function quotationText(
  client: KernelClient | undefined,
  authorization: string | undefined,
  release: Definitions,
  subject: SubjectRead,
  statement: Statement | undefined,
  property: string,
  locale: string,
  session?: string,
  documents?: unknown,
): Promise<QuotationText> {
  const missing = {
    property,
    status: 'missing' as const,
    qualifiers: [],
    references: [],
    sourceStatus: 'unknown' as const,
    spoiler: false,
  };
  if (!statement) return missing;
  const status = textState(statement, property);
  const qualifiers = projectQualifiers(statement, release, subject.related, locale);
  const references = projectReferences(statement, release, subject.related, locale);
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  const language = isRecord(content) && typeof content.language === 'string' ? content.language : undefined;
  const exact = {
    assertion: assertionFor(subject, statement),
    ...(language ? { language } : {}),
    statementId: statement.id,
    property,
    qualifiers,
    references,
    sourceStatus: sourceStatus(references),
    spoiler: spoilerLevel(statement) > 0,
  };
  if (status !== 'current') return { ...exact, status };
  const definition = release.properties[property];
  if (!definition) return { ...exact, status: 'unsupported' };
  if (definition.datatype === 'document') {
    if (!isRecord(content) || typeof content.document !== 'string' || typeof content.digest !== 'string' || !language)
      return { ...exact, status: 'unsupported' };
    const body =
      documents !== undefined
        ? pageDocumentBody(documents, subject.subject.id, statement)
        : client
          ? await readAuthoredBody(client, subject.subject.id, statement, authorization, session)
          : candidateFailure(503);
    if (!body.ok)
      return {
        ...exact,
        status:
          body.reason === 'stale'
            ? 'stale'
            : body.reason === 'invalid'
              ? 'unsupported'
              : body.reason === 'denied'
                ? 'withheld'
                : 'unavailable',
        body,
      };
    if (body.document.availability !== 'available') return { ...exact, status: 'unavailable', body };
    return {
      ...exact,
      status: 'current',
      language: body.document.language,
      body,
    };
  }
  if (statement.value.type !== 'value') return { ...exact, status: 'unsupported' };
  if (definition.datatype === 'monolingualtext') {
    if (!isRecord(content) || typeof content.text !== 'string' || !content.text.trim())
      return { ...exact, status: 'unavailable' };
    return {
      ...exact,
      status: 'current',
      text: content.text,
      ...(typeof content.language === 'string' && content.language ? { language: content.language } : {}),
    };
  }
  if (definition.datatype === 'string' && typeof content === 'string' && content.trim())
    return { ...exact, status: 'current', text: content };
  return { ...exact, status: 'unsupported' };
}

function observationOf(subject: SubjectRead['subject']) {
  return `${subject.id}\u0000${subject.release}\u0000${subject.context}\u0000${subject.revision}`;
}

async function quotationRow(
  client: KernelClient | undefined,
  authorization: string | undefined,
  release: Definitions,
  subject: SubjectRead,
  locale: string,
  session?: string,
  documents?: unknown,
): Promise<QuotationRow> {
  const properties = [
    ...quotationRequested.text,
    ...quotationRequested.speaker,
    ...quotationRequested.credited,
    ...quotationRequested.work,
    ...quotationRequested.voice,
  ];
  let count = 0;
  for (const property of properties) {
    const statements = subject.subject.statements[property] ?? [];
    count += statements.length;
    if (count > personBounds.facts || statements.some((statement) => !personEvidenceFits(statement)))
      return {
        id: subject.subject.id,
        state: 'current',
        observation: observationOf(subject.subject),
        contexts: [],
        statements: [
          {
            property: quotationRequested.text[0],
            status: 'unavailable',
            qualifiers: [],
            references: [],
            sourceStatus: 'unknown',
            spoiler: false,
          },
        ],
      };
  }
  const type = subject.subject.type;
  const textProperty = quotationProperty(release, type, quotationRequested.text);
  if (!textProperty || !typeExtends(release, type, quotationRequested.type))
    return {
      id: subject.subject.id,
      state: 'current',
      observation: observationOf(subject.subject),
      contexts: [],
      statements: [
        {
          property: textProperty ?? quotationRequested.text[0],
          status: 'unsupported',
          qualifiers: [],
          references: [],
          sourceStatus: 'unsupported',
          spoiler: false,
        },
      ],
    };
  // Apply the existing rank rule within each native language slot, never across languages.
  const languages = new Map<string, Statement[]>();
  for (const statement of subject.subject.statements[textProperty] ?? []) {
    if (statement.property.id !== textProperty) continue;
    const value = statement.value.type === 'value' ? statement.value.content : undefined;
    const language = isRecord(value) && typeof value.language === 'string' ? value.language : '';
    const group = languages.get(language) ?? [];
    group.push(statement);
    languages.set(language, group);
  }
  const selected = [...languages.values()].flatMap(ranked);
  const contexts = [
    ...contextsFor(subject, release, 'speaker', quotationRequested.speaker, locale),
    ...contextsFor(subject, release, 'credited', quotationRequested.credited, locale),
    ...contextsFor(subject, release, 'work', quotationRequested.work, locale),
    ...contextsFor(subject, release, 'voice', quotationRequested.voice, locale),
  ];
  return {
    id: subject.subject.id,
    state: 'current',
    observation: observationOf(subject.subject),
    contexts,
    statements: selected.length
      ? await Promise.all(
          selected.map((statement) =>
            quotationText(client, authorization, release, subject, statement, textProperty, locale, session, documents),
          ),
        )
      : [
          await quotationText(
            client,
            authorization,
            release,
            subject,
            undefined,
            textProperty,
            locale,
            session,
            documents,
          ),
        ],
  };
}

function rowFromRelation(release: Definitions, row: ForwardPage['relations'][number]): QuotationRow | undefined {
  if (!row.summary || !typeExtends(release, row.summary.type, quotationRequested.type)) return;
  return {
    id: row.summary.id,
    state: 'pending',
    contexts: [],
    statements: [],
  };
}

export async function readQuotationPage(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  id: string,
  locale: string,
  input: { quote?: string | undefined; cursor?: string | undefined; session?: string | undefined },
): Promise<QuotationRead> {
  try {
    const headers = headersOf(authorization, input.session);
    const current = await client.subjects({ id }).get({ headers });
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id) return candidateFailure(409);
    const type = current.data.subject.type;
    const observation = observationOf(current.data.subject);
    if (!quotationTypeAdmitted(release)) {
      return {
        ok: true,
        public: current.data,
        admitted: false,
        rows: [],
        selected: null,
        next: null,
        observation,
        unsupportedCount: 0,
      };
    }
    const isQuotation = typeExtends(release, type, quotationRequested.type);
    const workProperty = quotationProperty(release, type, quotationRequested.work);
    const speakerProperty = quotationProperty(release, type, quotationRequested.speaker);
    const listProperty = isQuotation
      ? undefined
      : (workProperty ?? speakerProperty ?? quotationProperty(release, type, ['schema:hasPart']));
    if (!isQuotation && !listProperty) {
      return {
        ok: true,
        public: current.data,
        admitted: false,
        rows: [],
        selected: null,
        next: null,
        observation,
        unsupportedCount: 0,
      };
    }
    let session = tokenOf(current) ?? input.session;
    let rows: QuotationRow[] = [];
    let next: string | null = null;
    let unsupportedCount = 0;
    if (isQuotation) {
      if (input.quote && input.quote !== id) return candidateFailure(409);
      rows = [await quotationRow(client, authorization, release, current.data, locale, session)];
    } else if (listProperty) {
      const page = await client.subjects({ id }).relations.get({
        query: {
          property: listProperty,
          language: locale,
          limit: QUOTATION_PAGE_CAP,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        headers: headersOf(authorization, session),
      });
      if (page.status !== 200 || !page.data || !('relations' in page.data)) return candidateFailure(page.status);
      session = tokenOf(page) ?? session;
      next = page.data.next;
      const relations = page.data.relations.slice(0, QUOTATION_PAGE_CAP);
      for (const relation of relations) {
        const row = rowFromRelation(release, relation);
        if (row) rows.push(row);
        else unsupportedCount += 1;
      }
      const chosen = input.quote ?? rows[0]?.id;
      if (input.quote && !rows.some((row) => row.id === input.quote)) return candidateFailure(409);
      if (chosen) {
        const target = await client.subjects({ id: chosen }).get({ headers: headersOf(authorization, session) });
        if (target.status !== 200 || !target.data) return candidateFailure(target.status);
        if (
          target.data.subject.id !== chosen ||
          !typeExtends(release, target.data.subject.type, quotationRequested.type)
        )
          return candidateFailure(409);
        session = tokenOf(target) ?? session;
        const detail = await quotationRow(client, authorization, release, target.data, locale, session);
        rows = rows.map((row) => (row.id === chosen ? detail : row));
      }
    }
    const selected = rows.find((row) => row.state === 'current') ?? null;
    const viewerActions = selected ? await readCorrectionActions(client, authorization, selected.id) : undefined;
    return {
      ok: true,
      public: current.data,
      admitted: true,
      rows,
      selected,
      viewerActions,
      next,
      observation,
      unsupportedCount,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}

function subjectFromPage(page: QuotationPage): SubjectRead | undefined {
  if (typeof page.subject !== 'string') return;
  for (const result of Object.values(page.reads)) {
    if (result.status !== 200 || !isRecord(result.body) || !isRecord(result.body.subject)) continue;
    const subject = result.body.subject as SubjectRead['subject'];
    if (subject.id !== page.subject || !isRecord(result.body.related)) continue;
    return {
      subject,
      related: result.body.related as SubjectRead['related'],
      account: ('account' in result.body ? (result.body.account as SubjectRead['account']) : null) ?? null,
      summary: ('summary' in result.body ? (result.body.summary as SubjectRead['summary']) : null) ?? null,
    };
  }
}

function documentsFromPage(page: QuotationPage, publicRead: SubjectRead): unknown {
  for (const result of Object.values(page.reads)) {
    if (result.status !== 200 || !isRecord(result.body) || !isRecord(result.body.subject)) continue;
    if ((result.body.subject as { id?: string }).id !== publicRead.subject.id) continue;
    return result.body.documents;
  }
}

/** Project an ordinary pages:read quotation envelope without further HTTP hydration. */
export async function projectQuotationFromPage(
  release: Definitions,
  page: QuotationPage,
  locale: string,
): Promise<QuotationRead> {
  const publicRead = subjectFromPage(page);
  if (!publicRead) return candidateFailure(503);
  const observation = observationOf(publicRead.subject);
  const authority = {
    ...(page.viewer ? { viewer: page.viewer } : {}),
    ...(page.actions ? { actions: page.actions } : {}),
  };
  if (!quotationTypeAdmitted(release) || !typeExtends(release, publicRead.subject.type, quotationRequested.type)) {
    return {
      ok: true,
      public: publicRead,
      admitted: false,
      rows: [],
      selected: null,
      next: null,
      observation,
      unsupportedCount: 0,
      ...authority,
    };
  }
  const selected = await quotationRow(
    undefined,
    undefined,
    release,
    publicRead,
    locale,
    undefined,
    documentsFromPage(page, publicRead),
  );
  return {
    ok: true,
    public: publicRead,
    admitted: true,
    rows: [selected],
    selected,
    next: null,
    observation,
    unsupportedCount: 0,
    ...authority,
  };
}

export function quotationWorkOrCharacter(release: Definitions, type: string) {
  return (
    typeExtends(release, type, 'schema:CreativeWork') ||
    typeExtends(release, type, 'wd:Q95074') ||
    typeExtends(release, type, quotationRequested.type)
  );
}
