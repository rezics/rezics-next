import { bundledDigest } from '@rezics/definitions/bundled';
import { documentText, parseDocument, type DocumentSnapshot } from '@rezics/document';
import type { Page } from 'playwright';
import { expect } from 'playwright/test';
import { m } from '../../src/paraglide/messages.js';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export const knowledgeJourneyCharacterType = 'wd:Q95074';
export const knowledgeJourneyLocale = 'en';
export const knowledgeJourneyLicence = 'LicenseRef-rezics-terms';

/** Original deterministic bodies. Unselected private text must stay absent from public and foreign reads. */
export const knowledgeJourneyText = {
  character: 'Native Knowledge journey character',
  notebook: 'Private Character notebook',
  parentTitle: 'Character arc',
  parentBody: 'Private nested arc notes remain unpublished in this journey.',
  firstTitle: 'Selected analysis draft one',
  firstBody: 'First saved analysis revision stays unselected after exact publication.',
  selectedTitle: 'Selected analysis revision',
  selectedBody: 'Exact published analysis selected from the saved private revisions.',
  laterTitle: 'Later private working draft',
  laterBody: 'Later private edits must leave the selected public revision unchanged.',
  reuseNotebook: 'Reuse destination notebook',
  reuseSeedTitle: 'Reuse notebook seed',
  reuseSeedBody: 'Seed document that marks the second owned notebook before reuse.',
} as const;

export type KnowledgeJourneyStage = 'setup' | 'private-save' | 'publication' | 'public-read' | 'reuse';

export type KnowledgeJourneyAccount = {
  accountId: string;
  email: string;
  authorization: string;
};

export type KnowledgeJourneySubject = {
  id: string;
  type: string;
  label: string;
};

export type KnowledgeJourneyDocument = {
  notebookId: string;
  documentId: string;
  placementId: string;
  revisionId: string;
  publicationId: string | null;
  title: string;
  body: string;
  sha256: string;
};

export type KnowledgeJourneyPlacement = {
  placementId: string;
  documentId: string;
  parentPlacementId: string | null;
  position: string;
  title: string;
};

export type KnowledgeJourneyHistoryRow = {
  revisionId: string;
  title: string;
  sha256: string;
};

export type KnowledgeJourneyPublicDocument = {
  documentId: string;
  revisionId: string;
  publicationId: string;
  subjectId: string;
  title: string;
  body: string;
  authorId: string | null;
  publishedAt: string;
  sha256: string;
};

export type KnowledgeJourneyEvidence = {
  stage: KnowledgeJourneyStage;
  subjectId?: string;
  sourceNotebookId?: string;
  parent?: KnowledgeJourneyDocument;
  child?: KnowledgeJourneyDocument;
  firstRevisionId?: string;
  selectedRevisionId?: string;
  selectedPublicationId?: string;
  laterRevisionId?: string;
  reuseNotebookId?: string;
  reuseSeed?: KnowledgeJourneyDocument;
  copy?: KnowledgeJourneyDocument;
};

const knowledgeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isKnowledgeJourneyId(value: unknown): value is string {
  return typeof value === 'string' && knowledgeIdPattern.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member(value: unknown, key: string): unknown {
  return record(value) ? value[key] : undefined;
}

function decodeCanonical(canonicalBytes: unknown): { snapshot: DocumentSnapshot; source: string; text: string } {
  if (typeof canonicalBytes !== 'string' || canonicalBytes.length === 0)
    throw new Error('Native Knowledge document omitted canonicalBytes');
  const source = new TextDecoder().decode(Uint8Array.from(atob(canonicalBytes), (code) => code.charCodeAt(0)));
  const snapshot = parseDocument(JSON.parse(source));
  return { snapshot, source, text: documentText(snapshot) };
}

export function knowledgeJourneyOperationError(
  stage: KnowledgeJourneyStage,
  operation: string,
  status: number,
  body: string,
): Error {
  return new Error(`${stage} ${operation} returned ${status}: ${body}`);
}

async function kernelJson<T>(
  response: Response,
  stage: KnowledgeJourneyStage,
  operation: string,
  expected: number | readonly number[],
): Promise<T> {
  const allowed = typeof expected === 'number' ? [expected] : expected;
  const body = await response.text();
  if (!allowed.includes(response.status)) throw knowledgeJourneyOperationError(stage, operation, response.status, body);
  return (body ? JSON.parse(body) : {}) as T;
}

export type KnowledgeJourneyFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: KnowledgeJourneyAccount;
  bob: KnowledgeJourneyAccount;
  subject: KnowledgeJourneySubject;
  evidence: KnowledgeJourneyEvidence;
  createHref: string;
  liveHref(documentId: string): string;
  exactHref(documentId: string, revisionId: string): string;
  privateHref(notebookId: string, documentId: string): string;
  hydrate(page: Page): Promise<void>;
  open(page: Page, path: string): Promise<void>;
  labeledValue(page: Page, label: string): Promise<string>;
  fillTitle(page: Page, label: string, value: string): Promise<void>;
  fillBody(page: Page, value: string): Promise<void>;
  waitEnabled(page: Page, name: string): Promise<void>;
  waitStatus(page: Page, text: string): Promise<void>;
  createCharacterSubject(): Promise<KnowledgeJourneySubject>;
  readOwnedNotebooks(
    stage: KnowledgeJourneyStage,
    persona: string,
    accountId: string,
  ): Promise<{ notebookId: string; title: string; structureRevisionId: string }[]>;
  readOutline(
    stage: KnowledgeJourneyStage,
    persona: string,
    accountId: string,
    notebookId: string,
    parentPlacementId?: string | null,
  ): Promise<{
    structureRevisionId: string;
    parentPlacementId: string | null;
    placements: KnowledgeJourneyPlacement[];
  }>;
  readPrivateDocument(
    stage: KnowledgeJourneyStage,
    persona: string,
    accountId: string,
    notebookId: string,
    documentId: string,
    expectedStatus?: number,
  ): Promise<KnowledgeJourneyDocument | { status: number; body: string }>;
  readPublicDocument(
    stage: KnowledgeJourneyStage,
    documentId: string,
    revisionId?: string,
    persona?: string,
    expectedStatus?: number,
  ): Promise<KnowledgeJourneyPublicDocument | { status: number; body: string }>;
  readHistory(
    stage: KnowledgeJourneyStage,
    persona: string,
    accountId: string,
    notebookId: string,
    documentId: string,
  ): Promise<KnowledgeJourneyHistoryRow[]>;
  requirePrivateDocument(
    stage: KnowledgeJourneyStage,
    persona: string,
    accountId: string,
    notebookId: string,
    documentId: string,
  ): Promise<KnowledgeJourneyDocument>;
  requirePublicDocument(
    stage: KnowledgeJourneyStage,
    documentId: string,
    revisionId?: string,
    persona?: string,
  ): Promise<KnowledgeJourneyPublicDocument>;
  requireUnauthorizedPrivate(
    stage: KnowledgeJourneyStage,
    operation: string,
    persona: string | undefined,
    accountId: string,
    notebookId: string,
    documentId: string,
    expected: readonly number[],
  ): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
};

