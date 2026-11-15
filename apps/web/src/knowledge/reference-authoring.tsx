import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import * as SharedSelect from '@rezics/ui/shadcn/select';
import {
  parseReferenceTarget,
  referenceBlocks,
  referenceIssues,
  referenceLabel,
  referenceLimit,
  referenceRoles,
  removeReference,
  repairReference,
  writeReference,
  type KnowledgeReference,
  type ReferenceDraft,
} from './reference-model';
import { referenceCopy } from './reference-copy';
import { KnowledgeReferenceList, ReferenceIdentity, referenceControl, referenceInput } from './reference-view';
import type { ReferenceInspector } from './reference-read';

type Entry = {
  id: string;
  role: KnowledgeReference['role'];
  kind: 'subject' | 'document' | 'revision' | 'unavailable';
  subjectId: string;
  documentId: string;
  revisionId: string;
  sha256: string;
  blockId: string;
  sourceBlockId: string;
  label: string;
};
function entry(reference: KnowledgeReference, draft: ReferenceDraft): Entry {
  const target = reference.target;
  return {
    id: reference.id,
    role: reference.role,
    kind: target?.kind ?? 'unavailable',
    subjectId: target?.kind === 'subject' ? target.subjectId : '',
    documentId: target && target.kind !== 'subject' ? target.documentId : '',
    revisionId: target?.kind === 'revision' ? target.revisionId : '',
    sha256: target?.kind === 'revision' ? target.sha256 : '',
    blockId: target?.kind === 'revision' ? (target.blockId ?? '') : '',
    sourceBlockId: reference.sourceBlockId ?? '',
    label: referenceLabel(draft.body, reference.id),
  };
}

