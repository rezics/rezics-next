import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { FilterDocument, OwnerLeaf } from '@rezics/filter';
import { parseFilter } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Field, FieldLabel, FieldGroup, FieldDescription } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { ConditionEditor, type ConditionExtension } from '../search/condition-editor';
import { localizedLabel } from '../search/results';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import type { RuleChoicePage, RuleChoices, RulePage } from './collection-rule-read';
import type { RuleWrite } from './collection-rule-actions';
import type { CollectionWriteResult } from './collection-records';
import { CollectionRuleControls } from './collection-rule-controls';
import { collectionRuleLabelPrefix } from './collection-rule-label-input';
import { ruleDraftSnapshot, useCollectionRuleDraftNavigation } from './collection-rule-draft-navigation';

type AvailablePage = Extract<RulePage, { state: 'new' | 'ready' }>;
const presence: FilterDocument = { owner: { presence: true } };

/** Navigation hint for the current owner's menu. The private GET still authorizes the definition. */
export function RuleEditLink({
  collection,
  viewerId,
  allowed,
}: {
  collection: { id: string; curatorAccountId: string | null; membershipKind?: string; builtinKind?: string };
  viewerId: string | null;
  allowed: boolean;
}) {
  if (
    !allowed ||
    !viewerId ||
    collection.curatorAccountId !== viewerId ||
    collection.membershipKind !== 'dynamic' ||
    collection.builtinKind
  )
    return null;
  return <a href={`/${getLocale()}/collections/${encodeURIComponent(collection.id)}/rule`}>{m.library_rule_edit()}</a>;
}

function TechnicalDetails({ label, children, id }: { label: string; children: ReactNode; id?: string }) {
  return (
    <details id={id} className="min-w-0 text-sm">
      <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {m.catalogue_technical_details()} · {label}
      </summary>
      <div className="flex min-w-0 flex-col gap-2 pt-2">{children}</div>
    </details>
  );
}

