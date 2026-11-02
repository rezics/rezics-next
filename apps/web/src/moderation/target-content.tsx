import { parseDocument } from '@rezics/document';
import { Tombstone } from '@rezics/ui/tombstone';
import { Withheld } from '@rezics/ui/withheld';
import type { ReactNode } from 'react';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { Byline } from '../threads/byline';
import { NativeDocumentImage } from '../threads/document-media';
import { exactRevisionHref } from '../threads/exact-revision-href';
import { revisionDocumentImage } from '../threads/exact-revision-media';
import { threadLocation } from '../threads/thread-href';
import type { ResolvedReportTarget } from './reports-read';
import { moderationEvidence, type ModerationEvidence } from './target-context';

export type ModerationTarget = ResolvedReportTarget;

/** Production presentation boundary shared by reports, appeals and their canonical stories. */
export function moderationTargetContent(target: ModerationTarget | undefined): ReactNode {
  const evidence = moderationEvidence(target?.value);
  if (evidence) {
    if (target?.kind !== evidence.kind || target.key !== `${evidence.kind}:${evidence.id}`)
      return m.moderation_target_unavailable();
    return <EvidenceContent evidence={evidence} />;
  }
  // Older component recordings have no native identity or enrichment. They still use the same document renderer.
  if (!target?.value || typeof target.value !== 'object') return m.moderation_target_unavailable();
  const data = target.value as Record<string, unknown>;
  const raw = data[target.kind] ?? data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return m.moderation_target_unavailable();
  const resource = raw as Record<string, unknown>;
  if (resource.id !== undefined && target.key !== `${target.kind}:${resource.id}`)
    return m.moderation_target_unavailable();
  if (resource.availability === 'withheld') return withheld();
  if (resource.availability === 'erased' || resource.availability === 'deleted' || resource.removed)
    return erased(target.kind);
  if (resource.availability !== undefined && resource.availability !== 'available')
    return m.moderation_target_unavailable();
  if (target.kind !== 'post')
    return typeof resource.title === 'string' && resource.title ? resource.title : m.threads_untitled();
  const revision =
    resource.revision && typeof resource.revision === 'object'
      ? (resource.revision as Record<string, unknown>)
      : resource;
  if (revision.availability === 'withheld') return withheld();
  if (revision.availability === 'erased' || revision.availability === 'deleted' || revision.removed)
    return erased(target.kind);
  if (revision.availability !== undefined && revision.availability !== 'available')
    return m.moderation_target_unavailable();
  const body = revision.body ?? resource.body;
  try {
    return typeof body === 'string' ? (
      body
    ) : body ? (
      <DocumentBody document={parseDocument(body)} />
    ) : (
      m.moderation_target_unavailable()
    );
  } catch {
    return m.moderation_target_unavailable();
  }
}

function withheld() {
  return <Withheld shape="passage" labels={{ withheld: m.moderation_target_withheld() }} />;
}
function erased(kind: ModerationTarget['kind']) {
  return (
    <Tombstone
      shape={kind === 'post' ? 'post' : 'row'}
      reason="deleted"
      labels={{ deleted: m.moderation_target_deleted() }}
    />
  );
}
function EvidenceContent({ evidence }: { evidence: ModerationEvidence['moderationEvidence'] }) {
  const session = useSession();
  const locale = getLocale();
  if (session.state !== 'unknown' && (session.state !== 'signed-in' || session.subject !== evidence.viewerId))
    return m.moderation_target_unavailable();
  if (evidence.state === 'withheld') return withheld();
  if (evidence.state === 'erased') return erased(evidence.kind);
  if (evidence.state !== 'available') return m.moderation_target_unavailable();
  const post = evidence.post;
  const thread = evidence.thread;
  const postId = evidence.kind === 'post' ? post?.id : undefined;
  // Evidence can belong to a different page of the current thread reader.
  // Keep its anchored identity and let the existing point locator admit that page.
  // Thread and board evidence still link to the thread beginning.
  const destination = thread ? threadLocation(locale, thread, undefined, postId) : undefined;
  return (
    <div className="w-full min-w-0 max-w-prose space-y-3 [overflow-wrap:anywhere]">
      <div className="space-y-1 text-sm">
        {thread ? (
          <a className="block underline underline-offset-4" href={destination}>
            {thread.title || m.threads_untitled()}
          </a>
        ) : evidence.kind !== 'board' ? (
          <p className="text-muted-foreground">{m.moderation_target_unavailable()}</p>
        ) : null}
        {evidence.board ? (
          <a
            className="block text-muted-foreground underline underline-offset-4"
            href={localizeHref(`/boards/${encodeURIComponent(evidence.board.id)}`)}
          >
            {evidence.board.title || m.threads_untitled()}
          </a>
        ) : null}
      </div>
      {post ? (
        <>
          <Byline
            author={evidence.author ?? undefined}
            createdAt={post.revisedAt ?? post.createdAt}
            now={evidence.now}
            size="sm"
          />
          <DocumentBody
            className="mx-0! w-full min-w-0 overflow-x-auto [overflow-wrap:anywhere]"
            document={post.body}
            locale={locale}
            renderImage={({ mediaId, alt }) => (
              <NativeDocumentImage
                image={revisionDocumentImage(evidence.documentMedia, post, mediaId)}
                alt={alt}
                locale={locale}
              />
            )}
          />
          <p className="text-xs text-muted-foreground">
            {m.thread_history_licence()}: {post.licence}
          </p>
          {evidence.exact ? (
            <a
              className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
              href={exactRevisionHref({ postId: post.id, revisionId: post.revisionId }, locale)}
            >
              {m.moderation_reported_revision_label()}
            </a>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
