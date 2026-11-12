import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, serializeDocument } from '@rezics/document';
import {
  admitKnowledgeExport,
  copyKnowledgeTransfer,
  exportKnowledgeTransfer,
  parseKnowledgeTransferSource,
  readKnowledgeCopy,
  sealKnowledgeCopy,
  type KnowledgeTransferSource,
} from '../src/knowledge/transfer';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const publicSource: KnowledgeTransferSource = { representation: 'public', documentId: id(1), revisionId: id(2) };
const ownSource: KnowledgeTransferSource = {
  ...publicSource,
  representation: 'authoring',
  accountId: id(99),
  notebookId: id(10),
};
const snapshot = fromPlainText('Exact TeX: \\frac{α}{β}\n  code();\nUnicode: 雪', 'blocks');
const selection = { ...publicSource, sha256: 'a'.repeat(64), publicationId: id(3) };
function envelope(source = publicSource) {
  return {
    version: 'knowledge-document-export-v1',
    representation: source.representation,
    selection: {
      documentId: source.documentId,
      revisionId: source.revisionId,
      representation: source.representation,
      sha256: 'a'.repeat(64),
      ...(source.representation === 'public' ? { publicationId: id(3) } : {}),
    },
    title: 'Exact source',
    language: 'en',
    licence: 'CC-BY-SA-4.0',
    subjectIds: [id(4)],
    snapshot,
    references: [
      {
        id: 'citation',
        role: 'cites',
        target: { kind: 'revision', documentId: id(6), revisionId: id(7), sha256: 'b'.repeat(64), blockId: 'step' },
      },
    ],
    provenance: selection,
    sha256: 'c'.repeat(64),
  };
}

test('generated public and owner export each make one exact no-store GET and preserve the native envelope text', async () => {
  const calls: Request[] = [];
  for (const source of [publicSource, ownSource]) {
    const bytes = JSON.stringify(envelope(source));
    const result = await exportKnowledgeTransfer(
      (decorate) =>
        createKernelClient('https://kernel.test', {
          fetch: decorate((async (input, init) => {
            calls.push(new Request(input, init));
            return new Response(bytes, { headers: { 'content-type': 'application/json' } });
          }) as typeof fetch),
        }),
      source,
      source.representation === 'authoring' ? 'Bearer saved-owner' : undefined,
    );
    expect(result).toEqual({ state: 'ready', bytes });
    const request = calls.at(-1)!;
    expect(request.method).toBe('GET');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    expect(new URL(request.url).searchParams.get('revisionId')).toBe(id(2));
    expect(request.headers.get('authorization')).toBe(source.representation === 'public' ? null : 'Bearer saved-owner');
  }
  expect(calls).toHaveLength(2);
  expect(calls.map((r) => new URL(r.url).pathname)).toEqual([
    `/v1/knowledge/documents/${id(1)}/export`,
    `/v1/accounts/${id(99)}/knowledge/notebooks/${id(10)}/documents/${id(1)}/export`,
  ]);
});

test('HTTP boundary accepts only the exact closed source union and native envelope limits', () => {
  expect(parseKnowledgeTransferSource(publicSource)).toEqual(publicSource);
  expect(parseKnowledgeTransferSource(ownSource)).toEqual(ownSource);
  for (const input of [
    { ...publicSource, accountId: id(99) },
    { ...publicSource, revisionId: 'live' },
    { ...ownSource, notebookId: '' },
    { documentId: id(1) },
  ])
    expect(parseKnowledgeTransferSource(input)).toBeNull();
  expect(admitKnowledgeExport(envelope(), publicSource)).toBe(true);
  for (const input of [
    { ...envelope(), version: 'v2' },
    { ...envelope(), representation: 'authoring' },
    { ...envelope(), selection: { ...selection, revisionId: id(8) } },
    { ...envelope(), references: Array(65).fill(envelope().references[0]) },
    { ...envelope(), snapshot: fromPlainText('a'.repeat(2 * 1024 * 1024), 'blocks') },
    {
      ...envelope(),
      references: [
        { id: 'target', role: 'cites', target: { kind: 'document', documentId: id(1), body: 'private target' } },
      ],
    },
  ])
    expect(admitKnowledgeExport(input, publicSource)).toBe(false);
});

test('copy sends the exact native union/CAS once and separately reads the independent revision and provenance', async () => {
  const calls: Request[] = [];
  const canonical = serializeDocument(fromPlainText('Independent copied text', 'blocks'));
  const sha256 = new Bun.CryptoHasher('sha256').update(canonical).digest('hex');
  const receipt = {
    notebookId: id(10),
    documentId: id(11),
    revisionId: id(12),
    placementId: id(13),
    structureRevisionId: id(14),
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return request.method === 'POST'
        ? Response.json(receipt, { status: 201 })
        : Response.json({
            document: {
              ...receipt,
              title: 'Independent copy',
              language: 'en',
              licence: 'CC-BY-SA-4.0',
              subjectIds: [id(4)],
              publicationId: null,
              canonicalBytes: Buffer.from(canonical).toString('base64'),
              sha256,
              references: [],
              provenance: selection,
            },
          });
    }) as typeof fetch,
  });
  const intent = sealKnowledgeCopy({
    source: publicSource,
    notebookId: id(10),
    expectedStructureRevisionId: id(20),
    parentPlacementId: id(21),
    binding: { viewer: id(99), csrfToken: 'csrf', credential: 'captured' },
  });
  expect(await copyKnowledgeTransfer(client, intent, 'Bearer original')).toEqual({ state: 'acknowledged', receipt });
  expect(calls).toHaveLength(1);
  expect(await calls[0]!.json()).toEqual({
    source: publicSource,
    expectedStructureRevisionId: id(20),
    parentPlacementId: id(21),
  });
  expect(calls[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(intent.idempotencyKey));
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/knowledge/notebooks/${id(10)}/documents:copy`);
  const read = await readKnowledgeCopy(client, receipt, id(99), 'Bearer current');
  expect(read).toMatchObject({
    state: 'ready',
    head: { documentId: id(11), revisionId: id(12), publicationId: null },
    provenance: selection,
  });
  expect(calls).toHaveLength(2);
  expect(new URL(calls[1]!.url).searchParams.get('revisionId')).toBe(id(12));
  expect(calls[1]!.cache).toBe('no-store');
});
