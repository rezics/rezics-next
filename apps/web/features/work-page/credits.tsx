import { Skeleton } from '@rezics/ui/skeleton';
import { ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { RetryButton } from './retry-button.tsx';
import type { CreditPage, Loaded } from './types.ts';

/** Main keeps Open Library's author path (`/authors/OL1A`); the page shows and links the ID. */
export const openLibraryAuthorKey = (key: string) => key.replace(/^\/authors\//, '');

/**
 * The header's credit line. Main records confirmed Open Library author
 * references and no native Agent or display name yet, so each credit names
 * its reference and links to it rather than inventing a name.
 */
export function WorkCredits({ credits, locale, messages }: {
  credits: Loaded<CreditPage>; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  if (!credits.ok) {
    return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
      <TriangleAlertIcon aria-hidden="true" className="size-4 text-destructive-foreground" />
      <span className="text-destructive-foreground">{t.creditsUnavailable}</span>
      <RetryButton label={t.retry} pendingLabel={t.retrying} />
    </div>;
  }
  const items = [...credits.data.items].sort((a, b) => a.ordinal - b.ordinal);
  if (!items.length) return <p className="text-muted-foreground text-sm">{t.noCredits}</p>;
  return <div className="grid gap-1 text-sm">
    <dl className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="text-muted-foreground">{t.author}</dt>
      {items.map(credit => {
        const key = openLibraryAuthorKey(credit.key);
        return <dd key={credit.id}>
          <a href={`https://openlibrary.org/authors/${encodeURIComponent(key)}`} rel="noreferrer"
            className="font-medium text-primary underline-offset-4 hover:underline">
            {t.openLibraryAuthor({ key })}<ExternalLinkIcon aria-hidden="true" className="ms-1 inline size-3.5 align-[-2px]" /></a>
        </dd>;
      })}
    </dl>
    {credits.data.nextCursor ? <p className="text-muted-foreground text-xs">{t.moreCredits}</p> : null}
  </div>;
}

export function WorkCreditsSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex gap-2">
    <Skeleton className="h-5 w-16 rounded-md" /><Skeleton className="h-5 w-40 rounded-md" />
  </div>;
}
