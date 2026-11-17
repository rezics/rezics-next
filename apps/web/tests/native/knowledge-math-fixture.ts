import { normalizeDocument, parseDocument } from '@rezics/document';
import type { KnowledgePublicDocument } from '../../src/knowledge/public-read';
import {
  writeReference,
  type KnowledgeReference,
  type KnowledgeReferenceTarget,
} from '../../src/knowledge/reference-model';
import type { KnowledgeExportEnvelope } from '../../src/knowledge/transfer';
import { knowledgeJourneyLicence, type KnowledgeJourneyFixture } from './knowledge-journey-fixture.ts';

type Notebook = { notebookId: string; structureRevisionId: string };
type Saved = { documentId: string; revisionId: string };
type PrivateWire = Saved & {
  title: string;
  notebookId: string;
  canonicalBytes: string;
  sha256: string;
  references: KnowledgeReference[];
};
type PublicWire = Omit<KnowledgePublicDocument, 'body'> & { canonicalBytes: string };
type Reader = 'alice' | 'bob' | 'anonymous' | 'moderator';

export function mathDocument(title: string, blockId: string, text: string, reference?: KnowledgeReference) {
  const body = normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: blockId }, content: [{ type: 'text', text }] }] },
  });
  const draft = reference
    ? writeReference({ body, references: [] }, reference, 'Read the cited statement')
    : { body, references: [] };
  return { title, ...draft, licence: knowledgeJourneyLicence, language: 'en', subjectIds: [] };
}

export function uses(id: string, sourceBlockId: string, target: KnowledgeReferenceTarget): KnowledgeReference {
  return { id, role: 'uses', sourceBlockId, target };
}

export function exact(row: PublicWire, blockId: string): Extract<KnowledgeReferenceTarget, { kind: 'revision' }> {
  return {
    kind: 'revision',
    documentId: row.documentId,
    revisionId: row.revisionId,
    sha256: row.sourceSha256,
    blockId,
  };
}

export function snapshot(row: { canonicalBytes: string }) {
  return parseDocument(JSON.parse(Buffer.from(row.canonicalBytes, 'base64').toString('utf8')));
}

export function mathApi(fixture: KnowledgeJourneyFixture) {
  const { stack } = fixture;

  async function request<T>(
    path: string,
    persona: Reader | 'editor',
    status: number | readonly number[],
    body?: unknown,
  ) {
    const response = await stack.kernel(
      path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
            body: JSON.stringify(body),
          },
      persona,
    );
    const raw = await response.text();
    const allowed = typeof status === 'number' ? [status] : status;
    if (!allowed.includes(response.status))
      throw new Error(`${persona} ${path}: expected ${status}, got ${response.status}: ${raw}`);
    return { value: JSON.parse(raw) as T, raw, cache: response.headers.get('cache-control') };
  }

  const documentPath = (documentId: string) => `/v1/knowledge/documents/${documentId}`;
  const selection = (revisionId?: string) => (revisionId ? `?revisionId=${revisionId}` : '');
  const owned = (accountId: string) => `/v1/accounts/${accountId}/knowledge/notebooks`;

  return {
    async subject(label: string) {
      const { value } = await request<{ subject: { id: string } }>('/v1/subjects', 'editor', 201, {
        type: 'skos:Concept',
        labels: { en: label },
      });
      return value.subject.id;
    },
    async notebook(persona: 'alice' | 'bob', subjectId: string, title: string) {
      return (await request<Notebook>('/v1/knowledge/notebooks', persona, 201, { subjectId, title })).value;
    },
    async create(persona: 'alice' | 'bob', notebook: Notebook, input: ReturnType<typeof mathDocument>) {
      const { value } = await request<Saved & Pick<Notebook, 'structureRevisionId'>>(
        `/v1/knowledge/notebooks/${notebook.notebookId}/documents`,
        persona,
        201,
        {
          ...input,
          expectedStructureRevisionId: notebook.structureRevisionId,
          parentPlacementId: null,
        },
      );
      notebook.structureRevisionId = value.structureRevisionId;
      return value;
    },
    async revise(saved: Saved, input: ReturnType<typeof mathDocument>) {
      return (
        await request<Saved>(`${documentPath(saved.documentId)}/revisions:revise`, 'alice', 200, {
          ...input,
          expectedHeadRevisionId: saved.revisionId,
        })
      ).value;
    },
    async select(saved: Saved, publicationId: string | null, revisionId: string | null = saved.revisionId) {
      return (
        await request<{ publicationId: string | null }>(
          `${documentPath(saved.documentId)}/publication:select`,
          'alice',
          200,
          {
            expectedHeadRevisionId: saved.revisionId,
            expectedPublicationId: publicationId,
            revisionId,
          },
        )
      ).value.publicationId;
    },
    async publicRead(persona: Reader, documentId: string, revisionId?: string) {
      return (await request<{ document: PublicWire }>(documentPath(documentId) + selection(revisionId), persona, 200))
        .value.document;
    },
    unavailable(persona: Reader, saved: Saved, exact: boolean, exporting = false) {
      return request(
        documentPath(saved.documentId) + (exporting ? '/export' : '') + selection(exact ? saved.revisionId : undefined),
        persona,
        404,
      );
    },
    export(persona: Reader, saved: Saved) {
      return request<KnowledgeExportEnvelope>(
        `${documentPath(saved.documentId)}/export${selection(saved.revisionId)}`,
        persona,
        200,
      );
    },
    privateRead(
      persona: Reader,
      owner: string,
      notebook: Notebook,
      saved: Saved,
      status: number | readonly number[] = 200,
    ) {
      return request<{ document: PrivateWire }>(
        `${owned(owner)}/${notebook.notebookId}/documents/${saved.documentId}`,
        persona,
        status,
      );
    },
    attached(persona: Reader, accountId: string, subjectId: string) {
      return request<{ notebooks: Notebook[]; next: string | null }>(
        `${owned(accountId)}?subjectId=${subjectId}`,
        persona,
        200,
      );
    },
  };
}
