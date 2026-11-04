import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { libraryShelfType, shelfHref, type ShelfLayout } from '../../library/shelf-params';
import {
  readShelfTypesCurrent,
  SHELF_TYPES_LIMIT,
  type ShelfTypesCurrentRead,
  type ShelfTypesView,
} from '../../library/shelf-types-read';
import type { ShelfPreferences } from '../preferences';

const nativeRead = (cursor?: string) => readShelfTypesCurrent({ data: cursor ? { cursor } : {} });
const layoutLabel = (layout: ShelfLayout) =>
  layout === 'grid' ? m.library_layout_grid() : layout === 'list' ? m.library_layout_list() : m.library_layout_table();

/** One replacement owner-index page; saved scopes remain removable when discovery cannot name them. */
export function ShelfTypeDefaults({
  layouts,
  globalLayout,
  savedLayouts,
  disabled,
  subject,
  isCurrent,
  onChange,
  readTypes = nativeRead,
}: {
  layouts: NonNullable<ShelfPreferences['layouts']>;
  globalLayout: ShelfLayout;
  savedLayouts: NonNullable<ShelfPreferences['layouts']>;
  disabled: boolean;
  subject: string | null;
  isCurrent: () => boolean;
  onChange: (scope: string, layout: ShelfLayout | undefined) => void;
  readTypes?: (cursor?: string) => Promise<ShelfTypesCurrentRead>;
}) {
  const locale = getLocale();
  const router = useRouter({ warn: false });
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState<ShelfTypesView>();
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const lifetime = useRef({ active: true, retired: false, revision: 0 });
  useEffect(() => {
    const owner = lifetime.current;
    owner.active = true;
    const release = router?.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
      if (fromLocation?.pathname === toLocation.pathname) return;
      owner.retired = true;
      owner.revision++;
      setPage(undefined);
      setSelected('');
    });
    return () => {
      owner.active = false;
      release?.();
    };
  }, [router, locale, subject]);
  const current = () => lifetime.current.active && !lifetime.current.retired && isCurrent();
  async function read(next?: string) {
    if (!current() || !subject || busy) return;
    const revision = ++lifetime.current.revision;
    const currentRequest = () => current() && lifetime.current.revision === revision;
    setBusy(true);
    setPage(undefined);
    setCursor(next);
    try {
      const result = await readTypes(next);
      if (!currentRequest()) return;
      setPage(
        result.sessionSubject === subject &&
          result.authorizationAgrees &&
          result.requested.locale === locale &&
          result.requested.limit === SHELF_TYPES_LIMIT &&
          result.requested.cursor === (next ?? null)
          ? result.page
          : { state: 'unavailable' },
      );
    } catch {
      if (currentRequest()) setPage({ state: 'unavailable' });
    } finally {
      if (currentRequest()) setBusy(false);
    }
  }
  const choices = page?.state === 'loaded' ? page.types : [];
  const scopes = [
    ...new Set([...choices.map((choice) => choice.type), ...Object.keys(savedLayouts), ...Object.keys(layouts)]),
  ].filter((scope) => scope !== 'all');
  const choice = choices.find((choice) => choice.type === selected);
  const override = layouts[selected];
  const canSet = !!choice && selected.length <= 256;
  // The submitted map includes the global scope only if it was stored or deliberately changed.
  const atLimit = Object.keys(layouts).length >= 32 && !override;
  const knownScope = scopes.includes(selected);
  const saved = savedLayouts[selected];
  const pending = override !== saved;
  return (
    <section aria-labelledby="settings-type-layouts" className="space-y-3 border-t pt-5">
      <h3 id="settings-type-layouts" className="font-medium">
        {m.settings_shelf_types_heading()}
      </h3>
      <p className="text-sm text-muted-foreground">{m.settings_shelf_types_help()}</p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 max-w-full whitespace-normal"
        disabled={!subject || busy || !current()}
        onClick={() => void read(cursor)}
      >
        {page && page.state !== 'loaded' ? m.library_types_retry() : m.settings_shelf_types_load()}
      </Button>
      {busy ? <p role="status">{m.library_types_loading()}</p> : null}
      {page?.state === 'loaded' && !page.types.length ? <p role="status">{m.library_types_empty()}</p> : null}
      {page && page.state !== 'loaded' ? (
        <p role="alert">
          {page.state === 'denied'
            ? m.library_types_denied()
            : page.state === 'closed'
              ? m.platform_closed_message()
              : page.state === 'preparing'
                ? m.library_types_preparing()
                : page.state === 'signed-out'
                  ? m.library_sign_in()
                  : m.library_types_unavailable()}
        </p>
      ) : null}
      {scopes.length ? (
        <label className="grid gap-1 text-sm">
          {m.settings_shelf_type()}
          <select
            className="min-h-11 w-full min-w-0 rounded-md border bg-background px-3 py-2"
            value={knownScope ? selected : ''}
            disabled={!current() || busy}
            onChange={(event) => {
              if (current()) setSelected(event.currentTarget.value);
            }}
          >
            <option value="">{m.settings_shelf_type_choose()}</option>
            {scopes.map((scope) => (
              <option key={scope} value={scope}>
                {choices.find((item) => item.type === scope)?.label ?? m.settings_shelf_type_unknown({ type: scope })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {knownScope ? (
        <div className="space-y-3">
          <p className="break-all text-sm text-muted-foreground">{selected}</p>
          {!choice ? <p className="text-sm">{m.settings_shelf_type_absent()}</p> : null}
          <p role="status">
            {override
              ? m.settings_shelf_type_override({ layout: layoutLabel(override) })
              : m.settings_shelf_type_inherits({ layout: layoutLabel(globalLayout) })}
          </p>
          {pending ? <p className="text-sm">{m.settings_shelf_type_unsaved()}</p> : null}
          {canSet ? (
            <label className="grid gap-1 text-sm">
              {m.settings_shelf_type_layout()}
              <select
                className="min-h-11 max-w-full rounded-md border bg-background px-3 py-2"
                value={override ?? ''}
                disabled={disabled || !current()}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (current() && (!atLimit || !value)) onChange(selected, value ? (value as ShelfLayout) : undefined);
                }}
              >
                <option value="">{m.settings_shelf_type_inherit()}</option>
                {(['grid', 'list', 'table'] as const).map((layout) => (
                  <option key={layout} value={layout} disabled={atLimit}>
                    {layoutLabel(layout)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {atLimit || (choice && !canSet) ? <p className="text-sm">{m.settings_shelf_type_limit()}</p> : null}
          {override ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 max-w-full whitespace-normal"
              disabled={disabled || !current()}
              onClick={() => {
                if (current()) onChange(selected, undefined);
              }}
            >
              {m.settings_shelf_type_remove()}
            </Button>
          ) : null}
          {choice && libraryShelfType(selected) ? (
            <a
              className={`${buttonVariants({ variant: 'outline' })} min-h-11 max-w-full whitespace-normal`}
              href={shelfHref(locale, { type: selected })}
              onClick={(event) => {
                if (!current()) event.preventDefault();
              }}
            >
              {m.settings_shelf_type_visit()}
            </a>
          ) : null}
        </div>
      ) : null}
      {page?.state === 'loaded' && page.next ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 max-w-full whitespace-normal"
          disabled={busy || !current()}
          onClick={() => void read(page.next!)}
        >
          {m.library_types_next()}
        </Button>
      ) : null}
      {cursor ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 max-w-full whitespace-normal"
          disabled={busy || !current()}
          onClick={() => void read()}
        >
          {m.library_types_first()}
        </Button>
      ) : null}
    </section>
  );
}
