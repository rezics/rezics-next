import type { ReactNode } from 'react';
import { Button } from '../shadcn/button.tsx';
import { ButtonGroup } from '../shadcn/button-group.tsx';
import { Menu } from './menu.tsx';

export interface SelectionBarProps {
  count: number;
  label: (count: number) => string;
  actions: ReactNode;
  onCancel: () => void;
  cancelLabel: string;
  moreLabel: string;
}
export function SelectionBar({ count, label, actions, onCancel, cancelLabel, moreLabel }: SelectionBarProps) {
  return (
    <div
      className="fixed inset-x-0 z-40 flex items-center justify-between gap-3 border-t bg-background p-3 shadow-lg"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--bottom-nav-height, 0px))' }}
    >
      <span aria-live="polite" aria-atomic="true">
        {label(count)}
      </span>
      <ButtonGroup className="hidden sm:flex">
        {actions}
        <Button variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </ButtonGroup>
      <div className="flex items-center gap-2 sm:hidden">
        <Menu
          title={moreLabel}
          content={actions}
          trigger={
            <Button variant="outline" aria-label={moreLabel}>
              ⋯
            </Button>
          }
        />
        <Button variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}
