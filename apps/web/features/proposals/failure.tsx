import { buttonVariants } from '@rezics/ui/button';
import { FileQuestionIcon, LogInIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ProposalMessages } from './messages.ts';
import type { ReadFailure } from './types.ts';

/** Why a proposal or list can't be shown, in words, with the next step. */
export function ProposalsFailure({ failure, signInHref, retryHref, locale, messages }: {
  failure: ReadFailure | 'signed-out'; signInHref: string; retryHref: string; locale: UiLocale; messages: ProposalMessages;
}) {
  const t = materializeData(messages, { locale });
  if (failure === 'signed-out' || failure === 'sign-in') {
    return <EmptyState icon={LogInIcon} role="status" title={t.signInTitle} description={t.signInHelp}>
      <a href={signInHref} className={buttonVariants()}>{t.signInAction}</a></EmptyState>;
  }
  if (failure === 'missing' || failure === 'invalid') {
    return <EmptyState icon={FileQuestionIcon} role="status" title={t.missingTitle} description={t.missingHelp} />;
  }
  return <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" title={t.unavailableTitle}
    description={t.unavailableHelp}>
    <LocalizedLink href={retryHref} className={buttonVariants({ variant: 'outline' })}>{t.retry}</LocalizedLink></EmptyState>;
}