export async function startKnowledgeJourneyFixture(): Promise<KnowledgeJourneyFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    const active = await kernelJson<{ digest: string }>(
      await stack.kernel('/v1/definitions/active'),
      'setup',
      'GET /v1/definitions/active',
      200,
    );
    if (active.digest !== bundledDigest)
      throw new Error(`Native stack activated ${active.digest}; expected bundled release ${bundledDigest}`);

    const [alice, bob] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);
    auth = await startAuthStack(stack);
    const fixture: KnowledgeJourneyFixture = {
      stack,
      auth,
      alice,
      bob,
      subject: { id: '', type: knowledgeJourneyCharacterType, label: knowledgeJourneyText.character },
      evidence: { stage: 'setup' },
      createHref: '',
      liveHref(documentId) {
        return `/${knowledgeJourneyLocale}/knowledge/documents/${documentId}`;
      },
      exactHref(documentId, revisionId) {
        return `${fixture.liveHref(documentId)}?revisionId=${encodeURIComponent(revisionId)}`;
      },
      privateHref(notebookId, documentId) {
        return `/${knowledgeJourneyLocale}/knowledge/notebooks/${notebookId}/documents/${documentId}`;
      },
      async hydrate(page) {
        await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      },
      async open(page, path) {
        const response = await page.goto(`${stack.web}${path}`, { waitUntil: 'domcontentloaded' });
        const status = response?.status() ?? 0;
        if (status >= 500)
          throw knowledgeJourneyOperationError(
            fixture.evidence.stage,
            `GET ${path}`,
            status,
            (await response?.text()) ?? '',
          );
        await fixture.hydrate(page);
      },
      async labeledValue(page, label) {
        const value = page
          .getByRole('term', { name: label, exact: true })
          .locator('xpath=following-sibling::dd')
          .first();
        await expect(value).toBeVisible();
        const text = (await value.innerText()).trim();
        if (!text) throw new Error(`${fixture.evidence.stage} page omitted ${label}`);
        return text;
      },
      async fillTitle(page, label, value) {
        const field = page.getByLabel(label, { exact: true });
        await expect(field).toBeVisible();
        await field.fill(value);
        await expect(field).toHaveValue(value);
      },
      async fillBody(page, value) {
        const editor = page.locator('.ProseMirror').first();
        await expect(editor).toBeVisible();
        await editor.click();
        await editor.fill(value);
        await expect(editor).toContainText(value);
      },
      async waitEnabled(page, name) {
        const button = page.getByRole('button', { name, exact: true });
        await expect(button).toBeEnabled();
      },
      async waitStatus(page, text) {
        await expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
      },
      async createCharacterSubject() {
        const label = `${knowledgeJourneyText.character} ${crypto.randomUUID().slice(0, 8)}`;
        const created = await kernelJson<{ subject?: { id?: string; type?: string } }>(
          await stack.kernel(
            '/v1/subjects',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': JSON.stringify(crypto.randomUUID()),
              },
              body: JSON.stringify({ type: knowledgeJourneyCharacterType, labels: { en: label } }),
            },
            'editor',
          ),
          'setup',
          'POST /v1/subjects wd:Q95074',
          201,
        );
        const id = created.subject?.id;
        if (!isKnowledgeJourneyId(id))
          throw new Error(`setup POST /v1/subjects wd:Q95074 returned no Character id: ${JSON.stringify(created)}`);
        const type = created.subject?.type ?? knowledgeJourneyCharacterType;
        fixture.subject = { id, type, label };
        fixture.createHref = `/${knowledgeJourneyLocale}/knowledge/new?subjectId=${encodeURIComponent(id)}`;
        fixture.evidence.subjectId = id;
        return fixture.subject;
      },
      async readOwnedNotebooks(stage, persona, accountId) {
        const path = `/v1/accounts/${accountId}/knowledge/notebooks`;
        const body = await kernelJson<{
          notebooks?: { notebookId?: string; title?: string; structureRevisionId?: string }[];
        }>(await stack.kernel(path, {}, persona), stage, `GET ${path}`, 200);
        const notebooks = (body.notebooks ?? []).flatMap((row) => {
          if (!isKnowledgeJourneyId(row.notebookId) || !row.title || !isKnowledgeJourneyId(row.structureRevisionId))
            return [];
          return [{ notebookId: row.notebookId, title: row.title, structureRevisionId: row.structureRevisionId }];
        });
        return notebooks;
      },
      async readOutline(stage, persona, accountId, notebookId, parentPlacementId = null) {
        const query = parentPlacementId === null ? '' : `?parentPlacementId=${encodeURIComponent(parentPlacementId)}`;
        const path = `/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/outline${query}`;
        const body = await kernelJson<{
          structureRevisionId?: string;
          parentPlacementId?: string | null;
          placements?: {
            placementId?: string;
            documentId?: string;
            parentPlacementId?: string | null;
            position?: string;
            title?: string;
          }[];
        }>(await stack.kernel(path, {}, persona), stage, `GET ${path}`, 200);
        if (!isKnowledgeJourneyId(body.structureRevisionId))
          throw new Error(`${stage} GET ${path} omitted structureRevisionId: ${JSON.stringify(body)}`);
        const placements: KnowledgeJourneyPlacement[] = (body.placements ?? []).map((row, index) => {
          if (
            !isKnowledgeJourneyId(row.placementId) ||
            !isKnowledgeJourneyId(row.documentId) ||
            (row.parentPlacementId !== null &&
              row.parentPlacementId !== undefined &&
              !isKnowledgeJourneyId(row.parentPlacementId)) ||
            typeof row.position !== 'string' ||
            typeof row.title !== 'string'
          )
            throw new Error(`${stage} GET ${path} placement ${index} was incomplete: ${JSON.stringify(row)}`);
          return {
            placementId: row.placementId,
            documentId: row.documentId,
            parentPlacementId: row.parentPlacementId ?? null,
            position: row.position,
            title: row.title,
          };
        });
        return {
          structureRevisionId: body.structureRevisionId,
          parentPlacementId: body.parentPlacementId ?? null,
          placements,
        };
      },
      async readPrivateDocument(stage, persona, accountId, notebookId, documentId, expectedStatus = 200) {
        const path = `/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/documents/${documentId}`;
        const response = await stack.kernel(path, {}, persona);
        const raw = await response.text();
        if (response.status !== expectedStatus)
          throw knowledgeJourneyOperationError(stage, `GET ${path}`, response.status, raw);
        if (response.status !== 200) return { status: response.status, body: raw };
        const value = raw ? JSON.parse(raw) : {};
        const document = member(value, 'document');
        const decoded = decodeCanonical(member(document, 'canonicalBytes'));
        const read: KnowledgeJourneyDocument = {
          notebookId: String(member(document, 'notebookId') ?? ''),
          documentId: String(member(document, 'documentId') ?? ''),
          placementId: '',
          revisionId: String(member(document, 'revisionId') ?? ''),
          publicationId: (member(document, 'publicationId') as string | null) ?? null,
          title: String(member(document, 'title') ?? ''),
          body: decoded.text,
          sha256: String(member(document, 'sha256') ?? ''),
        };
        if (
          read.notebookId !== notebookId ||
          read.documentId !== documentId ||
          !isKnowledgeJourneyId(read.revisionId) ||
          (read.publicationId !== null && !isKnowledgeJourneyId(read.publicationId)) ||
          !read.title ||
          !/^[0-9a-f]{64}$/.test(read.sha256)
        )
          throw new Error(`${stage} GET ${path} was not an admitted private head: ${raw}`);
        return read;
      },
      async readPublicDocument(stage, documentId, revisionId, persona, expectedStatus = 200) {
        const path = revisionId
          ? `/v1/knowledge/documents/${documentId}?revisionId=${encodeURIComponent(revisionId)}`
          : `/v1/knowledge/documents/${documentId}`;
        const response = await stack.kernel(path, {}, persona);
        const raw = await response.text();
        if (response.status !== expectedStatus)
          throw knowledgeJourneyOperationError(stage, `GET ${path}`, response.status, raw);
        if (response.status !== 200) return { status: response.status, body: raw };
        const value = raw ? JSON.parse(raw) : {};
        const document = member(value, 'document');
        const decoded = decodeCanonical(member(document, 'canonicalBytes'));
        const read: KnowledgeJourneyPublicDocument = {
          documentId: String(member(document, 'documentId') ?? ''),
          revisionId: String(member(document, 'revisionId') ?? ''),
          publicationId: String(member(document, 'publicationId') ?? ''),
          subjectId: String(member(document, 'subjectId') ?? ''),
          title: String(member(document, 'title') ?? ''),
          body: decoded.text,
          authorId: (member(document, 'authorId') as string | null) ?? null,
          publishedAt: String(member(document, 'publishedAt') ?? ''),
          sha256: String(member(document, 'sha256') ?? ''),
        };
        if (
          read.documentId !== documentId ||
          (revisionId !== undefined && read.revisionId !== revisionId) ||
          !isKnowledgeJourneyId(read.revisionId) ||
          !isKnowledgeJourneyId(read.publicationId) ||
          !isKnowledgeJourneyId(read.subjectId) ||
          !read.title ||
          !/^[0-9a-f]{64}$/.test(read.sha256) ||
          (record(document) && 'notebookId' in document)
        )
          throw new Error(`${stage} GET ${path} was not an admitted public publication: ${raw}`);
        return read;
      },
      async readHistory(stage, persona, accountId, notebookId, documentId) {
        const path = `/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/documents/${documentId}/history`;
        const body = await kernelJson<{
          documentId?: string;
          revisions?: { revisionId?: string; title?: string; sha256?: string }[];
        }>(await stack.kernel(path, {}, persona), stage, `GET ${path}`, 200);
        if (body.documentId !== documentId)
          throw new Error(`${stage} GET ${path} documentId ${body.documentId} !== ${documentId}`);
        return (body.revisions ?? []).map((row, index) => {
          if (!isKnowledgeJourneyId(row.revisionId) || typeof row.title !== 'string' || typeof row.sha256 !== 'string')
            throw new Error(`${stage} GET ${path} revision ${index} was incomplete: ${JSON.stringify(row)}`);
          return { revisionId: row.revisionId, title: row.title, sha256: row.sha256 };
        });
      },
      async requirePrivateDocument(stage, persona, accountId, notebookId, documentId) {
        const read = await fixture.readPrivateDocument(stage, persona, accountId, notebookId, documentId, 200);
        if ('status' in read) throw knowledgeJourneyOperationError(stage, 'private read', read.status, read.body);
        return read;
      },
      async requirePublicDocument(stage, documentId, revisionId, persona) {
        const read = await fixture.readPublicDocument(stage, documentId, revisionId, persona, 200);
        if ('status' in read) throw knowledgeJourneyOperationError(stage, 'public read', read.status, read.body);
        return read;
      },
      async requireUnauthorizedPrivate(stage, operation, persona, accountId, notebookId, documentId, expected) {
        const path = `/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/documents/${documentId}`;
        const response = await stack.kernel(path, {}, persona);
        const body = await response.text();
        if (!expected.includes(response.status))
          throw knowledgeJourneyOperationError(stage, `${operation} GET ${path}`, response.status, body);
        return { status: response.status, body };
      },
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
    fixture.subject = await fixture.createCharacterSubject();
    return fixture;
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}

