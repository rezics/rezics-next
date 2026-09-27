import { buttonVariants } from '@rezics/ui/button';
import { FileQuestionIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { RetryButton } from '../work-page/retry-button.tsx';
import { studioHref } from './agent.ts';
import type { StudioMessages } from './messages.ts';
import { idOf, type ReadFailure } from './types.ts';

/**
 * The writing page when there is nothing to write on: Main could not answer
 * (retry), this Agent may not see the text, or Studio cannot tell which save is
 * the latest (`position`), which it says rather than opening an older one.
 */
export function WriteUnavailable({ agent, failure, position = false, work, locale, messages }: {
  agent: AgentOption; failure: ReadFailure; position?: boolean; work?: string; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const back = <Link href={work ? studioHref(agent, `/works/${idOf(work)}`) : studioHref(agent)}
    className={buttonVariants({ variant: 'outline' })}>{work ? t.backToWork : t.backToStudio}</Link>;
  return <PageContainer className="max-w-2xl">
    {failure === 'unavailable' && !position
      ? <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1} title={t.textFailed}>
        <RetryButton label={t.retry} pendingLabel={t.retry} />{back}</EmptyState>
      : <EmptyState icon={FileQuestionIcon} headingLevel={1} title={position ? t.textFailed : work ? t.textMissing : t.workMissing}
        description={position ? t.textPosition : undefined}>{back}</EmptyState>}
  </PageContainer>;
}
