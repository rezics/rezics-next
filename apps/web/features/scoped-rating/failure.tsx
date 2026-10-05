import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { translate, type Translation } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import type { Failure } from './types.ts';

export function failureText(failure: Failure, t: Translation): string {
  switch (failure) {
    case 'missing': return t.failMissing;
    case 'sign-in': return t.failSignIn;
    case 'denied': return t.failDenied;
    case 'invalid': return t.failInvalid;
    case 'work-mismatch': return t.failWorkMismatch;
    case 'conflict': return t.failConflict;
    case 'moved':
    case 'unavailable': return t.failUnavailable;
  }
}

/** What a region says when it has no data: the reason in words, and a way on where one exists. */
export function FailureNote({ failure, locale, messages, retry, signInHref, className, children }: {
  failure: Failure; locale: UiLocale; messages: ScopedRatingMessages; retry?: () => void; signInHref?: string;
  className?: string; children?: ReactNode;
}) {
  const t = translate(messages, locale);
  return <div role="status" data-failure={failure}
    className={cn('grid justify-items-start gap-2 rounded-2xl bg-muted/60 px-4 py-3 text-sm', className)}>
    <p>{failureText(failure, t)}</p>
    {failure === 'sign-in' && signInHref ? <Link href={signInHref} className={buttonVariants({ size: 'sm' })}>{t.signInToRate}</Link> : null}
    {retry && failure !== 'sign-in' && failure !== 'denied' && failure !== 'missing' && failure !== 'work-mismatch'
      ? <Button size="sm" variant="outline" onClick={retry}>{t.retry}</Button> : null}
    {children}
  </div>;
}
