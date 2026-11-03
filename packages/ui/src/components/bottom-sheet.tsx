import type { ReactNode } from 'react';
import type { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import { Button } from '../shadcn/button.tsx';
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '../shadcn/drawer.tsx';

const doneLabels: Record<string, string> = {
  de: 'Fertig',
  en: 'Done',
  es: 'Listo',
  fr: 'Terminé',
  ja: '完了',
  ko: '완료',
  'zh-Hans': '完成',
  'zh-Hant': '完成',
};

export function BottomSheet({
  open,
  onOpenChange,
  title,
  children,
  closeLabel,
  before,
  className,
  onOpenChangeComplete,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  closeLabel?: string;
  before?: ReactNode;
  className?: string;
  onOpenChangeComplete?: DrawerPrimitive.Root.Props['onOpenChangeComplete'];
  finalFocus?: DrawerPrimitive.Popup.Props['finalFocus'];
}) {
  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang;
  const label = closeLabel ?? doneLabels[locale] ?? doneLabels[locale.split('-')[0]!] ?? 'Done';
  return (
    <Drawer open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete} showSwipeHandle>
      <DrawerContent className="max-h-[85dvh]" finalFocus={finalFocus}>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
            {before}
            <DrawerTitle className="min-w-0 flex-1 truncate text-left">{title}</DrawerTitle>
            <DrawerClose render={<Button variant="ghost" className="min-h-11 shrink-0" />}>{label}</DrawerClose>
          </div>
          <div
            className={`min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] ${className ?? ''}`}
          >
            {children}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
