import type { ContentCore } from '../../../../content/src/core.ts';
import type { NotificationSubjectReader, SubjectResolution } from './dispatcher.ts';

/** Recipient-specific disclosure decided by the subject's owner at delivery time. */
export type RecipientDisclosure = (principalId: string, revisionIds: readonly string[]) =>
  Promise<ReadonlySet<string>>;

/**
 * Content revision subjects: one bounded exact read per delivery. An erased
 * revision resolves to erased, a denied one to undisclosed; the delivery never
 * substitutes the current head or a stored copy for the pinned revision.
 */
export function contentSubjectReader(content: Pick<ContentCore, 'readExactBatch'>,
  disclosure: RecipientDisclosure): NotificationSubjectReader {
  return {
    async resolve(input): Promise<SubjectResolution> {
      if (input.owner !== 'content' || !input.revision) return { status: 'unavailable' };
      const revision = input.revision;
      const [read] = await content.readExactBatch([revision], ids => disclosure(input.principalId, ids));
      if (!read) return { status: 'unavailable' };
      if (read.status === 'erased') return { status: 'erased' };
      if (read.status === 'denied') return { status: 'undisclosed' };
      if (read.status !== 'available') return { status: 'unavailable' };
      const title = typeof read.body.title === 'string' ? read.body.title.slice(0, 200) : '';
      return { status: 'available', subject: { private: true,
        fields: { revision, digest: read.reference.byteDigest, ...(title ? { title } : {}) } } };
    },
  };
}
