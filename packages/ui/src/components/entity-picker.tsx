'use client';

import { createListCollection } from '@ark-ui/react/combobox';
import { XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from './button.tsx';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './combobox.tsx';
import { entityPickerMessages } from './entity-picker-messages.ts';
import {
  EntityPickerSource,
  type EntityPickerItem,
  type EntityPickerLoad,
} from './entity-picker-state.ts';
import { useLocale } from './locale.tsx';
import { uiCopyLocale } from '../i18n/copy.ts';

export type {
  EntityPickerItem,
  EntityPickerLoad,
  EntityPickerPage,
} from './entity-picker-state.ts';
export interface EntityPickerSelection<T extends EntityPickerItem = EntityPickerItem> {
  item: T;
  mode?: 'include' | 'exclude';
}
export interface EntityPickerProps<T extends EntityPickerItem> {
  label: string;
  placeholder?: string;
  load: EntityPickerLoad<T>;
  value: EntityPickerSelection<T>[];
  onValueChange: (value: EntityPickerSelection<T>[]) => void;
  multiple?: boolean;
  allowExclude?: boolean;
  disabled?: boolean;
  name?: string;
  locale?: keyof typeof entityPickerMessages;
  /** Followed or frequently used choices; shown only for an empty query. */
  suggestions?: ReactNode;
  renderItem?: (item: T) => ReactNode;
}

/** Remote choices retain selection across queries and pages; loaded counts never imply a total. */
export function EntityPicker<T extends EntityPickerItem>({
  label,
  placeholder,
  load,
  value,
  onValueChange,
  multiple = false,
  allowExclude = false,
  disabled = false,
  name,
  locale,
  suggestions,
  renderItem,
}: EntityPickerProps<T>) {
  const loadRef = useRef(load);
  loadRef.current = load;
  // Inline loaders change identity on parent renders; keep traversal state for this mount.
  const [source] = useState(() => new EntityPickerSource<T>((query) => loadRef.current(query)));
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const composing = useRef(false);
  const contextLocale = useLocale().locale;
  const t = entityPickerMessages[locale ?? uiCopyLocale(contextLocale)];
  useEffect(() => {
    void source.search('');
    return source.cancel;
  }, [source]);
  // Cached chips must not become invisible keyboard options in a different query.
  const collection = useMemo(() => createListCollection({ items: state.items }), [state.items]);
  const text = (pattern: string, item: T) => pattern.replace('{label}', item.label);
  return (
    <div className="grid min-w-0 gap-2" data-slot="entity-picker">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {value.map((selection) => (
            <span
              key={selection.item.value}
              className="inline-flex max-w-full items-center gap-1 rounded-xl border border-border bg-accent px-2 py-1 text-sm"
            >
              {allowExclude ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={text(
                    selection.mode === 'exclude' ? t.include : t.exclude,
                    selection.item,
                  )}
                  aria-pressed={selection.mode === 'exclude'}
                  onClick={() =>
                    onValueChange(
                      value.map((entry) =>
                        entry.item.value === selection.item.value
                          ? { ...entry, mode: entry.mode === 'exclude' ? 'include' : 'exclude' }
                          : entry,
                      ),
                    )
                  }
                >
                  {selection.mode === 'exclude' ? '−' : '+'}
                </Button>
              ) : null}
              <span className="min-w-0 truncate">{selection.item.label}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={text(t.remove, selection.item)}
                disabled={disabled}
                onClick={() =>
                  onValueChange(value.filter((entry) => entry.item.value !== selection.item.value))
                }
              >
                <XIcon aria-hidden="true" />
              </Button>
              {name ? (
                <input type="hidden" name={name} value={selection.item.value} disabled={disabled} />
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <Combobox
        collection={collection}
        multiple={multiple}
        disabled={disabled}
        value={value.map((entry) => entry.item.value)}
        inputBehavior="none"
        selectionBehavior="clear"
        onInputValueChange={({ inputValue }) => {
          if (!composing.current) void source.search(inputValue);
        }}
        onValueChange={({ value: selected }) =>
          onValueChange(
            selected.flatMap((id) => {
              const previous = value.find((entry) => entry.item.value === id);
              const item = collection.find(id);
              return previous ? [previous] : item ? [{ item, mode: 'include' as const }] : [];
            }),
          )
        }
      >
        <ComboboxInput
          aria-label={label}
          placeholder={placeholder}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            void source.search(event.currentTarget.value);
          }}
          onKeyDownCapture={(event) => {
            if (event.nativeEvent.isComposing || composing.current) event.stopPropagation();
          }}
        />
        <ComboboxContent
          aria-label={label}
          className="max-w-[calc(100vw-2rem)]"
          style={{ overflow: 'hidden' }}
        >
          {!state.q ? suggestions : null}
          <ComboboxList
            aria-label={label}
            tabIndex={state.items.length ? 0 : -1}
            className="max-h-64 overflow-y-auto overscroll-contain"
            onScroll={(event) => {
              const element = event.currentTarget;
              if (element.scrollHeight - element.scrollTop - element.clientHeight < 48)
                void source.more();
            }}
          >
            {state.items.map((item) => (
              <ComboboxItem key={item.value} item={item}>
                {renderItem ? (
                  renderItem(item)
                ) : (
                  <span className="grid min-w-0">
                    <span className="truncate">{item.label}</span>
                    {item.description ? (
                      <span className="text-muted-foreground text-xs">{item.description}</span>
                    ) : null}
                  </span>
                )}
              </ComboboxItem>
            ))}
          </ComboboxList>
          <div className="grid gap-2 px-3 py-2 text-muted-foreground text-sm" aria-live="polite">
            {state.loading ? <p role="status">{t.loading}</p> : null}
            {state.error ? (
              <>
                <p role="alert">{t.failed}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void source.retry()}
                >
                  {t.retry}
                </Button>
              </>
            ) : null}
            {!state.loading && !state.error && !state.items.length && state.complete ? (
              <p>{t.empty}</p>
            ) : null}
            {!state.error && (!state.loading || state.items.length > 0) ? (
              <p>
                {(state.complete ? t.count : t.atLeast).replace(
                  '{count}',
                  String(state.items.length),
                )}
              </p>
            ) : null}
            {!state.complete && state.nextCursor ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={state.loading || state.error}
                onClick={() => void source.more()}
              >
                {t.more}
              </Button>
            ) : null}
          </div>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
