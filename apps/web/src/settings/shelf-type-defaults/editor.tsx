import { useLayoutEffect, useRef, useState } from 'react';
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
import type { ShelfAdvice, ShelfPreferences } from '../preferences';

const nativeRead = (cursor?: string) => readShelfTypesCurrent({ data: cursor ? { cursor } : {} });

/** One replacement owner-index page; saved scopes remain removable when discovery cannot name them. */
export function ShelfTypeDefaults({
  layouts,
  supportedLayouts,
  layoutLabel,
  globalLayout,
  savedLayouts,
  disabled,
  subject,
  isCurrent,
  onChange,
  maxLayouts = 32,
  scopeMaxLength = 256,
  readTypes = nativeRead,
}: {
  layouts: NonNullable<ShelfPreferences['layouts']>;
  supportedLayouts: ShelfAdvice['supported']['layouts'];
  layoutLabel: (layout: string) => string;
  globalLayout: ShelfLayout;
  savedLayouts: NonNullable<ShelfPreferences['layouts']>;
  disabled: boolean;
  subject: string | null;
  isCurrent: () => boolean;
  onChange: (scope: string, layout: ShelfLayout | undefined) => void;
  maxLayouts?: number;
  scopeMaxLength?: number;
  readTypes?: (cursor?: string) => Promise<ShelfTypesCurrentRead>;
}) {
  const locale = getLocale();
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState<ShelfTypesView>();
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const lifetime = useRef({ active: true, revision: 0 });
  useLayoutEffect(() => {
    const owner = lifetime.current;
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, []);
  const current = () => lifetime.current.active && isCurrent();
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
  const canSet = !!choice && selected.length <= scopeMaxLength;
  // The submitted map includes the global scope only if it was stored or deliberately changed.
  const atLimit = Object.keys(layouts).length >= maxLayouts && !override;
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
                  if (!current() || (atLimit && value)) return;
                  const layout = supportedLayouts.find((candidate) => candidate === value);
                  if (!value || layout) onChange(selected, layout);
                }}
              >
                <option value="">{m.settings_shelf_type_inherit()}</option>
                {override && !supportedLayouts.includes(override) ? (
                  <option value={override} disabled>
                    {layoutLabel(override)}
                  </option>
                ) : null}
                {supportedLayouts.map((layout) => (
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
