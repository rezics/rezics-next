import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { GlobeIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { ScopeOffer, type ScopeView, scopeName } from './scope-bar.tsx';
import type { Classification, ClassificationPage, Loaded } from './types.ts';

export const CLASSIFICATION_REGION = 'work-classification';

type Translation = ReturnType<typeof materializeData<WorkPageMessages>>;

const levels = { central: 3, substantial: 2, incidental: 1 } as const;

/** A chip's recorded relevance, or null while unrecorded, stale or withdrawn. */
const levelOf = (item: Classification) => item.relevanceStatus === 'recorded' ? item.relevance?.level ?? null : null;

function Chips({ items, label, t }: { items: readonly Classification[]; label?: string; t: Translation }) {
  // Most relevant first within the page, as AniList orders tags; Main's order breaks ties.
  const rank = (item: Classification) => { const level = levelOf(item); return level ? levels[level] : 0; };
  const ordered = [...items].sort((a, b) => rank(b) - rank(a));
  return <ul aria-label={label} className="flex flex-wrap gap-2">
    {ordered.map(item => {
      const level = levelOf(item);
      return <li key={item.sense}>
        <Badge variant="outline" size="lg" className="gap-2 bg-card font-normal">
          <span lang={item.name.language} dir={item.name.direction}>{item.name.value}</span>
          {level ? <span title={t.relevance({ level: t[level] })} className="flex gap-0.5">
            <span className="sr-only">{t.relevance({ level: t[level] })}</span>
            {[1, 2, 3].map(dot => <span key={dot} aria-hidden="true" className={cn('size-1.5 rounded-full',
              dot <= levels[level] ? 'bg-primary' : 'bg-border')} />)}
          </span> : null}
        </Badge>
      </li>;
    })}
  </ul>;
}

/**
 * The accepted classification in a scope, as chips. In a Realm, the Realm's
 * own decisions are listed apart from those it inherits from Global. Mine has
 * no classification: people rate, Global and Realms classify.
 */
export function ClassificationRegion({ classifications, view, locale, messages }: {
  /** Null in Mine, which Main does not define for classification. */
  classifications: Loaded<ClassificationPage> | null; view: ScopeView; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = scopeName(view, messages, locale);
  const badge = <Badge variant="outline" className="bg-card">{name}</Badge>;
  const offer = <ScopeOffer view={view} locale={locale} messages={messages} />;
  const empty = (title: string, body?: string) =>
    <div className="grid justify-items-start gap-3 rounded-xl border border-border/80 border-dashed px-4 py-5">
      <p className="font-medium">{title}</p>
      {body ? <p className="text-muted-foreground text-sm">{body}</p> : null}
      {offer}
    </div>;
  if (!classifications) {
    return <Region id={CLASSIFICATION_REGION} title={t.classification} aside={badge}>
      {empty(t.classificationMine, t.classificationMineBody)}</Region>;
  }
  if (!classifications.ok) {
    return <Region id={CLASSIFICATION_REGION} title={t.classification} aside={badge}>
      <RegionFailure title={t.classificationUnavailable} failure={classifications.failure} messages={messages} />
    </Region>;
  }
  const { items, nextCursor } = classifications.data;
  if (!items.length) {
    return <Region id={CLASSIFICATION_REGION} title={t.classification} aside={badge}>
      {empty(view.scope.kind === 'realm' ? t.noClassificationRealm({ realm: name }) : t.noClassificationGlobal)}
    </Region>;
  }
  const local = items.filter(item => item.source === 'local');
  const inherited = items.filter(item => item.source === 'global');
  return <Region id={CLASSIFICATION_REGION} title={t.classification} aside={badge}>
    {view.scope.kind === 'realm' ? <div className="grid gap-4">
      {local.length ? <div className="grid gap-2">
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <UsersRoundIcon aria-hidden="true" className="size-3.5" />{t.decidedIn({ realm: name })}</p>
        <Chips items={local} label={t.decidedIn({ realm: name })} t={t} />
      </div> : null}
      {inherited.length ? <div className="grid gap-2">
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <GlobeIcon aria-hidden="true" className="size-3.5" />{t.fromGlobal}</p>
        <Chips items={inherited} label={t.fromGlobal} t={t} />
      </div> : null}
    </div> : <Chips items={items} t={t} />}
    {nextCursor ? <p className="text-muted-foreground text-xs">{t.moreClassifications}</p> : null}
  </Region>;
}
