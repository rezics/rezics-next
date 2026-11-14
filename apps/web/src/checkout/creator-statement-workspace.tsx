import type { ReactNode } from 'react';

/** Responsive group for the directory result, empty, and pagination states. */
export function StatementDirectoryFrame({ children }: { children: ReactNode }) {
  return <div className="min-w-0 space-y-4">{children}</div>;
}

/** Surface for the supplied statement totals, kept separate from payment and line history. */
export function StatementAccountingSummaryFrame({ children }: { children: ReactNode }) {
  return <div className="min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground sm:p-5">{children}</div>;
}

/** Independent region for bounded line reads, including their own empty and retry states. */
export function StatementLineHistoryFrame({ children }: { children: ReactNode }) {
  return <div className="min-w-0 space-y-4">{children}</div>;
}
