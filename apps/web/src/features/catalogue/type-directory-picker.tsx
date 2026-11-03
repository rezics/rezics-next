import { useEffect, useRef, useState } from 'react';
import type { CreateType, TypeDirectoryQuery, TypeDirectoryTransport } from './create-subject';
import { Button } from '@rezics/ui/shadcn/button';
import { FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { DefinitionMeaning } from './definition-meaning';

export function TypeDirectoryPicker({
  locale,
  transport,
  selected,
  disabled,
  invalid,
  describedBy,
  refreshToken,
  onSelectionChange,
  onPendingChange,
  onDescriptorState,
  offered,
  unavailable,
  admitType,
}: {
  locale: string;
  transport: TypeDirectoryTransport;
  selected: CreateType | null;
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
  refreshToken: number;
  onSelectionChange: (type: CreateType | null) => void;
  onPendingChange: (pending: boolean) => void;
  onDescriptorState?: (
    typeId: string,
    state: 'reading' | 'current' | 'missing' | 'unavailable' | 'unadmitted',
  ) => void;
  offered?: readonly CreateType[];
  unavailable?: readonly string[];
  admitType?: (type: CreateType) => boolean;
}) {
  const options = { locale: locale as never };
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'prefix' | 'id'>('prefix');
  const [activeSearch, setActiveSearch] = useState<TypeDirectoryQuery | null>(null);
  const [results, setResults] = useState<CreateType[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'stale'>('idle');
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const [selectionError, setSelectionError] = useState<'missing' | 'unavailable' | 'unadmitted' | null>(null);
  const [retryTypeId, setRetryTypeId] = useState<string>();
  const pageRequest = useRef(0);
  const selectionRequest = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  async function loadPage(binding: TypeDirectoryQuery, cursor: string | null, replace: boolean) {
    const request = ++pageRequest.current;
    setSearchState('loading');
    setFailedCursor(null);
    try {
      const result = await transport.page({ ...binding, ...(cursor === null ? {} : { cursor }) });
      if (request !== pageRequest.current) return;
      if (!result.ok) {
        setNext(null);
        setSearchState(result.reason === 'stale' ? 'stale' : 'failed');
        setFailedCursor(result.reason === 'unavailable' ? cursor : null);
        return;
      }
      setResults((current) => (replace ? result.types : [...current, ...result.types]));
      setNext(result.next);
      setSearchState('ready');
    } catch {
      if (request !== pageRequest.current) return;
      setSearchState('failed');
      setFailedCursor(cursor);
    }
  }

  function runSearch() {
    const binding = mode === 'id' ? { typeId: query } : { query };
    setActiveSearch(binding);
    setResults([]);
    setNext(null);
    if (mode === 'id' && query.length === 0) {
      pageRequest.current++;
      setFailedCursor(null);
      setSearchState('ready');
      return;
    }
    void loadPage(binding, null, true);
  }

  function invalidateSearch() {
    pageRequest.current++;
    setActiveSearch(null);
    setResults([]);
    setNext(null);
    setFailedCursor(null);
    setSearchState('idle');
  }

  async function readDescriptor(typeId: string, clearSelection: boolean) {
    const request = ++selectionRequest.current;
    setSelectionPending(true);
    setSelectionError(null);
    setRetryTypeId(typeId);
    onPendingChange(true);
    onDescriptorState?.(typeId, 'reading');
    if (clearSelection) onSelectionChange(null);
    try {
      const result = await transport.descriptor(typeId);
      if (request !== selectionRequest.current) return;
      if (result.ok) {
        if (admitType && !admitType(result.type)) {
          if (clearSelection) onSelectionChange(null);
          setSelectionError('unadmitted');
          onDescriptorState?.(typeId, 'unadmitted');
        } else {
          onSelectionChange(result.type);
          setRetryTypeId(undefined);
          setSelectionError(null);
          onDescriptorState?.(typeId, 'current');
        }
      } else {
        if (clearSelection) onSelectionChange(null);
        setSelectionError(result.reason);
        onDescriptorState?.(typeId, result.reason);
      }
    } catch {
      if (request !== selectionRequest.current) return;
      if (clearSelection) onSelectionChange(null);
      setSelectionError('unavailable');
      onDescriptorState?.(typeId, 'unavailable');
    } finally {
      if (request === selectionRequest.current) {
        setSelectionPending(false);
        onPendingChange(false);
      }
    }
  }

  useEffect(() => {
    if (!refreshToken || !selectedRef.current) return;
    void readDescriptor(selectedRef.current.id, false);
  }, [refreshToken]);

  const currentBinding = activeSearch;
  return (
    <div className="min-w-0 space-y-3">
      {!!offered?.length && (
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">{m.related_work_offered_types({}, options)}</p>
          <ul className="min-w-0 space-y-2">
            {offered.map((type) => (
              <li key={type.id} className="min-w-0">
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || selectionPending}
                  onClick={() => void readDescriptor(type.id, false)}
                >
                  <span lang={type.labelLanguage ?? locale}>{type.label || type.id}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!unavailable?.length && (
        <ul className="min-w-0 space-y-1 text-sm text-muted-foreground">
          {unavailable.map((type) => (
            <li key={type}>{m.related_work_type_unavailable({ type }, options)}</li>
          ))}
        </ul>
      )}
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <FieldLabel htmlFor="create-type-query">{m.catalogue_create_type_search({}, options)}</FieldLabel>
          <Input
            id="create-type-query"
            value={query}
            maxLength={mode === 'prefix' ? 512 : 4_194_304}
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => {
              setQuery(event.target.value);
              invalidateSearch();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runSearch();
              }
            }}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <FieldLabel htmlFor="create-type-search-mode">{m.catalogue_create_type_search_mode({}, options)}</FieldLabel>
          <NativeSelect
            id="create-type-search-mode"
            value={mode}
            disabled={disabled}
            onChange={(event) => {
              setMode(event.target.value as 'prefix' | 'id');
              invalidateSearch();
            }}
          >
            <NativeSelectOption value="prefix">{m.catalogue_create_type_prefix({}, options)}</NativeSelectOption>
            <NativeSelectOption value="id">{m.catalogue_create_type_exact_id({}, options)}</NativeSelectOption>
          </NativeSelect>
        </div>
        <Button type="button" variant="outline" disabled={disabled} onClick={runSearch}>
          {m.catalogue_create_type_search_action({}, options)}
        </Button>
      </div>

      {selectionPending && <p role="status">{m.catalogue_create_type_reading({}, options)}</p>}
      {selectionError && (
        <div role="alert" className="space-y-2">
          <p>
            {selectionError === 'missing'
              ? m.catalogue_create_type_retired({}, options)
              : selectionError === 'unadmitted'
                ? m.related_work_type_unadmitted({}, options)
                : m.catalogue_create_type_read_failed({}, options)}
          </p>
          {selectionError === 'unavailable' && retryTypeId && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || selectionPending}
              onClick={() => void readDescriptor(retryTypeId, false)}
            >
              {m.catalogue_create_retry({}, options)}
            </Button>
          )}
        </div>
      )}

      {searchState === 'loading' && <p role="status">{m.catalogue_create_type_searching({}, options)}</p>}
      {searchState === 'failed' && (
        <div role="alert" className="space-y-2">
          <p>{m.catalogue_create_type_search_failed({}, options)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              if (currentBinding) void loadPage(currentBinding, failedCursor, failedCursor === null);
            }}
          >
            {m.catalogue_create_retry({}, options)}
          </Button>
        </div>
      )}
      {searchState === 'stale' && (
        <div role="alert" className="space-y-2">
          <p>{m.catalogue_create_type_search_changed({}, options)}</p>
          <Button type="button" variant="outline" disabled={disabled} onClick={runSearch}>
            {m.catalogue_create_type_search_action({}, options)}
          </Button>
        </div>
      )}
      {searchState === 'ready' && results.length === 0 && (
        <p role="status">{m.catalogue_create_type_no_matches({}, options)}</p>
      )}
      {results.length > 0 && (
        <ul className="min-w-0 space-y-3" aria-label={m.catalogue_create_type_results({}, options)}>
          {results.map((result) => (
            <li key={result.id} className="min-w-0 rounded-lg border border-border p-3">
              <p lang={result.labelLanguage ?? locale} className="font-medium">
                {result.label || m.catalogue_creation_type_unlabelled({}, options)}
              </p>
              <code className="break-all text-xs">{result.id}</code>
              {result.description && (
                <DefinitionMeaning text={result.description} language={result.descriptionLanguage} locale={locale} />
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={disabled || selectionPending}
                aria-label={`${m.catalogue_create_type_select({}, options)} ${result.label || result.id}`}
                onClick={() => void readDescriptor(result.id, false)}
              >
                {m.catalogue_create_type_select({}, options)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {searchState === 'ready' && next && currentBinding && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => void loadPage(currentBinding, next, false)}
        >
          {m.catalogue_create_type_next({}, options)}
        </Button>
      )}
    </div>
  );
}
