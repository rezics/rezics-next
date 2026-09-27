import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { CompassIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import type { WorkMessages } from './messages.ts';

export interface WorkRevisionDetail {
  work: string;
  title: string;
  language: string;
  mainVersion: string;
  operation: string;
  sourcePosition: { sequence: string };
}

function Detail({ term, children, mono = false }: { term: string; children: string; mono?: boolean }) {
  return <div className="grid gap-0.5">
    <dt className="text-muted-foreground text-xs">{term}</dt>
    <dd className={mono ? 'break-all font-mono text-[13px]' : 'text-sm'}>{children}</dd>
  </div>;
}

/** One exact Work revision. Later Work views add a tab each. */
export function WorkDetail({ work, revision, locale, messages }: { work: WorkRevisionDetail; revision: string;
  locale: UiLocale; messages: WorkMessages }) {
  const t = materializeData(messages, { locale });
  return <PageContainer className="grid gap-8">
    <header className="aura-surface grid gap-5 rounded-3xl border border-border/60 p-6 shadow-(--aura-shadow-card)
      sm:p-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="soft">{t.exactRevision}</Badge>
          <Badge variant="outline" className="bg-card">{work.language.toUpperCase()}</Badge>
        </div>
        <h1 lang={work.language} className="text-balance break-words font-semibold font-work-title text-3xl/tight
          sm:text-4xl/tight">{work.title}</h1>
      </div>
      <div className="grid gap-1 rounded-2xl border border-border/60 bg-card/80 p-4 text-sm">
        <p className="text-muted-foreground text-xs">{t.perspective}</p>
        <p className="flex items-center gap-2 font-medium">
          <CompassIcon aria-hidden="true" className="size-4 text-primary" />{t.globalPerspective}</p>
        <p className="text-muted-foreground text-xs">{t.perspectiveHelp}</p>
      </div>
    </header>
    <Tabs defaultValue="main-version" className="gap-6">
      <TabsList variant="underline" aria-label={t.views}>
        <TabsTrigger value="main-version">{t.mainVersion}</TabsTrigger>
      </TabsList>
      <TabsContent value="main-version" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <Card>
          <CardHeader><CardTitle asChild><h2>{t.selectedVersion}</h2></CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <p lang={work.language} className="break-words font-work-title text-xl">{work.title}</p>
            <p className="break-all text-muted-foreground text-sm">{t.metadata({ revision })}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle asChild><h2>{t.revisionDetails}</h2></CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-3">
              <Detail term={t.work} mono>{work.work}</Detail>
              <Detail term={t.mainVersion} mono>{work.mainVersion}</Detail>
              <Detail term={t.operation}>{work.operation}</Detail>
              <Detail term={t.language}>{work.language}</Detail>
              <Detail term={t.sequence} mono>{work.sourcePosition.sequence}</Detail>
            </dl>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  </PageContainer>;
}

/** Main refused or failed the revision read; the revision may still exist. */
export function WorkUnavailable({ messages }: { messages: WorkMessages }) {
  return <PageContainer>
    <Alert variant="destructive" role="alert" className="mx-auto max-w-2xl">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{messages.unavailableTitle}</AlertTitle>
      <AlertDescription>
        <p>{messages.unavailable}</p>
        <p><a href="/search" className={buttonVariants({ variant: 'outline', size: 'sm' })}>{messages.searchWorks}</a></p>
      </AlertDescription>
    </Alert>
  </PageContainer>;
}
