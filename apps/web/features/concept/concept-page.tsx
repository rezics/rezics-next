import { Button, buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { cn } from '@rezics/ui/utils';
import { SearchIcon, TriangleAlertIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { idOf, iriOf } from '../discover/scope.ts';
import type { FollowActions } from '../profile/follow-button.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { type BarValue, type ConceptSearch, ConditionBar } from './condition-bar.tsx';
import { ConceptFollow } from './concept-follow.tsx';
import { type ConceptWorksLoader, ConceptWorks } from './concept-works.tsx';
import type { ConceptMessages } from './messages.ts';
import { type ConceptScope, type ConceptState, conceptHref, conceptPath } from './state.ts';
import type { ConceptFollowState, ConceptLink, ConceptRead, ConceptWorksPage, Loaded } from './types.ts';

type Text = ReturnType<typeof materializeData<ConceptMessages>>;
type Name = ConceptRead['name'];

/** Who is looking: signed in or not, and the Agent they follow as. */
export interface ConceptReader {
  signedIn: boolean;
  actingSubject?: string | null;
  /** Cover bytes go through the BFF, which then needs the reader's Agent. */
  avatarQuery?: string;
}

export interface ConceptPageProps {
  concept: ConceptRead;
  /** The label of the Facet the Concept is a value of ("Tags"); null when Main's Facets could not be read. */
  facet: string | null;
  state: ConceptState;
  /** Names of the Realms the page mentions: the scope's and a local Concept's. */
  realms: Readonly<Record<string, Name | null>>;
  works: Loaded<ConceptWorksPage>;
  follow: Loaded<ConceptFollowState>;
  reader: ConceptReader;
  /** Values per operator the Concept Facet admits. */
  maxValues?: number;
  /** Stories supply these; the page reads through the BFF. */
  followActions?: FollowActions;
  loadWorks?: ConceptWorksLoader;
  searchConcepts?: ConceptSearch;
  locale: UiLocale; messages: ConceptMessages;
}

const chip = cn('inline-flex h-8 max-w-full items-center rounded-full border border-border/70 bg-card px-3.5 text-sm',
  'outline-none transition-colors hover:border-primary/60 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring');

const realmName = (realm: string, realms: ConceptPageProps['realms'], t: Text) =>
  realms[realm]?.value ?? t.realmFallback;

/** Broader and narrower Concepts, each opening its own page in the same scope. */
function Related({ concept, scope, t }: { concept: ConceptRead; scope: ConceptScope; t: Text }) {
  const row = (label: string, items: readonly ConceptLink[], more = false) => items.length ? <div
    className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-baseline">
    <dt className="text-muted-foreground text-sm">{label}</dt>
    <dd><ul className="flex flex-wrap items-center gap-2">
      {items.map(item => <li key={item.id} className="flex min-w-0">
        <Link href={conceptPath(item.id, scope)} className={chip}>
          <span lang={item.name.language} dir={item.name.direction} className="truncate">{item.name.value}</span>
        </Link></li>)}
      {more ? <li className="text-muted-foreground text-sm">{t.moreNarrower}</li> : null}
    </ul></dd>
  </div> : null;
  if (!concept.broader.length && !concept.narrower.length) return null;
  return <dl className="grid gap-3">
    {row(t.broader, concept.broader)}
    {row(t.narrower, concept.narrower, concept.moreNarrower)}
  </dl>;
}

/** Whose accepted values are listed: everyone's, or a community's when the page was opened from one. */
function ScopeSwitch({ state, concept, realms, t }: { state: ConceptState; concept: ConceptRead;
  realms: ConceptPageProps['realms']; t: Text }) {
  const realm = state.scope.kind === 'realm' ? state.scope.realm : idOf(concept.realm ?? '');
  if (!realm) return null;
  const option = (scope: ConceptScope, label: string) => {
    const current = scope.kind === state.scope.kind;
    return <Link href={conceptHref({ ...state, scope })} aria-current={current || undefined} scroll={false}
      className={cn('inline-flex h-8 items-center gap-1.5 rounded-xl px-3 font-medium text-sm outline-none',
        'transition-colors focus-visible:ring-2 focus-visible:ring-ring', current ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground')}>{label}</Link>;
  };
  return <nav aria-label={t.scopeLabel} className="flex flex-wrap items-center gap-2">
    <span className="text-muted-foreground text-sm">{t.scopeLabel}</span>
    <div className="flex rounded-2xl border border-border/60 bg-card p-0.5">
      {option({ kind: 'global' }, t.scopeGlobal)}
      {option({ kind: 'realm', realm }, t.scopeRealm({ realm: realmName(realm, realms, t) }))}
    </div>
  </nav>;
}

/** Phrase search narrowed to this Concept through the same Query Condition. */
function SearchWithin({ concept, state, locale, t }: { concept: ConceptRead; state: ConceptState; locale: UiLocale;
  t: Text }) {
  const term = idOf(concept.id);
  if (!term) return null;
  const label = t.searchWithin({ name: concept.name.value });
  return <form role="search" aria-label={label} action={localizedPath('/search', locale)} method="get"
    className="flex w-full min-w-0 items-center gap-2 sm:ms-auto sm:w-auto">
    <input type="hidden" name="term" value={term} />
    {state.include.length ? <input type="hidden" name="ci" value={state.include.join(',')} /> : null}
    {state.exclude.length ? <input type="hidden" name="ce" value={state.exclude.join(',')} /> : null}
    {state.match === 'any' ? <input type="hidden" name="cm" value="any" /> : null}
    {state.scope.kind === 'realm' ? <>
      <input type="hidden" name="scope" value="realm" /><input type="hidden" name="realm" value={state.scope.realm} />
    </> : null}
    <Input name="q" type="search" required minLength={2} maxLength={80} aria-label={label}
      placeholder={label} className="min-w-0 flex-1 sm:w-64" />
    <Button type="submit" variant="outline" size="icon-md" aria-label={t.searchSubmit}>
      <SearchIcon aria-hidden="true" /></Button>
  </form>;
}

/** Concepts the first page's Works also carry, most shared first: the quickest next values to try. */
export function alsoCarried(works: Loaded<ConceptWorksPage>): BarValue[] {
  if (!works.ok || works.data.stale) return [];
  const counts = new Map<string, { value: BarValue; count: number }>();
  for (const item of works.data.items) {
    for (const tag of item.classifications) {
      const entry = counts.get(tag.concept) ?? { value: { id: tag.concept, name: tag.name }, count: 0 };
      entry.count++;
      counts.set(tag.concept, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map(entry => entry.value);
}

/**
 * A Concept's own page, as a tag page was: what it is and where it sits,
 * Follow, and the Works that reach it through its Facet, narrowed by a
 * Condition bar and searchable by phrase. Works come from the scope the
 * reader chose: everyone's accepted values or one community's.
 */
export function ConceptPage({ concept, facet, state, realms, works, follow, reader, maxValues, followActions,
  loadWorks, searchConcepts, locale, messages }: ConceptPageProps) {
  const t = materializeData(messages, { locale });
  const name = concept.name.value;
  const followed = follow.ok ? follow.data : null;
  const values: BarValue[] = works.ok ? works.data.values : [];
  const page: BarValue = { id: concept.id, name: concept.name };
  return <PageContainer className="grid gap-8 sm:gap-10">
    <header className="grid gap-5">
      <div className="grid gap-2">
        {facet || concept.realm ? <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium
          text-muted-foreground text-sm">
          {facet ? <span>{facet}</span> : null}
          {concept.realm ? <span className="inline-flex items-center gap-1.5">
            <UsersRoundIcon aria-hidden="true" className="size-3.5" />
            {t.fromRealm({ realm: realmName(idOf(concept.realm) ?? '', realms, t) })}</span> : null}
        </p> : null}
        <h1 lang={concept.name.language} dir={concept.name.direction} className="text-balance font-semibold
          font-work-title text-3xl/tight tracking-tight [overflow-wrap:anywhere] sm:text-5xl/tight">{name}</h1>
        {concept.description ? <p lang={concept.description.language} dir={concept.description.direction}
          className="max-w-3xl text-pretty text-lg text-muted-foreground">{concept.description.value}</p> : null}
      </div>
      <ConceptFollow concept={concept.id} name={name} following={followed?.following ?? null}
        revision={followed?.revision ?? null} followers={followed?.followers ?? null} signedIn={reader.signedIn}
        actingSubject={reader.actingSubject} signInHref={signInPath(localizedPath(conceptHref(state), locale))}
        actions={followActions} locale={locale} messages={messages} />
      <Related concept={concept} scope={state.scope} t={t} />
    </header>
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopeSwitch state={state} concept={concept} realms={realms} t={t} />
        <SearchWithin concept={concept} state={state} locale={locale} t={t} />
      </div>
      <ConditionBar state={state} page={page} values={values} suggestions={alsoCarried(works)} maxValues={maxValues}
        search={searchConcepts} locale={locale} actingSubject={reader.actingSubject ?? undefined}
        messages={messages} />
    </div>
    <ConceptWorks state={state} name={name} initial={works} avatarQuery={reader.avatarQuery} load={loadWorks}
      locale={locale} messages={messages} />
  </PageContainer>;
}

/** The Concept could not be read for a reason other than its absence. */
export function ConceptUnavailable({ state, locale, messages }: { state: ConceptState | null; locale: UiLocale;
  messages: ConceptMessages }) {
  const t = materializeData(messages, { locale });
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1} title={t.unavailableTitle}
      description={t.unavailableBody}>
      {state ? <Link href={conceptHref(state)} className={buttonVariants({ variant: 'outline' })}>{t.retry}</Link>
        : null}
    </EmptyState>
  </PageContainer>;
}

/** A link whose Conditions cannot be read: say so and offer the Concept's own Works. */
export function ConceptMalformed({ concept, locale, messages }: { concept: string; locale: UiLocale;
  messages: ConceptMessages }) {
  const t = materializeData(messages, { locale });
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} role="status" headingLevel={1} title={t.malformed}
      description={t.malformedHelp}>
      <Link href={conceptPath(iriOf(concept))} className={buttonVariants({ variant: 'outline' })}>{t.works}</Link>
    </EmptyState>
  </PageContainer>;
}
