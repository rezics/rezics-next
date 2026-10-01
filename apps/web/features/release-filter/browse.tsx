import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { ZoneContext, ZonePackage, ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import { ArrowLeftIcon, ArrowRightIcon, SearchXIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import type { CardRenderer } from '../zones/modules.tsx';
import { SlotBoundary } from '../zones/slot-boundary.tsx';
import type { ReleaseResult } from './adapt.ts';
import { chosenLabel, ReleaseFilterControl } from './control.tsx';
import type { ResolvedReleaseFilter } from './registry.ts';
import { noReleaseFilter, releaseFilterActive, releaseFilterHref, type ReleaseFilterState, without } from './state.ts';

/** The control, inside the package's `browseHeader` slot when it has one. */
export function ReleaseBrowseHeader({ zone, pkg, spec, filter, state, base }: {
  zone: ZoneContext; pkg: ZonePackage | null; spec: ZoneReleaseFilterSpec; filter: ResolvedReleaseFilter;
  state: ReleaseFilterState; base: string;
}) {
  const control = <ReleaseFilterControl spec={spec} filter={filter} state={state} action={base} clearHref={base} />;
  const Slot = pkg?.slots.browseHeader;
  return Slot ? <SlotBoundary slot="browseHeader" fallback={control}>
    <Slot zone={zone} filter={control} filtered={releaseFilterActive(state)} fallback={control} Link={LocalizedLink} />
  </SlotBoundary> : control;
}

const chip = cn('inline-flex h-7 items-center gap-1.5 rounded-full border border-border/80 bg-accent px-3 text-sm',
  'text-accent-foreground outline-none transition-colors hover:border-primary/50 focus-visible:ring-2',
  'focus-visible:ring-ring');

/**
 * A Zone's release-filtered results: the control above what Main matched, each card saying which
 * release matched (the card is the package's `workCard` slot or the platform's row), the chosen
 * conditions as removable chips, and the paging Main's cursor gives. An empty page says no release
 * meets the group; it never offers a Work whose title alone looks right.
 */
export function ReleaseBrowse({ header, spec, filter, state, base, items, next, card, messages, locale, firstPage }: {
  header: ReactNode; spec: Pick<ZoneReleaseFilterSpec, 'summary' | 'noMatch' | 'keepLooking'>;
  filter: ResolvedReleaseFilter; state: ReleaseFilterState; base: string;
  items: readonly ReleaseResult[]; next: string | null; card: CardRenderer; messages: ZoneMessages; locale: UiLocale;
  /** The words for the link back to the first page. */
  firstPage: string;
}) {
  const t = materializeData(messages, { locale });
  const chosen = filter.fields.filter(field => state.conditions[field.facet] !== undefined);
  const clear = releaseFilterHref(base, noReleaseFilter);
  return <PageContainer className="grid grid-cols-1 gap-4">
    {header}
    <section aria-labelledby="release-results" className="grid min-w-0 grid-cols-1 gap-4">
      <h2 id="release-results" className="sr-only">{spec.summary}</h2>
      <p role="status" className="font-medium text-sm">{spec.summary}</p>
      {chosen.length ? <ul aria-label={messages.filters} className="flex flex-wrap items-center gap-1.5">
        {chosen.map(field => {
          const label = chosenLabel(filter, field.facet, state.conditions[field.facet]!);
          return <li key={field.facet}><LocalizedLink href={releaseFilterHref(base, without(state, field.facet))}
            aria-label={t.removeFilter({ label })} className={chip}>
            {label}<XIcon aria-hidden="true" className="size-3.5" /></LocalizedLink></li>;
        })}
      </ul> : null}
      {items.length ? <ul data-release-results="" className="grid grid-cols-1 divide-y divide-border/60
        rounded-(--zone-radius-card) border border-border/60 bg-card">
        {items.map(({ work, matches }) => <li key={work.id} className="min-w-0 p-3 sm:p-4">
          {card(work, { layout: 'row', matches })}</li>)}
      </ul> : next ? <p role="status" className="rounded-xl bg-muted/60 px-4 py-3 text-muted-foreground text-sm">
        {spec.keepLooking}</p> : <EmptyState icon={SearchXIcon} title={spec.noMatch.title} description={spec.noMatch.body}
        headingLevel={3}>
        <LocalizedLink href={clear} className={buttonVariants({ variant: 'outline' })}>{messages.clearAll}</LocalizedLink>
      </EmptyState>}
      {next || state.cursor ? <nav className="flex flex-wrap justify-center gap-2">
        {state.cursor ? <LocalizedLink href={releaseFilterHref(base, { ...state, cursor: null })}
          className={buttonVariants({ variant: 'ghost' })}>
          <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />{firstPage}</LocalizedLink> : null}
        {next ? <LocalizedLink href={releaseFilterHref(base, { ...state, cursor: next })}
          className={buttonVariants({ variant: 'outline' })}>
          {messages.next}<ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" /></LocalizedLink> : null}
      </nav> : null}
    </section>
  </PageContainer>;
}
