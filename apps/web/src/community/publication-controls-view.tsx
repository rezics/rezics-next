import { useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { loadGlobalHeaderSuggestions } from '../search/header-search/suggestions';
import { hitYear } from '../search/results';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PublicationChange, PublicationOutcome } from './publication-controls';
import type { PublishedSubject } from './space';

export type PublicationTarget = PublishedSubject & { title: string };
export type PublicationSend = (input: PublicationChange) => Promise<PublicationOutcome>;

export function usePublicationControls(
  realmId: string,
  send: PublicationSend,
  saved: (input: PublicationChange, target: PublicationTarget, head: string) => void,
  currentSubjects: PublishedSubject[] = [],
) {
  const [target, setTarget] = useState<PublicationTarget | null>(null);
  const [outcome, setOutcome] = useState<PublicationOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<{ input: PublicationChange; target: PublicationTarget } | null>(null);
  const running = useRef(false);
  // Retain returned decision heads for an explicit republish during this visit.
  const heads = useRef(new Map<string, string>());
  const locked = busy || outcome?.kind === 'unavailable';
  function choose(next: PublicationTarget | null) {
    if (locked) return;
    setTarget(next);
    setOutcome(null);
    request.current = null;
  }
  async function perform(input: PublicationChange, subject: PublicationTarget) {
    if (running.current) return;
    running.current = true;
    request.current = { input, target: subject };
    setTarget(subject);
    setBusy(true);
    let result: PublicationOutcome;
    try {
      result = await send(input);
    } catch {
      result = { kind: 'unavailable' };
    }
    setOutcome(result);
    if (result.kind === 'saved') {
      heads.current.set(subject.id, result.head);
      setTarget({ ...subject, publicationId: result.head });
      saved(input, subject, result.head);
    }
    setBusy(false);
    running.current = false;
  }
  function change(action: PublicationChange['action'], subject = target) {
    if (!subject || locked) return;
    const head =
      currentSubjects.find((item) => item.id === subject.id)?.publicationId ??
      heads.current.get(subject.id) ??
      subject.publicationId;
    return perform(
      {
        realmId,
        subjectId: subject.id,
        action,
        idempotencyKey: crypto.randomUUID(),
        ...(head ? { expectedHead: head } : {}),
      },
      subject,
    );
  }
  function retry() {
    if (request.current) return perform(request.current.input, request.current.target);
  }
  function review() {
    if (outcome?.kind !== 'conflict' || !outcome.currentHead || !request.current) return;
    const { input, target: subject } = request.current;
    return perform({ ...input, expectedHead: outcome.currentHead, idempotencyKey: crypto.randomUUID() }, subject);
  }
  return { target, outcome, busy, locked, choose, change, retry, review, action: request.current?.input.action };
}

async function searchSubjects(text: string, signal: AbortSignal): Promise<EntityPickerSubject[]> {
  const locale = getLocale();
  const result = await loadGlobalHeaderSuggestions(text, locale, signal);
  return result.subjects.map((subject) => {
    const title = pickText(subject.labels, locale).text;
    return {
      id: subject.id,
      title,
      types: coverSubject(subject.id, title, subject.summary, subject.type).types,
      typeLabel: pickText(result.types[subject.type] ?? {}, locale).text,
      year: hitYear(subject.facts) ?? null,
      cover: coverOf(subject.summary),
    };
  });
}

export function PublicationControls({
  control,
  refresh,
}: {
  control: ReturnType<typeof usePublicationControls>;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const selected = control.target;
  const value: EntityPickerSubject[] = selected
    ? [
        {
          id: selected.id,
          title: selected.title,
          types: selected.types,
          typeLabel: selected.typeName ?? '',
          cover: selected.cover,
        },
      ]
    : [];
  return (
    <div className="space-y-3">
      <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {m.realm_publication_curate()}
      </Button>
      {open ? (
        <div className="max-w-xl space-y-3 rounded-xl bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{m.realm_publication_scope()}</p>
          <fieldset disabled={control.locked} className="space-y-3">
            <EntityPicker
              disabled={control.locked}
              label={m.realm_publication_choose()}
              value={value}
              search={searchSubjects}
              src={coverSrc}
              onValueChange={(items) => {
                const subject = items[0];
                control.choose(
                  subject
                    ? {
                        id: subject.id,
                        title: subject.title,
                        labels: { [getLocale()]: subject.title },
                        label: subject.title,
                        types: [...subject.types],
                        typeName: subject.typeLabel,
                        cover: subject.cover,
                      }
                    : null,
                );
              }}
            />
            <Button disabled={!selected || control.locked} onClick={() => void control.change('publish')}>
              {m.realm_publication_publish()}
            </Button>
          </fieldset>
        </div>
      ) : null}
      {control.busy ? <p role="status">{m.realm_publication_saving()}</p> : null}
      {!control.busy && control.outcome ? (
        <div role="status" className="space-y-2 text-sm">
          {control.outcome.kind === 'saved' ? (
            <p>{control.action === 'publish' ? m.realm_publication_saved() : m.realm_publication_removed()}</p>
          ) : null}
          {control.outcome.kind === 'denied' ? <p>{m.realm_publication_denied()}</p> : null}
          {control.outcome.kind === 'invalid' ? <p>{m.realm_publication_invalid()}</p> : null}
          {control.outcome.kind === 'unavailable' ? (
            <>
              <p>{m.realm_publication_uncertain()}</p>
              <Button variant="outline" onClick={() => void control.retry()}>
                {m.realm_publication_retry()}
              </Button>
            </>
          ) : null}
          {control.outcome.kind === 'conflict' ? (
            <>
              <p>{m.realm_publication_conflict()}</p>
              {control.outcome.currentHead ? (
                <Button variant="outline" onClick={() => void control.review()}>
                  {m.realm_publication_review()}
                </Button>
              ) : (
                <p>{m.realm_publication_head_unavailable()}</p>
              )}
              <Button variant="outline" onClick={() => void refresh()}>
                {m.realm_shelf_restart()}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ShelfContinuation({
  next,
  busy,
  failure,
  load,
  label,
}: {
  next: string | null;
  busy: boolean;
  failure: 'denied' | 'unavailable' | 'stale' | null;
  load: (restart?: boolean) => Promise<void>;
  label: string;
}) {
  return (
    <div className="space-y-2" aria-busy={busy}>
      {failure ? (
        <p role="status" className="text-sm text-muted-foreground">
          {failure === 'denied'
            ? m.realm_shelf_denied()
            : failure === 'stale'
              ? m.realm_shelf_stale()
              : m.realm_shelf_unavailable()}
        </p>
      ) : null}
      {failure === 'stale' || failure === 'denied' ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(true)}>
          {m.realm_shelf_restart()}
        </Button>
      ) : next ? (
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? m.realm_shelf_loading() : label}
        </Button>
      ) : null}
    </div>
  );
}