export async function knowledgeJourneyClick(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

export function knowledgeJourneyCopy() {
  return {
    createNotebook: m.knowledge_private_create_notebook(),
    createDocument: m.knowledge_private_create_document(),
    notebookTitle: m.knowledge_private_notebook_title(),
    documentTitle: m.knowledge_private_document_title(),
    notebookId: m.knowledge_private_notebook_id(),
    documentId: m.knowledge_private_document_id(),
    placementId: m.knowledge_private_placement_id(),
    revisionId: m.knowledge_private_revision(),
    structureRevision: m.knowledge_private_structure_revision(),
    publicationId: m.knowledge_publication_identity(),
    existingNotebook: m.knowledge_private_existing_notebook(),
    openNotebooks: m.knowledge_private_open_notebooks(),
    useNotebook: m.knowledge_private_select_notebook(),
    openOutline: m.knowledge_private_open_outline(),
    openParent: m.knowledge_private_open_parent(),
    placeHere: m.knowledge_private_place_here(),
    save: m.knowledge_private_save(),
    notebookAcknowledged: m.knowledge_private_notebook_acknowledged(),
    documentAcknowledged: m.knowledge_private_document_acknowledged(),
    savedReceipt: m.knowledge_private_saved_receipt(),
    readbackConfirmed: m.knowledge_private_readback_confirmed(),
    currentHead: m.knowledge_private_current_head(),
    reviewPublication: m.knowledge_publication_review(),
    publishExact: m.knowledge_publication_confirm(),
    publicationAcknowledged: m.knowledge_publication_acknowledged(),
    publicationObserved: m.knowledge_publication_observed(),
    newerDraft: m.knowledge_publication_new_draft(),
    exactPublic: m.knowledge_publication_exact(),
    livePublic: m.knowledge_publication_live(),
    copy: m.knowledge_transfer_copy(),
    reviewDestination: m.knowledge_transfer_review(),
    confirmCopy: m.knowledge_transfer_confirm(),
    copied: m.knowledge_transfer_copied(),
    openCopy: m.knowledge_transfer_open(),
    openPrivate: m.knowledge_private_open_document(),
    liveKind: m.knowledge_live_kind(),
    exactKind: m.knowledge_exact_kind(),
    notFound: m.knowledge_not_found(),
    privateDenied: m.knowledge_private_denied(),
    privateNotFound: m.knowledge_private_not_found(),
  };
}
