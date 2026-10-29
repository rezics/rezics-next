import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, VIEWS, type CompositionDocument, type View } from '@rezics/composition';
import type { ComponentProps, ReactNode } from 'react';
import { Cover, type CoverLabels, type CoverRatio } from '@rezics/ui/cover';
import { MetaLine } from '@rezics/ui/meta-line';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../../media/summary';
import { originalLanguage, originalTitle } from '../../subject/language';
import { defaultReader, type Reader } from '../../subject/reader';
import type { Subject } from '../../subject/types';
import { subjectHref } from '../../subject/subject-href';
import { pageText } from './data';
import { dateText } from './overview';
import { linkClass, linkColor, bestRank, isRecord, PlainLink, type PageLink, type Stmt } from './shared';
import { loadSubjectPage, pageContext, SubjectPage, type SubjectPageData } from './subject';
import { ViewTabs, type ViewTabLabels } from './view-tabs';
import type { ViewTab } from './views';

const DATE_PROPERTIES = ['schema:datePublished', 'schema:startDate', 'schema:dateCreated'];
/** The Wikidata time precisions that name a year, a month and a day. */
const PRECISION_ISO = { 9: 4, 10: 7, 11: 10 } as const;

/** What the compact header of a view page shows of its subject: a constant number of fields, however large the subject. */
export type SubjectFrameData = {
  id: string;
  type: string;
  /** The title in the reader's language; empty for a subject with no label at all. */
  title: { text: string; lang?: string | undefined };
  /** The title the subject was first written under, when it differs from the one shown. */
  original?: { text: string; lang: string };
  date?: string;
  summary: SubjectSummary | null;
};

function subjectRead(page: SubjectPageData): { subject: Subject; summary: SubjectSummary | null } | undefined {
  const planned = Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads,
  ).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
  const result = planned ? page.reads[planned[0]] : undefined;
  if (result?.status !== 200 || !isRecord(result.body) || !isRecord(result.body.subject)) return;
  const summary = isRecord(result.body.summary) ? (result.body.summary as unknown as SubjectSummary) : null;
  return { subject: result.body.subject as unknown as Subject, summary };
}

/** The first date the subject states, at its own precision, in the reader's language. */
function dateOf(subject: Subject, locale: string): string | undefined {
  const statements = subject.statements as unknown as Record<string, Stmt[]>;
  for (const property of DATE_PROPERTIES) {
    for (const statement of Object.hasOwn(statements, property) ? bestRank(statements[property] ?? []) : []) {
      const content = statement.value.type === 'value' ? statement.value.content : undefined;
      if (!isRecord(content) || typeof content.time !== 'string') continue;
      const length = PRECISION_ISO[content.precision as keyof typeof PRECISION_ISO];
      // Kernel dates use 00 for the month or day omitted at year or month precision.
      const iso = length === undefined ? undefined : content.time.replace(/^\+/, '').slice(0, length);
      const text = dateText(iso, locale);
      if (text) return text;
    }
  }
}

/** The frame of a view page, from the overview page read the view already makes. Nothing when that read failed. */
export function subjectFrame(overview: SubjectPageData, locale: string): SubjectFrameData | undefined {
  const read = subjectRead(overview);
  if (!read) return;
  const { subject, summary } = read;
  const label = pageText(subject.labels, locale, originalLanguage(subject));
  const first = originalTitle(subject);
  const date = dateOf(subject, locale);
  return {
    id: subject.id,
    type: subject.type,
    title: label,
    ...(first && label.text && first.text !== label.text ? { original: first } : {}),
    ...(date ? { date } : {}),
    summary,
  };
}

export type ViewPagesLoad =
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string; target?: 'account' }
  | { kind: 'page'; page: SubjectPageData; overview: SubjectPageData };

