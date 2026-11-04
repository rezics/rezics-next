import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { EntityPicker } from '@rezics/ui/entity-picker';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import {
  ConditionEntityLookupError,
  resolveConditionEntityLabels,
  searchConditionEntities,
  type ConditionEntityContext,
  type ConditionEntityLabelResult,
} from '../condition-entity';
import type { CharacterPersonMode } from '../character-person';
import {
  CHARACTER_PERSON_WORK_LIMIT,
  editCharacterPersonSelection,
  type CharacterPersonSelection,
  type CharacterPersonSelectionMetadata,
} from './model';

type Reader = { current(): boolean; identity: string; ready: boolean };
type MessageOptions = { locale: (typeof locales)[number] };
function options(locale: string): MessageOptions {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function failureText(error: unknown, locale: string): string {
  const opts = options(locale);
  if (error instanceof ConditionEntityLookupError) {
    if (error.failure === 'restart') return m.search_suggestions_restart({}, opts);
    if (error.failure === 'credentials') return m.search_suggestions_credentials({}, opts);
    if (error.failure === 'invalid') return m.search_suggestions_invalid({}, opts);
    if (error.failure === 'preparing') return m.character_person_preparing({}, opts);
  }
  return m.search_suggestions_unavailable({}, opts);
}

type Labels = {
  key: string;
  state: 'loading' | 'ready' | 'failed';
  value?: ConditionEntityLabelResult;
  error?: unknown;
};

/** One feature operand uses the existing keyboard picker and exact-identity lookup mechanism. */
function Operand({
  kind,
  ids,
  targets,
  context,
  reader,
  onSelect,
  onRemove,
  onReady,
}: {
  kind: 'work' | 'role';
  ids: readonly string[];
  targets: readonly string[];
  context: ConditionEntityContext;
  reader: Reader;
  onSelect(id: string): void;
  onRemove(index: number): void;
  onReady(ready: boolean): void;
}) {
  const opts = options(context.locale);
  const label = kind === 'work' ? m.character_person_works({}, opts) : m.character_person_role({}, opts);
  const headingId = useId();
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([reader.identity, context, targets, ids, retry]);
  const [labels, setLabels] = useState<Labels>();
  const [failure, setFailure] = useState<unknown>();
  const available = reader.ready && context.available && targets.length > 0;
  const currentLabels = labels?.key === key && reader.current() ? labels : undefined;
  const resolved = currentLabels?.state === 'ready' && !failure ? (currentLabels.value?.labels ?? {}) : {};
  const ready =
    ids.length === 0 ||
    (available && currentLabels?.state === 'ready' && ids.every((id) => resolved[id.toLowerCase()]));

  useEffect(() => onReady(Boolean(ready)), [Boolean(ready), onReady]);
  useEffect(() => {
    setFailure(undefined);
    if (!available || !reader.current()) return;
    const controller = new AbortController();
    let active = true;
    setLabels({ key, state: 'loading' });
    void resolveConditionEntityLabels(ids, targets, context, controller.signal).then(
      (value) => {
        if (active && !controller.signal.aborted && reader.current()) setLabels({ key, state: 'ready', value });
      },
      (error) => {
        if (active && !controller.signal.aborted && reader.current()) setLabels({ key, state: 'failed', error });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, available]);

  const search = useCallback(
    async (text: string, signal: AbortSignal) => {
      if (!reader.current()) throw new DOMException('Reader retired', 'AbortError');
      setFailure(undefined);
      try {
        const candidates = await searchConditionEntities(text, targets, context, signal);
        signal.throwIfAborted();
        if (!reader.current()) throw new DOMException('Reader retired', 'AbortError');
        return candidates;
      } catch (error) {
        if (!signal.aborted && reader.current()) setFailure(error);
        throw error;
      }
    },
    [key],
  );

  const error = failure ?? currentLabels?.error;
  const unresolved = ids.length > 0 && !ready;
  const loading = available && ids.length > 0 && (!currentLabels || currentLabels.state === 'loading');
  const disabled = !available || (kind === 'work' && ids.length >= CHARACTER_PERSON_WORK_LIMIT);
  return (
    <section aria-labelledby={headingId} className="space-y-2" aria-busy={loading}>
      <h2 id={headingId} className="text-sm font-medium">
        {label}
      </h2>
      {ids.length > 0 && (
        <ul className="space-y-2">
          {ids.map((id, index) => {
            const selected = resolved[id.toLowerCase()];
            return (
              <li key={`${index}:${id}`} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <input type="hidden" name={kind} value={id} />
                <span className="min-w-0 break-words" dir="auto">
                  {selected ? (
                    <>
                      {selected.label}
                      <span className="ml-2 text-xs text-muted-foreground">{selected.type}</span>
                    </>
                  ) : (
                    <>
                      <span>{m.character_person_unresolved({}, opts)}</span>
                      <code className="ml-2 text-xs">{id}</code>
                    </>
                  )}
                </span>
                <button type="button" className="shrink-0 text-sm underline" onClick={() => onRemove(index)}>
                  {m.refinement_remove({ value: selected?.label ?? label }, opts)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <EntityPicker
        key={key}
        search={search}
        src={coverSrc}
        value={[]}
        label={label}
        placeholder={m.condition_choose_value({}, opts)}
        disabled={disabled}
        onValueChange={(values) => {
          if (reader.current() && values[0]) onSelect(values[0].id);
        }}
      />
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.character_person_resolving({}, opts)}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {failureText(error, context.locale)}
        </p>
      )}
      {unresolved && !loading && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.condition_entity_unresolved({}, opts)}
        </p>
      )}
      {(error || (unresolved && !loading)) && available && (
        <button
          type="button"
          className="text-sm underline"
          onClick={() => {
            if (reader.current()) setRetry((value) => value + 1);
          }}
        >
          {m.character_person_retry({}, opts)}
        </button>
      )}
    </section>
  );
}

export function CharacterPersonSelectionFields({
  value,
  onChange,
  mode,
  locale,
  languages,
  metadata,
  preparing,
  reader,
  retryMetadata,
  onReady,
}: {
  value: CharacterPersonSelection;
  onChange(value: CharacterPersonSelection): void;
  mode: CharacterPersonMode;
  locale: string;
  languages: readonly string[];
  metadata: CharacterPersonSelectionMetadata | undefined;
  preparing: boolean;
  reader: Reader;
  retryMetadata(): void;
  onReady(ready: boolean): void;
}) {
  const opts = options(locale);
  const [worksReady, setWorksReady] = useState(false);
  const [roleReady, setRoleReady] = useState(false);
  const valuesKey = JSON.stringify(value);
  const context = useMemo<ConditionEntityContext>(
    () => ({
      locale,
      languages,
      reader: reader.identity,
      release: metadata?.release,
      available: !!metadata && reader.ready,
    }),
    [locale, JSON.stringify(languages), reader.identity, metadata],
  );
  const current =
    worksReady &&
    roleReady &&
    value.works.length <= CHARACTER_PERSON_WORK_LIMIT &&
    (!value.role || value.works.length > 0);
  useEffect(() => {
    onReady(current);
  }, [current, valuesKey, onReady]);
  return (
    <div className="space-y-4 sm:col-span-2">
      <p className="text-sm text-muted-foreground">{m.character_person_works_help({}, opts)}</p>
      {preparing || !reader.ready ? (
        <p role="status">{m.character_person_preparing({}, opts)}</p>
      ) : !metadata ? (
        <div role="status">
          <p>{m.condition_metadata_unavailable({}, opts)}</p>
          <button className="text-sm underline" type="button" onClick={retryMetadata}>
            {m.character_person_retry({}, opts)}
          </button>
        </div>
      ) : null}
      <Operand
        kind="work"
        ids={value.works}
        targets={metadata?.workTargets ?? []}
        context={{ ...context, workContext: true }}
        reader={reader}
        onSelect={(id) => onChange(editCharacterPersonSelection(value, { kind: 'work', id }))}
        onRemove={(index) => onChange(editCharacterPersonSelection(value, { kind: 'remove-work', index }))}
        onReady={setWorksReady}
      />
      <p className="text-sm text-muted-foreground">{m.character_person_role_help({}, opts)}</p>
      <Operand
        kind="role"
        ids={value.role ? [value.role] : []}
        targets={metadata?.roleTargets[mode] ?? []}
        context={{ ...context, available: context.available && value.works.length > 0 && worksReady }}
        reader={reader}
        onSelect={(id) => onChange(editCharacterPersonSelection(value, { kind: 'role', id }))}
        onRemove={() => onChange({ ...value, role: '' })}
        onReady={setRoleReady}
      />
      {value.works.length > 0 && metadata && metadata.roleTargets[mode].length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.character_person_roles_unavailable({}, opts)}
        </p>
      )}
    </div>
  );
}
