import type { ContentCore } from '../../../../content/src/core.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { NotificationSubjectReader, SubjectResolution } from './dispatcher.ts';
import type { NotificationStore } from './store.ts';

/** Recipient-specific disclosure decided by the subject's owner at delivery time. */
export type RecipientDisclosure = (principalId: string, revisionIds: readonly string[]) =>
  Promise<ReadonlySet<string>>;

const workReaderBasis = /^content-work-reader-v1:(https:\/\/rezics\.com\/id\/[0-9a-f-]{36})$/;

/** Stable basis format for producer events that disclose a Content Work to one recipient. */
export function contentWorkDisclosureBasis(actingSubject: string): string {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) {
    throw new Error('invalid Content disclosure subject');
  }
  return `content-work-reader-v1:${actingSubject}`;
}

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

/**
 * Production Content adapter: recover the recipient from Access, re-evaluate
 * current Work read authority there, then resolve only the pinned Content
 * revision. Unsupported bases and cross-owner identities fail closed.
 */
export function currentContentSubjectReader(content: Pick<ContentCore,
  'owningResourceForRevision' | 'readExactBatch'>,
  notifications: Pick<NotificationStore, 'readRecipientIdentity'>,
  access: Pick<AccessAdmissionRegistry, 'canReadWork'>): NotificationSubjectReader {
  return {
    async resolve(input): Promise<SubjectResolution> {
      if (input.owner !== 'content' || !input.revision) return { status: 'unavailable' };
      const basis = workReaderBasis.exec(input.disclosureBasis);
      if (!basis) return { status: 'undisclosed' };
      const recipient: VerifiedPrincipal | null = await notifications.readRecipientIdentity(input.principalId);
      if (!recipient) return { status: 'undisclosed' };
      const resource = await content.owningResourceForRevision(input.revision);
      if (!resource) return { status: 'unavailable' };
      const allowed = await access.canReadWork(recipient, basis[1]!, resource);
      const [read] = await content.readExactBatch([input.revision], async ids =>
        allowed ? new Set(ids) : new Set<string>());
      if (!read) return { status: 'unavailable' };
      if (read.status === 'erased') return { status: 'erased' };
      if (read.status === 'denied') return { status: 'undisclosed' };
      if (read.status !== 'available') return { status: 'unavailable' };
      const title = typeof read.body.title === 'string' ? read.body.title.slice(0, 200) : '';
      return { status: 'available', subject: { private: true,
        fields: { revision: input.revision, digest: read.reference.byteDigest, ...(title ? { title } : {}) } } };
    },
  };
}
