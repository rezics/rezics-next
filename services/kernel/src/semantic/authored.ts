import { recordSemanticDocumentSource } from './record-source-set.ts';
import type { Release } from '@rezics/definitions';
import { currentCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { appendAuthoredField } from '../content/authored-fields.ts';
import type { Resource } from '../request/access.ts';
import { revisionResource } from './authorship.ts';
import { creationDeclares } from '../access/parent-creation.ts';

/** Compatibility wrapper retaining the actual prepared Global Context authority. */
export function authoredAuthorization(authorization: CommandAuthorization, subject: Resource): CommandAuthorization {
  void subject;
  return authorization;
}

export type ProposalInstall = (allocated: {
  candidate: string;
  revision: number;
  body: unknown;
}) => Promise<unknown | undefined>;

type AuthoredEvent = { type: string; subject: string; data: unknown };

function authoredInstall(tx: CommandTransaction, subject: string, events: AuthoredEvent[]): ProposalInstall {
  return async ({ candidate, revision, body }) => {
    const content = (body as { value: { content: { document: unknown; licence: string; language: string } } }).value
      .content;
    const stored = await appendAuthoredField(tx, {
      subject,
      ...(creationDeclares(tx, revisionResource(subject, revision))
        ? { anchor: revisionResource(subject, revision).id }
        : {}),
      candidate,
      revision,
      ...content,
    });
    await recordSemanticDocumentSource(tx, {
      kind: 'contribution',
      subjectId: subject,
      candidateId: candidate,
      revision,
      documentId: stored.id,
    });
    events.push({
      type: 'com.rezics.content.authored-field.created.v1',
      subject,
      data: { id: stored.id, subject, candidate, authorId: currentCommand(tx).basis!.actorAccountId },
    });
    return { language: content.language, document: stored.id, digest: stored.digest };
  };
}

/** Install each document against its containing candidate, including qualifier and reference values.
 * Work only on a copy: serialization retries must see the original snapshot input.
 */
export async function installAuthoredStatement(
  tx: CommandTransaction,
  subject: string,
  release: Release,
  allocated: { candidate: string; revision: number; body: unknown },
  property: string,
): Promise<{ body: unknown; events: AuthoredEvent[] }> {
  const body = structuredClone(allocated.body) as {
    value: { type: string; content?: unknown };
    qualifiers: { property: string; value: { type: string; content?: unknown } }[];
    references: { parts: { property: string; value: { type: string; content?: unknown } }[] }[];
  };
  const events: AuthoredEvent[] = [];
  const install = authoredInstall(tx, subject, events);
  for (const snak of [
    { property, value: body.value },
    ...body.qualifiers,
    ...body.references.flatMap((reference) => reference.parts),
  ]) {
    if (release.properties[snak.property]?.datatype !== 'document' || snak.value.type !== 'value') continue;
    snak.value.content = await install({ ...allocated, body: snak });
  }
  return { body, events };
}