function Choice({
  label,
  value,
  choices,
  onChange,
  multiple = false,
  references = [],
  help,
}: {
  label: string;
  value: string | readonly string[];
  choices: { id: string; name: string }[];
  onChange(value: string[]): void;
  multiple?: boolean;
  references?: { label: string; value: string }[];
  help?: string | undefined;
}) {
  const fieldId = useId();
  const selected = typeof value === 'string' ? [value] : value;
  const retained = selected.filter((id) => id && !choices.some((choice) => choice.id === id));
  const unavailableName = (id: string) => m.library_rule_unavailable_choice({ number: retained.indexOf(id) + 1 });
  const hasDetails = selected.some(Boolean) || references.some(({ value }) => value);
  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
      <NativeSelect
        id={fieldId}
        className="w-full min-w-0"
        style={multiple ? { height: 'auto' } : undefined}
        multiple={multiple}
        value={multiple ? [...selected] : (selected[0] ?? '')}
        aria-describedby={help || retained.length ? `${fieldId}-help` : undefined}
        aria-details={hasDetails ? `${fieldId}-details` : undefined}
        onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
      >
        {!multiple && <NativeSelectOption value="">{m.condition_choose_value()}</NativeSelectOption>}
        {retained.map((id) => (
          <NativeSelectOption key={id} value={id}>
            {unavailableName(id)} · {m.library_rule_retained()}
          </NativeSelectOption>
        ))}
        {choices.map((choice) => (
          <NativeSelectOption key={choice.id} value={choice.id}>
            {choice.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {(help || retained.length > 0) && (
        <FieldDescription id={`${fieldId}-help`}>{help ?? m.library_rule_retained_help()}</FieldDescription>
      )}
      {multiple && selected.some(Boolean) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${m.library_subject_clear()} · ${label}`}
          onClick={() => onChange([])}
        >
          {m.library_subject_clear()}
        </Button>
      )}
      {hasDetails && (
        <TechnicalDetails id={`${fieldId}-details`} label={label}>
          <dl className="flex min-w-0 flex-col gap-2">
            {references
              .filter(({ value }) => value)
              .map(({ label, value }) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="select-text break-all">
                    <code>{value}</code>
                  </dd>
                </div>
              ))}
            {selected.filter(Boolean).map((id) => (
              <div key={id}>
                <dt className="text-muted-foreground">
                  {choices.find((choice) => choice.id === id)?.name ?? unavailableName(id)}
                </dt>
                <dd className="select-text break-all">
                  <code>{id}</code>
                </dd>
              </div>
            ))}
          </dl>
        </TechnicalDetails>
      )}
    </Field>
  );
}

/** Shared owner grammar only; profile/state/kind/status options come from the released registry. */
function OwnerFields({
  value,
  onChange,
  choices,
}: {
  value: OwnerLeaf;
  onChange(value: FilterDocument): void;
  choices: RuleChoices;
}) {
  const owner = value.owner;
  const locale = getLocale();
  const label = (labels: Record<string, string>) => localizedLabel(labels, locale).text;
  if ('presence' in owner) return <p>{m.library_rule_presence()}</p>;
  if ('label' in owner)
    return (
      <Choice
        label={m.library_rule_label()}
        value={owner.label.id}
        choices={choices.labels.values}
        onChange={([id]) => onChange({ owner: { label: { id: id ?? '' } } })}
      />
    );
  const operand = 'state' in owner ? owner.state : 'session' in owner ? owner.session : owner.holding;
  const profile = choices.release.profiles.find(({ id }) => id === operand.profileId);
  return (
    <FieldGroup>
      <Choice
        label={m.library_rule_profile()}
        value={operand.profileId}
        choices={choices.release.profiles
          .filter((profile) =>
            'state' in owner ? !!profile.entryStateSet : 'session' in owner ? !!profile.progress : !!profile.copies,
          )
          .map(({ id }) => ({ id, name: id }))}
        onChange={([profileId]) => {
          const next = choices.release.profiles.find(({ id }) => id === profileId);
          if ('state' in owner)
            onChange({
              owner: { state: { profileId: profileId ?? '', stateSetId: next?.entryStateSet?.id ?? '', in: [] } },
            });
          else if ('session' in owner)
            onChange({ owner: { session: { ...owner.session, profileId: profileId ?? '' } } });
          else onChange({ owner: { holding: { profileId: profileId ?? '' } } });
        }}
      />
      {'state' in owner && (
        <Choice
          label={m.library_rule_state()}
          multiple
          value={owner.state.in}
          references={[{ label: m.library_rule_state_set(), value: owner.state.stateSetId }]}
          help={
            owner.state.stateSetId && profile?.entryStateSet?.id !== owner.state.stateSetId
              ? m.library_rule_state_set_unavailable()
              : undefined
          }
          choices={
            profile?.entryStateSet?.id === owner.state.stateSetId
              ? profile.entryStateSet.states.map(({ id, labels }) => ({ id, name: label(labels) }))
              : []
          }
          onChange={(selected) => onChange({ owner: { state: { ...owner.state, in: selected } } })}
        />
      )}
      {'session' in owner && (
        <Choice
          label={m.library_rule_session()}
          value={owner.session.lifecycle}
          choices={[
            { id: 'active', name: m.library_rule_active() },
            { id: 'completed', name: m.library_rule_completed() },
            { id: 'abandoned', name: m.library_rule_abandoned() },
          ]}
          onChange={([lifecycle]) => {
            if (lifecycle === 'active' || lifecycle === 'completed' || lifecycle === 'abandoned')
              onChange({ owner: { session: { ...owner.session, lifecycle } } });
          }}
        />
      )}
      {'holding' in owner && (
        <>
          <Choice
            label={m.library_rule_holding_kind()}
            value={owner.holding.kind ?? ''}
            choices={profile?.copies?.kinds.map(({ id, labels }) => ({ id, name: label(labels) })) ?? []}
            onChange={([kind]) =>
              onChange({ owner: { holding: { profileId: owner.holding.profileId, ...(kind ? { kind } : {}) } } })
            }
          />
          <Choice
            label={m.library_rule_holding_status()}
            value={owner.holding.status ?? ''}
            choices={
              profile?.copies?.kinds
                .find(({ id }) => id === owner.holding.kind)
                ?.statuses.map(({ id, labels }) => ({ id, name: label(labels) })) ?? []
            }
            onChange={([status]) => {
              const { status: _old, ...rest } = owner.holding;
              onChange({ owner: { holding: { ...rest, ...(status ? { status } : {}) } } });
            }}
          />
        </>
      )}
    </FieldGroup>
  );
}

const alwaysCurrent = () => true;

type EditorProps = {
  page: RulePage;
  viewerId: string | null;
  collectionId: string | null;
  admitted: readonly string[] | undefined;
  save(input: RuleWrite, csrfToken: string): Promise<CollectionWriteResult>;
  captureSave?: () => EditorProps['save'] | null;
  reload(): Promise<RulePage>;
  labels?: ((q: string, cursor?: string) => Promise<RuleChoicePage | null>) | undefined;
  csrfToken: string;
  isCurrent?: (() => boolean) | undefined;
  currentCsrf?: (() => string | null) | undefined;
  isOwnerCurrent?: (() => boolean) | undefined;
  canLabelCurrent?: (() => boolean) | undefined;
  requireProvenance?: boolean | undefined;
  navigate?: ((id: string) => void) | undefined;
};

const pageIdentity = (page: RulePage) =>
  page.state === 'ready' || page.state === 'new' ? JSON.stringify([page.viewerId, page.intent]) : null;

/** Scope changes retire private state synchronously; a cached page needs a fresh private read to return. */
export function CollectionRuleEditor(props: EditorProps) {
  const { page, viewerId, collectionId, admitted } = props;
  const canRead =
    !!viewerId && !!admitted?.includes(collectionId === null ? 'collection.create' : 'collection_rule.get');
  const canSave = !!admitted?.includes(collectionId === null ? 'collection.create' : 'collection_rule.update');
  const canLabel = !!admitted?.includes('library_label.list');
  const scope = JSON.stringify(
    props.isOwnerCurrent ? [viewerId, collectionId] : [viewerId, collectionId, canRead, canSave, canLabel],
  );
  const latest = useRef({ page, scope });
  if (latest.current.page !== page || latest.current.scope !== scope) latest.current = { page, scope };
  const origin = latest.current;
  const sourceCurrent = () => latest.current === origin && (props.isCurrent?.() ?? true);
  const owned =
    canRead &&
    canSave &&
    (page.state === 'new' || page.state === 'ready') &&
    page.viewerId === viewerId &&
    (page.state === 'ready' ? page.id === collectionId : collectionId === null);
  const identity = pageIdentity(page);
  let [boundary, setBoundary] = useState(() => ({
    scope,
    source: page,
    epoch: 0,
    retired: new Set<string>(),
    seen: new Set(owned && identity ? [identity] : []),
  }));
  if (boundary.scope !== scope || boundary.source !== page) {
    const retired = new Set(boundary.retired);
    const changedScope = boundary.scope !== scope;
    if (changedScope) for (const previous of boundary.seen) retired.add(previous);
    const seen = changedScope ? new Set<string>() : new Set(boundary.seen);
    if (owned && identity && !retired.has(identity)) seen.add(identity);
    boundary = { scope, source: page, epoch: boundary.epoch + (changedScope ? 1 : 0), retired, seen };
    setBoundary(boundary);
  }
  return (
    <RuleLifetime
      key={scope}
      {...props}
      isCurrent={sourceCurrent}
      epoch={boundary.epoch}
      retired={boundary.retired}
      seen={boundary.seen}
      authorized={canRead && canSave}
      canLabel={canLabel}
    />
  );
}

// A synchronous lock and a mounted generation belong to this page, never to replacement IO.
function useRuleWork(epoch: number, isCurrent = alwaysCurrent, owns = isCurrent) {
  const work = useRef({ active: true, locked: false });
  const [pending, setPending] = useState(false);
  const previousEpoch = useRef(epoch);
  if (previousEpoch.current !== epoch) {
    work.current.active = false;
    work.current = { active: true, locked: false };
    previousEpoch.current = epoch;
  }
  useLayoutEffect(() => {
    const current = { active: true, locked: false };
    work.current = current;
    setPending(false);
    return () => {
      current.active = false;
    };
  }, [epoch]);
  function start(settles = isCurrent) {
    const current = work.current;
    if (!current.active || !isCurrent() || current.locked) return null;
    current.locked = true;
    setPending(true);
    return {
      current: () => current.active && settles(),
      finish: () => {
        if (!current.active || !owns()) return;
        current.locked = false;
        setPending(false);
      },
    };
  }
  return { pending, start };
}

function RuleLifetime({
  page,
  viewerId,
  collectionId,
  authorized,
  canLabel,
  epoch,
  retired,
  seen,
  ...actions
}: EditorProps & { authorized: boolean; canLabel: boolean; epoch: number; retired: Set<string>; seen: Set<string> }) {
  const [retried, setRetried] = useState<{ source: RulePage; page: RulePage } | null>(null);
  const current = retried?.source === page ? retried.page : page;
  const work = useRuleWork(epoch, actions.isCurrent, actions.isOwnerCurrent);
  function belongs(value: RulePage): value is AvailablePage {
    return (
      (value.state === 'ready' || value.state === 'new') &&
      value.viewerId === viewerId &&
      !retired.has(pageIdentity(value)!) &&
      (value.state === 'ready' ? value.id === collectionId : collectionId === null) &&
      (!actions.requireProvenance || value.address?.collectionId === collectionId)
    );
  }
  function accepts(value: RulePage): value is AvailablePage {
    return authorized && (actions.isCurrent?.() ?? true) && belongs(value);
  }
  function remember(value: AvailablePage) {
    seen.add(pageIdentity(value)!);
    setRetried({ source: page, page: value });
  }
  async function retry() {
    if (!authorized) return;
    const operation = work.start();
    if (!operation) return;
    try {
      if (!operation.current()) return;
      const result = await actions.reload();
      if (!operation.current()) return;
      if (accepts(result)) remember(result);
      setRetried({
        source: page,
        page: accepts(result) ? result : { state: result.state === 'unavailable' ? 'unavailable' : 'denied' },
      });
    } catch {
      if (operation.current()) setRetried({ source: page, page: { state: 'unavailable' } });
    } finally {
      operation.finish();
    }
  }
  const retained = useRef<AvailablePage | null>(null);
  if (belongs(current)) retained.current = current;
  const formPage = belongs(current) ? current : actions.isOwnerCurrent ? retained.current : null;
  return formPage && (actions.isOwnerCurrent || accepts(current)) ? (
    <RuleForm
      page={formPage}
      sourceAvailable={belongs(current)}
      viewerId={viewerId!}
      collectionId={collectionId}
      epoch={epoch}
      canLabel={canLabel}
      accepts={accepts}
      remember={remember}
      {...actions}
    />
  ) : (
    <div role="alert">
      <p>{current.state === 'unavailable' ? m.library_rule_unavailable() : m.library_rule_denied()}</p>
      <Button type="button" disabled={!authorized || work.pending} onClick={() => void retry()}>
        {m.library_follow_retry()}
      </Button>
    </div>
  );
}

function RuleForm({
  page,
  sourceAvailable,
  save,
  captureSave,
  reload,
  labels,
  csrfToken,
  navigate,
  viewerId,
  epoch,
  canLabel,
  isCurrent: ownerCurrent = alwaysCurrent,
  currentCsrf,
  isOwnerCurrent,
  canLabelCurrent,
  requireProvenance,
  accepts,
  remember,
}: Omit<EditorProps, 'page' | 'admitted'> & {
  page: AvailablePage;
  sourceAvailable: boolean;
  epoch: number;
  canLabel: boolean;
  accepts(value: RulePage): value is AvailablePage;
  remember(value: AvailablePage): void;
}) {
  const metadataId = useId();
  const sourceActive = useRef(true);
  const available = useRef(sourceAvailable);
  available.current = sourceAvailable;
  const isCurrent = () => sourceActive.current && available.current && ownerCurrent();
  function refuseSource() {
    sourceActive.current = false;
    setFeedback(m.library_rule_denied());
  }
  const [base, setBase] = useState(page);
  const [title, setTitle] = useState(page.state === 'ready' ? page.title : '');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState<FilterDocument | undefined>(
    page.state === 'ready' ? page.rule.filter : { and: [presence] },
  );
  const [choices, setChoices] = useState(page.choices);
  const [query, setQuery] = useState('');
  const prefix = collectionRuleLabelPrefix(query);
  const prefixError = prefix.ok
    ? null
    : prefix.issue === 'transport'
      ? m.library_rule_label_input_transport()
      : m.library_rule_label_input_correction();
  const { pending, start } = useRuleWork(epoch, ownerCurrent, isOwnerCurrent);
  const [feedback, setFeedback] = useState('');
  const [conflict, setConflict] = useState(false);
  const [intent, setIntent] = useState<RuleWrite | null>(null);
  const captured = useRef<RuleWrite | null>(null);
  const request = useRef<{ csrf: string; send: typeof save } | null>(null);
  const attempted = useRef(false);
  const choiceAddress = useRef({ raw: '', q: '', cursor: undefined as string | undefined, generation: 0 });
  const choiceContext = useRef({ q: '', next: page.choices.labels.next, generation: 0 });
  const labelContext = choiceContext.current;
  const [savedId, setSavedId] = useState<string | null>(null);
  const confirmed = useRef(false);
  const snapshot = ruleDraftSnapshot({ filter, title, description });
  const baseline = useRef(snapshot);
  const navigation = useCollectionRuleDraftNavigation({
    dirty: !savedId && (snapshot !== baseline.current || !!intent),
    isCurrent: () => isCurrent() && !confirmed.current,
    focus: () => (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  });
  const extension: ConditionExtension = {
    choices: [
      { label: m.library_rule_presence(), value: presence },
      { label: m.library_rule_state(), value: { owner: { state: { profileId: '', stateSetId: '', in: [] } } } },
      { label: m.library_rule_label(), value: { owner: { label: { id: '' } } } },
      { label: m.library_rule_session(), value: { owner: { session: { profileId: '', lifecycle: 'active' } } } },
      { label: m.library_rule_holding(), value: { owner: { holding: { profileId: '' } } } },
    ],
    render: (value, onChange): ReactNode =>
      'owner' in value ? (
        <OwnerFields
          value={value}
          onChange={(next) => {
            if (isCurrent() && !captured.current) onChange(next);
          }}
          choices={
            canLabel && (canLabelCurrent?.() ?? true)
              ? choices
              : { ...choices, labels: { state: 'unavailable', values: [], next: null } }
          }
        />
      ) : null,
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const csrf = currentCsrf ? currentCsrf() : csrfToken;
    if (!isCurrent() || !csrf || conflict || !filter || savedId) return;
    const operation = start(isOwnerCurrent ?? isCurrent);
    if (!operation) return;
    let parsed: FilterDocument;
    try {
      parsed = parseFilter(filter);
    } catch {
      setFeedback(m.condition_invalid());
      operation.finish();
      return;
    }
    const draft = {
      filter: parsed,
      sort: 'id' as const,
      ...(base.state === 'ready' ? { id: base.id, revision: base.rule.revision } : { title, description }),
    };
    const input = captured.current ?? {
      ...draft,
      idempotencyKey: attempted.current ? crypto.randomUUID() : base.intent,
    };
    const send = request.current?.send ?? (captureSave ? captureSave() : save);
    if (!send) {
      operation.finish();
      return;
    }
    attempted.current = true;
    captured.current = input;
    request.current ??= { csrf, send };
    const original = request.current;
    setIntent(input);
    setFeedback('');
    try {
      if (!isCurrent() || !operation.current()) return;
      const result = await original.send(input, original.csrf);
      if (!operation.current()) return;
      if (result.ok || result.reason !== 'unavailable') {
        captured.current = null;
        request.current = null;
        setIntent(null);
      }
      if (result.ok) {
        confirmed.current = true;
        baseline.current = snapshot;
        setSavedId(result.id);
        if (operation.current()) navigate?.(result.id);
      } else {
        setConflict(result.reason === 'conflict');
        setFeedback(
          result.reason === 'conflict'
            ? m.library_rule_conflict()
            : result.reason === 'unavailable'
              ? m.library_rule_unavailable()
              : result.reason === 'closed'
                ? m.platform_closed_message()
                : result.reason === 'forbidden' || result.reason === 'unauthorized'
                  ? m.library_rule_denied()
                  : m.condition_invalid(),
        );
      }
    } catch {
      if (operation.current()) setFeedback(m.library_rule_unavailable());
    } finally {
      operation.finish();
    }
  }
  async function refresh() {
    // Reloading the new-rule address cannot read the Collection just created. Keep its confirmation
    // until navigation: clearing it would reenable POST and create a second Collection from this draft.
    if (base.state === 'new' && savedId) return;
    const choiceOrigin = choiceAddress.current;
    const operation = start();
    if (!operation) return;
    try {
      if (!operation.current()) return;
      const current = await reload();
      if (!operation.current()) return;
      if (accepts(current)) {
        sourceActive.current = true;
        remember(current);
        // An uncertain command retains its exact revision, filter, metadata and key across reads.
        if (!captured.current) setBase(current);
        if (choiceAddress.current === choiceOrigin) {
          choiceAddress.current = { raw: '', q: '', cursor: undefined, generation: choiceOrigin.generation + 1 };
          choiceContext.current = {
            q: '',
            next: current.choices.labels.next,
            generation: choiceAddress.current.generation,
          };
          setQuery('');
          setChoices(current.choices);
        }
        setConflict(false);
        confirmed.current = false;
        setSavedId(null);
        setFeedback(m.library_rule_reloaded());
        // The draft remains intact. Only an explicit subsequent save uses this captured current rule revision.
      } else if (current.state === 'unavailable') setFeedback(m.library_rule_unavailable());
      else refuseSource();
    } catch {
      if (operation.current()) setFeedback(m.library_rule_unavailable());
    } finally {
      operation.finish();
    }
  }
  async function labelPage(cursor?: string, context = choiceContext.current) {
    if (
      !isCurrent() ||
      !labels ||
      !canLabel ||
      !(canLabelCurrent?.() ?? true) ||
      captured.current ||
      !prefix.ok ||
      query !== choiceAddress.current.raw ||
      (cursor !== undefined &&
        (context !== choiceContext.current ||
          prefix.query !== choiceContext.current.q ||
          choiceAddress.current.generation !== choiceContext.current.generation ||
          cursor !== choiceContext.current.next))
    )
      return;
    const operation = start();
    if (!operation) return;
    const requested = { ...choiceAddress.current, q: prefix.query, cursor };
    choiceAddress.current = requested;
    try {
      if (!operation.current()) return;
      const result = await labels(requested.q, requested.cursor);
      if (!operation.current()) return;
      if (choiceAddress.current !== requested || !(canLabelCurrent?.() ?? true)) return;
      if (requireProvenance && (!result || result.viewerId !== viewerId || !result.address)) {
        setFeedback(m.library_rule_labels_unavailable());
        return;
      }
      if (
        result?.viewerId === viewerId &&
        result.address?.q === requested.q &&
        result.address.cursor === (requested.cursor ?? null)
      ) {
        choiceContext.current = { q: requested.q, next: result.choices.labels.next, generation: requested.generation };
        setChoices(result.choices);
      } else setFeedback(m.library_rule_unavailable());
    } catch {
      if (operation.current() && choiceAddress.current === requested) setFeedback(m.library_rule_unavailable());
    } finally {
      operation.finish();
    }
  }
  // Keep this intent mounted while authority is unavailable, without retaining private UI in the DOM.
  if (!isCurrent())
    return (
      <div role="alert">
        <p>{m.library_rule_denied()}</p>
        <Button type="button" disabled={!ownerCurrent() || pending} onClick={() => void refresh()}>
          {m.library_collection_reload()}
        </Button>
      </div>
    );
  const visibleChoices =
    canLabel && (canLabelCurrent?.() ?? true)
      ? choices
      : { ...choices, labels: { state: 'unavailable' as const, values: [], next: null } };
  return (
    <article className="flex min-w-0 max-w-4xl flex-col gap-4 text-foreground">
      {navigation.boundary}
      <PageHeading>{base.state === 'new' ? m.library_rule_new() : m.library_rule_edit()}</PageHeading>
      <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-6">
        <fieldset disabled={pending || !!intent || !!savedId} className="min-w-0">
          <FieldGroup>
            {base.state === 'new' && (
              <>
                <Field>
                  <FieldLabel htmlFor={`${metadataId}-title`}>{m.library_collection_title()}</FieldLabel>
                  <Input
                    id={`${metadataId}-title`}
                    aria-describedby={`${metadataId}-title-limit`}
                    required
                    maxLength={512}
                    value={title}
                    onChange={(event) => {
                      if (isCurrent() && !captured.current) setTitle(event.currentTarget.value);
                    }}
                  />
                  <FieldDescription id={`${metadataId}-title-limit`}>{m.library_rule_title_limit()}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${metadataId}-description`}>{m.library_collection_description()}</FieldLabel>
                  <Textarea
                    id={`${metadataId}-description`}
                    aria-describedby={`${metadataId}-description-limit`}
                    value={description}
                    maxLength={20000}
                    rows={4}
                    onChange={(event) => {
                      if (isCurrent() && !captured.current) setDescription(event.currentTarget.value);
                    }}
                  />
                  <FieldDescription id={`${metadataId}-description-limit`}>
                    {m.library_rule_description_limit()}
                  </FieldDescription>
                </Field>
              </>
            )}
            {choices.release.state !== 'ready' && (
              <p role="status">
                {choices.release.state === 'preparing'
                  ? m.library_rule_preparing()
                  : m.condition_metadata_unavailable()}
              </p>
            )}
            {visibleChoices.labels.state !== 'ready' && (
              <p role="status">
                {visibleChoices.labels.state === 'preparing'
                  ? m.library_rule_preparing()
                  : m.library_rule_labels_unavailable()}
              </p>
            )}
            {labels && canLabel && (
              <Field>
                <FieldLabel htmlFor={`${metadataId}-label-search`}>{m.library_rule_label_search()}</FieldLabel>
                <Input
                  id={`${metadataId}-label-search`}
                  aria-describedby={`${metadataId}-${prefixError ? 'label-error' : 'label-limit'}`}
                  aria-invalid={!!prefixError}
                  value={query}
                  maxLength={1000}
                  onChange={(event) => {
                    if (!isCurrent() || !(canLabelCurrent?.() ?? true) || captured.current) return;
                    const raw = event.currentTarget.value;
                    const next = collectionRuleLabelPrefix(raw);
                    choiceAddress.current = {
                      raw,
                      q: next.ok ? next.query : '',
                      cursor: undefined,
                      generation: choiceAddress.current.generation + 1,
                    };
                    // A raw edit retires even equal normalized queries and their continuation positions.
                    choiceContext.current = { q: '', next: null, generation: -1 };
                    setChoices((current) => ({ ...current, labels: { state: 'ready', values: [], next: null } }));
                    setQuery(raw);
                  }}
                />
                <FieldDescription id={`${metadataId}-label-limit`}>
                  {m.library_rule_label_input_help()}
                </FieldDescription>
                {prefixError && (
                  <FieldDescription id={`${metadataId}-label-error`} role="alert">
                    {prefixError}
                  </FieldDescription>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" disabled={!prefix.ok} onClick={() => void labelPage()}>
                    {m.search_apply()}
                  </Button>
                  {choices.labels.next &&
                    prefix.ok &&
                    choiceContext.current.q === prefix.query &&
                    choiceContext.current.generation === choiceAddress.current.generation && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void labelPage(choices.labels.next!, labelContext)}
                      >
                        {m.library_label_more()}
                      </Button>
                    )}
                </div>
              </Field>
            )}
            <ConditionEditor
              value={filter}
              onChange={(value) => {
                if (isCurrent() && !captured.current) setFilter(value);
              }}
              locale={getLocale()}
              metadata={choices.release.metadata ?? { types: {}, properties: {} }}
              extension={extension}
              embedded
            />
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.search_reader_condition_limits_title()}
              </summary>
              <p className="text-muted-foreground">{m.search_reader_condition_limits()}</p>
            </details>
          </FieldGroup>
        </fieldset>
        {feedback && <p role="alert">{feedback}</p>}
        {intent && !pending && <p role="status">{m.library_rule_uncertain()}</p>}
        {savedId && <p role="status">{m.library_rule_saved()}</p>}
        {base.state === 'new' && <p className="text-sm text-muted-foreground">{m.library_rule_private()}</p>}
        <CollectionRuleControls
          creating={base.state === 'new'}
          pending={pending}
          conflict={conflict}
          hasFilter={!!filter && !!(currentCsrf ? currentCsrf() : csrfToken)}
          savedId={savedId}
          collectionId={base.state === 'ready' ? base.id : null}
          refresh={() => void refresh()}
        />
        <TechnicalDetails label={m.library_rule_details()}>
          <p className="text-muted-foreground">{m.library_rule_sort()}</p>
          {base.state === 'ready' && (
            <>
              <p className="text-muted-foreground">{m.library_rule_loaded_references()}</p>
              <dl className="flex min-w-0 flex-col gap-2">
                {[
                  { label: m.library_rule_release(), value: base.rule.releaseDigest },
                  { label: m.library_rule_source_generation(), value: base.rule.sourceGeneration },
                  { label: m.library_rule_revision(), value: base.rule.revision },
                  { label: m.library_rule_collection_revision(), value: base.rule.collectionRevision },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="select-text break-all">
                      <code>{value}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </TechnicalDetails>
      </form>
    </article>
  );
}
