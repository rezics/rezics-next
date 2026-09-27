import { type ReactNode, Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { AdoptionRegion } from './adoption.tsx';
import { ClassificationRegion } from './classification.tsx';
import { WorkCredits, WorkCreditsSkeleton } from './credits.tsx';
import { HistoryRegion } from './history.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RatingSummaryRegion } from './ratings.tsx';
import { readAdoptions, readClassifications, readCredits, readHistory, readRatings, readRealm,
  readVersions } from './read.ts';
import { RegionSkeleton } from './region.tsx';
import { WorkRecord } from './record.tsx';
import { idOf, type VersionQuery, type WorkScope } from './route.ts';
import { ScopeBar, ScopeBarSkeleton, type ScopeRealm, type ScopeView } from './scope-bar.tsx';
import type { WorkHeader as Header } from './types.ts';
import { VersionsRegion } from './versions.tsx';
import { OverviewLayout, WorkFrame } from './work-frame.tsx';

// Server compositions for the `/w/[ref]` routes: each region reads Main on its
// own under Suspense, so the page streams as answers arrive and one failure
// stays in its region.

interface Common { locale: UiLocale; messages: WorkPageMessages }

/** Realms the scope bar and empty states can offer: those that adopted the Work, plus the one in the URL. */
async function scopeRealms(id: string, scope: WorkScope | null, locale: UiLocale): Promise<ScopeRealm[]> {
  const [adoptions, current] = await Promise.all([readAdoptions(id, locale),
    scope?.kind === 'realm' ? readRealm(scope.realm, locale) : null]);
  const realms: ScopeRealm[] = adoptions.ok ? adoptions.data.items.flatMap(item => {
    const realm = idOf(item.realm);
    return realm ? [{ id: realm, name: item.name }] : [];
  }) : [];
  if (scope?.kind === 'realm' && !realms.some(realm => realm.id === scope.realm)) {
    realms.unshift({ id: scope.realm, name: current?.ok ? current.data.name : null });
  }
  return realms;
}

async function Credits({ id, locale, messages }: Common & { id: string }) {
  return <WorkCredits credits={await readCredits(id)} locale={locale} messages={messages} />;
}

/** Header and tabs around every Work view; credits stream in on their own. */
export function WorkFrameView({ workRef, id, work, locale, messages, children }: Common & {
  workRef: string; id: string; work: Header; children: ReactNode;
}) {
  return <WorkFrame workRef={workRef} work={work} locale={locale} messages={messages}
    credits={<Suspense fallback={<WorkCreditsSkeleton label={messages.loadingRegion} />}>
      <Credits id={id} locale={locale} messages={messages} /></Suspense>}>
    {children}</WorkFrame>;
}

async function ScopeBarSlot({ workRef, id, scope, locale, messages }: Common & {
  workRef: string; id: string; scope: WorkScope | null;
}) {
  return <ScopeBar workRef={workRef} scope={scope} realms={await scopeRealms(id, scope, locale)}
    locale={locale} messages={messages} />;
}

type ScopedProps = Common & { workRef: string; id: string; scope: WorkScope };

async function view({ workRef, id, scope, locale }: ScopedProps): Promise<ScopeView> {
  return { workRef, scope, realms: await scopeRealms(id, scope, locale) };
}

async function Ratings(props: ScopedProps & { context: string | undefined }) {
  const [scopeView, ratings] = await Promise.all([view(props), readRatings(props.id, props.scope, props.context)]);
  return <RatingSummaryRegion ratings={ratings} view={scopeView} locale={props.locale} messages={props.messages} />;
}

async function Classification(props: ScopedProps) {
  const [scopeView, classifications] = await Promise.all([view(props), props.scope.kind === 'mine' ? null
    : readClassifications(props.id, props.locale, props.scope)]);
  return <ClassificationRegion classifications={classifications} view={scopeView} locale={props.locale}
    messages={props.messages} />;
}

async function Adoption(props: ScopedProps) {
  const [scopeView, adoptions] = await Promise.all([view(props), readAdoptions(props.id, props.locale)]);
  return <AdoptionRegion adoptions={adoptions} view={scopeView} locale={props.locale} messages={props.messages} />;
}

/** Overview: each region reads in parallel under its own Suspense boundary. */
export function WorkOverview({ workRef, id, work, scope, context, locale, messages }: Common & {
  workRef: string; id: string; work: Header; scope: WorkScope | null; context: string | undefined;
}) {
  const t = messages;
  const loading = t.loadingRegion;
  return <OverviewLayout messages={messages}
    scopeBar={<Suspense fallback={<ScopeBarSkeleton label={loading} />}>
      <ScopeBarSlot workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />
    </Suspense>}
    ratings={scope ? <Suspense fallback={<RegionSkeleton id="work-ratings-loading" title={t.ratings} label={loading}
      lines={5} />}>
      <Ratings workRef={workRef} id={id} scope={scope} context={context} locale={locale} messages={messages} />
    </Suspense> : null}
    classification={scope ? <Suspense fallback={<RegionSkeleton id="work-classification-loading"
      title={t.classification} label={loading} />}>
      <Classification workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />
    </Suspense> : null}
    adoption={scope ? <Suspense fallback={<RegionSkeleton id="work-adoption-loading" title={t.adoption}
      label={loading} lines={2} />}>
      <Adoption workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />
    </Suspense> : null}
    record={<WorkRecord work={work} locale={locale} messages={messages} />} />;
}

export async function WorkVersions({ workRef, id, query, locale, messages }: Common & {
  workRef: string; id: string; query: VersionQuery | null;
}) {
  const versions = query ? await readVersions(id, locale, query) : null;
  return <VersionsRegion versions={versions} workRef={workRef} query={query ?? {}} locale={locale} messages={messages} />;
}

export async function WorkHistory({ workRef, id, cursor, locale, messages }: Common & {
  workRef: string; id: string; cursor: string | undefined;
}) {
  return <HistoryRegion history={await readHistory(id, cursor)} workRef={workRef} cursor={cursor} locale={locale}
    messages={messages} />;
}
