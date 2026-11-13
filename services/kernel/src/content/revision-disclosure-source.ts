import type { AccessClient } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { isSpdxLicense } from './document.ts';
import {
  type RevisionDisclosureSource,
  type RevisionDisclosureSourceRow,
  type RevisionDisclosureTarget,
} from './revision-disclosure-model.ts';
import { revisionDisclosureSourceHome } from './revision-disclosure-store.ts';
import observeSource from './revision-disclosure-source.sql';
import currentSource from './revision-disclosure-current.sql';

function sourceFromRow(row: RevisionDisclosureSourceRow): RevisionDisclosureSource | null {
  if (
    row.post_visibility !== 'draft' ||
    row.thread_visibility !== 'draft' ||
    row.post_availability !== 'available' ||
    row.thread_availability !== 'available' ||
    row.revision_availability !== 'available' ||
    row.author_erased ||
    row.reply_to_post_id !== null ||
    row.first_post_id !== row.post_id ||
    !isSpdxLicense(row.licence)
  )
    return null;
  return {
    threadId: row.thread_id,
    postId: row.post_id,
    revisionId: row.revision_id,
    sha256: row.sha256,
    licence: row.licence,
    creatorAccountId: row.creator_account_id,
    incarnation: {
      postTransactionId: row.source_post_transaction_id,
      threadTransactionId: row.source_thread_transaction_id,
      postSecurityRevision: row.source_post_security_revision,
      threadSecurityRevision: row.source_thread_security_revision,
    },
  };
}

/** Exact private opening observation. Attachment readability is not this check. */
export async function observeRevisionDisclosureSource(
  client: AccessClient,
  target: RevisionDisclosureTarget,
): Promise<RevisionDisclosureSource | null> {
  const route = revisionDisclosureSourceHome(target);
  if (route === null) return null;
  const row = await observeSource.run(client, {
    route,
    thread_id: target.threadId,
    post_id: target.postId,
    revision_id: target.revisionId,
    sha256: target.sha256,
    partition_no: partitionOf(route),
  });
  if (!row) return null;
  const source = sourceFromRow(row);
  if (
    !source ||
    source.threadId !== target.threadId ||
    source.postId !== target.postId ||
    source.revisionId !== target.revisionId ||
    source.sha256 !== target.sha256
  )
    return null;
  return source;
}

export async function revisionDisclosureSourceCurrent(
  client: AccessClient,
  source: RevisionDisclosureSource,
): Promise<boolean> {
  const route = revisionDisclosureSourceHome(source);
  if (route === null) return false;
  const row = await currentSource.run(client, {
    route,
    thread_id: source.threadId,
    post_id: source.postId,
    revision_id: source.revisionId,
    sha256: source.sha256,
    source_post_transaction_id: source.incarnation.postTransactionId,
    source_thread_transaction_id: source.incarnation.threadTransactionId,
  });
  return row !== null;
}
