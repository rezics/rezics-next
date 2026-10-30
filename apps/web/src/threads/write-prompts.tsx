import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

export function ExistingReviewNotice({ reviewId }: { reviewId: string }) {
  const locale = getLocale();
  return (
    <p>
      {m.thread_review_duplicate()}{' '}
      <a className="font-medium text-primary underline underline-offset-4" href={`/${locale}/threads/${reviewId}`}>
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
  const href = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  const text = label ?? m.account_sign_in();
  if (compact)
    return (
      <a
        className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 font-medium text-primary underline-offset-4 outline-none hover:bg-muted hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        href={href}
      >
        {text}
      </a>
    );
  return (
    <p className="rounded-lg border border-border/70 bg-card p-4 text-muted-foreground">
      <a className="font-medium text-primary underline-offset-4 hover:underline" href={href}>
        {text}
      </a>
    </p>
  );
}
