'use client';

import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';

/**
 * Long text folded to a few lines with "Show more", as Goodreads folds a
 * description. The toggle appears only when the text is actually cut.
 */
export function Expandable({ children, more, less, className }: {
  children: ReactNode; more: string; less: string; className?: string;
}) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className={cn('grid justify-items-start gap-2', className)}>
    <div ref={body} id={id} className={cn('w-full', !open && 'max-h-[8.75rem] overflow-hidden',
      !open && cut && '[mask-image:linear-gradient(to_bottom,black_55%,transparent)]')}>{children}</div>
    {cut || open ? <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
      className="inline-flex items-center gap-1 rounded-sm font-semibold text-sm outline-none hover:underline
        focus-visible:ring-2 focus-visible:ring-ring">
      {open ? less : more}<ChevronDownIcon aria-hidden="true" className={cn('size-4 transition-transform',
        open && 'rotate-180')} /></button> : null}
  </div>;
}
