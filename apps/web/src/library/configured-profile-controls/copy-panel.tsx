import { useId, useRef, useState, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { Exposure, type GatedOperation } from '../../kernel/exposure';
import { CopyForm, type CopiesOrigin } from '../copies-page';
import { readCopyDetail, readCopySubject } from '../copies-actions';
import type { CopyItem, CopyRemoved } from '../copies-read';
import type { CopyProfile } from '../copies-profiles';
import { csrfHeaders } from '../../threads/composer';

const target =
  'min-h-11 min-w-11 max-w-full cursor-pointer whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const quiet = `${target} inline-flex items-center justify-center rounded-lg border border-border px-4 hover:bg-muted disabled:opacity-60`;
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';

export type ConfiguredCopyOrigin = CopiesOrigin;

export function configuredCopyOrigin(options: {
  isCurrent: (operation?: GatedOperation) => boolean;
  headers?: (operation?: GatedOperation) => HeadersInit | null;
  profile: CopyProfile;
  subjectId: string;
  subjectLabel: string;
  subjectType: string;
}): ConfiguredCopyOrigin {
  return {
    isCurrent: options.isCurrent,
    headers: (operation) => options.headers?.(operation) ?? csrfHeaders(),
    readDetail: (id) => readCopyDetail({ data: { id } }),
    readSubject: async (id) =>
      id === options.subjectId
        ? {
            state: 'ready',
            subject: {
              id: options.subjectId,
              type: options.subjectType,
              types: [options.subjectType],
              label: options.subjectLabel,
              cover: null,
            },
            profile: options.profile,
          }
        : readCopySubject({ data: id }),
  };
}

export function ConfiguredCopyPanel({
  subjectId,
  subjectType,
  subjectLabel,
  profile,
  items,
  next,
  addKey,
  sendKind,
  originating,
  onPage,
  onCreated,
  onSaved,
  onRemoved,
}: {
  subjectId: string;
  subjectType: string;
  subjectLabel: string;
  profile: CopyProfile;
  items: CopyItem[];
  next: string | null;
  addKey: string;
  sendKind: boolean;
  originating: ConfiguredCopyOrigin;
  onPage?: (cursor: string) => void;
  onCreated: (copy: CopyItem) => void;
  onSaved: (copy: CopyItem) => void;
  onRemoved: (id: string, result: CopyRemoved, deadline: number) => void;
}): ReactNode {
  const headingId = useId();
  const [editing, setEditing] = useState<CopyItem | null | undefined>(undefined);
  const [editorKey, setEditorKey] = useState(addKey);
  const addKeyRef = useRef(addKey);
  if (addKeyRef.current !== addKey) {
    addKeyRef.current = addKey;
    setEditorKey(addKey);
  }
  const writable = profile.kinds.some((kind) => kind.statuses.length);
  const close = () => originating.isCurrent() && setEditing(undefined);
  return (
    <section
      className="min-w-0 space-y-3"
      aria-labelledby={headingId}
      data-library-identity={subjectType}
      data-library-subject={subjectLabel}
    >
      <h3 id={headingId} className="text-base font-medium">
        {m.library_configured_copies_heading()}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.library_configured_copies_empty()}</p>
      ) : (
        <ul className="min-w-0 space-y-2">
          {items.map((copy) => (
            <li key={copy.id} className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="min-w-0 [overflow-wrap:anywhere] text-sm">
                {copy.kindLabel ?? copy.kind ?? m.library_other()}
                {' · '}
                {copy.statusLabel ?? copy.status}
              </span>
              <Exposure operation="copy.get">
                <button
                  type="button"
                  className={quiet}
                  onClick={() => originating.isCurrent('copy.get') && setEditing(copy)}
                >
                  {m.library_configured_open_copy()}
                </button>
              </Exposure>
            </li>
          ))}
        </ul>
      )}
      {next && onPage ? (
        <button type="button" className={linkClass} onClick={() => originating.isCurrent('copy.list') && onPage(next)}>
          {m.library_configured_next_copies()}
        </button>
      ) : null}
      {writable ? (
        editing === undefined ? (
          <Exposure operation="copy.create">
            <button type="button" className={quiet} onClick={() => originating.isCurrent('copy.create') && setEditing(null)}>
              {m.library_configured_add_copy()}
            </button>
          </Exposure>
        ) : (
          <CopyForm
            key={editing?.id ?? editorKey}
            originating={originating}
            {...(editing ? { copy: editing } : {})}
            profile={profile}
            sendKind={sendKind}
            inline
            subjectId={subjectId}
            addKey={editorKey}
            onClose={close}
            onCreated={(copy) => {
              onCreated(copy);
              close();
            }}
            onSaved={(copy) => {
              onSaved(copy);
              close();
            }}
            onRemoved={(id, result, deadline) => {
              onRemoved(id, result, deadline);
              close();
            }}
            onKey={(key) => setEditorKey(key)}
          />
        )
      ) : null}
    </section>
  );
}
