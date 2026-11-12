import { expect, test } from 'bun:test';
import { fromPlainText, normalizeDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import {
  canonicalKnowledgeJson,
  knowledgeDigest,
  KNOWLEDGE_REFERENCE_DEFINITION,
  makeKnowledgeExport,
  parseKnowledgeExport,
  remapKnowledgeCopy,
  validateKnowledgeReferences,
  type KnowledgeReference,
} from '../../src/content/knowledge-portable.ts';
import { newId } from '../../src/route/route.ts';

export function portableBody(): DocumentSnapshot {
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'statement' },
          content: [
            { type: 'text', text: 'See theorem', marks: [{ type: 'link', attrs: { href: '#statement' } }] },
            {
              type: 'extensionInline',
              attrs: {
                id: 'citation',
                definition: KNOWLEDGE_REFERENCE_DEFINITION,
                version: '1',
                payload: { referenceId: 'ref' },
                fallback: 'A theorem',
              },
            },
          ],
        },
        {
          type: 'extensionBlock',
          attrs: {
            id: 'math',
            definition: 'example.math-source',
            version: '1',
            payload: { source: '\\forall x, x = x', nested: { id: 'statement', referenceId: 'ref' } },
            fallback: '\\forall x, x = x',
          },
        },
      ],
    },
  });
}

const external: KnowledgeReference = {
  id: 'ref',
  role: 'cites',
  sourceBlockId: 'statement',
  target: {
    kind: 'revision',
    documentId: newId(0),
    revisionId: newId(0),
    sha256: 'a'.repeat(64),
    blockId: 'external-block',
  },
};

test('portable envelope and contained Document validate independently and detect representation or metadata tampering', () => {
  const snapshot = fromPlainText('An exact statement');
  const selection = {
    documentId: newId(0),
    revisionId: newId(0),
    representation: 'authoring' as const,
    sha256: knowledgeDigest(serializeDocument(snapshot)),
  };
  const envelope = makeKnowledgeExport({
    representation: 'authoring',
    selection,
    snapshot,
    title: 'Statement',
    language: 'en',
    licence: 'MIT',
    subjectIds: [],
    references: [],
    provenance: null,
  });
  expect(parseKnowledgeExport(JSON.parse(canonicalKnowledgeJson(envelope)))).toEqual(envelope);
  expect(() => parseKnowledgeExport({ ...envelope, title: 'Changed' })).toThrow('digest mismatch');
  const { sha256: _digest, ...payload } = envelope;
  const malformedBody = makeKnowledgeExport({
    ...payload,
    snapshot: { ...snapshot, version: 'bad' } as unknown as DocumentSnapshot,
  });
  expect(() => parseKnowledgeExport(malformedBody)).toThrow('snapshot');
  const wrongSelection = makeKnowledgeExport({ ...payload, selection: { ...selection, sha256: 'b'.repeat(64) } });
  expect(() => parseKnowledgeExport(wrongSelection)).toThrow('representation digest mismatch');
});

test('copy remaps local component/reference/block identities and fragment links while preserving opaque math and exact external citations', () => {
  const snapshot = portableBody();
  validateKnowledgeReferences(snapshot, [external]);
  let sequence = 0;
  const copied = remapKnowledgeCopy(snapshot, [external], () => `new-${++sequence}`);
  expect(copied.references[0]!.id).not.toBe(external.id);
  expect(copied.references[0]!.target).toEqual(external.target);
  const paragraph = copied.snapshot.doc.content![0]!;
  expect(copied.references[0]!.sourceBlockId).toBe(paragraph.attrs!.id);
  expect(paragraph.content![0]!.marks![0]!.attrs!.href).toBe(`#${paragraph.attrs!.id}`);
  expect(paragraph.content![1]!.attrs!.payload).toEqual({ referenceId: copied.references[0]!.id });
  expect(copied.snapshot.doc.content![1]!.attrs!.payload).toEqual(snapshot.doc.content![1]!.attrs!.payload);
  expect(snapshot.doc.content![0]!.attrs!.id).toBe('statement');
  expect(validateKnowledgeReferences(copied.snapshot, copied.references)).toEqual(copied.references);
});

test('reference components reject duplicate, missing, orphan and absent source anchors at the authoring boundary', () => {
  const snapshot = portableBody();
  expect(() => validateKnowledgeReferences(snapshot, [])).toThrow();
  expect(() => validateKnowledgeReferences(snapshot, [external, external])).toThrow();
  expect(() => validateKnowledgeReferences(snapshot, [{ ...external, sourceBlockId: 'absent' }])).toThrow();
  expect(() => validateKnowledgeReferences(fromPlainText('No component'), [external])).toThrow();
  const bad = JSON.parse(serializeDocument(snapshot));
  bad.doc.content[0].content[1].attrs.payload.targetId = 'private target';
  expect(() => validateKnowledgeReferences(bad, [external])).toThrow();
});
