import { useEditorLifetime } from './editor-lifetime';
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ViewHeading } from '../pages/view-heading';
import { m } from '../../paraglide/messages.js';
import { CreateSubjectForm } from './create-subject-form';
import type { CreateFailure, CreateResult, CreatedReader, InitialSubject } from './create-subject';
import { creationStatement, type StatementInput } from './statement-editor';
import {
  peopleInitialItem,
  validatePeopleItem,
  type PeopleItem,
  type PeopleRead,
  type PeopleTransport,
} from './people-profile';
import { type CreatedCreditIdentity, type CreditTargetHandoff } from './credit-target-handoff';
import { PeopleCreateFields, capturePeopleReuse, type PeopleReuseState } from './people-create-fields';
import { PeopleCreateReview } from './people-create-review';
import {
  peopleAdmitCreatedReader,
  peopleCreateControl,
  peopleFactDrafts,
  peopleFactsFromDrafts,
} from './people-create';
import { applyReuse, captureReuse, cloneReferenceGroup } from './reference-reuse';

type Current = Extract<PeopleRead, { ok: true }>;
type Created = Extract<CreateResult, { ok: true }>;
type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';

const peopleActionTarget =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

function createdIdentity(result: Created): CreatedCreditIdentity | undefined {
  const identity = result.reader.state === 'ready' ? result.reader.identity : undefined;
  if (!identity || (identity.type !== 'schema:Person' && identity.type !== 'schema:Organization')) return undefined;
  return identity as CreatedCreditIdentity;
}

/** Keep the scalar and citation mounted until a populated unsent fact is deliberately removed. */
function PeopleInitialFactRemove({
  id,
  statement,
  disabled,
  locale,
  onRemove,
}: {
  id: string;
  statement: StatementInput;
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [confirmingId, setConfirmingId] = useState<string>();
  const confirming = confirmingId === id;
  const current = useRef({ id, disabled, onRemove });
  current.current = { id, disabled, onRemove };
  const editable = () =>
    lifetime.active() &&
    !current.current.disabled &&
    current.current.id === id &&
    !!holder.current?.isConnected &&
    !holder.current.closest('fieldset:disabled');
  useLayoutEffect(() => {
    if (!editable()) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  const cancelRemoval = () => {
    if (!editable()) return;
    restoreFocus.current = true;
    setConfirmingId(undefined);
  };
  const remove = () => {
    const row = holder.current?.closest('fieldset');
    if (!editable() || !row) return;
    const controls = [
      ...(row.parentElement?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex="0"], [contenteditable="true"]',
      ) ?? []),
    ];
    const first = controls.findIndex((control) => row.contains(control));
    const last = controls.findLastIndex((control) => row.contains(control));
    [...controls.slice(last + 1), ...controls.slice(0, first).reverse()]
      .find(
        (control) =>
          !control.matches(':disabled, [aria-disabled="true"], [type="hidden"]') &&
          !control.closest('[hidden], [inert]'),
      )
      ?.focus();
    current.current.onRemove();
  };
  const hasContent = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value == null) return false;
    if (typeof value === 'object') return Object.values(value).some(hasContent);
    return true;
  };
  const populatedPart = (part: StatementInput | StatementInput['references'][number]['parts'][number]) =>
    part.value.type !== 'value' || hasContent(part.value.content);
  const populated =
    populatedPart(statement) ||
    statement.qualifiers?.some(populatedPart) ||
    statement.references.some((reference) => reference.parts.some(populatedPart));
  return (
    <div ref={holder}>
      {confirming ? (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action: m.people_profile_remove_fact({}, o) }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRemoval();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action: m.people_profile_remove_fact({}, o) }, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={cancel}
              type="button"
              variant="outline"
              className={peopleActionTarget}
              disabled={disabled}
              onClick={cancelRemoval}
            >
              {m.candidate_cancel({}, o)}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className={peopleActionTarget}
              disabled={disabled}
              onClick={remove}
            >
              {m.people_profile_remove_fact({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          className={peopleActionTarget + ' self-start'}
          disabled={disabled}
          onClick={() => {
            if (editable()) populated ? setConfirmingId(id) : remove();
          }}
        >
          {m.people_profile_remove_fact({}, o)}
        </Button>
      )}
    </div>
  );
}

