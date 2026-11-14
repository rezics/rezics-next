import type { ReactNode } from 'react';

/** Responsive regions for source context, the selected occurrence, its plan, and its outcome. */
export function ProgressWorkspace({
  sourceContext,
  occurrenceBrowser,
  plan,
  operation,
  restoredSession,
  archiveActions,
}: {
  sourceContext: ReactNode;
  occurrenceBrowser: ReactNode;
  plan: ReactNode;
  operation: ReactNode;
  restoredSession: ReactNode;
  archiveActions: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 space-y-4">
        {sourceContext}
        {occurrenceBrowser}
      </div>
      <div className="min-w-0 space-y-4">
        {plan}
        {operation}
        {restoredSession}
      </div>
      {archiveActions ? <div className="min-w-0 lg:col-span-2">{archiveActions}</div> : null}
    </div>
  );
}
