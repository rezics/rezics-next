import { ContentActions } from '@rezics/ui/content-actions';
import type { ReportDialogLabels, ReportSubmission } from '@rezics/ui/report-dialog';
import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { EllipsisIcon, LinkIcon } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { csrfHeaders } from '../threads/composer';
import { sendReport } from './actions';
import type { ReportResult } from './submit.server';
import { Verification, type VerificationConfig } from './turnstile';

function labels(): ReportDialogLabels {
  return {
    title: m.report_title(),
    description: m.report_description(),
    reasons: m.report_reasons(),
    offTopic: m.report_off_topic(),
    offTopicDescription: m.report_off_topic_description(),
    inappropriate: m.report_inappropriate(),
    inappropriateDescription: m.report_inappropriate_description(),
    spam: m.report_spam(),
    spamDescription: m.report_spam_description(),
    illegal: m.report_illegal(),
    illegalDescription: m.report_illegal_description(),
    other: m.report_other(),
    otherDescription: m.report_other_description(),
    details: m.report_details(),
    detailsRequiredHint: m.report_details_hint(),
    characterCount: m.report_count(),
    characterCountText: m.report_count_text({ count: '{count}', max: '{max}' }),
    verification: m.report_verification(),
    submit: m.report_submit(),
    submitting: m.report_submitting(),
    cancel: m.report_cancel(),
    success: m.report_success(),
    successDescription: m.report_success_description(),
    failure: m.report_unavailable(),
  };
}
function refusalText(result: Extract<ReportResult, { ok: false }>): string {
  switch (result.reason) {
    case 'closed':
      return m.platform_closed_message();
    case 'forbidden':
      return m.report_forbidden();
    case 'invalid':
      return m.report_invalid();
    case 'rate-limited':
      return m.report_rate_limited({ seconds: result.retryAfter ?? 1 });
    default:
      return m.report_unavailable();
  }
}

export function PostActions({
  target,
  revisionId,
  ownsContent,
  verification,
}: {
  target: { kind: 'thread' | 'post'; id: string };
  revisionId?: string;
  ownsContent: boolean;
  verification: VerificationConfig;
}) {
  const [token, setToken] = useState('');
  const reset = useRef<(() => void) | null>(null);
  const key = useRef('');
  const start = useCallback(() => {
    key.current = crypto.randomUUID();
  }, []);
  const copyLink = () =>
    navigator.clipboard.writeText(`${location.origin}${location.pathname}#${target.kind}-${target.id}`);
  const report = async ({ reason, details }: ReportSubmission) => {
    let result: ReportResult;
    try {
      result = await sendReport({
        data: {
          target,
          ...(revisionId ? { revisionId } : {}),
          reason,
          ...(details ? { evidence: details } : {}),
          botToken: token,
          idempotencyKey: key.current,
        },
        headers: csrfHeaders(),
      });
    } catch {
      reset.current?.();
      throw new Error(m.report_unavailable());
    }
    if (!result.ok) {
      reset.current?.();
      throw new Error(refusalText(result));
    }
  };

  // The shared owner's menu also requires edit and delete handlers. Until those operations
  // exist on this page, owners have only the supported copy-link action.
  if (ownsContent)
    return (
      <Menu>
        <MenuTrigger asChild>
          <Button aria-label={m.report_more()} size="icon-sm" variant="ghost">
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onClick={copyLink} value="copy-link">
            <LinkIcon aria-hidden="true" />
            {m.report_copy()}
          </MenuItem>
        </MenuContent>
      </Menu>
    );
  return (
    <ContentActions
      ownsContent={false}
      onCopyLink={copyLink}
      onReport={report}
      labels={{ moreActions: m.report_more(), copyLink: m.report_copy(), report: m.report_action() }}
      reportLabels={labels()}
      maxDetails={4096}
      verified={Boolean(token)}
      verification={
        <Verification config={verification} locale={getLocale()} onToken={setToken} reset={reset} onStart={start} />
      }
    />
  );
}
