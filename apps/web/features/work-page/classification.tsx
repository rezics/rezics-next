import { cn } from '@rezics/ui/utils';
import { GlobeIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { discoverHref } from '../discover/state.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf } from './route.ts';
import { ScopeOffer, type ScopeView, scopeName } from './scope-bar.tsx';
import type { Classification, ClassificationPage, Loaded } from './types.ts';

export const CLASSIFICATION_REGION = 'work-classification';

type Translation = ReturnType<typeof materializeData<WorkPageMessages>>;

const levels = { central: 3, substantial: 2, incidental: 1 } as const;

/** A chip's recorded relevance, or null while unrecorded, stale or withdrawn. */
const levelOf = (item: Classification) => item.relevanceStatus === 'recorded' ? item.relevance?.level ?? null : null;

/** Genres as links to their Discover shelves, most relevant first, as Goodreads lists a book's genres. */
function Chips({ items, label, view, t }: { items: readonly Classification[]; label?: string; view: ScopeView; t: Translation }) {
  // Most relevant first within the page, as AniList orders tags; Main's order breaks ties.
  const rank = (item: Classification) => { const level = levelOf(item); return level ? levels[level] : 0; };
  const ordered = [...items].sort((a, b) => rank(b) - rank(a));
  const scope = view.scope.kind === 'realm' ? view.scope : { kind: 'global' as const };
  return <ul aria-label={label} className="flex flex-wrap gap-x-4 gap-y-2">
    {ordered.map(item => {
      const level = levelOf(item);
      const term = idOf(item.sense);
      const name = <span lang={item.name.language} dir={item.name.direction}>{item.name.value}</span>;
      return <li key={item.sense} className="flex items-center gap-1.5">
        {term ? <Link href={discoverHref({ scope, context: null, type: null, term })}
          className="rounded-sm font-medium text-[15px] underline decoration-primary/40 decoration-2 underline-offset-[6px]
            outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring">{name}</Link>
          : <span className="font-medium text-[15px]">{name}</span>}
        {level ? <span title={t.relevance({ level: t[level] })} className="flex gap-0.5">
          <span className="sr-only">{t.relevance({ level: t[level] })}</span>
          {[1, 2, 3].map(dot => <span key={dot} aria-hidden="true" className={cn('size-1.5 rounded-full',
            dot <= levels[level] ? 'bg-primary' : 'bg-border')} />)}
        </span> : null}
      </li>;
    })}
  </ul>;
}

/**
 * The genres accepted in a scope, each opening its Discover shelf. In a
 * community, its own choices are listed apart from those it inherits from
 * everyone. Mine has none: people rate, while everyone and communities
 * choose genres.
 */
export function ClassificationRegion({ classifications, view, locale, messages }: {
  /** Null in Mine, which Main does not define for classification. */
  classifications: Loaded<ClassificationPage> | null; view: ScopeView; locale: UiLocale; messages: WorkPageMessages;
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
  if (!classifications) {
    return <Region id={CLASSIFICATION_REGION} title={t.classification}>
      {empty(t.classificationMine, t.classificationMineBody)}</Region>;
  }
  if (!classifications.ok) {
    return <Region id={CLASSIFICATION_REGION} title={t.classification}>
      <RegionFailure title={t.classificationUnavailable} failure={classifications.failure} messages={messages} />
    </Region>;
  }
  const { items, nextCursor } = classifications.data;
  if (!items.length) {
    return <Region id={CLASSIFICATION_REGION} title={t.classification}>
      {empty(view.scope.kind === 'realm' ? t.noClassificationRealm({ realm: name }) : t.noClassificationGlobal)}
    </Region>;
  }
  const local = items.filter(item => item.source === 'local');
  const inherited = items.filter(item => item.source === 'global');
  return <Region id={CLASSIFICATION_REGION} title={t.classification}>
    {view.scope.kind === 'realm' ? <div className="grid gap-4">
      {local.length ? <div className="grid gap-2">
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <UsersRoundIcon aria-hidden="true" className="size-3.5" />{t.decidedIn({ realm: name })}</p>
        <Chips items={local} label={t.decidedIn({ realm: name })} view={view} t={t} />
      </div> : null}
      {inherited.length ? <div className="grid gap-2">
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <GlobeIcon aria-hidden="true" className="size-3.5" />{t.fromGlobal}</p>
        <Chips items={inherited} label={t.fromGlobal} view={view} t={t} />
      </div> : null}
    </div> : <Chips items={items} view={view} t={t} />}
    {nextCursor ? <p className="text-muted-foreground text-xs">{t.moreClassifications}</p> : null}
  </Region>;
}
