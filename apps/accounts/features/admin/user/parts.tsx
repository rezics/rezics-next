'use client';

import { Button } from '@rezics/ui/button';
import { toast } from '@rezics/ui/toast';
import { cn } from '@rezics/ui/utils';
import { CopyIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { AdminResult } from '../api/client.ts';
import { errorMessage } from '../actions/confirm.tsx';
import { useTranslation } from '../../../i18n/client.ts';

/** A titled card of the user page. */
export function Panel({ title, description, action, children, className }: { title: string; description?: string;
  action?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return <section aria-labelledby={id} className={cn('rounded-3xl border border-border/60 bg-card shadow-(--aura-shadow-card)', className)}>
    <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-3">
      <div className="min-w-0"><h2 id={id} className="font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}</div>
      {action}
    </header>
    {children}
  </section>;
}

/** Label and value rows inside a panel. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="divide-y divide-border/60 border-t border-border/60">
    {rows.map(([label, value]) => <div key={label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4 px-5 py-2.5 text-sm
      group-data-[density=compact]/admin:py-1.5">
      <dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
  </dl>;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation('admin');
  return <Button variant="ghost" size="icon-xs" aria-label={label} title={label} onClick={() => {
    void navigator.clipboard.writeText(value).then(() => toast.success({ title: t.user.copied }), () => {});
  }}><CopyIcon aria-hidden="true" /></Button>;
}

/** A cursor-paged list that appends the next page on demand. */
export function usePages<T>(initial: { items: T[]; nextCursor: string | null },
  next: (cursor: string) => Promise<AdminResult<{ items: T[]; nextCursor: string | null }>>) {
  const { t } = useTranslation('admin');
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function more() {
    if (!cursor) return;
    setLoading(true); setError(null);
    const result = await next(cursor);
    setLoading(false);
    if (!result.ok) { setError(errorMessage(result, t)); return; }
    setItems(current => [...current, ...result.data.items]);
    setCursor(result.data.nextCursor);
  }
  const button = cursor ? <div className="flex flex-col items-center gap-2 border-t border-border/60 px-5 py-3">
    {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
    <Button variant="outline" size="sm" isLoading={loading} onClick={() => void more()}>{t.loadMore}</Button>
  </div> : null;
  return { items, button };
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="border-t border-border/60 px-5 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
