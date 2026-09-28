import { GlobeIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type ChipGroup, FacetRows } from './concept-chips.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RegionFailure } from './region.tsx';
import { realmLabel, ScopeOffer, type ScopeRealm, type ScopeView, scopeName } from './scope-bar.tsx';
import type { Classification, ClassificationPage, Loaded } from './types.ts';

export const CLASSIFICATION_REGION = 'work-classification';

/** The Concepts a community that features the Work accepted, for everyone's view when everyone accepted none. */
export interface CommunityGenres { realm: ScopeRealm; items: readonly Classification[] }

/** The Facet a Work's accepted Concepts are read through, named by Main ("Tags"). */
export interface ValueFacet { id: string; label: string }

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-labelledby={CLASSIFICATION_REGION} className="grid min-w-0 gap-3">
    <h2 id={CLASSIFICATION_REGION} className="sr-only">{title}</h2>
    {children}
  </section>;
}

/**
 * The Concepts accepted in a scope, as chips grouped by their Facet, each
 * opening its Concept's page. In a community, its own values are listed apart
 * from those it inherits from everyone. Everyone's view of a Work nobody has
 * classified shows what the communities featuring it accepted, each named, and
 * nothing when they accepted none either. Mine has none: people rate, while
 * everyone and communities classify.
 */
export function ClassificationRegion({ classifications, view, communities = [], facet, locale, messages }: {
  /** Null in Mine, which Main does not define for classification. */
  classifications: Loaded<ClassificationPage> | null; view: ScopeView;
  /** In everyone's view, the Concepts communities featuring the Work accepted; read only when everyone accepted none. */
  communities?: readonly CommunityGenres[];
  /** Null when Main's Facets could not be read; the values are then listed under the region's own name. */
  facet: ValueFacet | null;
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
  const rows = (groups: ChipGroup[]) => <FacetRows rows={[{ key: facet?.id ?? 'classification',
    label: facet?.label ?? t.classification, groups }]} locale={locale} messages={messages} />;
  if (!classifications) return <Section title={t.classification}>{empty(t.classificationMine, t.classificationMineBody)}</Section>;
  if (!classifications.ok) {
    return <Section title={t.classification}>
      <RegionFailure title={t.classificationUnavailable} failure={classifications.failure} messages={messages} />
    </Section>;
  }
  const { items, nextCursor } = classifications.data;
  if (!items.length && view.scope.kind === 'global') {
    const chosen = communities.filter(group => group.items.length);
    // Nobody classified it anywhere: leave the section out, as Goodreads does, rather than lead with an empty box.
    if (!chosen.length) return null;
    return <Section title={t.classification}>
      {rows(chosen.map(group => ({ key: group.realm.id, items: group.items,
        scope: { kind: 'realm', realm: group.realm.id },
        caption: { icon: UsersRoundIcon, label: t.decidedIn({ realm: realmLabel(group.realm, messages, locale) }) } })))}
    </Section>;
  }
  if (!items.length) {
    return <Section title={t.classification}>
      {empty(view.scope.kind === 'realm' ? t.noClassificationRealm({ realm: name }) : t.noClassificationGlobal)}
    </Section>;
  }
  const scope = view.scope.kind === 'realm' ? { kind: 'realm' as const, realm: view.scope.realm }
    : { kind: 'global' as const };
  const local = items.filter(item => item.source === 'local');
  const inherited = items.filter(item => item.source === 'global');
  return <Section title={t.classification}>
    {rows(scope.kind === 'realm' ? [
      ...local.length ? [{ key: 'local', items: local, scope,
        caption: { icon: UsersRoundIcon, label: t.decidedIn({ realm: name }) } }] : [],
      ...inherited.length ? [{ key: 'global', items: inherited, scope,
        caption: { icon: GlobeIcon, label: t.fromGlobal } }] : [],
    ] : [{ key: 'global', items, scope }])}
    {nextCursor ? <p className="text-muted-foreground text-xs">{t.moreClassifications}</p> : null}
  </Section>;
}
