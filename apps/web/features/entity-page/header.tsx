import { Badge } from '@rezics/ui/badge';
import { initials } from '@rezics/ui/avatar-initials';
import { LocalizedText } from '@rezics/ui/localized-text';
import { cn } from '@rezics/ui/utils';
import { LockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { WebMediaImage } from '../document-editor/media-image.tsx';
import { entryLabel } from '../catalogue/types.ts';
import { copyOf, type Copy } from './messages.ts';
import { Expandable } from '../work-page/expandable.tsx';
import type { EntityProjection } from './types.ts';

type Summary = Extract<EntityProjection['summary'], { status: 'available' }>;

/** Identity and actions stay together even when a subject has a long biography or definition. */
export function SubjectHeader({ identity, primary, actions, children, className, locale = 'en', resource, semanticType, contentModel }: {
  identity: ReactNode; primary?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string;
  locale?: UiLocale; resource?: string; semanticType?: string; contentModel?: string;
}) {
  const t = copyOf(locale);
  return <header data-subject-header data-resource={resource} data-semantic-type={semanticType} data-content-model={contentModel}
    className={cn('grid min-w-0 gap-4', className)}>
    <div className="grid min-w-0 gap-4">
      <div data-subject-identity className="min-w-0">{identity}</div>
      {primary || actions ? <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        {primary ? <div data-subject-primary role="group" aria-label={t.primaryActions}
          className="flex min-w-0 flex-wrap items-center gap-3">{primary}</div> : null}
        {actions ? <div data-subject-actions className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
          {actions}</div> : null}
      </div> : null}
    </div>
    {children}
  </header>;
}

export function SubjectDescription({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  const t = copyOf(locale);
  return <Expandable more={t.showMore} less={t.showLess} className="max-w-prose">{children}</Expandable>;
}

/**
 * The resource's avatar: its picture when one is selected, else the initials of
 * its name on the accent surface. Squares for everything that is not a person.
 */
export function EntityAvatar({ summary, avatarQuery = '', className, revealable = false }: {
  summary: Summary; avatarQuery?: string; className?: string; revealable?: boolean;
}) {
  const avatar = summary.avatar;
  const src = avatar.kind === 'image' && avatar.url.startsWith('/v1/media/')
    ? `${BFF_PREFIX}${avatar.url}${avatarQuery}` : null;
  return <span className={cn('relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-[22%] bg-accent',
    'text-accent-foreground after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-foreground/8',
    'sm:size-20', className)}>
    {src ? <WebMediaImage revealable={revealable} compact src={src} alt="" className="size-full object-cover" />
      : <span aria-hidden="true" className="font-semibold font-work-title text-2xl leading-none sm:text-3xl">
        {initials(summary.name.value)}</span>}
  </span>;
}

/**
 * The page's one heading: the resource's name in its own language and
 * direction, what kind of thing it is (from the type registry, never the
 * type's IRI) and whether it is private.
 */
export function EntityHeader({ summary, registry, avatarQuery, locale, t, actions, primary }: {
  summary: Summary; registry: EntityProjection['registry']; avatarQuery?: string; locale: UiLocale; t: Copy;
  actions?: ReactNode; primary?: ReactNode;
}) {
  return <SubjectHeader locale={locale} resource={summary.reference} semanticType={registry.type}
    actions={actions} primary={primary} className="border-border/60 border-b pb-6"
    identity={<div className="flex min-w-0 items-center gap-3 sm:gap-4">
    <EntityAvatar revealable summary={summary} avatarQuery={avatarQuery} />
    <div className="grid min-w-0 gap-1.5">
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
        <span data-entity-type>{entryLabel(registry, locale)}</span>
        {summary.disclosure === 'restricted'
          ? <Badge variant="outline" title={t.restrictedHelp}><LockIcon aria-hidden="true" />{t.restricted}</Badge> : null}
      </p>
      <h1 className="text-balance font-semibold font-work-title text-2xl tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
        <LocalizedText text={summary.name} as="span" /></h1>
    </div>
  </div>} />;
}