/** One `pages.read` of the view and one of the overview, whose previews give the tab bar its counts and the frame its subject. */
export async function loadViewPages(
  client: KernelClient,
  id: string,
  view: View,
  locale = 'en',
): Promise<ViewPagesLoad> {
  const result = await loadSubjectPage(client, id, view, locale);
  if (result.kind !== 'page') return result;
  const overview = await loadSubjectPage(client, id, undefined, locale);
  if (overview.kind !== 'page') return overview;
  return { kind: 'page', page: result.page, overview: overview.page };
}

/** The tabs with the current view among them: the reader is on it, so the bar always offers it, in the documented order. */
function withCurrent(tabs: readonly ViewTab[], view: View): readonly ViewTab[] {
  if (tabs.some((tab) => tab.view === view)) return tabs;
  const order = (tab: ViewTab) => VIEWS.indexOf(tab.view);
  return [...tabs, { view }].sort((a, b) => order(a) - order(b));
}

/**
 * The compact header every subject view starts with, and the view tabs under it: which subject the reader is on, and
 * the way to every other view. The summary, reactions and library controls stay on the overview.
 */
export function SubjectFrame({
  frame,
  locale,
  link: Link = PlainLink,
  reader = defaultReader,
  coverLabels,
  unlabelled,
  typeLabel,
  ratio,
  tabs,
  tabLabels,
  view,
  base: tabBase,
}: {
  frame: SubjectFrameData;
  locale: string;
  link?: PageLink;
  reader?: Reader;
  coverLabels?: Partial<CoverLabels>;
  unlabelled: string;
  typeLabel?: string;
  ratio?: CoverRatio;
  tabs: readonly ViewTab[];
  tabLabels: ViewTabLabels;
  view: View;
  /** The page-view address when this subject is embedded in a routed Zone. */
  base?: string;
}) {
  const title = frame.title.text || unlabelled;
  const base = subjectHref({ id: frame.id, label: title }, locale).href;
  const facts = [typeLabel, frame.date].filter((fact): fact is string => !!fact);
  return (
    <div data-slot="subject-frame" className="flex min-w-0 flex-col gap-4">
      <header data-slot="subject-header" className="flex min-w-0 items-center gap-3">
        <Cover
          subject={coverSubject(frame.id, title, frame.summary ?? undefined, frame.type)}
          cover={coverOf(frame.summary ?? undefined)}
          size="xs"
          src={coverSrc}
          suitability={reader.suitability}
          decorative
          {...(coverLabels ? { labels: coverLabels } : {})}
          {...(ratio ? { ratio } : {})}
        />
        <div className="min-w-0 space-y-0.5">
          <p className="flex flex-wrap items-baseline gap-x-3 break-words">
            <span
              className={`${linkClass} ${frame.title.text ? linkColor : 'text-muted-foreground'} font-serif text-lg font-semibold`}
            >
              <Link href={base} {...(frame.title.lang ? { lang: frame.title.lang } : {})}>
                {title}
              </Link>
            </span>
            {frame.original && (
              <span lang={frame.original.lang} className="font-serif text-sm text-muted-foreground">
                {frame.original.text}
              </span>
            )}
          </p>
          {facts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <MetaLine items={facts} />
            </p>
          )}
        </div>
      </header>
      <ViewTabs
        tabs={withCurrent(tabs, view)}
        active={view}
        locale={locale}
        base={tabBase ?? base}
        labels={tabLabels}
      />
    </div>
  );
}

/** The view's own heading, which follows the frame. */
export function ViewHeading({ label, count }: { label: string; count?: ReactNode }) {
  return (
    <div data-slot="view-heading" className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{label}</h1>
      {count}
    </div>
  );
}

/** A view served by the view route: the frame, the view's heading, then the view's own document. */
type SubjectViewPageProps = Omit<ComponentProps<typeof SubjectPage>, 'heading' | 'tabs' | 'tabLabels' | 'actions'> & {
  frame: ReactNode;
  label: string;
  actions?: ReactNode;
};

export function SubjectViewPage({ frame, label, actions, ...page }: SubjectViewPageProps) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-8">
      {frame}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <ViewHeading label={label} />
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <SubjectPage {...page} />
    </div>
  );
}
