import { cn } from '@rezics/ui/utils';
import type { LucideIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { type ConceptScope, conceptPath } from '../concept/state.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from './messages.ts';
import type { Classification } from './types.ts';

type Translation = ReturnType<typeof materializeData<WorkPageMessages>>;

const levels = { central: 3, substantial: 2, incidental: 1 } as const;

/** A chip's recorded relevance, or null while unrecorded, stale or withdrawn. */
const levelOf = (item: Classification) => item.relevanceStatus === 'recorded' ? item.relevance?.level ?? null : null;

const chip = cn('inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-border/70 bg-card px-3.5',
  'text-sm outline-none transition-colors hover:border-primary/60 hover:text-primary focus-visible:ring-2',
  'focus-visible:ring-ring');

/**
 * Accepted Concepts as chips, most relevant first, as AniList orders tags;
 * Main's order breaks ties. Each opens its Concept's page in the scope it was
 * accepted in, as a tag opened the list of what carried it.
 */
export function ConceptChips({ items, scope, label, t }: { items: readonly Classification[]; scope: ConceptScope;
  label?: string; t: Translation }) {
  const rank = (item: Classification) => { const level = levelOf(item); return level ? levels[level] : 0; };
  const ordered = [...items].sort((a, b) => rank(b) - rank(a));
  return <ul aria-label={label} className="flex min-w-0 flex-wrap gap-2">
    {ordered.map(item => {
      const level = levelOf(item);
      return <li key={item.sense} className="flex min-w-0">
        <Link href={conceptPath(item.concept, scope)} className={chip}>
          <span lang={item.name.language} dir={item.name.direction} className="truncate">{item.name.value}</span>
          {level ? <span aria-hidden="true" title={t.relevance({ level: t[level] })} className="flex shrink-0 gap-0.5">
            {[1, 2, 3].map(dot => <span key={dot} className={cn('size-1.5 rounded-full',
              dot <= levels[level] ? 'bg-primary' : 'bg-border')} />)}
          </span> : null}
        </Link>
        {/* Beside the link, so the link is named by its Concept alone. */}
        {level ? <span className="sr-only">{t.relevance({ level: t[level] })}</span> : null}
      </li>;
    })}
  </ul>;
}

/** Values one decider accepted, under a line saying whose they are. */
export interface ChipGroup { key: string; items: readonly Classification[]; scope: ConceptScope;
  caption?: { icon: LucideIcon; label: string } }

/** One Facet's accepted values: its label beside them, as AO3 lists a work's tags by type. */
export interface FacetValues { key: string; label: string; groups: readonly ChipGroup[] }

/**
 * A Work's accepted values grouped by the Facet each is read through
 * ("Tags: Minecraft · Fabric"), one row per Facet. The Facet's label comes from
 * Main; within a row, each decider's values are listed apart.
 */
export function FacetRows({ rows, locale, messages }: { rows: readonly FacetValues[]; locale: UiLocale;
  messages: WorkPageMessages }) {
  const t = materializeData(messages, { locale });
  return <dl className="grid gap-4">
    {rows.map(row => {
      const captioned = row.groups.some(group => group.caption);
      return <div key={row.key} className="grid min-w-0 gap-x-5 gap-y-2 sm:grid-cols-[minmax(4rem,auto)_minmax(0,1fr)]
        sm:items-start">
        <dt className={cn('text-muted-foreground text-sm', !captioned && 'sm:pt-1.5')}>{row.label}</dt>
        <dd className="grid min-w-0 gap-4">
          {row.groups.map(group => group.caption ? <div key={group.key} className="grid min-w-0 gap-2">
            <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <group.caption.icon aria-hidden="true" className="size-3.5 shrink-0" />{group.caption.label}</p>
            <ConceptChips items={group.items} scope={group.scope} label={group.caption.label} t={t} />
          </div> : <ConceptChips key={group.key} items={group.items} scope={group.scope} label={row.label} t={t} />)}
        </dd>
      </div>;
    })}
  </dl>;
}
