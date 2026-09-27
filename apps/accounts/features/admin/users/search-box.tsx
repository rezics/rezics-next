'use client';

import { Button } from '@rezics/ui/button';
import { Kbd } from '@rezics/ui/kbd';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { Popover, PopoverBody, PopoverContent, PopoverHeader, PopoverTrigger } from '@rezics/ui/popover';
import { CircleHelpIcon, CornerDownLeftIcon, ListFilterIcon, SearchIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { type RefObject, useRef } from 'react';
import type { AdminUser } from '../api/types.ts';
import { addFilter, type FilterKey, isChip, parseQuery, type QueryProblem, type QueryToken, removeToken } from './query.ts';
import { useTranslation } from '../../../i18n/client.ts';

type AdminText = ReturnType<typeof useTranslation<'admin'>>['t'];

function chipLabel(token: QueryToken, t: AdminText): string {
  const key = token.key!;
  const values = token.value.split(',').filter(Boolean).map(value => {
    const lower = value.toLowerCase();
    if (key === 'status') return (t.statuses as Record<string, string>)[lower === 'reset' || lower === 'reset-required'
      ? 'password-reset-required' : lower] ?? value;
    if (key === 'role') return lower === 'staff' || lower === 'operator' ? t.filters.staff : lower === 'none' ? t.filters.none
      : (t.roles as Record<string, string>)[lower] ?? value;
    if (key === 'verified' || key === '2fa') return ['yes', 'true', 'on', '1'].includes(lower) ? t.filters.yes : t.filters.no;
    return value;
  }).join(', ');
  return `${t.filters[key]}: ${token.negated ? t.filters.not({ value: values }) : values}`;
}

function problemText(problem: QueryProblem, t: AdminText): string {
  switch (problem.kind) {
    case 'unknown-filter': return t.search.problems.unknownFilter({ key: problem.key });
    case 'no-handle': return t.search.problems.noHandle;
    case 'bad-value': return t.search.problems.badValue({ key: problem.key, value: problem.value });
    case 'no-negation': return problem.key === 'text' ? t.search.problems.noTextNegation : t.search.problems.noNegation({ key: problem.key });
    case 'contradiction': return t.search.problems.contradiction({ key: problem.key });
  }
}

const day = 86_400_000;
const utcDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The directory's search box: text with filters, removable chips, what
 * couldn't be understood, and the exact ID/email match to jump to. */
export function SearchBox({ value, onType, onComposing, onApply, exact, onOpenExact, inputRef, onArrowDown }: { value: string;
  /** Typing: searched after a pause, never mid-composition. */
  onType(value: string): void; onComposing(composing: boolean): void;
  /** Enter, chips, filters and clearing: searched at once. */
  onApply(value: string): void; exact: AdminUser | null; onOpenExact(): void;
  inputRef: RefObject<HTMLInputElement | null>; onArrowDown(): void }) {
  const { t } = useTranslation('admin');
  const composing = useRef(false);
  const parsed = parseQuery(value);
  const chips = parsed.tokens.filter(isChip);
  const append = (key: FilterKey, filter: string) => { onApply(addFilter(value, key, filter)); inputRef.current?.focus(); };
  const startTyping = (key: FilterKey) => {
    onType(`${value.trim()} ${key}:`.trim());
    requestAnimationFrame(() => { const input = inputRef.current; if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
  };
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-72">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input ref={inputRef} id="admin-search" type="search" role="searchbox" aria-label={t.search.label}
          aria-describedby="admin-search-help" placeholder={t.search.placeholder} value={value} autoComplete="off"
          spellCheck={false} autoCapitalize="none" enterKeyHint="search" maxLength={400}
          className="h-10 w-full rounded-xl border border-border/80 bg-primary/5 ps-10 pe-24 text-base shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/64 hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 md:text-sm [&::-webkit-search-cancel-button]:hidden"
          onChange={event => onType(event.currentTarget.value)}
          onCompositionStart={() => { composing.current = true; onComposing(true); }}
          onCompositionEnd={event => { composing.current = false; onComposing(false); onType(event.currentTarget.value); }}
          onKeyDown={event => {
            // Enter while an IME is composing picks a candidate; it never searches.
            if (event.nativeEvent.isComposing || composing.current) return;
            if (event.key === 'Enter') { event.preventDefault(); if (exact) onOpenExact(); else onApply(value); }
            if (event.key === 'Escape' && value) { event.preventDefault(); onApply(''); }
            if (event.key === 'ArrowDown') { event.preventDefault(); onArrowDown(); }
          }} />
        <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {value ? <Button variant="ghost" size="icon-sm" aria-label={t.search.clear} onClick={() => { onApply(''); inputRef.current?.focus(); }}>
            <XIcon aria-hidden="true" /></Button> : <Kbd aria-hidden="true" className="me-1.5 max-md:hidden">/</Kbd>}
          <SyntaxHelp />
        </div>
      </div>
      <Menu positioning={{ placement: 'bottom-end' }} onSelect={({ value: choice }) => {
        const [key, filter] = choice.split('=') as [FilterKey, string];
        if (filter === undefined) startTyping(key); else append(key, filter);
      }}>
        <MenuTrigger asChild><Button variant="outline" className="h-10"><ListFilterIcon aria-hidden="true" />{t.search.addFilter}</Button></MenuTrigger>
        <MenuContent className="min-w-60">
          <MenuGroup heading={t.filters.status}>
            <MenuItem value="status=active">{t.statuses.active}</MenuItem>
            <MenuItem value="status=suspended">{t.statuses.suspended}</MenuItem>
            <MenuItem value="status=reset">{t.statuses['password-reset-required']}</MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup heading={t.filters.role}>
            <MenuItem value="role=staff">{t.filters.staff}</MenuItem>
            <MenuItem value="role=owner">{t.roles.owner}</MenuItem>
            <MenuItem value="role=admin">{t.roles.admin}</MenuItem>
            <MenuItem value="role=support">{t.roles.support}</MenuItem>
            <MenuItem value="role=none">{t.filters.none}</MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem value="verified=no">{`${t.filters.verified}: ${t.filters.no}`}</MenuItem>
          <MenuItem value="2fa=off">{`${t.filters['2fa']}: ${t.filters.no}`}</MenuItem>
          <MenuItem value={`created=>=${utcDate(Date.now() - 7 * day)}`}>{`${t.filters.created}: ${t.ranges['7d']}`}</MenuItem>
          <MenuItem value={`created=>=${utcDate(Date.now() - 30 * day)}`}>{`${t.filters.created}: ${t.ranges['30d']}`}</MenuItem>
          <MenuSeparator />
          <MenuItem value="name">{`${t.filters.name}…`}</MenuItem>
          <MenuItem value="email">{`${t.filters.email}…`}</MenuItem>
        </MenuContent>
      </Menu>
    </div>
    {chips.length ? <ul className="flex flex-wrap gap-1.5" aria-label={t.search.addFilter}>
      {chips.map(token => {
        const label = chipLabel(token, t);
        return <li key={`${token.start}:${token.end}`}>
          <button type="button" onClick={() => onApply(removeToken(value, token))} aria-label={t.search.removeFilter({ filter: label })}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-primary/25 bg-primary/8 ps-3 pe-2 text-xs font-medium text-primary outline-none hover:bg-primary/15 focus-visible:ring-[3px] focus-visible:ring-ring/32">
            {label}<XIcon className="size-3.5" aria-hidden="true" /></button></li>;
      })}
    </ul> : null}
    <div id="admin-search-help" role="status" className="flex flex-col gap-1.5 empty:hidden">
      {parsed.problems.map(problem => <p key={JSON.stringify(problem)} className="flex items-start gap-2 text-sm text-warning-foreground">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{problemText(problem, t)}</p>)}
      {exact ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-primary/25 bg-primary/5 px-4 py-2 text-sm">
        <span>{t.search.jumpTo({ name: exact.name || exact.email })} <span className="text-muted-foreground">{exact.email}</span></span>
        <span className="flex items-center gap-2 text-muted-foreground max-sm:hidden"><Kbd><CornerDownLeftIcon aria-hidden="true" /></Kbd>{t.search.jumpHint}</span>
        <Button size="sm" variant="soft" className="ms-auto" onClick={onOpenExact}>{t.search.open}</Button>
      </div> : null}
    </div>
  </div>;
}

function SyntaxHelp() {
  const { t } = useTranslation('admin');
  const examples = ['status:suspended', '-role:none', 'email:ada@', 'name:明', 'verified:no 2fa:off', 'created:>=2026-01',
    'created:2026-01..2026-03'];
  return <Popover positioning={{ placement: 'bottom-end' }}>
    <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t.search.help}><CircleHelpIcon aria-hidden="true" /></Button></PopoverTrigger>
    <PopoverContent className="w-[min(24rem,calc(100vw-2rem))]">
      <PopoverHeader title={t.search.helpTitle} description={t.search.helpIntro} />
      <PopoverBody className="flex flex-col gap-3 text-sm">
        <p className="font-medium">{t.search.examples}</p>
        <ul className="flex flex-wrap gap-1.5">{examples.map(example => <li key={example}>
          <code className="rounded-lg bg-muted px-2 py-1 font-mono text-xs">{example}</code></li>)}</ul>
        <p className="text-muted-foreground">{t.search.datesAreUtc}</p>
      </PopoverBody>
    </PopoverContent>
  </Popover>;
}
