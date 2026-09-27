import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import type { WorkPageMessages } from './messages.ts';
import { workHref } from './route.ts';
import type { WorkHeader as Header } from './types.ts';
import { WorkHeader } from './work-header.tsx';
import { WorkTabs } from './work-tabs.tsx';

/** Header and tabs around every Work view. */
export function WorkFrame({ workRef, work, credits, locale, messages, children }: {
  workRef: string; work: Header; credits: ReactNode; locale: UiLocale; messages: WorkPageMessages; children: ReactNode;
}) {
  return <PageContainer className="grid gap-6">
    <WorkHeader work={work} credits={credits} readHref={workHref(workRef, 'contents')} locale={locale}
      messages={messages} />
    <WorkTabs workRef={workRef} label={messages.sections} labels={{ overview: messages.overview,
      contents: messages.contents, versions: messages.versions, discussion: messages.discussion,
      history: messages.history }} />
    {children}
  </PageContainer>;
}

/**
 * The Overview's arrangement: the description, the scope bar, then ratings and classification
 * in the chosen scope beside Realm adoption and the record. An unknown scope
 * is reported in place of the scoped regions, never replaced by Global.
 */
export function OverviewLayout({ about, scopeBar, ratings, classification, adoption, record, messages }: {
  /** The Work's description; it does not change with scope, so it comes first. */
  about?: ReactNode; scopeBar: ReactNode;
  /** Null when the URL names no known scope. */
  ratings: ReactNode | null; classification: ReactNode; adoption: ReactNode; record: ReactNode;
  messages: WorkPageMessages;
}) {
  return <>
    {about}
    {scopeBar}
    {ratings === null ? <InvalidScope messages={messages} /> : <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="grid min-w-0 gap-6">{ratings}{classification}</div>
      <div className="grid min-w-0 gap-6">{adoption}{record}</div>
    </div>}
  </>;
}

/** The URL names no scope this page can show; it says so instead of showing Global. */
export function InvalidScope({ messages }: { messages: WorkPageMessages }) {
  return <Alert variant="warning" role="alert">
    <CircleAlertIcon aria-hidden="true" />
    <AlertTitle>{messages.invalidScopeTitle}</AlertTitle>
    <AlertDescription>{messages.invalidScopeBody}</AlertDescription>
  </Alert>;
}
