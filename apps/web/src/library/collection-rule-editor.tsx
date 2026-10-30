import { useState, type FormEvent, type ReactNode } from 'react';
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
import type { RuleChoices, RulePage } from './collection-rule-read';
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

export function CollectionRuleEditor({
  page,
  save,
  reload,
  labels,
  csrfToken,
  navigate,
}: {
  page: RulePage;
  save(input: RuleWrite, csrfToken: string): Promise<CollectionWriteResult>;
  reload(): Promise<RulePage>;
  labels?(q: string, cursor?: string): Promise<RuleChoices | null>;
  csrfToken: string;
  navigate?(id: string): void;
}) {
  const [retried, setRetried] = useState<RulePage | null>(null);
  const current = retried ?? page;
  return current.state === 'new' || current.state === 'ready' ? (
    <RuleForm
      key={current.state === 'new' ? 'new' : current.id}
      page={current}
      save={save}
      reload={reload}
      labels={labels}
      csrfToken={csrfToken}
      navigate={navigate}
    />
  ) : (
    <div role="alert">
      <p>{current.state === 'denied' ? m.library_rule_denied() : m.library_rule_unavailable()}</p>
      <Button
        type="button"
        onClick={() =>
          void reload()
            .then(setRetried)
            .catch(() => setRetried({ state: 'unavailable' }))
        }
      >
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
}: {
  page: AvailablePage;
  save(input: RuleWrite, csrfToken: string): Promise<CollectionWriteResult>;
  reload(): Promise<RulePage>;
  labels?: ((q: string, cursor?: string) => Promise<RuleChoices | null>) | undefined;
  csrfToken: string;
  navigate?: ((id: string) => void) | undefined;
}) {
  const [base, setBase] = useState(page);
  const [title, setTitle] = useState(page.state === 'ready' ? page.title : '');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState<FilterDocument | undefined>(
    page.state === 'ready' ? page.rule.filter : { and: [presence] },
  );
  const [choices, setChoices] = useState(page.choices);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
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
    if (pending || conflict || !filter || savedId) return;
    let parsed: FilterDocument;
    try {
      parsed = parseFilter(filter);
    } catch {
      setFeedback(m.condition_invalid());
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
    setPending(true);
    setFeedback('');
    try {
      const result = await save({ ...draft, idempotencyKey: key }, csrfToken);
      if (result.ok) {
        setSavedId(result.id);
        navigate?.(result.id);
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
      setFeedback(m.library_rule_unavailable());
    } finally {
      setPending(false);
    }
  }
  async function refresh() {
    setPending(true);
    try {
      const current = await reload();
      if (current.state === 'ready' || current.state === 'new') {
        setBase(current);
        setChoices(current.choices);
        setConflict(false);
        setIntent(null);
        setSavedId(null);
        setFeedback(m.library_rule_reloaded());
        // The draft remains intact. Only an explicit subsequent save uses this captured current rule revision.
      } else setFeedback(current.state === 'denied' ? m.library_rule_denied() : m.library_rule_unavailable());
    } catch {
      setFeedback(m.library_rule_unavailable());
    } finally {
      setPending(false);
    }
  }
  async function labelPage(cursor?: string) {
    if (!labels) return;
    setPending(true);
    try {
      const result = await labels(query, cursor);
      if (result) setChoices(result);
      else setFeedback(m.library_rule_unavailable());
    } catch {
      setFeedback(m.library_rule_unavailable());
    } finally {
      setPending(false);
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
            {labels && (
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
