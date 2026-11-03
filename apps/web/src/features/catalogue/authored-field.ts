import type { CandidateWork } from '../../subject/candidate-lifetime';
import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickLanguage, pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkStatementInput, type Violation } from '@rezics/definitions/validate';
import {
  checkDocument,
  fromPlainText,
  hasDocumentContent,
  serializeDocument,
  type DocumentSnapshot,
} from '@rezics/document';
import {
  candidateContext,
  candidateFailure,
  readCandidates,
  type CandidateFailure,
  type CandidateRead,
} from '../../subject/candidates';
import { originalLanguage } from '../../subject/language';
import { bestRank, isRecord } from '../pages/shared';
import type { ProposalResult, StatementInput } from './statement-editor';

// The native proposal schema accepts a generic statement; reuse the shared definition input for its parts.
export type AuthoredStatement = StatementInput;
export type AuthoredCommand = { id: string; key: string; statement: AuthoredStatement; session?: string };
export type AuthoredAddress = { id: string; property?: string; session?: string };
type Statement = SubjectRead['subject']['statements'][string][number];
export type AuthoredDocument = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['documents']>['get']>>['data']
>['document'];
export type AuthoredBody = { ok: true; document: AuthoredDocument } | CandidateFailure;
export type AuthoredRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      release: Release;
      property: string;
      selected: Statement | null;
      body: AuthoredBody | null;
      session?: string;
    };
export type AuthoredReview = {
  comparison: CandidateRead;
  body: AuthoredBody | null;
  current?: Extract<AuthoredRead, { ok: true }>;
};
export type AuthoredTransport = {
  reader?: string;
  read: (property?: string, session?: string) => Promise<AuthoredRead>;
  propose: (command: AuthoredCommand) => Promise<ProposalResult>;
  review: (
    property: string,
    candidate: string,
    cursor?: string,
    session?: string,
    work?: CandidateWork,
  ) => Promise<AuthoredReview>;
};

export function authoredProperties(release: Release, type: string): string[] {
  return (release.types[type]?.properties ?? []).filter((id) => release.properties[id]?.datatype === 'document');
}

/** A new authored work has its own licence and evidence; the current work is never used as an editable draft. */
export function authoredStatement(
  property: string,
  document: DocumentSnapshot,
  language: string,
  licence: string,
  evidence: StatementInput['references'] | string,
): AuthoredStatement {
  // Keep the former single citation call shape as one ordinary schema:url reference part.
  const references =
    typeof evidence === 'string'
      ? [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: evidence } }] }]
      : structuredClone(evidence);
  return {
    property: { id: property },
    value: { type: 'value', content: { document, language, licence } },
    references,
    qualifiers: [],
    rank: 'normal',
  };
}

/** A preview accepts only the same bounded, authored document shapes that native validation accepts. */
export function authoredDocumentError(document: unknown): Violation['code'] | undefined {
  if (!checkDocument(document) || !hasDocumentContent(document)) return 'invalid_format';
  if (new TextEncoder().encode(serializeDocument(document)).byteLength > 2 * 1024 * 1024) return 'out_of_range';
  const pending = [document.doc];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image' || node.type === 'media') return 'unsupported';
    pending.push(...(node.content ?? []));
  }
  return undefined;
}

export function validateAuthored(statement: unknown, release?: Release): Violation[] {
  const errors = checkStatementInput(statement, release, { authoredDocuments: true }).violations;
  const value = statement as { value?: { content?: { document?: unknown } } } | null;
  const document = value?.value?.content?.document;
  const documentError = authoredDocumentError(document);
  if (documentError) errors.push({ pointer: '/statement/value/content/document', code: documentError });
  return errors;
}

/** Only an exact native document response binds body, language, identity and digest to a disclosed statement. */
export async function readAuthoredBody(
  client: KernelClient,
  id: string,
  statement: Statement,
  authorization?: string,
  session?: string,
): Promise<AuthoredBody> {
  const content: unknown = statement.value.type === 'value' ? statement.value.content : null;
  if (
    !isRecord(content) ||
    typeof content.document !== 'string' ||
    typeof content.digest !== 'string' ||
    typeof content.language !== 'string'
  )
    return candidateFailure(503);
  try {
    const result = await client.documents({ id: content.document }).get({
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(session ? { 'rezics-session-token': session } : {}),
      },
    });
    if (result.status !== 200 || !result.data) return candidateFailure(result.status);
    const document = result.data.document;
    if (
      document.id !== content.document ||
      document.subjectId !== id ||
      document.candidateId !== statement.id ||
      document.digest !== content.digest ||
      document.language !== content.language ||
      document.availability !== 'available' ||
      !checkDocument(document.body)
    )
      return candidateFailure(503);
    return { ok: true, document };
  } catch {
    return candidateFailure(503);
  }
}

