import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { copyOf } from '../work-levels/messages.ts';
import type { BooksReleasePage } from './books-edition-page.read.ts';
import { EditionsSection } from './editions.tsx';
import type { WorkPageMessages } from './messages.ts';
import { Region } from './region.tsx';
import type { Loaded } from './types.ts';
import { YourEdition } from './your-edition.tsx';

/** The Books hub's bounded edition slice; the Work frame supplies its title and personal status. */
export function BooksEditionPage({ work, releases, signInHref, editionsHref, locale, messages }: {
  work: string; releases: Loaded<BooksReleasePage>; signInHref: string; editionsHref: string;
  locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const levels = copyOf(locale);
  const inventory = releases.ok ? { entries: releases.data.items, nextCursor: releases.data.nextCursor } : null;
  if (inventory && !inventory.entries.length && !inventory.nextCursor) return <section aria-label={t.sectionAvailability}
    id="work-availability" data-hub-empty className="grid gap-2 text-muted-foreground text-sm">
    <p>{levels.noReleasesBody}</p>
    <details className="min-w-0">
      <summary className="w-fit cursor-pointer rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        {t.yourEdition}</summary>
      <div className="pt-3"><YourEdition work={work} locale={locale} messages={messages} signInHref={signInHref} /></div>
    </details>
  </section>;
  return <Region id="work-availability" title={t.sectionAvailability} className="grid-cols-1">
    <YourEdition work={work} locale={locale} messages={messages} signInHref={signInHref} />
    <EditionsSection items={inventory?.entries ?? null}
      failure={releases.ok ? null : releases.failure} locale={locale} messages={messages} />
    <Link href={editionsHref} className="text-primary text-sm underline underline-offset-4">{levels.allEditions}</Link>
  </Region>;
}
