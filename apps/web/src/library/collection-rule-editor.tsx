import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { FilterDocument, OwnerLeaf } from '@rezics/filter';
import { parseFilter } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel, FieldGroup } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { ConditionEditor, type ConditionExtension } from '../search/condition-editor';
import { localizedLabel } from '../search/results';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import type { RuleChoicePage, RuleChoices, RulePage } from './collection-rule-read';
import type { RuleWrite } from './collection-rule-actions';
import type { CollectionWriteResult } from './collection-records';

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

function Choice({
  label,
  value,
  choices,
  onChange,
  multiple = false,
}: {
  label: string;
  value: string | readonly string[];
  choices: { id: string; name: string }[];
  onChange(value: string[]): void;
  multiple?: boolean;
}) {
  const selected = typeof value === 'string' ? [value] : value;
  const retained = selected.filter((id) => id && !choices.some((choice) => choice.id === id));
  return (
    <Field>
      <FieldLabel>
        {label}
        <NativeSelect
          multiple={multiple}
          value={multiple ? [...selected] : (selected[0] ?? '')}
          onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
        >
          {!multiple && <NativeSelectOption value="">{m.condition_choose_value()}</NativeSelectOption>}
          {retained.map((id) => (
            <NativeSelectOption key={id} value={id}>
              {id} · {m.library_rule_retained()}
            </NativeSelectOption>
          ))}
          {choices.map((choice) => (
            <NativeSelectOption key={choice.id} value={choice.id}>
              {choice.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FieldLabel>
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
        <>
          <p className="text-sm text-muted-foreground">{owner.state.stateSetId}</p>
          <Choice
            label={m.library_rule_state()}
            multiple
            value={owner.state.in}
            choices={
              profile?.entryStateSet?.id === owner.state.stateSetId
                ? profile.entryStateSet.states.map(({ id, labels }) => ({ id, name: label(labels) }))
                : []
            }
            onChange={(selected) => onChange({ owner: { state: { ...owner.state, in: selected } } })}
          />
        </>
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

type EditorProps = {
  page: RulePage;
  viewerId: string | null;
  collectionId: string | null;
  admitted: readonly string[] | undefined;
  save(input: RuleWrite, csrfToken: string): Promise<CollectionWriteResult>;
  reload(): Promise<RulePage>;
  labels?: ((q: string, cursor?: string) => Promise<RuleChoicePage | null>) | undefined;
  csrfToken: string;
  navigate?: ((id: string) => void) | undefined;
};

const pageIdentity = (page: RulePage) =>
  page.state === 'ready' || page.state === 'new' ? JSON.stringify([page.viewerId, page.intent]) : null;

/** Scope changes retire private state synchronously; a cached page needs a fresh private read to return. */
export function CollectionRuleEditor(props: EditorProps) {
  const { page, viewerId, collectionId, csrfToken, admitted } = props;
  const canRead =
    !!viewerId &&
    !!csrfToken &&
    !!admitted?.includes(collectionId === null ? 'collection.create' : 'collection_rule.get');
  const canSave = !!admitted?.includes(collectionId === null ? 'collection.create' : 'collection_rule.update');
  const canLabel = !!admitted?.includes('library_label.list');
  const scope = JSON.stringify([viewerId, collectionId, canRead, canSave, canLabel]);
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
    boundary = { scope, source: page, epoch: boundary.epoch + 1, retired, seen };
    setBoundary(boundary);
  }
  return (
    <RuleLifetime
      key={scope}
      {...props}
      epoch={boundary.epoch}
      retired={boundary.retired}
      seen={boundary.seen}
      authorized={canRead && canSave}
      canLabel={canLabel}
    />
  );
}

// A synchronous lock and a mounted generation belong to this page, never to replacement IO.
function useRuleWork(epoch: number) {
  const work = useRef({ active: true, locked: false });
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    const current = { active: true, locked: false };
    work.current = current;
    setPending(false);
    return () => {
      current.active = false;
    };
  }, [epoch]);
  function start() {
    const current = work.current;
    if (!current.active || current.locked) return null;
    current.locked = true;
    setPending(true);
    return {
      current: () => current.active,
      finish: () => {
        if (!current.active) return;
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
  const work = useRuleWork(epoch);
  function accepts(value: RulePage): value is AvailablePage {
    return (
      authorized &&
      (value.state === 'ready' || value.state === 'new') &&
      value.viewerId === viewerId &&
      !retired.has(pageIdentity(value)!) &&
      (value.state === 'ready' ? value.id === collectionId : collectionId === null)
    );
  }
  function remember(value: AvailablePage) {
    seen.add(pageIdentity(value)!);
  }
  async function retry() {
    if (!authorized) return;
    const operation = work.start();
    if (!operation) return;
    try {
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
  return accepts(current) ? (
    <RuleForm
      page={current}
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
  save,
  reload,
  labels,
  csrfToken,
  navigate,
  viewerId,
  epoch,
  canLabel,
  accepts,
  remember,
}: Omit<EditorProps, 'page' | 'admitted'> & {
  page: AvailablePage;
  epoch: number;
  canLabel: boolean;
  accepts(value: RulePage): value is AvailablePage;
  remember(value: AvailablePage): void;
}) {
  const [base, setBase] = useState(page);
  const [title, setTitle] = useState(page.state === 'ready' ? page.title : '');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState<FilterDocument | undefined>(
    page.state === 'ready' ? page.rule.filter : { and: [presence] },
  );
  const [choices, setChoices] = useState(page.choices);
  const [query, setQuery] = useState('');
  const { pending, start } = useRuleWork(epoch);
  const [feedback, setFeedback] = useState('');
  const [conflict, setConflict] = useState(false);
  const [intent, setIntent] = useState<{ fingerprint: string; key: string } | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const extension: ConditionExtension = {
    choices: [
      { label: m.library_rule_presence(), value: presence },
      { label: m.library_rule_state(), value: { owner: { state: { profileId: '', stateSetId: '', in: [] } } } },
      { label: m.library_rule_label(), value: { owner: { label: { id: '' } } } },
      { label: m.library_rule_session(), value: { owner: { session: { profileId: '', lifecycle: 'active' } } } },
      { label: m.library_rule_holding(), value: { owner: { holding: { profileId: '' } } } },
    ],
    render: (value, onChange): ReactNode =>
      'owner' in value ? <OwnerFields value={value} onChange={onChange} choices={choices} /> : null,
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!csrfToken || conflict || !filter || savedId) return;
    const operation = start();
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
    const fingerprint = JSON.stringify(draft);
    const key = intent?.fingerprint === fingerprint ? intent.key : intent === null ? base.intent : crypto.randomUUID();
    setIntent({ fingerprint, key });
    setFeedback('');
    try {
      const result = await save({ ...draft, idempotencyKey: key }, csrfToken);
      if (!operation.current()) return;
      if (result.ok) {
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
    const operation = start();
    if (!operation) return;
    try {
      const current = await reload();
      if (!operation.current()) return;
      if (accepts(current)) {
        remember(current);
        setBase(current);
        setChoices(current.choices);
        setConflict(false);
        setSavedId(null);
        setFeedback(m.library_rule_reloaded());
        // The draft remains intact. Only an explicit subsequent save uses this captured current rule revision.
      } else setFeedback(current.state === 'denied' ? m.library_rule_denied() : m.library_rule_unavailable());
    } catch {
      if (operation.current()) setFeedback(m.library_rule_unavailable());
    } finally {
      operation.finish();
    }
  }
  async function labelPage(cursor?: string) {
    if (!labels || !canLabel) return;
    const operation = start();
    if (!operation) return;
    try {
      const result = await labels(query, cursor);
      if (!operation.current()) return;
      if (result?.viewerId === viewerId) setChoices(result.choices);
      else setFeedback(m.library_rule_unavailable());
    } catch {
      if (operation.current()) setFeedback(m.library_rule_unavailable());
    } finally {
      operation.finish();
    }
  }
  return (
    <article className="flex max-w-4xl flex-col gap-6 text-foreground">
      <PageHeading>{base.state === 'new' ? m.library_rule_new() : m.library_rule_edit()}</PageHeading>
      <p>{m.library_rule_private()}</p>
      {base.state === 'ready' && (
        <p className="break-all text-sm text-muted-foreground">
          {m.library_rule_release()} {base.rule.releaseDigest}
        </p>
      )}
      <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-6">
        <fieldset disabled={pending || !!savedId} className="min-w-0">
          <FieldGroup>
            {base.state === 'new' && (
              <>
                <Field>
                  <FieldLabel>
                    {m.library_collection_title()}
                    <Input
                      required
                      maxLength={512}
                      value={title}
                      onChange={(event) => setTitle(event.currentTarget.value)}
                    />
                  </FieldLabel>
                </Field>
                <Field>
                  <FieldLabel>
                    {m.library_collection_description()}
                    <Input
                      value={description}
                      maxLength={20000}
                      onChange={(event) => setDescription(event.currentTarget.value)}
                    />
                  </FieldLabel>
                </Field>
              </>
            )}
            <p>{m.library_rule_sort()}</p>
            {choices.release.state !== 'ready' && (
              <p role="status">
                {choices.release.state === 'preparing'
                  ? m.library_rule_preparing()
                  : m.condition_metadata_unavailable()}
              </p>
            )}
            {choices.labels.state !== 'ready' && (
              <p role="status">
                {choices.labels.state === 'preparing'
                  ? m.library_rule_preparing()
                  : m.library_rule_labels_unavailable()}
              </p>
            )}
            {labels && canLabel && (
              <Field>
                <FieldLabel>
                  {m.library_rule_label_search()}
                  <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
                </FieldLabel>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => void labelPage()}>
                    {m.search_apply()}
                  </Button>
                  {choices.labels.next && (
                    <Button type="button" variant="outline" onClick={() => void labelPage(choices.labels.next!)}>
                      {m.library_label_more()}
                    </Button>
                  )}
                </div>
              </Field>
            )}
            <ConditionEditor
              value={filter}
              onChange={setFilter}
              locale={getLocale()}
              metadata={choices.release.metadata ?? { types: {}, properties: {} }}
              extension={extension}
              embedded
            />
          </FieldGroup>
        </fieldset>
        {feedback && <p role="alert">{feedback}</p>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={pending || conflict || !filter || !!savedId}>
            {pending
              ? m.library_collection_save_pending()
              : base.state === 'new'
                ? m.library_collection_create()
                : m.library_collection_save()}
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => void refresh()}>
            {m.library_collection_reload()}
          </Button>
        </div>
        {savedId && (
          <a href={`/${getLocale()}/collections/${encodeURIComponent(savedId)}`}>{m.library_rule_members()}</a>
        )}
        {base.state === 'ready' && (
          <a href={`/${getLocale()}/collections/${encodeURIComponent(base.id)}`}>{m.library_rule_members()}</a>
        )}
      </form>
    </article>
  );
}
