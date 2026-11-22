import type { ReactNode } from 'react';
import { Progress } from '../shadcn/progress.tsx';

/** The compact progress layout used on subject cards; shadcn has no such row. */
export function ProgressRow({ value, label, menu }: { value: number | null; label: string; menu?: ReactNode }) {
  return (
    <div data-slot="progress-row" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {menu}
      {value != null && (
        <Progress
          value={value * 100}
          aria-label={label}
          className="min-w-6 flex-1"
        />
      )}
      <span className="min-w-0 max-w-full whitespace-normal wrap-anywhere tabular-nums">{label}</span>
    </div>
  );
}
