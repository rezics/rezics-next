import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { websiteSignInHref } from '../session/return-target';

export function ExistingReviewNotice({ reviewId }: { reviewId: string }) {
  const locale = getLocale();
  return (
    <p className="min-w-0 [overflow-wrap:anywhere]">
      {m.thread_review_duplicate()}{' '}
      <a
        href={`/${locale}/threads/${reviewId}`}
        className={cn(
          buttonVariants({ variant: 'link', size: 'sm' }),
          'h-auto min-h-6 max-w-full whitespace-normal [overflow-wrap:anywhere]',
        )}
      >
        {m.thread_review_existing()}
      </a>
    </p>
  );
}

export function SignInPrompt({
  returnTo,
  label,
  compact = false,
}: {
  returnTo: string;
  label?: string;
  compact?: boolean;
}) {
  const href = websiteSignInHref(returnTo);
  const text = label ?? m.account_sign_in();
  if (compact)
    return (
      <a
        href={href}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'h-auto min-h-6 max-w-full whitespace-normal [overflow-wrap:anywhere]',
        )}
      >
        {text}
      </a>
    );
  return (
    <p className="min-w-0 rounded-lg border border-border/70 bg-card p-4 text-muted-foreground [overflow-wrap:anywhere]">
      <a href={href} className={cn(buttonVariants({ variant: 'link' }), 'h-auto min-h-7 max-w-full whitespace-normal')}>
        {text}
      </a>
    </p>
  );
}
