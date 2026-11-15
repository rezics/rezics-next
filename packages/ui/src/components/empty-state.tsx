import { useId, type ReactNode } from 'react';
import { cn } from '../utils.ts';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from '../shadcn/empty.tsx';

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  density?: 'page' | 'compact';
  tone?: 'default' | 'attention';
  /** Only the explanation is live. Controls remain outside the live region. */
  role?: 'status' | 'alert';
  className?: string;
};

/** Semantic composition over Empty; selection, localized copy and recovery belong to the caller. */
export function EmptyState({
  title,
  description,
  icon,
  actions,
  headingLevel = 2,
  density = 'page',
  tone = 'default',
  role,
  className,
}: EmptyStateProps) {
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <Empty
      data-slot="empty-state"
      data-density={density}
      data-tone={tone}
      className={cn(
        density === 'page' ? 'min-h-72 px-5 py-9 sm:px-10 sm:py-12' : 'gap-3 px-4 py-5 sm:px-6',
        className,
      )}
    >
      <EmptyHeader className="w-full max-w-lg gap-3">
        {icon ? (
          <EmptyMedia aria-hidden="true" variant="icon">
            {icon}
          </EmptyMedia>
        ) : null}
        <div role={role} aria-atomic={role ? true : undefined} className="min-w-0 space-y-2">
          <Heading
            id={`${id}-title`}
            className="text-balance text-lg font-semibold tracking-tight [overflow-wrap:anywhere]"
          >
            {title}
          </Heading>
          {description ? (
            <EmptyDescription className="text-pretty [overflow-wrap:anywhere]">{description}</EmptyDescription>
          ) : null}
        </div>
      </EmptyHeader>
      {actions ? (
        <EmptyContent className="max-w-lg flex-row flex-wrap justify-center gap-2">
          {actions}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
