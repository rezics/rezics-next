import { createContext, useContext, type ComponentProps, type ReactNode, type Ref } from 'react';
import { cn } from '@rezics/ui/utils';

export type StreamHeadingLevel = 1 | 2;

/** The full-page host names its sole stream; every other embedded heading retains h2. */
export const PageStreamHeadingContext = createContext<string | undefined>(undefined);

export function StreamHeading({
  level,
  node,
  className,
  ...props
}: ComponentProps<'h2'> & { level?: StreamHeadingLevel | undefined; node?: string | undefined }) {
  const pageStream = useContext(PageStreamHeadingContext);
  const Heading = (level ?? (node !== undefined && pageStream === node ? 1 : 2)) === 1 ? 'h1' : 'h2';
  return <Heading {...props} className={cn('min-w-0 max-w-full wrap-anywhere', className)} />;
}

/** The view's own heading, which follows the subject frame. */
export function ViewHeading({
  label,
  count,
  headingClassName,
  headingRef,
  headingTabIndex,
}: {
  label: string;
  count?: ReactNode;
  headingClassName?: string;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  headingTabIndex?: number | undefined;
}) {
  return (
    <div data-slot="view-heading" className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1
        ref={headingRef}
        tabIndex={headingTabIndex}
        className={cn(
          'min-w-0 max-w-full font-sans text-3xl font-semibold tracking-tight wrap-anywhere text-balance sm:text-4xl',
          headingClassName,
        )}
      >
        {label}
      </h1>
      {count}
    </div>
  );
}

/** Keeps actions beside the view heading while allowing the row to wrap on narrow screens. */
export function ViewHeadingActions({
  label,
  actions,
  headingClassName,
}: {
  label: string;
  actions?: ReactNode;
  headingClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <ViewHeading label={label} {...(headingClassName ? { headingClassName } : {})} />
      {actions ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:wrap-anywhere [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:wrap-anywhere">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
