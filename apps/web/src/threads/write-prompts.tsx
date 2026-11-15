import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { websiteSignInHref } from '../session/return-target';

export function ExistingReviewNotice({ reviewId }: { reviewId: string }) {
  const locale = getLocale();
  return (
    <p className="min-w-0 [overflow-wrap:anywhere]">
      {m.thread_review_duplicate()}{' '}
      <Button
        variant="link"
        size="sm"
        className="h-auto min-h-6 max-w-full whitespace-normal"
        nativeButton={false}
        render={<a href={`/${locale}/threads/${reviewId}`} />}
      >
        {m.thread_review_existing()}
      </Button>
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
      <Button
        variant="outline"
        size="sm"
        className="h-auto min-h-6 max-w-full whitespace-normal"
        nativeButton={false}
        render={<a href={href} />}
      >
        {text}
      </Button>
    );
  return (
    <p className="min-w-0 rounded-lg border border-border/70 bg-card p-4 text-muted-foreground [overflow-wrap:anywhere]">
      <Button
        variant="link"
        className="h-auto min-h-7 max-w-full whitespace-normal"
        nativeButton={false}
        render={<a href={href} />}
      >
        {text}
      </Button>
    </p>
  );
}
