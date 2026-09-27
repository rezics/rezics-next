import { cn } from '@rezics/ui/utils';
import type { ZoneModule } from '@rezics/zone-sdk';
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import LocalizedLink from '../shell/localized-link.tsx';

/** A module's heading id, for `aria-labelledby` and in-page links. */
export const moduleHeadingId = (module: Pick<ZoneModule, 'id'>) => `zone-module-${module.id}`;

/** The module title in the Zone's heading face and scale. */
export function ModuleHeading({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return <h2 id={id} className={cn('text-balance font-(family-name:--zone-heading-font) font-semibold tracking-tight',
    'text-[length:calc(1.125rem*var(--zone-heading-scale,1))]', className)}>{children}</h2>;
}

/**
 * A module's panel: its title, optional controls and "More", then the body.
 * On a `cards` page it is a card on the tinted page; on a `flat` page it
 * sits directly on the page.
 */
export function ModuleFrame({ module, actions, more, children, className }: {
  module: ZoneModule; actions?: ReactNode; more?: string; children: ReactNode; className?: string;
}) {
  const id = moduleHeadingId(module);
  return <section aria-labelledby={id} data-zone-module={module.type}
    className={cn('zone-module min-w-0 rounded-(--zone-radius-card) bg-(--zone-panel) p-(--zone-panel-pad)', className)}>
    <header className="mb-3 flex min-h-8 items-center justify-between gap-3">
      <ModuleHeading id={id}>{module.title}</ModuleHeading>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {module.more ? <LocalizedLink href={module.more} className="inline-flex h-8 items-center gap-0.5 rounded-full
          px-2 font-medium text-primary text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          {more}<ChevronRightIcon aria-hidden="true" className="size-4 rtl:rotate-180" /></LocalizedLink> : null}
      </div>
    </header>
    {children}
  </section>;
}
