'use client';

import { Alert, AlertAction, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from '@rezics/ui/menu';
import { toast } from '@rezics/ui/toast';
import { ChevronRightIcon, ChevronsLeftIcon, CircleAlertIcon, Columns3Icon, SearchXIcon, UsersIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AccountErrorCode, AdminAction, AdminUser, Directory, DirectoryColumn, Preferences } from '../api/types.ts';
import { ActionDialog, type ActionRequest } from '../actions/action-dialog.tsx';
import { actionPermission, bulkActionOrder } from '../actions/actions.ts';
import { userHref } from '../audit/entry.tsx';
import { PageHeading } from '../shell/admin-states.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { usePageKeys } from '../shell/keys.ts';
import { useNarrow } from '../shell/media.ts';
import { DirectoryCards, DirectoryTable, toTarget } from './directory-table.tsx';
import { parseQuery } from './query.ts';
import { SearchBox } from './search-box.tsx';
import { columnOrder, defaultColumns, type DirectoryState, directoryParams, readState, type SortKey, stateHref } from './state.ts';
import { ViewTabs } from './views.tsx';
import { useTranslation } from '../../../i18n/client.ts';

export type DirectoryRead = { status: 'ok'; data: Directory } | { status: 'error'; code: AccountErrorCode | 'network' };

/** The user directory: search as you type (200 ms), every state in the URL,
 * keyboard driven, selection turning the toolbar into a bulk-action bar. */
export function UserDirectory({ initialState, initial, preferences }: { initialState: DirectoryState; initial: DirectoryRead;
  preferences: Preferences }) {
  const { t } = useTranslation('admin');
  const { api, navigate, replaceUrl } = useAdminClient();
  const { me, can } = useAdmin();
  const [state, setState] = useState(initialState);
  const [text, setText] = useState(initialState.text);
  const [read, setRead] = useState<DirectoryRead | null>(initial);
  const [loading, setLoading] = useState(false);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  // Selected users by ID, kept across pages and sorting (not a new search),
  // with the rows they were chosen from for the bulk preview.
  const [selection, setSelection] = useState<ReadonlyMap<string, AdminUser>>(new Map());
  const selected = useMemo(() => new Set(selection.keys()), [selection]);
  const [active, setActive] = useState(-1);
  const [columns, setColumns] = useState<readonly DirectoryColumn[]>(preferences.columns ?? defaultColumns);
  const [views, setViews] = useState(preferences.views);
  const [request, setRequest] = useState<ActionRequest | null>(null);
  const [reload, setReload] = useState(0);
  const [composing, setComposing] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  // Fetch whenever the URL state changes (the first render has server data).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const controller = new AbortController();
    setLoading(true);
    api.users(directoryParams(state), controller.signal).then(result => {
      setRead(result.ok ? { status: 'ok', data: result.data } : { status: 'error', code: result.code });
      setLoading(false);
      setActive(-1);
    }, () => {});
    return () => controller.abort();
  }, [api, state, reload]);

  const current = useRef(initialState);
  const go = useCallback((next: DirectoryState, push = false) => {
    if (next.text !== current.current.text) setSelection(new Map());
    current.current = next;
    setState(next);
    replaceUrl(stateHref(next), push);
  }, [replaceUrl]);
  // Typing waits 200 ms for a pause; Enter, chips and filters search at once.
  useEffect(() => {
    if (text === state.text || composing) return;
    const timer = setTimeout(() => { go({ ...state, text, cursor: null }); setPrevious([]); }, 200);
    return () => clearTimeout(timer);
  }, [text, state, go, composing]);
  useEffect(() => {
    const restore = () => {
      const next = readState(new URLSearchParams(window.location.search));
      if (next.text !== current.current.text) setSelection(new Map());
      current.current = next;
      setState(next); setText(next.text); setPrevious([]);
    };
    window.addEventListener('popstate', restore);
    if (window.location.hash === '#search') search.current?.focus();
    return () => window.removeEventListener('popstate', restore);
  }, []);

  const commit = (value: string) => { setText(value); setPrevious([]); go({ ...state, text: value, cursor: null }); };
  const data = read?.status === 'ok' ? read.data : null;
  const users = data?.items ?? null;
  const exact = data?.exact && text === state.text ? data.exact : null;
  const phone = useNarrow(639);
  const focusRow = (index: number) => {
    const link = document.querySelector<HTMLAnchorElement>(`[data-row-link="${index}"]`);
    if (link) { link.focus(); link.closest('tr, li')?.scrollIntoView({ block: 'nearest' }); }
    setActive(index);
  };
  usePageKeys(event => {
    if (!users?.length) return false;
    if (event.key === 'j') { focusRow(Math.min(users.length - 1, active + 1)); return true; }
    if (event.key === 'k') { focusRow(Math.max(0, active - 1)); return true; }
    const user = users[Math.max(active, 0)];
    if (event.key === 'x' && user) { toggle([user.id], !selected.has(user.id)); return true; }
    if (event.key === 'Enter' && active >= 0 && user) { navigate(userHref(user.id)); return true; }
    return false;
  });
  const toggle = (ids: string[], value: boolean) => {
    const rows = (users ?? []).filter(user => ids.includes(user.id));
    if (value && new Set([...selection.keys(), ...ids]).size > me.bulkLimit) {
      toast.error({ title: t.undo.limit({ value: me.bulkLimit }) });
      return;
    }
    setSelection(current => {
      const next = new Map(current);
      for (const user of rows) { if (value) next.set(user.id, user); else next.delete(user.id); }
      return next;
    });
  };
  const sortBy = (sort: SortKey) => go({ ...state, cursor: null, sort,
    direction: sort === state.sort ? state.direction === 'asc' ? 'desc' : 'asc' : sort === 'createdAt' ? 'desc' : 'asc' });
  const saveColumns = (next: DirectoryColumn[]) => {
    const before = columns;
    setColumns(next);
    void api.savePreferences({ columns: next }).then(result => { if (!result.ok) setColumns(before); });
  };
  const saveViews = (next: typeof views, message: string) => {
    const before = views;
    setViews(next);
    void api.savePreferences({ views: next }).then(result => {
      if (result.ok) toast.success({ title: message });
      else { setViews(before); toast.error({ title: t.errors.temporarily_unavailable }); }
    });
  };
  const selectedUsers = [...selection.values()];
  const elsewhere = selectedUsers.filter(user => !users?.some(row => row.id === user.id)).length;
  const bulk = bulkActionOrder.filter(action => me.bulkActions.includes(action) && can(actionPermission[action]));
  const hasSearch = !!state.text.trim();
  const hiddenFilters = parseQuery(state.text).problems.length > 0;

  return <>
    <PageHeading title={t.users} />
    <div className="flex flex-col gap-4 group-data-[density=compact]/admin:gap-3">
      <ViewTabs text={state.text} views={views} onOpen={query => commit(query)}
        onSave={name => saveViews([...views, { id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
          || 'view'}-${crypto.randomUUID().slice(0, 6)}`, name, query: state.text.trim() }], t.views.saved)}
        onRemove={id => saveViews(views.filter(view => view.id !== id), t.views.removed)} />
      {selected.size ? <div role="toolbar" aria-label={t.selected(selected.size)}
        className="flex min-h-10 flex-wrap items-center gap-2 rounded-2xl border border-primary/25 bg-primary/5 px-3 py-2
          max-sm:sticky max-sm:bottom-3 max-sm:z-10 max-sm:order-last max-sm:shadow-(--aura-shadow-card) max-sm:bg-card">
        <span className="me-2 text-sm font-medium">{t.selected(selected.size)}
          {elsewhere ? <span className="block text-xs font-normal text-muted-foreground">{t.undo.elsewhere(elsewhere)}</span> : null}</span>
        {bulk.map(action => <Button key={action} size="sm" variant={action === 'suspend' ? 'destructive' : 'outline'}
          onClick={() => setRequest({ action, targets: selectedUsers.map(toTarget) })}>{t.actions[action]}</Button>)}
        <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setSelection(new Map())}>
          <XIcon aria-hidden="true" />{t.clearSelection}</Button>
      </div> : <SearchBox value={text} inputRef={search} exact={exact} onType={setText}
        onComposing={setComposing} onApply={commit} onOpenExact={() => exact && navigate(userHref(exact.id))}
        onArrowDown={() => focusRow(0)} tools={<Menu positioning={{ placement: 'bottom-end' }} closeOnSelect={false}>
          <MenuTrigger asChild><Button variant="outline" className="h-10"><Columns3Icon aria-hidden="true" />{t.columns.choose}</Button></MenuTrigger>
          <MenuContent className="min-w-52">
            {columnOrder.map(column => <MenuCheckboxItem key={column} value={column} checked={columns.includes(column)}
              disabled={column === 'name'} onCheckedChange={checked => saveColumns(columnOrder.filter(item =>
                item === column ? checked : columns.includes(item)))}>{t.columns[column]}</MenuCheckboxItem>)}
          </MenuContent>
        </Menu>} />}
      {read?.status === 'error' && !loading ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" />
        <AlertDescription>{t.errorLine({ code: read.code })}</AlertDescription>
        <AlertAction><Button size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>{t.retry}</Button></AlertAction>
      </Alert> : users && !users.length && !loading ? <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-border px-6 py-14 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
          {hasSearch ? <SearchXIcon className="size-6" aria-hidden="true" /> : <UsersIcon className="size-6" aria-hidden="true" />}</span>
        <h2 className="text-lg font-semibold">{hasSearch ? t.noMatchTitle : t.emptyTitle}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{hasSearch ? t.noMatchBody : t.emptyBody}</p>
        {hasSearch || hiddenFilters ? <Button variant="outline" onClick={() => commit('')}>{t.clearFilters}</Button> : null}
      </div> : phone ? <DirectoryCards users={users} loading={loading} selected={selected} onSelect={toggle} active={active}
        onActive={setActive} onAction={(action: AdminAction, user) => setRequest({ action, targets: [toTarget(user)] })} />
        : <DirectoryTable users={users} columns={columns} loading={loading} sort={state.sort} direction={state.direction} onSort={sortBy}
          selected={selected} onSelect={toggle} active={active} onActive={setActive}
          onAction={(action: AdminAction, user) => setRequest({ action, targets: [toTarget(user)] })} />}
      {data && (data.nextCursor || state.cursor) ? <nav aria-label={t.pages} className="flex flex-wrap items-center justify-end gap-2">
        {data.nextCursor ? <span className="me-auto text-sm text-muted-foreground">{t.moreAvailable}</span> : null}
        {state.cursor ? <Button variant="ghost" size="sm" onClick={() => { setPrevious([]); go({ ...state, cursor: null }, true); }}>
          <ChevronsLeftIcon aria-hidden="true" />{t.firstPage}</Button> : null}
        {previous.length ? <Button variant="outline" size="sm" onClick={() => {
          const back = previous.at(-1) ?? null; setPrevious(previous.slice(0, -1)); go({ ...state, cursor: back }, true);
        }}>{t.previousPage}</Button> : null}
        {data.nextCursor ? <Button variant="outline" size="sm" onClick={() => {
          setPrevious([...previous, state.cursor]); go({ ...state, cursor: data.nextCursor }, true);
        }}>{t.nextPage}<ChevronRightIcon aria-hidden="true" /></Button> : null}
      </nav> : null}
    </div>
    <ActionDialog request={request} onClose={() => setRequest(null)}
      onDone={() => { setRequest(null); setSelection(new Map()); setReload(value => value + 1); }} />
  </>;
}

