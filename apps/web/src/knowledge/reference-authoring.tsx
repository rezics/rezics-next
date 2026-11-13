import { useId, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
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
import { KnowledgeReferenceList, referenceControl, referenceInput } from './reference-view';
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
  inspect?: ReferenceInspector;
  onEditingChange: (editing: boolean) => void;
}) {
  const copy = referenceCopy(locale);
  const heading = useId();
  const fields = useId();
  const [editing, setEditing] = useState<Entry | null>(null);
  const [invalid, setInvalid] = useState(false);
  const issues = referenceIssues(draft);
  const blocks = referenceBlocks(draft.body);
  function field(name: keyof Entry, title: string, maxLength = 256) {
    return (
      <label className="block min-w-0 space-y-2" htmlFor={`${fields}-${name}`}>
        <span className="block text-sm font-medium">{title}</span>
        <Input
          id={`${fields}-${name}`}
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
  function select(name: 'kind' | 'role' | 'sourceBlockId', title: string, options: ReactNode) {
    return (
      <label className="block min-w-0 space-y-2" htmlFor={`${fields}-${name}`}>
        <span className="block text-sm font-medium">{title}</span>
        <select
          id={`${fields}-${name}`}
          value={editing![name]}
          className={`${referenceInput} rounded-md border py-2 text-sm`}
          disabled={disabled}
          onChange={(event) => {
            setInvalid(false);
            setEditing({ ...editing!, [name]: event.currentTarget.value });
          }}
        >
          {options}
        </select>
      </label>
    );
  }
  function apply() {
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
    setEditing(null);
    onEditingChange(false);
    setInvalid(false);
  }
  return (
    <section className="min-w-0 space-y-4 border-t border-border pt-5" aria-labelledby={heading}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h3 id={heading} className="text-base font-semibold">
          {copy.title} ({draft.references.length}/64)
        </h3>
        <Button
          type="button"
          variant="outline"
          className={referenceControl}
          disabled={disabled || draft.references.length >= referenceLimit || !!editing}
          onClick={() => {
            onEditingChange(true);
            setEditing({ ...entry({ id: crypto.randomUUID(), role: 'cites', target: null }, draft), kind: 'subject' });
          }}
        >
          {copy.add}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{copy.max}</p>
      {issues.length ? (
        <div className="min-w-0 space-y-3" role="alert">
          <p>{copy.repairReview}</p>
          <ul className="min-w-0 space-y-3">
            {issues.map((issue) => (
              <li key={`${issue.kind}:${issue.id}`} className="min-w-0 space-y-2">
                <p className="break-all text-sm">{issue.id}</p>
                <Button
                  type="button"
                  variant="outline"
                  className={referenceControl}
                  disabled={disabled || (issue.kind === 'unlisted' && draft.references.length >= referenceLimit)}
                  onClick={() => onChange(repairReference(draft, issue))}
                >
                  {copy[issue.kind]}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {draft.references.length ? (
        <ul className="min-w-0 space-y-3">
          {draft.references.map((reference) => (
            <li key={reference.id} className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                {referenceLabel(draft.body, reference.id) || reference.id}
              </span>
              <Button
                type="button"
                variant="outline"
                className={referenceControl}
                disabled={disabled || !!editing}
                onClick={() => {
                  onEditingChange(true);
                  setEditing(entry(reference, draft));
                }}
              >
                {copy.edit}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={referenceControl}
                disabled={disabled || !!editing}
                onClick={() => onChange(removeReference(draft, reference.id))}
              >
                {copy.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      )}
      {editing ? (
        <fieldset className="min-w-0 space-y-4 rounded-lg border border-border p-4" disabled={disabled}>
          <legend className="px-1 font-medium">{copy.edit}</legend>
          <p className="break-all text-sm text-muted-foreground">{editing.id}</p>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            {select(
              'kind',
              copy.kind,
              <>
                {editing.kind === 'unavailable' ? <option value="unavailable">{copy.unavailable}</option> : null}
                <option value="subject">{copy.subject}</option>
                <option value="document">{copy.live}</option>
                <option value="revision">{copy.exact}</option>
              </>,
            )}
            {select(
              'role',
              copy.role,
              referenceRoles.map((role) => (
                <option key={role} value={role}>
                  {copy.roles[role]}
                </option>
              )),
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
          {select(
            'sourceBlockId',
            copy.sourceBlock,
            <>
              <option value="">{copy.whole}</option>
              {editing.sourceBlockId && !blocks.includes(editing.sourceBlockId) ? (
                <option value={editing.sourceBlockId}>{editing.sourceBlockId}</option>
              ) : null}
              {blocks.map((block) => (
                <option key={block} value={block}>
                  {block}
                </option>
              ))}
            </>,
          )}
          {field('label', copy.label, 512)}
          <p className="text-sm text-muted-foreground">
            {editing.kind === 'revision' ? copy.exactHint : editing.kind === 'document' ? copy.liveHint : null}
          </p>
          {invalid ? <p role="alert">{copy.invalid}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button type="button" className={referenceControl} onClick={apply}>
              {copy.apply}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={referenceControl}
              onClick={() => {
                setEditing(null);
                onEditingChange(false);
                setInvalid(false);
              }}
            >
              {copy.cancel}
            </Button>
          </div>
        </fieldset>
      ) : null}
      <KnowledgeReferenceList
        body={draft.body}
        references={draft.references}
        locale={locale}
        inspect={inspect}
        privateTargets={!!inspect}
      />
    </section>
  );
}
