import type { ReactNode } from 'react';
import { Progress } from '../shadcn/progress.tsx';

/** The compact progress layout used on subject cards; shadcn has no such row. */
export function ProgressRow({ value, label, menu }: { value: number | null; label: string; menu?: ReactNode }) {
  return (
    <div data-slot="progress-row" className="flex min-w-0 items-center gap-2">
      {menu}
      {value != null && (
        <Progress
          value={value * 100}
          aria-label={label}
          className="min-w-0 flex-1 [&_[data-slot=progress-track]]:h-1"
        />
      )}
      <span className="shrink-0 tabular-nums">{label}</span>
    </div>
  );
}
