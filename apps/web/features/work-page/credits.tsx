import { Skeleton } from '@rezics/ui/skeleton';
import { TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { RetryButton } from './retry-button.tsx';
import type { AgentCreditPage, CreditPage, Loaded } from './types.ts';

/** Main keeps Open Library's author path (`/authors/OL1A`); the page shows and links the ID. */
export const openLibraryAuthorKey = (key: string) => key.replace(/^\/authors\//, '');

const roles = ['author', 'translator', 'editor'] as const;

/**
 * The header's credit lines, one per role. Native credits name their Agent
 * and handle; confirmed Open Library author references follow, named by their
 * reference and linked to it rather than given an invented name. When one of
 * the two reads fails, the other still shows and the gap is said.
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
  return <div className="grid gap-1 text-sm">
    <dl className="grid gap-1">
      {roles.map(role => {
        const people = native.filter(credit => credit.role === role);
        const references = role === 'author' ? external : [];
        if (!people.length && !references.length) return null;
        return <div key={role} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <dt className="text-muted-foreground">{t[role]}</dt>
          {people.map(credit => <dd key={credit.id} className="flex min-w-0 items-baseline gap-1 font-medium">
            {credit.displayName}
            {/* Unclaimed handles are long machine names; keep them to one line. */}
            <span title={`@${credit.handle}`} className="max-w-40 truncate font-normal text-muted-foreground">
              @{credit.handle}</span>
          </dd>)}
          {references.map(credit => {
            const key = openLibraryAuthorKey(credit.key);
            return <dd key={credit.id}>
              <a href={`https://openlibrary.org/authors/${encodeURIComponent(key)}`} rel="noreferrer"
                className="font-medium text-primary underline-offset-4 hover:underline">
                {/* A text arrow joined by a no-break space wraps with the last word; an icon would not. */}
                {t.openLibraryAuthor({ key })}{'\u00a0'}<span aria-hidden="true">↗</span></a>
            </dd>;
          })}
        </div>;
      })}
    </dl>
    {more ? <p className="text-muted-foreground text-xs">{t.moreCredits}</p> : null}
    {retry}
  </div>;
}

export function WorkCreditsSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex gap-2">
    <Skeleton className="h-5 w-16 rounded-md" /><Skeleton className="h-5 w-40 rounded-md" />
  </div>;
}
