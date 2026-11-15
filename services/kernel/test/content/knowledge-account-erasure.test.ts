import { expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import {
  knowledgeMediaQuery,
  knowledgeMediaSource,
  type KnowledgeMediaSelection,
} from '@rezics/definitions/knowledge-media';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import {
  advanceKnowledgeAccountErasure,
  isKnowledgeAccountErasureCursor,
  type KnowledgeAccountErasureCursor,
} from '../../src/content/knowledge-account-erasure.ts';
import { knowledgeMediaRetentionSelection } from '../../src/content/knowledge-media-selection.ts';
import { advanceKnowledgeLifecycleRestorePage } from '../../src/content/knowledge-lifecycle-work.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { createKnowledgeMediaDriver, currentMediaUploadScenario } from './media-driver.ts';
import type { ContentCredential } from './support/system.ts';

setDefaultTimeout(360_000);

test('account disposition retains all selected revisions and media without private ancestry and resumes after a hold', async () => {
  const media = await createKnowledgeMediaDriver();
  try {
    const { system } = currentMediaUploadScenario();
    const pool = system.database.pool;
    const author = system.actors.author;
    const accountId = author.actor.accountId;
    const route = routeOf(accountId)!;
    const call = async (actor: ContentCredential | null, method: string, path: string, body?: unknown) => {
      const response = await system.kernel.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
            ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const text = await response.text();
      return { status: response.status, value: text ? (JSON.parse(text) as Record<string, any>) : null };
    };
    const command = async (path: string, body: unknown, expected = 200) => {
      const result = await call(author, 'POST', path, body);
      expect(result.status, JSON.stringify(result.value)).toBe(expected);
      return result.value!;
    };
    const { subject } = await command(
      '/v1/subjects',
      { type: 'skos:Concept', labels: { en: 'Retained Knowledge' } },
      201,
    );
    const notebook = await command(
      '/v1/knowledge/notebooks',
      { subjectId: subject.id, title: 'Private notebook identity' },
      201,
    );
    const privateRoot = await command(
      `/v1/knowledge/notebooks/${notebook.notebookId}/documents`,
      {
        title: 'Private ancestor',
        body: fromPlainText('Private ancestor manuscript'),
        licence: 'MIT',
        subjectIds: [],
        expectedStructureRevisionId: notebook.structureRevisionId,
        parentPlacementId: null,
      },
      201,
    );
    const document = await command(
      `/v1/knowledge/notebooks/${notebook.notebookId}/documents`,
      {
        title: 'Initial private child',
        body: fromPlainText('Unselected initial child'),
        licence: 'MIT',
        subjectIds: [],
        expectedStructureRevisionId: privateRoot.structureRevisionId,
        parentPlacementId: privateRoot.placementId,
      },
      201,
    );
    let structure = document.structureRevisionId;
    for (let index = 0; index < 6; index++) {
      const sibling = await command(
        `/v1/knowledge/notebooks/${notebook.notebookId}/documents`,
        {
          title: `Private root sibling ${index}`,
          body: fromPlainText(`Private root manuscript ${index}`),
          licence: 'MIT',
          subjectIds: [],
          expectedStructureRevisionId: structure,
          parentPlacementId: null,
        },
        201,
      );
      structure = sibling.structureRevisionId;
    }
    const rootHistory = await pool.query<{ count: number; nonnull: number }>(
      `SELECT (count(*) FILTER(WHERE parent_id IS NULL))::integer AS count,
              (count(*) FILTER(WHERE parent_id IS NOT NULL))::integer AS nonnull
       FROM content.knowledge_structure_parent_root WHERE route=$1 AND notebook_id=$2`,
      [route, notebook.notebookId],
    );
    expect(rootHistory.rows[0]!.count).toBeGreaterThan(4);
    expect(rootHistory.rows[0]!.nonnull).toBeGreaterThan(0);
    const secondNotebook = await command(
      '/v1/knowledge/notebooks',
      { subjectId: subject.id, title: 'Second private identity' },
      201,
    );
    const secondDocument = await command(
      `/v1/knowledge/notebooks/${secondNotebook.notebookId}/documents`,
      {
        title: 'Second selected contribution',
        body: fromPlainText('Selected in another notebook'),
        licence: 'MIT',
        subjectIds: [],
        expectedStructureRevisionId: secondNotebook.structureRevisionId,
        parentPlacementId: null,
      },
      201,
    );
    const secondPublication = await command(`/v1/knowledge/documents/${secondDocument.documentId}/publication:select`, {
      expectedHeadRevisionId: secondDocument.revisionId,
      expectedPublicationId: null,
      revisionId: secondDocument.revisionId,
    });
    const restoringRoot = await command(
      `/v1/knowledge/notebooks/${secondNotebook.notebookId}/documents`,
      {
        title: 'Pending private restore',
        body: fromPlainText('Pending private root manuscript'),
        licence: 'MIT',
        subjectIds: [],
        expectedStructureRevisionId: secondDocument.structureRevisionId,
        parentPlacementId: null,
      },
      201,
    );
    const restoringChild = await command(
      `/v1/knowledge/notebooks/${secondNotebook.notebookId}/documents`,
      {
        title: 'Pending restore child',
        body: fromPlainText('Pending private child manuscript'),
        licence: 'MIT',
        subjectIds: [],
        expectedStructureRevisionId: restoringRoot.structureRevisionId,
        parentPlacementId: restoringRoot.placementId,
      },
      201,
    );
    await command(`/v1/knowledge/documents/${restoringRoot.documentId}:trash`, {
      expectedStructureRevisionId: restoringChild.structureRevisionId,
      expectedGeneration: '0',
    });
    const restoring = await command(`/v1/knowledge/documents/${restoringRoot.documentId}:restore`, {
      expectedStructureRevisionId: restoringChild.structureRevisionId,
      expectedGeneration: '1',
    });
    expect(restoring).toMatchObject({ complete: false, reason: 'restoring' });
    const oldRestore = (
      await pool.query<{ operation_id: string }>(
        'SELECT operation_id FROM content.knowledge_lifecycle_restore WHERE route=$1 AND root_document_id=$2',
        [route, restoringRoot.documentId],
      )
    ).rows[0]!.operation_id;

    // Use the existing ordinary upload, website completion and real image-processing fixture.
    const source = await media.source('tiny');
    const reservationRequestId = crypto.randomUUID();
    const reserved = await media.reserve('author', {
      requestId: reservationRequestId,
      containerId: document.documentId,
      purpose: 'knowledge-image',
      type: source.type,
      length: source.bytes.length,
      sha256: source.sha256,
    });
    if (reserved.outcome !== 'permitted') throw new Error(`Knowledge reservation: ${reserved.outcome}`);
    const mediaId = reserved.media.id;
    await media.placeOriginal(mediaId, source.bytes);
    expect(
      await media.complete('worker', {
        requestId: crypto.randomUUID(),
        reservationRequestId,
        containerId: document.documentId,
        byteCount: source.bytes.length,
        sha256: source.sha256,
      }),
    ).toBe('permitted');
    expect(await media.process('job', mediaId)).toBe('permitted');
    const output = (await media.derivatives(mediaId))[0]!;
    const image = await media.decode(output.bytes);
    const variant = `${image.format}-${image.width}`;
    const imageBody = (title: string) =>
      normalizeDocument({
        version: 'rezics-document-v1',
        profile: 'blocks',
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', attrs: { id: 'caption' }, content: [{ type: 'text', text: title }] },
            { type: 'image', attrs: { id: 'image', src: knowledgeMediaSource(mediaId), alt: title } },
          ],
        },
      });
    const first = await command(`/v1/knowledge/documents/${document.documentId}/revisions:revise`, {
      expectedHeadRevisionId: document.revisionId,
      title: 'Selected one',
      body: imageBody('Selected one'),
      licence: 'MIT',
      subjectIds: [],
    });
    const firstPublication = await command(`/v1/knowledge/documents/${document.documentId}/publication:select`, {
      expectedHeadRevisionId: first.revisionId,
      expectedPublicationId: null,
      revisionId: first.revisionId,
    });
    const second = await command(`/v1/knowledge/documents/${document.documentId}/revisions:revise`, {
      expectedHeadRevisionId: first.revisionId,
      title: 'Selected two',
      body: imageBody('Selected two'),
      licence: 'MIT',
      subjectIds: [],
    });
    await command(`/v1/knowledge/documents/${document.documentId}/publication:select`, {
      expectedHeadRevisionId: second.revisionId,
      expectedPublicationId: firstPublication.publicationId,
      revisionId: second.revisionId,
    });
    const unselected = await command(`/v1/knowledge/documents/${document.documentId}/revisions:revise`, {
      expectedHeadRevisionId: second.revisionId,
      title: 'Private working title',
      body: fromPlainText('Unselected private working body'),
      licence: 'MIT',
      subjectIds: [],
    });
    const publicPath = `/v1/knowledge/documents/${document.documentId}`;
    const before = await Promise.all(
      [first.revisionId, second.revisionId].map(async (revisionId) => {
        const read = await call(null, 'GET', `${publicPath}?revisionId=${revisionId}`);
        expect(read.status, JSON.stringify(read.value)).toBe(200);
        return read.value!.document;
      }),
    );
    const selectedBytes = (
      await pool.query<{
        revision_id: string;
        canonical_bytes: Buffer;
        body_sha256: Buffer;
        media_ids: string[];
      }>(
        `SELECT revision_id,canonical_bytes,body_sha256,media_ids FROM content.knowledge_revision
       WHERE route=$1 AND document_id=$2 AND revision_id=ANY($3::uuid[]) ORDER BY revision_id`,
        [route, document.documentId, [first.revisionId, second.revisionId]],
      )
    ).rows;
    const mediaSource: KnowledgeMediaSelection = {
      representation: 'public',
      documentId: document.documentId,
      revisionId: first.revisionId,
      publicationId: firstPublication.publicationId,
      sourceSha256: before[0].sourceSha256,
    };
    const imagePath = `/v1/media/${mediaId}:authorizeDownload?${new URLSearchParams({ variant, ...knowledgeMediaQuery(mediaSource) })}`;
    expect((await call(null, 'GET', imagePath)).status).toBe(200);

    // Retention fixtures alter only the real native hold field, not disposition authority.
    await pool.query('UPDATE content.knowledge_document SET legal_hold=true WHERE route=$1 AND document_id=$2', [
      route,
      privateRoot.documentId,
    ]);
    const runtime = accountDeletionRuntime(system);
    const obligation = await deletePersona(
      { version: 1, pool, auth: runtime.auth },
      { accountId, bearer: author.bearer },
    );
    let step = 0;
    const page = async (cursor: KnowledgeAccountErasureCursor | null, number: number) =>
      runCommand(
        pool,
        {
          partition: partitionOf(route),
          deadline: Date.now() + 120_000,
          authorization: {
            action: 'content.knowledge.account-disposition',
            resource: { route, id: accountId },
            async authorize(tx) {
              const status = await readErasureStatus(tx, accountId);
              if (!status || status.at !== obligation.at)
                throw new Error('Original immutable erasure obligation is missing');
              return 'execute';
            },
            denied: () => new Error('Original immutable erasure obligation is missing'),
          },
          receipt: {
            actorAccountId: accountId,
            kind: 'content.knowledge.account-disposition',
            key: `${accountId}:${number}`,
            digest: createHash('sha256')
              .update(JSON.stringify({ accountId, cursor, number, limit: 4 }))
              .digest(),
          },
        },
        async (tx) => noEffect(await advanceKnowledgeAccountErasure(tx, accountId, cursor, 4)),
      );
    const firstPage = await page(null, step++);
    expect((await page(null, 0)).value).toEqual(firstPage.value);
    let cursor = firstPage.value.next;
    let heldStep = -1;
    let heldCursor: KnowledgeAccountErasureCursor | null = null;
    let heldValue: typeof firstPage.value | undefined;
    while (!heldValue) {
      if (!cursor || step > 256) throw new Error('Fixture did not reach its bounded hold');
      expect(isKnowledgeAccountErasureCursor(cursor)).toBe(true);
      const number = step++;
      const result = await page(cursor, number);
      expect(result.value.found).toBeLessThanOrEqual(4);
      if (result.value.pending) {
        heldStep = number;
        heldCursor = cursor;
        heldValue = result.value;
      }
      cursor = result.value.next;
    }
    const markers = (
      await pool.query<{ retained_public_generation: string | null }>(
        'SELECT retained_public_generation::text FROM content.knowledge_document WHERE route=$1 AND document_id=ANY($2::uuid[])',
        [route, [document.documentId, secondDocument.documentId]],
      )
    ).rows;
    expect(markers).toHaveLength(2);
    expect(markers.every((row) => row.retained_public_generation === '0')).toBe(true);
    expect(
      (
        await pool.query('SELECT revision_id FROM content.knowledge_revision WHERE route=$1 AND document_id=$2', [
          route,
          privateRoot.documentId,
        ])
      ).rowCount,
    ).toBe(1);
    await pool.query('UPDATE content.knowledge_document SET legal_hold=false WHERE route=$1 AND document_id=$2', [
      route,
      privateRoot.documentId,
    ]);
    expect((await page(heldCursor, heldStep)).value).toEqual(heldValue);
    while (cursor) {
      if (step > 256) throw new Error('Fixture disposition did not exhaust');
      expect(isKnowledgeAccountErasureCursor(cursor)).toBe(true);
      const result = await page(cursor, step++);
      expect(result.value.pending).not.toBe(true);
      expect(result.value.found).toBeLessThanOrEqual(4);
      cursor = result.value.next;
    }

    expect((await page(null, step++)).value).toMatchObject({ next: null, found: 0 });
    expect((await page(null, 0)).value).toEqual(firstPage.value);
    expect(
      (
        await pool.query('SELECT notebook_id FROM content.knowledge_notebook WHERE route=$1 AND owner_account_id=$2', [
          route,
          accountId,
        ])
      ).rowCount,
    ).toBe(0);
    for (const table of [
      'knowledge_placement',
      'knowledge_structure_page',
      'knowledge_structure_change',
      'knowledge_structure_parent_root',
      'knowledge_structure_revision',
      'knowledge_lifecycle_frontier',
      'knowledge_lifecycle_restore',
    ])
      expect(
        (
          await pool.query(`SELECT 1 FROM content.${table} WHERE route=$1 AND notebook_id=ANY($2::uuid[])`, [
            route,
            [notebook.notebookId, secondNotebook.notebookId],
          ])
        ).rowCount,
      ).toBe(0);
    const retained = (
      await pool.query<{
        revision_id: string;
        canonical_bytes: Buffer;
        body_sha256: Buffer;
        media_ids: string[];
        author_account_id: string | null;
      }>(
        'SELECT revision_id,canonical_bytes,body_sha256,media_ids,author_account_id FROM content.knowledge_revision WHERE route=$1 AND document_id=$2 ORDER BY revision_id',
        [route, document.documentId],
      )
    ).rows;
    expect(retained).toHaveLength(2);
    expect(selectedBytes).toHaveLength(2);
    retained.forEach((row, index) => {
      const selected = selectedBytes[index];
      if (!selected) throw new Error('selected revision bytes missing');
      expect(row).toEqual({ ...selected, author_account_id: null });
    });
    expect(retained.every((row) => row.media_ids.length === 1 && row.media_ids[0] === mediaId)).toBe(true);
    expect(retained.some((row) => row.revision_id === unselected.revisionId)).toBe(false);
    const documents = (
      await pool.query<{
        document_id: string;
        notebook_id: string | null;
        head_revision_id: string | null;
        created_at: Date | null;
        created_transaction_id: string | null;
        purge_completed: boolean;
      }>(
        'SELECT document_id,notebook_id,head_revision_id,created_at,created_transaction_id,purge_completed FROM content.knowledge_document WHERE route=$1 AND document_id=ANY($2::uuid[])',
        [
          route,
          [
            document.documentId,
            privateRoot.documentId,
            secondDocument.documentId,
            restoringRoot.documentId,
            restoringChild.documentId,
          ],
        ],
      )
    ).rows;
    expect(
      documents.every(
        (row) =>
          row.notebook_id === null &&
          row.head_revision_id === null &&
          row.created_at === null &&
          row.created_transaction_id === null,
      ),
    ).toBe(true);
    expect(documents.find((row) => row.document_id === privateRoot.documentId)?.purge_completed).toBe(true);
    expect(await knowledgeMediaRetentionSelection(pool, route, privateRoot.documentId)).toMatchObject({
      disposition: 'erased',
    });
    expect(await knowledgeMediaRetentionSelection(pool, route, document.documentId)).toMatchObject({
      disposition: 'retained',
    });
    expect(
      (
        await pool.query('SELECT revision_id FROM content.knowledge_revision WHERE route=$1 AND document_id=$2', [
          route,
          privateRoot.documentId,
        ])
      ).rowCount,
    ).toBe(0);
    for (const [index, revisionId] of [first.revisionId, second.revisionId].entries()) {
      const read = await call(null, 'GET', `${publicPath}?revisionId=${revisionId}`);
      expect(read.status, JSON.stringify(read.value)).toBe(200);
      expect(read.value!.document.canonicalBytes).toBe(before[index].canonicalBytes);
      expect(read.value!.document.sourceSha256).toBe(before[index].sourceSha256);
      expect(read.value!.document.authorId).toBeNull();
    }
    const secondKept = await call(
      null,
      'GET',
      `/v1/knowledge/documents/${secondDocument.documentId}?revisionId=${secondDocument.revisionId}`,
    );
    expect(secondKept.status, JSON.stringify(secondKept.value)).toBe(200);
    expect(secondKept.value!.document.publicationId).toBe(secondPublication.publicationId);
    expect((await call(null, 'GET', `${publicPath}?revisionId=${unselected.revisionId}`)).status).toBe(404);
    expect((await call(null, 'GET', `/v1/knowledge/documents/${privateRoot.documentId}`)).status).toBe(404);
    expect((await call(null, 'GET', imagePath)).status).toBe(200);
    expect(await advanceKnowledgeLifecycleRestorePage(pool, system.access, oldRestore, () => new Date())).toMatchObject(
      { state: 'missing', complete: true },
    );
    await expect(
      pool.query(
        'UPDATE content.knowledge_document SET notebook_id=$3,head_revision_id=$4 WHERE route=$1 AND document_id=$2',
        [route, document.documentId, notebook.notebookId, first.revisionId],
      ),
    ).rejects.toThrow('cannot restore private or public state');
  } finally {
    await media.close();
  }
});
