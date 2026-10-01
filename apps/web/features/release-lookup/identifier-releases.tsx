import { materializeData } from 'native-i18n';
import { buttonVariants } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { ReleaseCard } from '../work-levels/editions.tsx';
import { copyOf } from '../work-levels/messages.ts';
import { namesOf } from '../work-levels/read.ts';
import type { ReleasePage } from '../work-levels/types.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { type ReleaseIdentifier, releaseLookupHref } from './route.ts';

const outline = buttonVariants({ variant: 'outline', size: 'sm' });

/**
 * Several releases carry one store identifier (or Main has more to give): the reader chooses, none is picked
 * for them. The identifier is shown with its provider, since the same value under another provider is another release.
 */
export async function IdentifierReleases({ lookup, releases, cursor, locale, messages }: {
  lookup: ReleaseIdentifier; releases: ReleasePage; cursor: boolean; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = copyOf(locale);
  const words = materializeData(messages, { locale });
  const names = await namesOf(releases.items.flatMap(item => item.coverage.map(entry => entry.work)));
  return <div className="grid gap-6">
    <header className="grid gap-1">
      <h1 className="font-semibold text-3xl tracking-tight">{words.identifierMatches}</h1>
      <p data-release-lookup className="flex min-w-0 flex-wrap gap-x-2 text-muted-foreground text-sm [overflow-wrap:anywhere]">
        <span>{lookup.provider}</span><span className="font-mono">{lookup.identifier}</span></p>
    </header>
    <div className="grid gap-5">{releases.items.map(release => <ReleaseCard key={release.id} release={release} names={names}
      locale={locale} t={t} headingLevel={2} />)}</div>
    {releases.nextCursor || cursor ? <nav aria-label={t.releasesPages} className="flex flex-wrap justify-between gap-2">
      {cursor ? <Link href={releaseLookupHref(lookup)} className={outline}>{t.firstPage}</Link> : <span />}
      {releases.nextCursor ? <Link href={releaseLookupHref(lookup, releases.nextCursor)} className={outline}>{t.showMore}</Link> : null}
    </nav> : null}
  </div>;
}
