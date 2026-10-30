import type { ReactNode } from 'react';

/** The view's own heading, which follows the subject frame. */
export function ViewHeading({ label, count }: { label: string; count?: ReactNode }) {
  return (
    <div data-slot="view-heading" className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{label}</h1>
      {count}
    </div>
  );
}

/** Keeps actions beside the view heading while allowing the row to wrap on narrow screens. */
export function ViewHeadingActions({ label, actions }: { label: string; actions?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <ViewHeading label={label} />
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