export function PeopleCreate({
  read,
  current,
  recovering,
  recovery,
  refresh: reload,
  work,
  locale,
  session,
  transport,
  onNavigate,
  headingRef,
  handoff,
  onCreated,
  onReturnToCreditDraft,
  intro,
  admittedProfiles,
}: {
  read: Current;
  current: boolean;
  recovering: boolean;
  recovery: ReactNode;
  refresh: () => Promise<PeopleRead>;
  work: string | undefined;
  locale: string;
  session: Session;
  transport: PeopleTransport;
  onNavigate: (href: string) => void;
  headingRef: Ref<HTMLHeadingElement>;
  handoff?: CreditTargetHandoff;
  onCreated?: (result: Created) => void;
  onReturnToCreditDraft?: (identity: CreatedCreditIdentity) => void;
  intro: ReactNode;
  admittedProfiles: Current['profiles'];
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [drafts, setDrafts] = useState<Record<string, Record<string, StatementInput>>>({});
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<Created>();
  const [reuse, setReuse] = useState<PeopleReuseState | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ holder: string; index: number; nonce: number }>();
  const returnedIdentity = created && createdIdentity(created);
  const canReturnToCreditDraft =
    !!handoff &&
    handoff.phase === 'ready' &&
    !!returnedIdentity &&
    handoff.createdId === created?.id &&
    handoff.identity?.id === returnedIdentity.id &&
    handoff.admittedTypes.includes(returnedIdentity.type) &&
    admittedProfiles.some((profile) => profile.id === returnedIdentity.type);
  const scope = useId();
  const rowIds = useRef(new Map<string, string>());
  const fieldsets = useRef(new Map<string, HTMLFieldSetElement>());
  const addition = useRef<
    | {
        id: string;
        type: string;
        property: string;
        opener: HTMLButtonElement;
        canEdit: () => boolean;
        stop: () => void;
      }
    | undefined
  >(undefined);
  function cancelAddition() {
    addition.current?.stop();
    addition.current = undefined;
  }
  useLayoutEffect(() => () => cancelAddition(), []);
  useLayoutEffect(() => {
    const intent = addition.current;
    if (!intent) return;
    cancelAddition();
    const row = fieldsets.current.get(intent.id);
    const document = intent.opener.ownerDocument;
    if (
      !lifetime.active() ||
      !current ||
      recovering ||
      !intent.canEdit() ||
      !read.profiles.find((profile) => profile.id === intent.type)?.fields.includes(intent.property) ||
      rowIds.current.get(JSON.stringify([intent.type, intent.property])) !== intent.id ||
      !row?.isConnected ||
      row.matches(':disabled') ||
      row.closest('[hidden], [inert]') ||
      (document.activeElement !== document.body && document.activeElement !== intent.opener)
    )
      return;
    row
      .querySelector<HTMLElement>(
        'select:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled)',
      )
      ?.focus();
  });
  function requestAddition(
    id: string,
    type: string,
    property: string,
    opener: HTMLButtonElement,
    canEdit: () => boolean,
  ) {
    cancelAddition();
    const document = opener.ownerDocument;
    const moved = (event: Event) => {
      if (event.type === 'pointerdown' || event.target !== opener) cancelAddition();
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', moved, true);
    addition.current = {
      id,
      type,
      property,
      opener,
      canEdit,
      stop: () => {
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', moved, true);
      },
    };
  }
  const metadata = useRef(read);
  metadata.current = read;
  const sequence = useRef(0);
  function rowId(type: string, property: string) {
    const key = JSON.stringify([type, property]);
    let id = rowIds.current.get(key);
    if (!id) {
      id = `${scope}-people-${sequence.current++}`;
      rowIds.current.set(key, id);
    }
    return id;
  }
  function admitReader(id: string, reader: CreatedReader): CreatedReader {
    return peopleAdmitCreatedReader(reader, id, admittedProfiles);
  }
  function update(
    type: string,
    property: string,
    id: string | undefined,
    canEdit: () => boolean,
    change?: (statement: StatementInput) => StatementInput,
  ) {
    const key = JSON.stringify([type, property]);
    if (!lifetime.active() || !canEdit() || rowIds.current.get(key) !== id) return;
    if (change && !metadata.current.profiles.find((entry) => entry.id === type)?.fields.includes(property) && change)
      return;
    const updatedId = change ? rowId(type, property) : undefined;
    if (!change) rowIds.current.delete(key);
    setDrafts((previous) => {
      const fields = { ...previous[type] };
      if (change) fields[property] = change(fields[property]!);
      else delete fields[property];
      return { ...previous, [type]: fields };
    });
    setReuse((currentReuse) => (currentReuse?.source.property === property && !change ? null : currentReuse));
    setFailure((previous) => {
      if (!previous?.errors) return previous;
      const pointer = `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      const errors = previous.errors.filter(
        (error) => error.pointer !== pointer && !error.pointer.startsWith(`${pointer}/`),
      );
      return errors.length === previous.errors.length ? previous : errors.length ? { ...previous, errors } : undefined;
    });
    return updatedId;
  }
  function jump(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    const focus = target.matches('input, select, textarea, button')
      ? target
      : target.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
        );
    if (focus) focus.focus();
    else {
      target.setAttribute('tabindex', '-1');
      target.focus();
    }
  }
  return (
    <section className="mx-auto min-w-0 w-full max-w-3xl space-y-6 [overflow-wrap:anywhere]">
      <ViewHeading
        label={m.people_profile_title({}, o)}
        headingClassName="font-sans"
        headingRef={headingRef}
        headingTabIndex={-1}
      />
      {current && intro}
      {created && (
        <p role="status">
          {m.people_profile_created_id({}, o)} <code className="break-all">{created.id}</code>
        </p>
      )}
      <CreateSubjectForm
        locale={locale}
        session={session}
        onCreated={(result) => {
          const admitted = { ...result, reader: admitReader(result.id, result.reader) };
          setCreated(admitted);
          onCreated?.(admitted);
        }}
        onNavigate={work ? () => {} : onNavigate}
        transport={{
          definitions: async (refresh) => {
            const next = refresh ? await reload() : current ? read : undefined;
            if (!lifetime.active()) return { ok: false as const, reason: 'denied' as const };
            if (!next?.ok) return { ok: false };
            return { ok: true, types: next.profiles.map(({ id, label, description }) => ({ id, label, description })) };
          },
          submit: async (command) => {
            const result = await transport.create(command);
            if (!lifetime.active()) return { ok: false as const, reason: 'denied' as const };
            setFailure(result.ok ? undefined : result);
            if (!result.ok) return result;
            return { ...result, reader: admitReader(result.id, result.reader) };
          },
          read: async (id) => admitReader(id, await transport.read(id)),
        }}
        profile={{
          title: m.people_profile_title({}, o),
          hideHeading: true,
          scope: 'people-profile',
          metadata: {
            ready: current,
            pending: recovering,
            failure: recovery,
            types: admittedProfiles,
          },
          href: `/${locale}/catalogue/people${work ? `?work=${encodeURIComponent(work)}` : ''}`,
          labelLanguage: (type) => read.profiles.find((profile) => profile.id === type)?.lang ?? undefined,
          descriptionLanguage: (type) =>
            read.profiles.find((profile) => profile.id === type)?.descriptionLang ?? undefined,
          control: (pointer, type) =>
            peopleCreateControl(
              pointer,
              type,
              drafts,
              rowId,
              read.release,
              locale,
              read.profiles.find((entry) => entry.id === type)?.fields ?? [],
            ),
          prepare: (initial) => {
            const facts = Object.fromEntries(
              Object.entries(drafts[initial.type] ?? {}).map(([property, statement]) => [
                property,
                creationStatement(statement, read.release),
              ]),
            );
            const item = peopleInitialItem(initial, facts);
            const errors = validatePeopleItem(item, read.release);
            setFailure(errors.length ? { ok: false, reason: 'invalid', errors } : undefined);
            return { item, errors };
          },
          review: ({ item, stale }) => (
            <PeopleCreateReview
              item={item as PeopleItem}
              read={read}
              locale={locale}
              stale={stale}
              onJump={jump}
            />
          ),
          fields: (type, disabled, canEdit, invalidate) => {
            const fields = drafts[type] ?? {};
            const touch = () => invalidate?.();
            return (
              <PeopleCreateFields
                type={type}
                disabled={disabled}
                canEdit={canEdit}
                read={read}
                locale={locale}
                fields={fields}
                errors={failure?.errors ?? []}
                rowId={rowId}
                fieldsets={fieldsets}
                reuse={reuse && reuse.source.holder === rowId(type, reuse.source.property) ? reuse : null}
                focusCopy={focusCopy}
                onAdd={(property, statement) => {
                  const added = update(type, property, undefined, canEdit, () => statement);
                  touch();
                  return added;
                }}
                onChange={(property, id, statement) => {
                  update(type, property, id, canEdit, () => statement);
                  touch();
                }}
                onRemove={(property, id) => {
                  update(type, property, id, canEdit);
                  touch();
                }}
                onReuse={(property, index) => {
                  if (!lifetime.active() || !canEdit()) return;
                  const next = capturePeopleReuse(fields, type, property, index, rowId);
                  if (next) setReuse(next);
                }}
                onReuseSelected={(selected) => {
                  if (!lifetime.active() || !reuse) return;
                  setReuse({ ...reuse, selected, applied: [], refused: [] });
                }}
                onReuseApply={() => {
                  if (!lifetime.active() || !canEdit() || !reuse) return;
                  const staged = peopleFactDrafts(type, fields, rowId);
                  const result = applyReuse(staged, reuse.source, reuse.selected, read.release);
                  setDrafts((previous) => ({ ...previous, [type]: peopleFactsFromDrafts(result.drafts) }));
                  setReuse({ ...reuse, applied: result.applied, refused: result.refused });
                  const first = result.applied[0];
                  if (first) setFocusCopy({ holder: first.holder, index: first.index, nonce: Date.now() });
                  touch();
                }}
                onReuseCancel={() => setReuse(null)}
                onReuseRefresh={() => {
                  if (!lifetime.active() || !reuse) return;
                  const origin = fields[reuse.source.property];
                  const group = origin?.references[reuse.source.groupIndex];
                  if (!origin || !group) return;
                  const source = { ...reuse.source, snapshot: cloneReferenceGroup(group) };
                  setReuse({
                    ...reuse,
                    source,
                    capture: captureReuse(source, peopleFactDrafts(type, fields, rowId)),
                    applied: [],
                    refused: [],
                  });
                }}
                onReuseOpen={(holder, index) => setFocusCopy({ holder, index, nonce: Date.now() })}
                requestAddition={requestAddition}
                removeControl={(property, statement, id) => (
                  <PeopleInitialFactRemove
                    key={id}
                    id={id}
                    statement={statement}
                    disabled={disabled || !current || recovering}
                    locale={locale}
                    onRemove={() => {
                      update(type, property, id, canEdit);
                      touch();
                    }}
                  />
                )}
              />
            );
          },
        }}
      />
      {canReturnToCreditDraft && returnedIdentity && (
        <Button
          type="button"
          variant="outline"
          className={peopleActionTarget}
          disabled={!lifetime.active()}
          onClick={() => onReturnToCreditDraft?.(returnedIdentity)}
        >
          {m.people_profile_return_to_credit({}, o)}
        </Button>
      )}
    </section>
  );
}


