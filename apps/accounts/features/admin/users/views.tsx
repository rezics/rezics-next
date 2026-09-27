'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { cn } from '@rezics/ui/utils';
import { BookmarkPlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import type { SavedView } from '../api/types.ts';
import { useDismiss } from '../actions/confirm.tsx';
import { sameSearch } from './state.ts';
import { useTranslation } from '../../../i18n/client.ts';

/** Views are named links to a search: three built in, the rest the operator's own. */
export function ViewTabs({ text, views, onOpen, onSave, onRemove }: { text: string; views: SavedView[];
  onOpen(query: string): void; onSave(name: string): void; onRemove(id: string): void }) {
  const { t } = useTranslation('admin');
  const [saving, setSaving] = useState(false);
  const builtIn = [{ id: 'all', name: t.views.all, query: '' }, { id: 'suspended', name: t.views.suggestions.suspended, query: 'status:suspended' },
    { id: 'staff', name: t.views.suggestions.staff, query: 'role:staff' }, { id: 'unverified', name: t.views.suggestions.unverified, query: 'verified:no' }];
  const current = [...builtIn, ...views].find(view => sameSearch(view.query, text));
  const tab = (view: SavedView, removable: boolean) => {
    const active = view === current;
    return <li key={view.id} className={cn('group/view flex shrink-0 items-center rounded-full border text-sm transition-colors',
      active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
      <a href={`/admin/users${view.query ? `?q=${encodeURIComponent(view.query)}` : ''}`} aria-current={active ? 'page' : undefined}
        onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; event.preventDefault(); onOpen(view.query); }}
        className={cn('rounded-full py-1.5 font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32', removable ? 'ps-3.5 pe-1' : 'px-3.5')}>
        {view.name}</a>
      {removable ? <button type="button" onClick={() => onRemove(view.id)} aria-label={t.views.remove({ name: view.name })}
        className="me-1 grid size-6 place-items-center rounded-full opacity-60 outline-none hover:bg-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/32">
        <XIcon className="size-3.5" aria-hidden="true" /></button> : null}
    </li>;
  };
  return <nav aria-label={t.views.label} className="flex items-center gap-2">
    <ul className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {builtIn.map(view => tab(view, false))}{views.map(view => tab(view, true))}</ul>
    {text.trim() && !current ? <Button variant="ghost" size="sm" onClick={() => setSaving(true)}>
      <BookmarkPlusIcon aria-hidden="true" />{t.views.save}</Button> : null}
    {saving ? <SaveViewDialog query={text.trim()} onClose={() => setSaving(false)}
      onSave={name => { setSaving(false); onSave(name); }} /> : null}
  </nav>;
}

function SaveViewDialog({ query, onClose, onSave }: { query: string; onClose(): void; onSave(name: string): void }) {
  const { t } = useTranslation('admin');
  const [name, setName] = useState(query.slice(0, 60));
  const dismiss = useDismiss(onClose);
  return <Dialog open {...dismiss.root}>
    <DialogContent ref={dismiss.content} size="sm" showCloseButton={false}>
      <form className="contents" onSubmit={event => { event.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
        <DialogHeader title={t.views.saveTitle} description={t.views.saveBody} />
        <DialogBody>
          <Field><FieldLabel>{t.views.name}</FieldLabel>
            <Input value={name} maxLength={60} autoFocus onChange={event => setName(event.currentTarget.value)} />
            <FieldDescription className="font-mono break-all">{query}</FieldDescription></Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t.cancel}</Button>
          <Button type="submit" disabled={!name.trim()}>{t.views.save}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
