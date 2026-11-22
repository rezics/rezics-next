import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useRef, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { searchContentSubjects } from '../threads/content-subject-search';
import {
  readCollectionAppliedMembers,
  readSubjectApplications,
  updateSubjectApplication,
  type SubjectApplicationTarget,
} from './collection-application-actions';

type Attempt = { appliedSubjectId: string; present: boolean; key: string };

export function SubjectApplicationsEditor({
  target,
  csrf,
  onClose,
  onSaved,
}: {
  target: SubjectApplicationTarget;
  csrf: () => string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [selection, setSelection] = useState<EntityPickerSubject[]>([]);
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({});
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const active = useRef(false);
  const sending = useRef(false);
  const admission = useRef(csrf);
  admission.current = csrf;
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetKey = JSON.stringify(target);

  useEffect(() => {
    let current = true;
    active.current = true;
    void readSubjectApplications({ data: targetRef.current }).then(
      (result) => {
        if (!current || !admission.current()) return;
        setIds(result);
        setFailed(result === null);
      },
      () => {
        if (current && admission.current()) setFailed(true);
      },
    );
    return () => {
      current = false;
      active.current = false;
    };
  }, [targetKey, reload]);

  async function send(intent: Attempt) {
    const credential = admission.current();
    if (!credential || sending.current || !active.current) return;
    sending.current = true;
    setAttempt(intent);
    setBusy(true);
    setFailed(false);
    try {
      const result = await updateSubjectApplication({
        headers: { 'X-CSRF-Token': credential },
        data: { target, ...intent },
      });
      if (!active.current || admission.current() !== credential) return;
      if (result.state === 'saved') {
        onSaved?.();
        setAttempt(null);
        setSelection([]);
        setIds(null);
        setReload((value) => value + 1);
      } else {
        if (result.state === 'refused') setAttempt(null);
        setFailed(true);
      }
    } catch {
      if (active.current && admission.current() === credential) setFailed(true);
    } finally {
      sending.current = false;
      if (active.current && admission.current() === credential) setBusy(false);
    }
  }

  return (
    <section className="grid w-full min-w-0 gap-3 rounded-md border p-3" aria-label={m.collection_applications()}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{m.collection_applications()}</h3>
        <Button type="button" variant="ghost" disabled={busy || attempt !== null} onClick={onClose}>
          {m.library_destination_close()}
        </Button>
      </div>
      {ids?.length ? (
        <ul className="grid min-w-0 gap-2">
          {ids.map((id) => (
            <li key={id} className="flex min-w-0 flex-wrap items-center gap-2">
              <a className="break-all underline" href={subjectHref({ id, label: labels[id] ?? id }, getLocale()).href}>
                {labels[id] ?? id}
              </a>
              <Button
                type="button"
                variant="outline"
                disabled={attempt !== null || busy}
                onClick={() => void send({ appliedSubjectId: id, present: false, key: crypto.randomUUID() })}
              >
                {m.collection_application_remove()}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <EntityPicker
        label={m.library_collection_find_subject()}
        search={searchContentSubjects}
        value={selection}
        onValueChange={setSelection}
        src={coverSrc}
        disabled={busy || attempt !== null || ids === null || ids.length >= 32}
      />
      <Button
        type="button"
        disabled={!selection[0] || ids === null || ids.includes(selection[0].id) || busy || attempt !== null}
        onClick={() => {
          const subject = selection[0];
          if (!subject) return;
          setLabels((current) => ({ ...current, [subject.id]: subject.title }));
          void send({ appliedSubjectId: subject.id, present: true, key: crypto.randomUUID() });
        }}
      >
        {m.collection_application_apply()}
      </Button>
      {failed ? (
        <div role="alert">
          <p>{m.error_message()}</p>
          {attempt || ids === null ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (attempt) void send(attempt);
                else setReload((value) => value + 1);
              }}
            >
              {m.collection_discovery_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function CollectionApplicationFilter({
  collectionId,
  titles,
}: {
  collectionId: string;
  titles: ReadonlyMap<string, string>;
}) {
  const [value, setValue] = useState<EntityPickerSubject[]>([]);
  const selected = value[0];
  return (
    <details className="grid min-w-0 space-y-3 rounded-md border p-3">
      <summary className="cursor-pointer font-medium">{m.collection_application_filter()}</summary>
      <EntityPicker
        label={m.library_collection_find_subject()}
        search={searchContentSubjects}
        value={value}
        onValueChange={setValue}
        src={coverSrc}
      />
      {selected ? (
        <CollectionApplicationResults
          key={selected.id}
          collectionId={collectionId}
          appliedSubjectId={selected.id}
          titles={titles}
        />
      ) : null}
    </details>
  );
}

function CollectionApplicationResults({
  collectionId,
  appliedSubjectId,
  titles,
}: {
  collectionId: string;
  appliedSubjectId: string;
  titles: ReadonlyMap<string, string>;
}) {
  const [cursor, setCursor] = useState<string>();
  const [result, setResult] = useState<Awaited<ReturnType<typeof readCollectionAppliedMembers>>>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void readCollectionAppliedMembers({ data: { collectionId, appliedSubjectId, ...(cursor ? { cursor } : {}) } }).then(
      (page) => {
        if (active) setResult(page);
      },
      () => {
        if (active) setResult(null);
      },
    );
    return () => {
      active = false;
    };
  }, [collectionId, appliedSubjectId, cursor, reload]);

  if (result === undefined) return <p role="status">{m.library_bangumi_label_loading()}</p>;
  if (result === null)
    return (
      <div role="alert">
        <p>{m.error_message()}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setResult(undefined);
            setCursor(undefined);
            setReload((value) => value + 1);
          }}
        >
          {m.collection_discovery_retry()}
        </Button>
      </div>
    );
  return (
    <div className="grid min-w-0 gap-3">
      {!result.members.length && !result.next ? <p role="status">{m.collection_application_empty()}</p> : null}
      <ul className="grid min-w-0 gap-1">
        {result.members.map(({ id, subjectId, note }) => {
          const title = titles.get(subjectId) ?? subjectId;
          return (
            <li key={id} className="min-w-0 break-words">
              <a className="break-all underline" href={subjectHref({ id: subjectId, label: title }, getLocale()).href}>
                {title}
              </a>
              {note ? <p className="whitespace-pre-wrap">{note}</p> : null}
            </li>
          );
        })}
      </ul>
      {result.next ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setResult(undefined);
            setCursor(result.next ?? undefined);
          }}
        >
          {m.library_next_page()}
        </Button>
      ) : null}
    </div>
  );
}
