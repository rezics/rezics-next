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
import { ShelfTypeWindowNavigation } from '../../library/shelf-type-window-navigation';
import type { ShelfAdvice, ShelfPreferences } from '../preferences';

const nativeRead = (cursor?: string) => readShelfTypesCurrent({ data: cursor ? { cursor } : {} });

/** The existing current() authority owns retirement; source/locale replacement gets a fresh local path. */
export function ShelfTypeDefaults(props: Parameters<typeof OwnerShelfTypeDefaults>[0]) {
  const locale = getLocale();
  const origin = useRef({
    subject: props.subject,
    read: props.readTypes,
    current: props.isCurrent,
    locale,
    active: true,
    key: 0,
  });
  const old = origin.current;
  if (
    old.subject !== props.subject ||
    old.read !== props.readTypes ||
    old.current !== props.isCurrent ||
    old.locale !== locale
  ) {
    old.active = false;
    origin.current = {
      subject: props.subject,
      read: props.readTypes,
      current: props.isCurrent,
      locale,
      active: true,
      key: old.key + 1,
    };
  }
  const owner = origin.current;
  if (!props.isCurrent()) {
    owner.active = false;
    return null;
  }
  return <OwnerShelfTypeDefaults key={owner.key} {...props} isCurrent={() => owner.active && props.isCurrent()} />;
}

/** One replacement owner-index page; saved scopes remain removable when discovery cannot name them. */
function OwnerShelfTypeDefaults({
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
  const navigation = useRef(new ShelfTypeWindowNavigation());
  const heading = useRef<HTMLHeadingElement>(null);
  const focus = useRef(false);
  const inFlight = useRef(false);
  const lifetime = useRef({ active: true, revision: 0 });
  useLayoutEffect(() => {
    const owner = lifetime.current;
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, []);
  const current = () => lifetime.current.active && isCurrent();
  const renderedRevision = lifetime.current.revision;
  const currentChoice = () => current() && renderedRevision === lifetime.current.revision;
  useLayoutEffect(() => {
    if (focus.current && page?.state === 'loaded' && current()) heading.current?.focus();
    focus.current = false;
  });
  async function read(movement: 'read' | 'next' | 'previous' | 'first' | 'retry' = 'read', cursor?: string) {
    if (!currentChoice() || !subject || inFlight.current) return;
    const target = navigation.current.stage(movement, cursor);
    if (!target) return;
    const next = target.cursor;
    inFlight.current = true;
    focus.current = false;
    const revision = ++lifetime.current.revision;
    const currentRequest = () => current() && lifetime.current.revision === revision;
    setBusy(true);
    setPage(undefined);

    try {
      const result = await readTypes(next);
      if (!currentRequest()) return;
      const matches =
        result.sessionSubject === subject &&
        result.authorizationAgrees &&
        result.requested.locale === locale &&
        result.requested.limit === SHELF_TYPES_LIMIT &&
        result.requested.cursor === (next ?? null);
      const admitted = matches && result.page.state === 'loaded';
      navigation.current.settle(admitted);
      focus.current = admitted && movement !== 'read';
      setPage(matches ? result.page : { state: 'unavailable' });
    } catch {
      if (currentRequest()) {
        navigation.current.settle(false);
        setPage({ state: 'unavailable' });
      }
    } finally {
      if (currentRequest()) {
        inFlight.current = false;
        setBusy(false);
      }
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
      <h3 ref={heading} tabIndex={-1} id="settings-type-layouts" className="font-medium">
        {m.settings_shelf_types_heading()}
      </h3>
      <p className="text-sm text-muted-foreground">{m.settings_shelf_types_help()}</p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 max-w-full whitespace-normal"
        disabled={!subject || busy || !currentChoice()}
        onClick={() => void read(page && page.state !== 'loaded' ? 'retry' : 'read')}
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
            disabled={!currentChoice() || busy}
            onChange={(event) => {
              if (currentChoice()) setSelected(event.currentTarget.value);
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
                disabled={disabled || !currentChoice()}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (!currentChoice() || (atLimit && value)) return;
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
              disabled={disabled || !currentChoice()}
              onClick={() => {
                if (currentChoice()) onChange(selected, undefined);
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
                if (!currentChoice()) event.preventDefault();
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
          disabled={busy || !currentChoice()}
          onClick={() => void read('next', page.next!)}
        >
          {m.library_types_next()}
        </Button>
      ) : null}
      {navigation.current.hasPrevious ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 max-w-full whitespace-normal"
          disabled={busy || !currentChoice()}
          onClick={() => void read('previous')}
        >
          {m.library_collections_previous()}
        </Button>
      ) : null}
      {navigation.current.hasFirst ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 max-w-full whitespace-normal"
          disabled={busy || !currentChoice()}
          onClick={() => void read('first')}
        >
          {m.library_types_first()}
        </Button>
      ) : null}
    </section>
  );
}
