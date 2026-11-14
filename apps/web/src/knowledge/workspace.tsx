import type { ReactNode } from 'react';

export const knowledgeControl =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-snug [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
export const knowledgeLink =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
export const knowledgeSummary =
  'min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Disclosure changes presentation only. Children keep their visit-owned state while collapsed. */
export function KnowledgeDetails({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="min-w-0 border-t border-border">
      <summary className={knowledgeSummary}>{label}</summary>
      <div className="min-w-0 space-y-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

export function KnowledgeValue({ label, value, exact = false }: { label: string; value: string; exact?: boolean }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere] ${exact ? 'font-mono' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
