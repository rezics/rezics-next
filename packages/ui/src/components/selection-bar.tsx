import type { ReactNode } from 'react';
import { Button } from '../shadcn/button.tsx';
import { ButtonGroup } from '../shadcn/button-group.tsx';
import { Menu } from './menu.tsx';

export interface SelectionBarProps {
  count: number;
  label: (count: number) => string;
  actions: ReactNode;
  primaryAction?: ReactNode;
  statusMessage?: ReactNode;
  onCancel: () => void;
  cancelLabel: string;
  moreLabel: string;
  ariaLabel?: string;
  bottomOffset?: string;
}
export function SelectionBar({
  count,
  label,
  actions,
  primaryAction,
  statusMessage,
  onCancel,
  cancelLabel,
  moreLabel,
  ariaLabel,
  bottomOffset,
}: SelectionBarProps) {
  return (
    <div
      role={ariaLabel ? 'region' : undefined}
      aria-label={ariaLabel}
      className="fixed inset-x-0 z-40 flex flex-wrap items-center justify-between gap-3 border-t bg-background p-3 shadow-lg"
      style={{ bottom: bottomOffset ?? 'calc(env(safe-area-inset-bottom, 0px) + var(--bottom-nav-height, 0px))' }}
    >
      {statusMessage ? <p role="status" className="w-full text-sm">{statusMessage}</p> : null}
      <span aria-live="polite" aria-atomic="true">
        {label(count)}
      </span>
      <ButtonGroup className="hidden sm:flex">
        {primaryAction}
        {actions}
        <Button variant="outline" className="min-h-11" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </ButtonGroup>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:hidden">
        {primaryAction}
        <Menu
          title={moreLabel}
          content={actions}
          trigger={
            <Button variant="outline" className="min-h-11" aria-label={moreLabel}>
              ⋯
            </Button>
          }
        />
        <Button variant="outline" className="min-h-11" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}
