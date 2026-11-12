import { parseDocument, serializeDocument } from '@rezics/document';
import type { Actor } from '../request/access.ts';
import type { ReadContext } from './model.ts';
import { writeKnowledgeDocument } from './knowledge-commands.ts';
import { readKnowledgePrivateDocument, readKnowledgePublicDocument } from './knowledge-reads.ts';
import { KnowledgeNotFoundError, type KnowledgeCommandContext, type KnowledgeDependencies } from './knowledge-model.ts';
import {
  canonicalKnowledgeJson,
  knowledgeDigest,
  makeKnowledgeExport,
  remapKnowledgeCopy,
  type KnowledgeExport,
} from './knowledge-portable.ts';

export type KnowledgeSourceSelection =
  | Readonly<{ representation: 'public'; documentId: string; revisionId: string }>
  | Readonly<{
      representation: 'authoring';
      accountId: string;
      notebookId: string;
      documentId: string;
      revisionId: string;
    }>;
export type KnowledgeCopyInput = Readonly<{
  source: KnowledgeSourceSelection;
  expectedStructureRevisionId: string;
  parentPlacementId: string | null;
}>;

/** No implicit owner upgrade: even an author using the public address gets the public representation. */
export async function exportKnowledgeDocument(
  deps: KnowledgeDependencies,
  source: KnowledgeSourceSelection | Readonly<{ representation: 'public'; documentId: string; revisionId?: string }>,
  context: ReadContext,
) {
  const result =
    source.representation === 'authoring'
      ? await readKnowledgePrivateDocument(
          deps,
          source.accountId,
          source.notebookId,
          source.documentId,
          context,
          source.revisionId,
        )
      : await readKnowledgePublicDocument(
          deps,
          source.documentId,
          source.revisionId === undefined ? {} : { revisionId: source.revisionId },
          context,
        );
  const document = result.value.document;
  const snapshot = parseDocument(JSON.parse(Buffer.from(document.canonicalBytes, 'base64').toString('utf8')));
  const canonical = serializeDocument(snapshot);
  const envelope = makeKnowledgeExport({
    representation: source.representation,
    selection: {
      documentId: document.documentId,
      revisionId: document.revisionId,
      representation: source.representation,
      sha256: knowledgeDigest(canonical),
      ...(source.representation === 'public' ? { publicationId: document.publicationId! } : {}),
    },
    title: document.title,
    language: document.language,
    licence: document.licence,
    subjectIds: document.subjectIds,
    snapshot,
    references: document.references,
    provenance: document.provenance,
  });
  return { value: envelope, anchors: result.anchors };
}

export function serializeKnowledgeExport(envelope: KnowledgeExport): string {
  return canonicalKnowledgeJson(envelope);
}

export async function copyKnowledgeDocument(
  deps: KnowledgeDependencies,
  actor: Actor,
  notebookId: string,
  input: KnowledgeCopyInput,
  context: KnowledgeCommandContext,
) {
  if (actor.kind !== 'account') throw new KnowledgeNotFoundError();
  // Source is selected per command attempt before opening the destination transaction. The request pins
  // an exact revision, so a retry can never substitute a newer live publication or a hidden head.
  return writeKnowledgeDocument(deps, actor, notebookId, input, context, {
    kind: 'content.knowledge.document.copy',
    receiptInput: input,
    async prepare() {
      const selected = await exportKnowledgeDocument(deps, input.source, { actor, deadline: context.deadline });
      const copied = remapKnowledgeCopy(selected.value.snapshot, selected.value.references);
      return {
        input: {
          title: selected.value.title,
          language: selected.value.language,
          licence: selected.value.licence,
          subjectIds: selected.value.subjectIds,
          body: copied.snapshot,
          references: copied.references,
        },
        provenance: selected.value.provenance ?? selected.value.selection,
      };
    },
  });
}
