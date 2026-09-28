import { cn } from '@rezics/ui/utils';
import { GlobeIcon, type LucideIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { BrowseScope } from '../discover/scope.ts';
import { discoverHref } from '../discover/state.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RegionFailure } from './region.tsx';
import { idOf } from './route.ts';
import { realmLabel, ScopeOffer, type ScopeRealm, type ScopeView, scopeName } from './scope-bar.tsx';
import type { Classification, ClassificationPage, Loaded } from './types.ts';

export const CLASSIFICATION_REGION = 'work-classification';

type Translation = ReturnType<typeof materializeData<WorkPageMessages>>;

/** The genres a community that features the Work chose, for everyone's view when everyone chose none. */
export interface CommunityGenres { realm: ScopeRealm; items: readonly Classification[] }

const levels = { central: 3, substantial: 2, incidental: 1 } as const;

/** A chip's recorded relevance, or null while unrecorded, stale or withdrawn. */
const levelOf = (item: Classification) => item.relevanceStatus === 'recorded' ? item.relevance?.level ?? null : null;

const chip = 'inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-border/70 bg-card px-3.5 text-sm';

/**
 * Genres as chips that open their Discover shelf, most relevant first, as
 * Goodreads lists a book's genres. A community's genres open that
 * community's shelf; everyone's open everyone's.
 */
function Chips({ items, label, scope, t }: { items: readonly Classification[]; label?: string; scope: BrowseScope;
  t: Translation }) {
  // Most relevant first within the page, as AniList orders tags; Main's order breaks ties.
  const rank = (item: Classification) => { const level = levelOf(item); return level ? levels[level] : 0; };
  const ordered = [...items].sort((a, b) => rank(b) - rank(a));
  return <ul aria-label={label} className="flex min-w-0 flex-wrap gap-2">
    {ordered.map(item => {
      const level = levelOf(item);
      const term = idOf(item.sense);
      const content = <>
        <span lang={item.name.language} dir={item.name.direction} className="truncate">{item.name.value}</span>
        {level ? <span aria-hidden="true" title={t.relevance({ level: t[level] })} className="flex shrink-0 gap-0.5">
          {[1, 2, 3].map(dot => <span key={dot} className={cn('size-1.5 rounded-full',
            dot <= levels[level] ? 'bg-primary' : 'bg-border')} />)}
        </span> : null}
      </>;
      return <li key={item.sense} className="flex min-w-0">
        {term ? <Link href={discoverHref({ scope, context: null, type: null, term })} className={cn(chip,
          'outline-none transition-colors hover:border-primary/60 hover:text-primary focus-visible:ring-2',
          'focus-visible:ring-ring')}>{content}</Link> : <span className={chip}>{content}</span>}
        {level ? <span className="sr-only">{t.relevance({ level: t[level] })}</span> : null}
      </li>;
    })}
  </ul>;
}

/** One community's or everyone's genres under a line saying whose they are. */
function Group({ icon: Icon, label, items, scope, t }: { icon: LucideIcon; label: string;
  items: readonly Classification[]; scope: BrowseScope; t: Translation }) {
  return <div className="grid min-w-0 gap-2">
    <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />{label}</p>
    <Chips items={items} label={label} scope={scope} t={t} />
  </div>;
}

/** Goodreads' genres line: a quiet label beside the chips, so the genres read as part of what the Work is. */
function Genres({ title, grouped = false, children }: { title: string;
  /** Groups open with a line saying whose they are, which the label aligns with instead of the chips. */
  grouped?: boolean; children: ReactNode }) {
  return <section aria-labelledby={CLASSIFICATION_REGION} className="grid min-w-0 gap-x-5 gap-y-2
    sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
    <h2 id={CLASSIFICATION_REGION} className={cn('text-muted-foreground text-sm', !grouped && 'sm:pt-1.5')}>{title}</h2>
    <div className="grid min-w-0 gap-4">{children}</div>
  </section>;
}

/**
 * The genres accepted in a scope, each opening its Discover shelf. In a
 * community, its own choices are listed apart from those it inherits from
 * everyone. Everyone's view of a Work nobody has tagged shows what the
 * communities featuring it chose, each named, and nothing when they chose
 * none either. Mine has none: people rate, while everyone and communities
 * choose genres.
 */
export function ClassificationRegion({ classifications, view, communities = [], locale, messages }: {
  /** Null in Mine, which Main does not define for classification. */
  classifications: Loaded<ClassificationPage> | null; view: ScopeView;
  /** In everyone's view, the genres communities featuring the Work chose; read only when everyone chose none. */
  communities?: readonly CommunityGenres[];
  locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = scopeName(view, messages, locale);
  const offer = <ScopeOffer view={view} locale={locale} messages={messages} />;
  const empty = (title: string, body?: string) =>
    <div className="grid justify-items-start gap-3 rounded-2xl bg-muted/60 px-5 py-4">
      <p className="font-medium">{title}</p>
      {body ? <p className="text-muted-foreground text-sm">{body}</p> : null}
      {offer}
    </div>;
  if (!classifications) return <Genres title={t.classification}>{empty(t.classificationMine, t.classificationMineBody)}</Genres>;
  if (!classifications.ok) {
    return <Genres title={t.classification}>
      <RegionFailure title={t.classificationUnavailable} failure={classifications.failure} messages={messages} />
    </Genres>;
  }
  const { items, nextCursor } = classifications.data;
  if (!items.length && view.scope.kind === 'global') {
    const chosen = communities.filter(group => group.items.length);
    // Nobody has tagged it anywhere: leave the section out, as Goodreads does, rather than lead with an empty box.
    if (!chosen.length) return null;
    return <Genres title={t.classification} grouped>
      {chosen.map(group => <Group key={group.realm.id} icon={UsersRoundIcon}
        label={t.decidedIn({ realm: realmLabel(group.realm, messages, locale) })} items={group.items}
        scope={{ kind: 'realm', realm: group.realm.id }} t={t} />)}
    </Genres>;
  }
  if (!items.length) {
    return <Genres title={t.classification}>
      {empty(view.scope.kind === 'realm' ? t.noClassificationRealm({ realm: name }) : t.noClassificationGlobal)}
    </Genres>;
  }
  const local = items.filter(item => item.source === 'local');
  const inherited = items.filter(item => item.source === 'global');
  return <Genres title={t.classification} grouped={view.scope.kind === 'realm'}>
    {view.scope.kind === 'realm' ? <>
      {local.length ? <Group icon={UsersRoundIcon} label={t.decidedIn({ realm: name })} items={local} scope={view.scope}
        t={t} /> : null}
      {inherited.length ? <Group icon={GlobeIcon} label={t.fromGlobal} items={inherited} scope={view.scope} t={t} />
        : null}
    </> : <Chips items={items} scope={{ kind: 'global' }} t={t} />}
    {nextCursor ? <p className="text-muted-foreground text-xs">{t.moreClassifications}</p> : null}
  </Genres>;
}
