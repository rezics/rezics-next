import { FileQuestionIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { CSSProperties, ReactNode } from 'react';
import type { ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { type AdaptContext, zoneWork } from '../realm/adapt.ts';
import type { RealmMessages } from '../realm/messages.ts';
import { realmWorkHref, siteHref } from '../realm/route.ts';
import type { ZoneRouteRead } from '../realm/types.ts';
import { Pager } from '../realm/views.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { bodyAfterTitle, ReaderText } from '../work-page/reader.tsx';
import { paragraphs } from '../work-page/format.ts';
import { RetryButton } from '../work-page/retry-button.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import type { WorkHeader, WorkText } from '../work-page/types.ts';
import { shortId } from '../work-page/route.ts';
import { ModuleHeading } from './module-frame.tsx';
import type { CardRenderer } from './modules.tsx';

// The pages a Zone's mounts give it: a mounted document, a mounted Collection's index, and the one state for
// a page this host cannot show yet.

type Route<Kind extends ZoneRouteRead['kind']> = Extract<ZoneRouteRead, { kind: Kind }>;

/**
 * A mounted document: its Main Version's published text under its title, in the text's own language and
 * direction. It sets the text as the reader does and adds none of the reader's chrome: the Zone's frame is
 * the page.
 */
export function DocumentPage({ work, text, messages }: {
  work: WorkHeader; text: WorkText; messages: WorkPageMessages;
}) {
  return <PageContainer>
    <article lang={text.language} dir="auto" className="mx-auto grid w-full max-w-3xl gap-6 [text-autospace:normal]">
      <header className="grid gap-2 border-border/60 border-b pb-4">
        <h1 lang={work.title.language} dir={work.title.direction} className="text-balance font-(family-name:--zone-heading-font)
          font-semibold text-[length:calc(1.875rem*var(--zone-heading-scale,1))] leading-tight tracking-tight">
          {work.title.value}</h1>
      </header>
      <div style={{ '--reader-size': '1.0625rem' } as CSSProperties}>
        <ReaderText lines={bodyAfterTitle(paragraphs(text.body), work.title.value)} formatNote={messages.textFormat} />
      </div>
    </article>
  </PageContainer>;
}

/** Main could not return a mounted document's text, though the mount exists. */
export function DocumentUnavailable({ messages, workMessages }: { messages: RealmMessages; workMessages: WorkPageMessages }) {
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1}
      title={messages.unavailableTitle} description={messages.documentUnavailable}>
      <RetryButton label={workMessages.retry} pendingLabel={workMessages.retrying} />
    </EmptyState>
  </PageContainer>;
}

/**
 * A mounted Collection: its public members a page at a time, each opening under the mount. A member that is
 * not a Work has no card to show yet; it opens as its page, which this host says it cannot show.
 */
export function IndexPage({ route, title, cursor, context, card, locale, messages, arrange }: {
  route: Route<'index'>; title: ReactNode; cursor: string | undefined; context: AdaptContext; card: CardRenderer;
  locale: UiLocale; messages: RealmMessages;
  /** The Zone package's `index` slot: given the page's Works and the platform's grid, returns the page's body. */
  arrange?: (works: ZoneWork[], grid: ReactNode) => ReactNode;
}) {
  const t = materializeData(messages, { locale });
  const segment = route.mount.segment;
  const here = (query: Record<string, string | undefined> = {}) => siteHref(locale, context.ref, [segment], query);
  const works = route.items.flatMap(item => 'title' in item ? [zoneWork(item, context, null, segment)] : []);
  const grid = <ul className="grid grid-cols-2 gap-x-(--zone-shelf-gap) gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
    {route.items.map(item => <li key={item.id} className="min-w-0">
      {'title' in item ? card(zoneWork(item, context, null, segment), { layout: 'cover' })
        : <LocalizedLink href={realmWorkHref(context.ref, item.id, segment)}
          className="block rounded-(--zone-radius-card) border border-border/60 p-4 text-sm underline-offset-4
            hover:underline">{t.pageItem({ id: shortId(item.id) })}</LocalizedLink>}
    </li>)}
  </ul>;
  return <PageContainer className="grid gap-6">
    <header><ModuleHeading id="zone-index-title" className="text-[length:calc(1.75rem*var(--zone-heading-scale,1))]">
      {title}</ModuleHeading></header>
    {route.items.length ? arrange ? arrange(works, grid) : grid
      : <EmptyState icon={FileQuestionIcon} title={messages.indexEmptyTitle} description={messages.indexEmptyBody} />}
    <Pager next={route.nextCursor ? here({ cursor: route.nextCursor }) : null} first={cursor ? here() : null}
      messages={messages} />
  </PageContainer>;
}

/** A page this host has no rendering for yet, whatever it is; one state, so the Zone's frame stays. */
export function PageNotAvailable({ messages }: { messages: RealmMessages }) {
  return <PageContainer>
    <EmptyState icon={FileQuestionIcon} headingLevel={1} title={messages.pageNotYetTitle}
      description={messages.pageNotYetBody} />
  </PageContainer>;
}
