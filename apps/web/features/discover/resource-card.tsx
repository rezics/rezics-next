import { cn } from '@rezics/ui/utils';
import { GlobeIcon, HashIcon, ListIcon, type LucideIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { WorkTile } from '../catalogue/work-tile.tsx';
import { coverKindOf, type CatalogueWork } from '../catalogue/work.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import Link from '../shell/localized-link.tsx';
import { resourceHref, spaceHref } from '../address/path.ts';
import type { ResourceCard } from './api.ts';
import { browseMessages } from './browse-messages.ts';
import { workHref, type BrowseScope } from './scope.ts';

export function browseResourceHref(item: Pick<ResourceCard, 'kind' | 'id'>): string {
  switch (item.kind) {
    case 'work': return resourceHref('/w/', item.id);
    case 'realm': return spaceHref(item.id, 'community');
    case 'agent': return resourceHref('/a/', item.id);
    case 'concept': return resourceHref('/concepts/', item.id);
    case 'site': case 'collection': case 'space': return resourceHref('/e/', item.id);
  }
}

/** Resource-list-v1 currently serves identity only; richer Work fields belong in Main's card contract. */
export function resourceWork(item: ResourceCard, scope: BrowseScope = { kind: 'global' }): CatalogueWork {
  return { id: item.id, href: workHref(item.id, scope), title: item.name, cover: item.icon,
    kind: coverKindOf(item.types), authors: [], rating: null };
}

interface CardProps { item: ResourceCard; locale: UiLocale; avatarQuery?: string; headingLevel?: 2 | 3 | 4 }

/** Shared identity card for previews and complete lists; each type supplies its own recognizable mark. */
function IdentityCard({ item, avatarQuery, label, icon: Icon, person = false, headingLevel = 3 }: CardProps & {
  label: string; icon?: LucideIcon; person?: boolean;
}) {
  const Heading = `h${headingLevel}` as const;
  return <article className="min-w-0">
    <Link href={browseResourceHref(item)} className="flex min-w-0 items-start gap-3 rounded-2xl border
      border-border/70 bg-card p-4 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring">
      {Icon && item.icon.kind === 'fallback' ? <span aria-hidden="true" className={cn(
        'grid size-9 shrink-0 place-items-center bg-muted text-muted-foreground',
        person ? 'rounded-full' : 'rounded-xl')}><Icon className="size-5" /></span>
        : <CommunityIcon icon={item.icon} name={item.name.value} person={person} size="md"
          avatarQuery={avatarQuery} />}
      <div className="grid min-w-0 gap-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        <Heading className="break-words font-medium text-sm/snug">
          <bdi lang={item.name.language} dir={item.name.direction}>{item.name.value}</bdi>
        </Heading>
      </div>
    </Link>
  </article>;
}

export function CommunityCard(props: CardProps) {
  return <IdentityCard {...props} label={browseMessages[props.locale].communities} />;
}
export function SiteCard(props: CardProps) {
  return <IdentityCard {...props} label={browseMessages[props.locale].sites} icon={GlobeIcon} />;
}
export function PersonCard(props: CardProps) {
  return <IdentityCard {...props} label={browseMessages[props.locale].people} person />;
}
export function ListCard(props: CardProps) {
  return <IdentityCard {...props} label={browseMessages[props.locale].lists} icon={ListIcon} />;
}
export function TopicCard(props: CardProps) {
  return <IdentityCard {...props} label={browseMessages[props.locale].topics} icon={HashIcon} />;
}

/** One card dispatch for Home's previews, Discover's sections and every complete type traversal. */
export function DiscoverResourceCard(props: CardProps & { slot?: number; scope?: BrowseScope }) {
  switch (props.item.kind) {
    case 'work': return <WorkTile work={resourceWork(props.item, props.scope)} locale={props.locale}
      avatarQuery={props.avatarQuery} slot={props.slot} headingLevel={props.headingLevel} />;
    case 'realm': return <CommunityCard {...props} />;
    case 'site': case 'space': return <SiteCard {...props} />;
    case 'agent': return <PersonCard {...props} />;
    case 'collection': return <ListCard {...props} />;
    case 'concept': return <TopicCard {...props} />;
  }
}
