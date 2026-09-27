import { Skeleton } from '@rezics/ui/skeleton';
import { TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { RetryButton } from './retry-button.tsx';
import type { AgentCreditPage, CreditPage, Loaded } from './types.ts';

/** Main keeps Open Library's author path (`/authors/OL1A`); the page shows and links the ID. */
export const openLibraryAuthorKey = (key: string) => key.replace(/^\/authors\//, '');

/**
 * Who made the Work, as Goodreads sets it under the title: authors in the
 * Work-title face, then "Translated by" and "Edited by" in smaller type.
 * Native credits name their Agent (with the handle on hover); confirmed Open
 * Library author references are linked by their reference rather than given
 * an invented name. When one of the two reads fails, the other still shows
 * and the gap is said.
 */
export function WorkCredits({ agentCredits, credits, locale, messages }: {
  agentCredits: Loaded<AgentCreditPage>; credits: Loaded<CreditPage>; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const failure = !agentCredits.ok || !credits.ok;
  const retry = failure ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
    <TriangleAlertIcon aria-hidden="true" className="size-4 text-destructive-foreground" />
    <span className="text-destructive-foreground">
      {!agentCredits.ok && !credits.ok ? t.creditsUnavailable : t.someCreditsUnavailable}</span>
    <RetryButton label={t.retry} pendingLabel={t.retrying} />
  </div> : null;
  const native = agentCredits.ok ? agentCredits.data.items : [];
  const external = credits.ok ? [...credits.data.items].sort((a, b) => a.ordinal - b.ordinal) : [];
  if (!native.length && !external.length) return retry ?? <p className="text-muted-foreground text-sm">{t.noCredits}</p>;
  const more = (agentCredits.ok && agentCredits.data.nextCursor) || (credits.ok && credits.data.nextCursor);
  const authors = native.filter(credit => credit.role === 'author');
  const others = (['translator', 'editor'] as const).map(role => ({ role,
    people: native.filter(credit => credit.role === role) })).filter(group => group.people.length);
  // Centred under the cover on a phone, beside it from lg, as the title is.
  return <div className="grid gap-1.5">
    {authors.length || external.length ? <p className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1
      lg:justify-start">
      <span className="sr-only">{t.author}: </span>
      {authors.map(credit => <span key={credit.id} title={`@${credit.handle}`}
        className="font-work-title text-foreground/85 text-xl sm:text-2xl">{credit.displayName}</span>)}
      {external.map(credit => {
        const key = openLibraryAuthorKey(credit.key);
        return <a key={credit.id} href={`https://openlibrary.org/authors/${encodeURIComponent(key)}`} rel="noreferrer"
          className="font-medium text-primary text-sm underline-offset-4 hover:underline">
          {/* A text arrow joined by a no-break space wraps with the last word; an icon would not. */}
          {t.openLibraryAuthor({ key })}{'\u00a0'}<span aria-hidden="true">↗</span></a>;
      })}
    </p> : null}
    {others.length ? <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-muted-foreground text-sm
      lg:justify-start">
      {others.map(group => <span key={group.role}>
        {group.role === 'translator' ? t.translatedBy : t.editedBy}{' '}
        {group.people.map((credit, index) => <span key={credit.id} title={`@${credit.handle}`}
          className="font-medium text-foreground">{index ? ', ' : ''}{credit.displayName}</span>)}
      </span>)}
    </p> : null}
    {more ? <p className="text-muted-foreground text-xs">{t.moreCredits}</p> : null}
    {retry}
  </div>;
}

export function WorkCreditsSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex gap-2">
    <Skeleton className="h-5 w-16 rounded-md" /><Skeleton className="h-5 w-40 rounded-md" />
  </div>;
}
