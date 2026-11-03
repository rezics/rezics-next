import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FilterDocument } from '@rezics/filter';
import { collectionFacetRequest, loadCollectionFacetValues, type CollectionFacetLoader } from '../collection-facet-values';
import { RuleEditLink } from '../saved-query-results';
import { useCollectionOwnerCurrent } from '../collection-owner-current';
import { requestLanguages } from '../../kernel/languages';
import { operationIsAdmitted } from '../../kernel/exposure';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import {
  disclosedValueLabel,
  savedFilterFacetBatches,
  savedFilterFacetType,
  savedFilterReviewTree,
  type CurrentFieldState,
  type ReviewTree,
} from './model';
import { readSavedFilterReview, type SavedFilterReviewPage } from './read';

export type SavedFilterReviewScope = {
  id: string;
  title: string;
  ownerId: string;
  viewerId: string;
};

type ReviewAuthority = {
  subject: string | null;
  admitted: readonly string[];
  generation: number;
  lifetime: string;
  isOwnerCurrent: () => boolean;
};

type ReviewContext = { scope: SavedFilterReviewScope; authority: ReviewAuthority };
const SavedFilterReviewContext = createContext<ReviewContext | null>(null);

export function useSavedFilterReviewContext() {
  return useContext(SavedFilterReviewContext);
}

/** The private review boundary is mounted only for an ordinary saved Collection's displayed owner. */
export function SavedFilterReviewScopeBoundary({
  scope,
  children,
}: {
  scope: SavedFilterReviewScope | null;
  children: ReactNode;
}) {
  if (!scope) return children;
  return <CurrentSavedFilterReviewScope scope={scope}>{children}</CurrentSavedFilterReviewScope>;
}

function CurrentSavedFilterReviewScope({ scope, children }: { scope: SavedFilterReviewScope; children: ReactNode }) {
  const authority = useCollectionOwnerCurrent(JSON.stringify(['saved-filter-review', scope.id]), true);
  return <SavedFilterReviewContext.Provider value={{ scope, authority }}>{children}</SavedFilterReviewContext.Provider>;
}

/** Rendered by the existing Collection filter-address feedback, keeping review beside applied route filters. */
export function SavedFilterReviewEntry() {
  const context = useSavedFilterReviewContext();
  return context ? <SavedFilterReviewPanel scope={context.scope} authority={context.authority} /> : null;
}

type ReviewPanelProps = {
  scope: SavedFilterReviewScope;
  authority: ReviewAuthority;
  read?: (id: string) => Promise<SavedFilterReviewPage>;
  readValues?: CollectionFacetLoader;
};

type PanelState =
  | { phase: 'closed'; binding: string; returned?: boolean }
  | { phase: 'reading'; binding: string }
  | { phase: 'denied' | 'unavailable'; binding: string }
  | { phase: 'ready'; binding: string; page: Extract<SavedFilterReviewPage, { state: 'ready' }> };

type ValueState =
  | { phase: 'idle'; binding: string; labels: Record<string, Record<string, Record<string, string>>> }
  | { phase: 'loading'; binding: string; labels: Record<string, Record<string, Record<string, string>>> }
  | {
      phase: 'ready' | 'unavailable' | 'preparing' | 'refused' | 'restart' | 'no-scope';
      binding: string;
      labels: Record<string, Record<string, Record<string, string>>>;
      partial?: boolean;
    };

const emptyLabels = () => ({}) as Record<string, Record<string, Record<string, string>>>;
const reviewButtonClass =
  'inline-flex min-h-11 min-w-0 max-w-full items-center justify-center break-words rounded-lg border border-border px-4 py-2 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

