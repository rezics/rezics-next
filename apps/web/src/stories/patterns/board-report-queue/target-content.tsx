import { documentText, parseDocument } from '@rezics/document';
import { Tombstone } from '@rezics/ui/tombstone';
import { Withheld } from '@rezics/ui/withheld';
import type { ReactNode } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { ResolvedReportTarget } from '../../../moderation/reports-read';

export type ModerationTarget = ResolvedReportTarget;
export function moderationTargetContent(target: ModerationTarget | undefined): ReactNode {
  if (!target?.value || typeof target.value !== 'object') return m.moderation_target_unavailable();
  const data = target.value as Record<string, unknown>;
  const raw = data.post ?? data.thread ?? data.board ?? data;
  const resource = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return m.moderation_target_unavailable();
  if (resource.availability === 'withheld')
    return <Withheld shape="passage" labels={{ withheld: m.moderation_target_withheld() }} />;
  if (resource.availability === 'erased' || resource.availability === 'deleted' || resource.removed)
    return (
      <Tombstone
        shape={target.kind === 'post' ? 'post' : 'row'}
        reason="deleted"
        labels={{ deleted: m.moderation_target_deleted() }}
      />
    );
  if (resource.availability === 'unavailable') return m.moderation_target_unavailable();
  const revision =
    resource.revision && typeof resource.revision === 'object'
      ? (resource.revision as Record<string, unknown>)
      : resource;
  if (target.kind === 'post') {
    const body = revision.body ?? resource.body;
    try {
      return typeof body === 'string'
        ? body
        : body && typeof body === 'object'
          ? documentText(parseDocument(body))
          : m.moderation_target_unavailable();
    } catch {
      return m.moderation_target_unavailable();
    }
  }
  return typeof resource.title === 'string' && resource.title ? resource.title : m.threads_untitled();
}