export async function readAuthoredField(
  client: KernelClient,
  address: AuthoredAddress,
  locale: string,
): Promise<AuthoredRead> {
  try {
    // These reads are independent. Public selection never borrows the editor's bearer.
    const [current, active] = await Promise.all([
      client
        .subjects({ id: address.id })
        .get(address.session ? { headers: { 'rezics-session-token': address.session } } : undefined),
      client.definitions.active.get(),
    ]);
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== address.id || current.data.subject.context !== candidateContext)
      return candidateFailure(409);
    if (active.status !== 200 || !active.data) return candidateFailure(active.status);
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data) return candidateFailure(bundle.status);
    const release = bundle.data.release as Release;
    if (bundle.data.digest !== active.data.digest || !release.types || !release.properties)
      return candidateFailure(503);
    const fields = authoredProperties(release, current.data.subject.type);
    const property = address.property ?? fields[0] ?? '';
    if (property && !fields.includes(property)) return candidateFailure(400);
    const selected = bestRank(current.data.subject.statements[property] ?? []) as Statement[];
    const language = pickLanguage(
      selected.flatMap((statement) => {
        const content = statement.value.type === 'value' ? statement.value.content : null;
        return isRecord(content) && typeof content.language === 'string' ? [content.language] : [];
      }),
      locale,
      originalLanguage(current.data.subject),
    );
    const statement =
      selected.find(
        (statement) =>
          statement.value.type === 'value' &&
          isRecord(statement.value.content) &&
          statement.value.content.language === language,
      ) ?? null;
    const session = new Headers(current.headers).get('rezics-session-token') ?? address.session;
    const body = statement ? await readAuthoredBody(client, address.id, statement, undefined, session) : null;
    return {
      ok: true,
      public: current.data,
      release,
      property,
      selected: statement,
      body,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}

export async function proposeAuthoredField(
  client: KernelClient,
  authorization: string,
  command: AuthoredCommand,
): Promise<ProposalResult> {
  try {
    const result = await client.subjects({ id: command.id }).candidates.post(
      { statement: command.statement },
      {
        headers: {
          authorization,
          'idempotency-key': command.key,
          ...(command.session ? { 'rezics-session-token': command.session } : {}),
        } as { 'idempotency-key': string },
      },
    );
    if (result.status !== 201 || !result.data) {
      const problem: unknown = result.error?.value;
      const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
      // A key conflict needs explicit review; it must never generate an automatic new key.
      if (code === 'idempotency_conflict') return candidateFailure(409);
      if (result.status === 413) return candidateFailure(400);
      return candidateFailure(result.status);
    }
    const session = new Headers(result.headers).get('rezics-session-token');
    return {
      ok: true,
      kind: 'proposed-awaiting-review',
      candidate: result.data.candidate,
      revision: result.data.revision,
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}

export async function readAuthoredReview(
  client: KernelClient,
  authorization: string,
  address: AuthoredAddress & { property: string; candidate: string; cursor?: string },
  locale: string,
): Promise<AuthoredReview> {
  const [comparison, form] = await Promise.all([
    readCandidates(client, authorization, address.id, address.property, address.cursor, undefined, address.session),
    readAuthoredField(client, address, locale),
  ]);
  if (!comparison.ok) return { comparison, body: null };
  if (!form.ok) return { comparison: form, body: null };
  const field = form.release.properties[address.property];
  if (!field || field.datatype !== 'document') return { comparison: candidateFailure(400), body: null };
  const actual = comparison.page?.candidates.find(
    (candidate) => candidate.id === address.candidate && candidate.retracted === null,
  );
  return {
    current: form,
    comparison: {
      ...comparison,
      fields: [{ id: address.property, label: pickText(field.labels, locale).text, multivalued: field.multivalued }],
      names: Object.fromEntries(Object.entries(form.release.properties).map(([id, field]) => [id, field.labels])),
    },
    body: actual
      ? await readAuthoredBody(
          client,
          address.id,
          actual.statement,
          authorization,
          comparison.session ?? address.session,
        )
      : null,
  };
}

export type AuthoredField = { document: DocumentSnapshot; language: string; licence: string };
export const newAuthoredField = (): AuthoredField => ({ document: fromPlainText(''), language: '', licence: '' });
/** An explicit new body; never decode a stored document reference as plain text. */
export function authoredFieldValue(field: AuthoredField): StatementInput['value'] {
  return { type: 'value', content: structuredClone(field) };
}