/** Knowledge's manifest and opaque component need a domain editor; shadcn supplies its controls. */
export function KnowledgeReferenceAuthoring({
  draft,
  locale,
  disabled,
  onChange,
  inspect,
  onEditingChange,
}: {
  draft: ReferenceDraft;
  locale: string;
  disabled: boolean;
  onChange: (draft: ReferenceDraft) => void;
  inspect?: ReferenceInspector | undefined;
  onEditingChange: (editing: boolean) => void;
}) {
  const copy = referenceCopy(locale);
  const heading = useId();
  const fields = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const entryInputRef = useRef<HTMLInputElement>(null);
  const entryKindRef = useRef<HTMLButtonElement>(null);
  const sourceBlockRef = useRef<HTMLButtonElement>(null);
  const entryLegendRef = useRef<HTMLLegendElement>(null);
  const repairHeadingRef = useRef<HTMLHeadingElement>(null);
  const editActions = useRef(new Map<string, HTMLButtonElement>());
  const originAction = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<{ token: number; frame: number } | null>(null);
  const focusToken = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [editing, setEditing] = useState<Entry | null>(null);
  const [invalid, setInvalid] = useState(false);
  const issues = referenceIssues(draft);
  const blocks = referenceBlocks(draft.body);
  const cancelFocusRequest = useCallback(() => {
    if (pendingFocus.current) cancelAnimationFrame(pendingFocus.current.frame);
    pendingFocus.current = null;
    focusToken.current++;
  }, []);
  function focusable(target: HTMLElement | null): target is HTMLElement {
    return !!target?.isConnected &&
      target.getClientRects().length > 0 &&
      !target.hasAttribute('hidden') &&
      target.getAttribute('aria-disabled') !== 'true' &&
      !target.matches(':disabled');
  }
  function requestFocus(resolve: () => HTMLElement | null) {
    cancelFocusRequest();
    if (disabledRef.current) return;
    const token = ++focusToken.current;
    const frame = requestAnimationFrame(() => {
      if (pendingFocus.current?.token !== token) return;
      pendingFocus.current = null;
      const target = resolve();
      if (!disabledRef.current && focusable(target)) target.focus();
    });
    pendingFocus.current = { token, frame };
  }
  useEffect(() => {
    const onWindowBlur = () => cancelFocusRequest();
    const onPointerDown = () => cancelFocusRequest();
    const onKeyDown = () => cancelFocusRequest();
    const onFocusIn = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== document.documentElement) cancelFocusRequest();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') cancelFocusRequest();
    };
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      cancelFocusRequest();
    };
  }, [cancelFocusRequest]);
  useEffect(() => {
    if (disabled) cancelFocusRequest();
  }, [cancelFocusRequest, disabled]);
  function orientEntry() {
    requestFocus(() => entryInputRef.current ?? entryKindRef.current ?? entryLegendRef.current);
  }
  function returnFocusTarget(origin: HTMLElement | null) {
    if (focusable(origin)) return origin;
    const add = addRef.current;
    if (focusable(add)) return add;
    return headingRef.current;
  }
  function finishEntry(event: MouseEvent<HTMLButtonElement>) {
    const origin = originAction.current;
    originAction.current = null;
    setEditing(null);
    onEditingChange(false);
    setInvalid(false);
    if (event.detail === 0) requestFocus(() => returnFocusTarget(origin));
    else cancelFocusRequest();
  }
  function beginAdd(event: MouseEvent<HTMLButtonElement>) {
    originAction.current = event.currentTarget;
    onEditingChange(true);
    setInvalid(false);
    setEditing({ ...entry({ id: crypto.randomUUID(), role: 'cites', target: null }, draft), kind: 'subject' });
    if (event.detail === 0) orientEntry();
    else cancelFocusRequest();
  }
  function beginEdit(event: MouseEvent<HTMLButtonElement>, reference: KnowledgeReference) {
    originAction.current = event.currentTarget;
    onEditingChange(true);
    setInvalid(false);
    setEditing(entry(reference, draft));
    if (event.detail === 0) orientEntry();
    else cancelFocusRequest();
  }
  function field(name: keyof Entry, title: string, maxLength = 256) {
    return (
      <label className="block min-w-0 space-y-2" htmlFor={`${fields}-${name}`}>
        <span className="block text-sm font-medium">{title}</span>
        <Input
          id={`${fields}-${name}`}
          ref={name === 'subjectId' || name === 'documentId' ? entryInputRef : undefined}
          className={referenceInput}
          value={editing![name]}
          maxLength={maxLength}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => {
            setInvalid(false);
            setEditing({ ...editing!, [name]: event.currentTarget.value });
          }}
        />
      </label>
    );
  }
  function select(
    name: 'kind' | 'role' | 'sourceBlockId',
    title: string,
    options: readonly { value: string; label: string }[],
  ) {
    const selected = editing![name];
    return (
      <Field className="min-w-0">
        <FieldLabel htmlFor={`${fields}-${name}`}>{title}</FieldLabel>
        <SharedSelect.Select
          value={selected === '' ? null : selected}
          items={options.map((option) => ({ value: option.value === '' ? null : option.value, label: option.label }))}
          disabled={disabled}
          onValueChange={(value) => {
            setInvalid(false);
            setEditing({ ...editing!, [name]: value ?? '' });
          }}
        >
          <SharedSelect.SelectTrigger
            id={`${fields}-${name}`}
            className="w-full max-w-full"
            ref={name === 'kind' ? entryKindRef : name === 'sourceBlockId' ? sourceBlockRef : undefined}
          >
            <SharedSelect.SelectValue />
          </SharedSelect.SelectTrigger>
          <SharedSelect.SelectContent>
            <SharedSelect.SelectGroup>
              {options.map((option) => (
                <SharedSelect.SelectItem key={option.value || 'none'} value={option.value === '' ? null : option.value}>
                  {option.label}
                </SharedSelect.SelectItem>
              ))}
            </SharedSelect.SelectGroup>
          </SharedSelect.SelectContent>
        </SharedSelect.Select>
      </Field>
    );
  }
  function apply(event: MouseEvent<HTMLButtonElement>) {
    if (!editing) return;
    const e = editing;
    const target = parseReferenceTarget(
      e.kind === 'unavailable'
        ? null
        : e.kind === 'subject'
          ? { kind: e.kind, subjectId: e.subjectId }
          : e.kind === 'document'
            ? { kind: e.kind, documentId: e.documentId }
            : {
                kind: e.kind,
                documentId: e.documentId,
                revisionId: e.revisionId,
                sha256: e.sha256,
                ...(e.blockId ? { blockId: e.blockId } : {}),
              },
    );
    if (target === undefined) {
      setInvalid(true);
      return;
    }
    const reference: KnowledgeReference = {
      id: e.id,
      role: e.role,
      target,
      ...(e.sourceBlockId ? { sourceBlockId: e.sourceBlockId } : {}),
    };
    onChange(writeReference(draft, reference, e.label));
    finishEntry(event);
  }
  function repair(issue: (typeof issues)[number], event: MouseEvent<HTMLButtonElement>) {
    const repaired = repairReference(draft, issue);
    if (issue.kind === 'source') {
      const sourceBlockId = repaired.references.find((reference) => reference.id === issue.id)?.sourceBlockId ?? '';
      setEditing((current) => (current?.id === issue.id ? { ...current, sourceBlockId } : current));
    }
    onChange(repaired);
    if (event.detail === 0) {
      requestFocus(() => {
        if (editing?.id === issue.id && issue.kind === 'source') return sourceBlockRef.current;
        if (editing) return entryInputRef.current ?? entryKindRef.current ?? entryLegendRef.current;
        return repairHeadingRef.current ?? headingRef.current;
      });
    } else cancelFocusRequest();
  }
  function remove(event: MouseEvent<HTMLButtonElement>, referenceId: string) {
    const index = draft.references.findIndex((reference) => reference.id === referenceId);
    const nextId = draft.references[index + 1]?.id ?? draft.references[index - 1]?.id;
    onChange(removeReference(draft, referenceId));
    if (event.detail === 0) {
      requestFocus(() => {
        if (nextId) {
          const next = editActions.current.get(nextId);
          if (next && focusable(next)) return next;
        }
        const add = addRef.current;
        return focusable(add) ? add : headingRef.current;
      });
    } else cancelFocusRequest();
  }
  return (
    <section
      className="min-w-0 space-y-4 border-t border-border pt-5"
      aria-labelledby={heading}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h3 id={heading} ref={headingRef} tabIndex={-1} className="text-base font-semibold">
          {copy.title} ({draft.references.length}/{referenceLimit})
        </h3>
        <Button
          ref={addRef}
          type="button"
          variant="outline"
          className={referenceControl}
          disabled={disabled || draft.references.length >= referenceLimit || !!editing}
          onClick={beginAdd}
        >
          {copy.add}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{copy.max}</p>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {issues.length ? (
            <section className="min-w-0 space-y-3" role="alert" aria-labelledby={`${heading}-repairs`}>
              <h4 id={`${heading}-repairs`} ref={repairHeadingRef} tabIndex={-1} className="font-medium">
                {copy.repairReview}
              </h4>
              <ul className="min-w-0 space-y-3">
                {issues.map((issue) => (
                  <li key={`${issue.kind}:${issue.id}`} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
                    <details className="min-w-0">
                      <summary className={`${referenceControl} cursor-pointer`}>{copy.inspect}</summary>
                      <p className="break-all pt-2 text-sm text-muted-foreground">{issue.id}</p>
                    </details>
                    <Button
                      type="button"
                      variant="outline"
                      className={referenceControl}
                      disabled={disabled || (issue.kind === 'unlisted' && draft.references.length >= referenceLimit)}
                      onClick={(event) => repair(issue, event)}
                    >
                      {copy[issue.kind]}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {editing ? (
            <fieldset className="min-w-0 space-y-4 rounded-lg border border-border p-4" disabled={disabled}>
              <legend ref={entryLegendRef} tabIndex={-1} className="px-1 font-medium">
                {copy.edit}
              </legend>
              <details className="min-w-0">
                <summary className={`${referenceControl} cursor-pointer`}>{copy.inspect}</summary>
                <p className="break-all pt-2 text-sm text-muted-foreground">{editing.id}</p>
              </details>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                {select('kind', copy.kind, [
                  ...(editing.kind === 'unavailable' ? [{ value: 'unavailable', label: copy.unavailable }] : []),
                  { value: 'subject', label: copy.subject },
                  { value: 'document', label: copy.live },
                  { value: 'revision', label: copy.exact },
                ])}
                {select(
                  'role',
                  copy.role,
                  referenceRoles.map((role) => ({ value: role, label: copy.roles[role] })),
                )}
              </div>
              {editing.kind === 'subject'
                ? field('subjectId', copy.subjectId, 36)
                : editing.kind !== 'unavailable'
                  ? field('documentId', copy.documentId, 36)
                  : null}
              {editing.kind === 'revision' ? (
                <>
                  {field('revisionId', copy.revisionId, 36)}
                  {field('sha256', copy.digest, 64)}
                  {field('blockId', copy.blockId)}
                </>
              ) : null}
              {select('sourceBlockId', copy.sourceBlock, [
                { value: '', label: copy.whole },
                ...(editing.sourceBlockId && !blocks.includes(editing.sourceBlockId)
                  ? [{ value: editing.sourceBlockId, label: editing.sourceBlockId }]
                  : []),
                ...blocks.map((block) => ({ value: block, label: block })),
              ])}
              {field('label', copy.label, 512)}
              <p className="text-sm text-muted-foreground">
                {editing.kind === 'revision' ? copy.exactHint : editing.kind === 'document' ? copy.liveHint : null}
              </p>
              {invalid ? <p role="alert">{copy.invalid}</p> : null}
              <div className="flex flex-wrap gap-3">
                <Button type="button" className={referenceControl} onClick={apply}>
                  {copy.apply}
                </Button>
                <Button type="button" variant="outline" className={referenceControl} onClick={finishEntry}>
                  {copy.cancel}
                </Button>
              </div>
            </fieldset>
          ) : null}
          {draft.references.length ? (
            <ul className="min-w-0 space-y-3" aria-label={copy.title}>
              {draft.references.map((reference) => {
                const label = referenceLabel(draft.body, reference.id);
                const targetName =
                  reference.target === null
                    ? copy.unavailable
                    : reference.target.kind === 'subject'
                      ? copy.subject
                      : reference.target.kind === 'document'
                        ? copy.live
                        : copy.exact;
                return (
                  <li key={reference.id} className="min-w-0 rounded-lg border border-border p-3">
                    <div className="min-w-0 space-y-2">
                      {label ? (
                        <p className="min-w-0 text-sm [overflow-wrap:anywhere]">
                          <span className="font-medium">{copy.label}: </span>{label}
                        </p>
                      ) : null}
                      <p className="min-w-0 text-sm [overflow-wrap:anywhere]">
                        <span className="font-medium">{copy.role}: </span>{copy.roles[reference.role]}
                        <span aria-hidden="true"> · </span>
                        <span className="font-medium">{copy.kind}: </span>{targetName}
                      </p>
                      <details className="min-w-0">
                        <summary className={`${referenceControl} cursor-pointer`}>{copy.inspect}</summary>
                        <div className="min-w-0 pt-3">
                          <ReferenceIdentity reference={reference} locale={locale} />
                        </div>
                      </details>
                    </div>
                    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3">
                      <Button
                        ref={(button) => {
                          if (button) editActions.current.set(reference.id, button);
                          else editActions.current.delete(reference.id);
                        }}
                        type="button"
                        variant="outline"
                        className={referenceControl}
                        disabled={disabled || !!editing}
                        onClick={(event) => beginEdit(event, reference)}
                      >
                        {copy.edit}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className={referenceControl}
                        disabled={disabled || !!editing}
                        onClick={(event) => remove(event, reference.id)}
                      >
                        {copy.remove}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.empty}</p>
          )}
        </div>
        {draft.references.length ? (
          <aside className="min-w-0 border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <KnowledgeReferenceList
              body={draft.body}
              references={draft.references}
              locale={locale}
              inspect={inspect}
              privateTargets={!!inspect}
            />
          </aside>
        ) : null}
      </div>
    </section>
  );
}