/** Kept injectable so focused stories can exercise refusal and retired-reader outcomes without a fake native result. */
export function SavedFilterReviewPanel({
  scope,
  authority,
  read = (id) => readSavedFilterReview({ data: id }),
  readValues = loadCollectionFacetValues,
}: ReviewPanelProps) {
  const locale = getLocale();
  const binding = JSON.stringify([
    scope.id,
    scope.ownerId,
    scope.viewerId,
    authority.generation,
    authority.lifetime,
    locale,
  ]);
  const bindingRef = useRef(binding);
  const scopeRef = useRef(scope);
  const authorityRef = useRef(authority);
  bindingRef.current = binding;
  scopeRef.current = scope;
  authorityRef.current = authority;
  const readSequence = useRef(0);
  const valueSequence = useRef(0);
  const [state, setState] = useState<PanelState>({ phase: 'closed', binding: '' });
  const [values, setValues] = useState<ValueState>({ phase: 'idle', binding: '', labels: emptyLabels() });
  const shown = state.binding === binding ? state : ({ phase: 'closed', binding } as const);
  const shownValues = values.binding === binding ? values : ({ phase: 'idle', binding, labels: emptyLabels() } as const);
  const authorized =
    scope.viewerId === scope.ownerId &&
    authority.subject === scope.viewerId &&
    operationIsAdmitted('collection.get', authority.admitted) &&
    authority.isOwnerCurrent();
  const expanded = shown.phase !== 'closed';
  const panelId = 'saved-filter-review-' + scope.id.replace(/[^a-zA-Z0-9_-]/g, '-');

  useLayoutEffect(() => {
    readSequence.current += 1;
    valueSequence.current += 1;
    setState({ phase: 'closed', binding });
    setValues({ phase: 'idle', binding, labels: emptyLabels() });
  }, [binding]);
  useLayoutEffect(
    () => () => {
      readSequence.current += 1;
      valueSequence.current += 1;
    },
    [],
  );

  function isCurrent(sequence: number, kind: 'read' | 'values', expectedBinding: string): boolean {
    return (
      bindingRef.current === expectedBinding &&
      (kind === 'read' ? readSequence.current : valueSequence.current) === sequence &&
      authorityRef.current.subject === scopeRef.current.viewerId &&
      operationIsAdmitted('collection.get', authorityRef.current.admitted) &&
      authorityRef.current.isOwnerCurrent()
    );
  }

  async function openReview() {
    if (!authorized) return;
    const sequence = ++readSequence.current;
    valueSequence.current += 1;
    setValues({ phase: 'idle', binding, labels: emptyLabels() });
    setState({ phase: 'reading', binding });
    try {
      const result = await read(scope.id);
      if (!isCurrent(sequence, 'read', binding)) return;
      if (result.state !== 'ready') {
        setState({ phase: result.state, binding });
        return;
      }
      if (result.id !== scope.id || result.viewerId !== scope.viewerId) {
        setState({ phase: 'denied', binding });
        return;
      }
      setState({ phase: 'ready', binding, page: result });
    } catch {
      if (isCurrent(sequence, 'read', binding)) setState({ phase: 'unavailable', binding });
    }
  }

  function returnUnchanged() {
    readSequence.current += 1;
    valueSequence.current += 1;
    setValues({ phase: 'idle', binding, labels: emptyLabels() });
    setState({ phase: 'closed', binding, returned: true });
  }

  async function loadValues(page: Extract<SavedFilterReviewPage, { state: 'ready' }>) {
    if (!authorized) return;
    const sequence = ++valueSequence.current;
    const labels = emptyLabels();
    setValues({ phase: 'loading', binding, labels });
    const type = savedFilterFacetType(page.rule.filter, page.accepted.metadata);
    const batches = savedFilterFacetBatches(page.rule.filter, page.accepted.metadata, page.current);
    if (!type || !page.current.digest || !batches.length) {
      if (isCurrent(sequence, 'values', binding)) setValues({ phase: 'no-scope', binding, labels });
      return;
    }

    let succeeded = 0;
    let failure: 'unavailable' | 'preparing' | 'refused' | 'restart' | undefined;
    try {
      for (const batch of batches) {
        const request = collectionFacetRequest(
          {
            resource: { kind: 'collection', id: page.id },
            type,
            release: page.current.digest,
            languages: requestLanguages(locale),
          },
          batch.map((property) => ({ property, size: 20 })),
        );
        const result = await readValues(request, new AbortController().signal);
        if (!isCurrent(sequence, 'values', binding)) return;
        if (result.status !== 'ready') {
          failure ??= result.status;
          continue;
        }
        succeeded += 1;
        for (const facet of result.page.facets)
          for (const value of facet.values) labels[facet.property] = { ...labels[facet.property], [value.value]: value.labels };
      }
      if (!isCurrent(sequence, 'values', binding)) return;
      if (failure) setValues({ phase: failure, binding, labels, ...(succeeded ? { partial: true } : {}) });
      else setValues({ phase: 'ready', binding, labels });
    } catch {
      if (isCurrent(sequence, 'values', binding))
        setValues({ phase: 'unavailable', binding, labels, ...(succeeded ? { partial: true } : {}) });
    }
  }

  if (scope.viewerId !== scope.ownerId) return null;
  if (!authorized)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {m.saved_filter_review_denied()}
      </p>
    );

  return (
    <div className="min-w-0 space-y-3 break-words">
      <button
        type="button"
        className={reviewButtonClass}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        disabled={!authorized || shown.phase === 'reading'}
        onClick={() => (expanded ? returnUnchanged() : void openReview())}
      >
        {expanded ? m.saved_filter_review_return() : m.saved_filter_review_open()}
      </button>
      {shown.phase === 'closed' ? (
        shown.returned ? <p role="status">{m.saved_filter_review_returned()}</p> : null
      ) : (
        <section id={panelId} aria-labelledby={panelId + '-heading'} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <h2 id={panelId + '-heading'} className="text-lg font-semibold">{m.saved_filter_review_heading()}</h2>
              <p className="max-w-prose text-sm text-muted-foreground">{m.saved_filter_review_intro()}</p>
            </div>
            <button type="button" className={reviewButtonClass} onClick={returnUnchanged}>
              {m.saved_filter_review_return()}
            </button>
          </div>
          {shown.phase === 'reading' ? <p role="status">{m.saved_filter_review_loading()}</p> : null}
          {shown.phase === 'denied' ? (
            <div role="alert" className="space-y-2">
              <p>{m.saved_filter_review_denied()}</p>
              <button type="button" className={reviewButtonClass} onClick={() => void openReview()}>{m.saved_filter_review_retry()}</button>
            </div>
          ) : null}
          {shown.phase === 'unavailable' ? (
            <div role="alert" className="space-y-2">
              <p>{m.saved_filter_review_unavailable()}</p>
              <button type="button" className={reviewButtonClass} onClick={() => void openReview()}>{m.saved_filter_review_retry()}</button>
            </div>
          ) : null}
          {shown.phase === 'ready' ? (
            <ReviewContent
              page={shown.page}
              labels={shownValues.labels}
              values={shownValues}
              onReadValues={() => void loadValues(shown.page)}
              onRefresh={() => void openReview()}
            />
          ) : null}
        </section>
      )}
    </div>
  );
}

