import { m } from '../paraglide/messages.js';
import type { InboxNotice } from './inbox-decode';

/** Localize the installed system messages while retaining any separately supplied notice text. */
export function inboxNoticeSummary({ kind, summary }: Pick<InboxNotice, 'kind' | 'summary'>): string | undefined {
  if (kind === 'reply' && summary === 'replied in a discussion') return m.inbox_notice_reply_summary();
  if (kind === 'mention' && summary === 'mentioned you') return m.inbox_notice_mention_summary();
  if (kind !== 'moderation_decision') return summary;

  switch (summary) {
    case 'your report was actioned':
      return m.inbox_notice_report_actioned();
    case 'your report was dismissed':
      return m.inbox_notice_report_dismissed();
    case 'your appeal restored the content':
      return m.decision_appeal_reversed();
    case 'your appeal was upheld':
      return m.decision_appeal_upheld();
    case 'your content was taken down':
      return m.inbox_notice_content_removed();
    case 'a moderation outcome was recorded':
      return m.inbox_kind_moderation();
    default:
      return summary;
  }
}
