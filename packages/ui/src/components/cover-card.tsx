import { EllipsisIcon } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { Button } from '../shadcn/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../shadcn/dropdown-menu.tsx';
import { Cover, type CoverProps, type CoverRatio } from './cover.tsx';

const RatioContext = createContext<CoverRatio | undefined>(undefined);

export interface CoverCardProps {
  href: string;
  cover: Omit<CoverProps, 'size'>;
  title: string;
  titleLang?: string;
  secondary?: ReactNode;
  state?: ReactNode;
  menu?: ReactNode;
  menuLabel?: string;
}

/** A subject card with a stretched title link; shadcn has no subject-cover card pattern. */
export function CoverCard({ href, cover, title, titleLang, secondary, state, menu, menuLabel }: CoverCardProps) {
  const ratio = useContext(RatioContext);
  return (
    <article className="group relative min-w-0 overflow-hidden rounded-lg bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring">
      <Cover
        {...cover}
        size="fill"
        {...(ratio ? { ratio } : {})}
        decorative
        caption={false}
        className="[&_[data-slot=aspect-ratio]]:rounded-none [&_[data-slot=aspect-ratio]]:ring-0 [&_button:not(.absolute)]:relative [&_button]:z-10"
      />
      <div className="space-y-1 p-3">
        <a
          href={href}
          lang={titleLang}
          className="line-clamp-2 text-sm font-semibold wrap-anywhere outline-none after:absolute after:inset-0 after:content-['']"
        >
          {title}
        </a>
        {secondary != null && <div className="line-clamp-1 text-xs text-muted-foreground">{secondary}</div>}
        {(state != null || menu != null) && (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {menu != null && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="relative z-10 shrink-0"
                      aria-label={menuLabel ?? `More actions for ${title}`}
                    />
                  }
                >
                  <EllipsisIcon aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent>{menu}</DropdownMenuContent>
              </DropdownMenu>
            )}
            {state != null && <div className="min-w-0 flex-1">{state}</div>}
          </div>
        )}
      </div>
    </article>
  );
}

/** A responsive subject grid; shadcn does not provide this layout. */
export function CoverGrid({ ratio, children }: { ratio: CoverRatio; children: ReactNode }) {
  return (
    <RatioContext.Provider value={ratio}>
      <div className="@container">
        <div className="grid grid-cols-2 gap-4 @min-[30rem]:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]">
          {children}
        </div>
      </div>
    </RatioContext.Provider>
  );
}

/** A keyboard-reachable, snapping subject row; shadcn does not provide this layout. */
export function CoverRow({ ratio, label, children }: { ratio: CoverRatio; label: string; children: ReactNode }) {
  return (
    <RatioContext.Provider value={ratio}>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto rounded-lg focus-visible:outline-2 focus-visible:outline-ring [&>*]:w-[7.5rem] [&>*]:shrink-0 [&>*]:snap-start"
      >
        {children}
      </div>
    </RatioContext.Provider>
  );
}