function ReviewContent({
  page,
  labels,
  values,
  onReadValues,
  onRefresh,
}: {
  page: Extract<SavedFilterReviewPage, { state: 'ready' }>;
  labels: Record<string, Record<string, Record<string, string>>>;
  values: ValueState;
  onReadValues: () => void;
  onRefresh: () => void;
}) {
  const locale = getLocale();
  const tree = savedFilterReviewTree(page.rule.filter, page.accepted, page.current, locale);
  const valueType = savedFilterFacetType(page.rule.filter, page.accepted.metadata);
  const valueButtonLabel = values.phase === 'idle' || values.phase === 'no-scope'
    ? m.saved_filter_review_value_labels()
    : m.saved_filter_review_value_labels_retry();
  return (
    <div className="min-w-0 space-y-4">
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
        <div className="min-w-0"><dt className="text-sm font-medium">{m.saved_filter_review_accepted_release()}</dt><dd className="break-all"><code>{page.rule.releaseDigest}</code></dd></div>
        {page.current.digest ? <div className="min-w-0"><dt className="text-sm font-medium">{m.saved_filter_review_current_release()}</dt><dd className="break-all"><code>{page.current.digest}</code></dd></div> : null}
      </dl>
      {page.accepted.state !== 'ready' ? (
        <div role="status" className="space-y-2">
          <p>{m.saved_filter_review_accepted_unavailable()}</p>
          <button type="button" className={reviewButtonClass} onClick={onRefresh}>{m.saved_filter_review_retry()}</button>
        </div>
      ) : null}
      {page.current.state !== 'ready' ? <p role="status">{m.saved_filter_review_current_unavailable()}</p> : null}
      <div className="min-w-0 space-y-3">
        <h3 className="font-semibold">{m.saved_filter_review_operands()}</h3>
        <ul className="min-w-0 space-y-3">{renderReviewTree(tree, labels, locale)}</ul>
      </div>
      <details className="min-w-0">
        <summary className="cursor-pointer py-2 underline underline-offset-4 focus-visible:outline-2">{m.saved_filter_review_exact()}</summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify(page.rule.filter, null, 2)}</pre>
      </details>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{m.saved_filter_review_value_help()}</p>
        {!valueType ? <p role="status">{m.saved_filter_review_value_labels_no_scope()}</p> : null}
        <button
          type="button"
          className={reviewButtonClass}
          disabled={values.phase === 'loading' || !valueType || page.current.state !== 'ready'}
          onClick={onReadValues}
        >
          {values.phase === 'loading' ? m.saved_filter_review_value_labels_loading() : valueButtonLabel}
        </button>
        <ValueStatus values={values} />
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-sm text-muted-foreground">{m.saved_filter_review_edit_help()}</p>
        <RuleEditLink
          collection={{ id: page.id, curatorAccountId: page.viewerId, membershipKind: 'dynamic' }}
          viewerId={page.viewerId}
          allowed
        />
      </div>
    </div>
  );
}

