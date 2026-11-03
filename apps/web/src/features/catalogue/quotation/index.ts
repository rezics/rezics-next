import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import { typeExtends } from '../../pages/graph-browser';
import { QUOTATION_PAGE_CAP } from '../../pages/graph-browser';
import { readAuthoredBody, type AuthoredBody } from '../authored-field';

export const quotationRequested = {
  type: 'schema:Quotation',
  speaker: ['schema:spokenByCharacter', 'schema:creator'] as const,
  work: ['schema:isPartOf', 'schema:about'] as const,
  voice: ['schema:recordedBy', 'schema:actor'] as const,
  text: ['schema:text', 'schema:abstract'] as const,
};

export type QuotationContextKind = 'speaker' | 'work' | 'voice' | 'source';
export type QuotationContext = {
  kind: QuotationContextKind;
  status: 'current' | 'unknown' | 'concealed' | 'restricted' | 'missing';
  id?: string;
  label?: string;
  href?: string;
};
export type QuotationRow = {
  id: string;
  language: string | null;
  text: string | null;
  body: AuthoredBody | null;
  contexts: QuotationContext[];
  spoiler?: boolean;
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
      session?: string | undefined;
    };

type Definitions = Pick<Release, 'types' | 'properties'>;
type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type InversePage = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;

function headersOf(authorization?: string, session?: string) {
  return {
    ...(authorization ? { authorization } : {}),
    ...(session ? { 'rezics-session-token': session } : {}),
  };
}

function tokenOf(result: { headers?: HeadersInit | undefined }) {
  return new Headers(result.headers ?? {}).get('rezics-session-token') || undefined;
}

export function quotationTypeAdmitted(release: Definitions): boolean {
  return !!release.types[quotationRequested.type];
}

export function quotationProperty(release: Definitions, type: string, ids: readonly string[]) {
  return ids.find((id) => release.types[type]?.properties.includes(id) && release.properties[id]);
}

function documentPlain(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const node = body as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  return node.content.map(documentPlain).join(node.type === 'paragraph' ? '\n' : '');
}

function relatedLabel(related: SubjectRead['related'], id: string, locale: string) {
  const summary = related[id];
  if (!summary || !('labels' in summary)) return;
  return pickText(summary.labels ?? {}, locale);
}

function contextOf(
  kind: QuotationContextKind,
  value: unknown,
  related: SubjectRead['related'],
  locale: string,
): QuotationContext {
  if (typeof value !== 'string' || !value) return { kind, status: 'missing' };
  if (!Object.hasOwn(related, value)) return { kind, status: 'concealed', id: value };
  const label = relatedLabel(related, value, locale);
  if (!label?.text) return { kind, status: 'restricted', id: value };
  return { kind, status: 'current', id: value, label: label.text };
}

function statementText(statement: SubjectRead['subject']['statements'][string][number]): string | null {
  if (statement.value.type !== 'value') return null;
  const content = statement.value.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') return content.text;
  return null;
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
    if (current.data.subject.id !== id) return candidateFailure(400);
    if (!quotationTypeAdmitted(release)) {
      return { ok: true, public: current.data, admitted: false, rows: [], selected: null, next: null };
    }
    const type = current.data.subject.type;
    const workProperty = quotationProperty(release, type, quotationRequested.work);
    const speakerProperty = quotationProperty(release, type, quotationRequested.speaker);
    const listProperty =
      typeExtends(release, type, quotationRequested.type)
        ? undefined
        : workProperty ?? speakerProperty ?? quotationProperty(release, type, ['schema:hasPart']);
    let session = tokenOf(current) ?? input.session;
    const rows: QuotationRow[] = [];
    let next: string | null = null;
    if (typeExtends(release, type, quotationRequested.type)) {
      rows.push(await quotationRow(client, authorization, release, current.data, locale, session));
    } else if (listProperty) {
      const page = await client.subjects({ id }).relations.get({
        query: { property: listProperty, language: locale, limit: QUOTATION_PAGE_CAP, ...(input.cursor ? { cursor: input.cursor } : {}) },
        headers: headersOf(authorization, session),
      });
      if (page.status !== 200 || !page.data || !('relations' in page.data)) return candidateFailure(page.status);
      session = tokenOf(page) ?? session;
      next = page.data.next;
      for (const row of page.data.relations) {
        if (!row.summary) continue;
        rows.push({
          id: row.summary.id,
          language: row.summary.label?.language ?? null,
          text: row.summary.label?.value ?? null,
          body: null,
          contexts: [],
        });
      }
    }
    const chosen = input.quote ?? rows[0]?.id;
    if (input.quote && !rows.some((row) => row.id === input.quote) && rows.length) return candidateFailure(409);
    if (chosen && !typeExtends(release, type, quotationRequested.type)) {
      const target = await client.subjects({ id: chosen }).get({ headers: headersOf(authorization, session) });
      if (target.status === 200 && target.data) {
        const detailed = await quotationRow(client, authorization, release, target.data, locale, session);
        const index = rows.findIndex((row) => row.id === chosen);
        if (index >= 0) rows[index] = detailed;
        else rows.unshift(detailed);
      }
    }
    const selected = chosen ? rows.find((row) => row.id === chosen) ?? null : rows[0] ?? null;
    return {
      ok: true,
      public: current.data,
      admitted: true,
      rows,
      selected,
      next,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}

async function quotationRow(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  subject: SubjectRead,
  locale: string,
  session?: string,
): Promise<QuotationRow> {
  const type = subject.subject.type;
  const textProperty = quotationProperty(release, type, quotationRequested.text);
  const speakerProperty = quotationProperty(release, type, quotationRequested.speaker);
  const workProperty = quotationProperty(release, type, quotationRequested.work);
  const voiceProperty = quotationProperty(release, type, quotationRequested.voice);
  const textStatement = textProperty ? subject.subject.statements[textProperty]?.[0] : undefined;
  let body: AuthoredBody | null = null;
  let text = textStatement ? statementText(textStatement) : null;
  let language: string | null = textStatement?.value.type === 'value' && isRecord(textStatement.value.content)
    ? typeof textStatement.value.content.language === 'string'
      ? textStatement.value.content.language
      : null
    : null;
  if (textStatement && release.properties[textStatement.property.id]?.datatype === 'document') {
    body = await readAuthoredBody(client, subject.subject.id, textStatement, authorization, session);
    if (body.ok) {
      text = documentPlain(body.document.body);
      language = body.document.language;
    }
  }
  const item = (property: string | undefined, kind: QuotationContextKind): QuotationContext => {
    if (!property) return { kind, status: 'unknown' };
    const statement = subject.subject.statements[property]?.[0];
    if (!statement) return { kind, status: kind === 'speaker' ? 'missing' : 'unknown' };
    return contextOf(kind, statement.value.type === 'value' ? statement.value.content : undefined, subject.related, locale);
  };
  return {
    id: subject.subject.id,
    language,
    text,
    body,
    contexts: [
      item(speakerProperty, 'speaker'),
      item(workProperty, 'work'),
      item(voiceProperty, 'voice'),
      subject.subject.sourceRecords[0]
        ? { kind: 'source', status: 'current', label: subject.subject.sourceRecords[0].name, href: subject.subject.sourceRecords[0].url }
        : { kind: 'source', status: 'unknown' },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function quotationWorkOrCharacter(release: Definitions, type: string) {
  return (
    typeExtends(release, type, 'schema:CreativeWork') ||
    typeExtends(release, type, 'wd:Q95074') ||
    typeExtends(release, type, quotationRequested.type)
  );
}

export type { InversePage };