function renderReviewTree(
  node: ReviewTree,
  labels: Record<string, Record<string, Record<string, string>>>,
  locale: string,
): ReactNode {
  if (node.kind === 'group') {
    const groupLabel =
      node.operator === 'and'
        ? m.saved_filter_review_group_and()
        : node.operator === 'or'
          ? m.saved_filter_review_group_or()
          : node.operator === 'not'
            ? m.saved_filter_review_group_not()
            : m.saved_filter_review_group_saved();
    return (
      <li key={node.path || 'root'} className="min-w-0 rounded-lg border border-border p-3">
        <p className="mb-2 font-medium">{groupLabel}{node.reference ? <>: <code>{node.reference}</code></> : null}</p>
        <ul className="min-w-0 space-y-2">{node.children.map((child) => renderReviewTree(child, labels, locale))}</ul>
      </li>
    );
  }
  const value = node.value;
  const roleLabel =
    value.role === 'type'
      ? m.saved_filter_review_type()
      : value.role === 'owner'
        ? m.saved_filter_review_owner()
        : value.role === 'saved'
          ? m.saved_filter_review_group_saved()
          : m.saved_filter_review_property();
  return (
    <li key={value.path || 'root'} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium">{roleLabel}</span>
        {value.fieldId ? <code className="break-all">{value.fieldId}</code> : null}
        <code>{value.operation}</code>
      </div>
      {value.acceptedLabel ? <p>{m.saved_filter_review_accepted_label()} {value.acceptedLabel}</p> : null}
      {value.currentLabel ? <p>{m.saved_filter_review_current_label()} {value.currentLabel}</p> : null}
      <CurrentFieldStatus state={value.currentState} />
      {value.values?.length ? (
        <ul className="min-w-0 space-y-1">
          {value.values.map((entry, index) => {
            const currentLabel = value.fieldId && value.role === 'property'
              ? disclosedValueLabel(labels, value.fieldId, entry.exact, locale)
              : entry.currentTypeLabel;
            return (
              <li key={value.path + '-value-' + index} className="min-w-0 break-words">
                {entry.acceptedLabel ? <span>{m.saved_filter_review_accepted_label()} {entry.acceptedLabel} </span> : null}
                {currentLabel ? <span>{m.saved_filter_review_current_label()} {currentLabel} </span> : null}
                {!currentLabel && value.role === 'property' ? <span>{m.saved_filter_review_value_unlabelled()} </span> : null}
                <code className="break-all">{entry.exact}</code>
              </li>
            );
          })}
        </ul>
      ) : null}
      {value.range ? <p>{m.saved_filter_review_range()} <code>{JSON.stringify(value.range)}</code></p> : null}
      {value.qualifiers?.length ? (
        <ul className="min-w-0 space-y-2 border-l-2 border-border pl-3">
          {value.qualifiers.map((qualifier, index) => (
            <li key={value.path + '-qualifier-' + index} className="min-w-0 break-words">
              <p>{m.saved_filter_review_qualifier()} <code>{qualifier.property}</code></p>
              {qualifier.acceptedLabel ? <p>{m.saved_filter_review_accepted_label()} {qualifier.acceptedLabel}</p> : null}
              {qualifier.currentLabel ? <p>{m.saved_filter_review_current_label()} {qualifier.currentLabel}</p> : null}
              <CurrentFieldStatus state={qualifier.currentState} />
              <ul className="min-w-0 space-y-1">
                {qualifier.values.map((entry, valueIndex) => (
                  <li key={value.path + '-qualifier-value-' + index + '-' + valueIndex}>
                    <span>{m.saved_filter_review_value_unlabelled()} </span><code className="break-all">{entry.exact}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {value.exact ? <pre className="whitespace-pre-wrap break-all text-xs">{value.exact}</pre> : null}
    </li>
  );
}

function CurrentFieldStatus({ state }: { state: CurrentFieldState }) {
  if (state === 'removed') return <p role="status">{m.saved_filter_review_field_removed()}</p>;
  if (state === 'missing-label') return <p role="status">{m.saved_filter_review_label_missing()}</p>;
  if (state === 'changed') return <p role="status">{m.saved_filter_review_definition_changed()}</p>;
  if (state === 'unavailable') return <p role="status">{m.saved_filter_review_current_unavailable()}</p>;
  return null;
}

function ValueStatus({ values }: { values: ValueState }) {
  if (values.phase === 'loading' || values.phase === 'idle') return null;
  if (values.phase === 'ready') return <p role="status">{m.saved_filter_review_value_labels_ready()}</p>;
  if (values.phase === 'no-scope') return <p role="status">{m.saved_filter_review_value_labels_no_scope()}</p>;
  if (values.phase === 'refused') return <p role="alert">{m.saved_filter_review_value_labels_refused()}</p>;
  if (values.phase === 'preparing') return <p role="status">{m.saved_filter_review_value_labels_preparing()}</p>;
  if (values.phase === 'restart') return <p role="alert">{m.saved_filter_review_value_labels_restart()}</p>;
  return <p role="alert">{m.saved_filter_review_value_labels_unavailable()}</p>;
}
