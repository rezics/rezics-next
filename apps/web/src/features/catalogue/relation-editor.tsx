import { useRef, useState } from 'react';
import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { EntityPicker, type EntityPickerSubject, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { CandidateValue } from '../pages/data';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { candidateContext, type Candidate, type CandidateFailure } from '../../subject/candidates';
import {
  relationDraft,
  relationSlotMatches,
  validRelationSlot,
  type RelationDraft,
  type RelationRead,
  type RelationSlot,
  type RelationConfirmation,
  type RelationResult,
  type RelationProposal,
  type RelationTransport,
  type RelationQualifier,
} from '../../subject/relation-candidates';

type Snak = RelationDraft['qualifiers'][number];
const blankDraft = (property: string): RelationDraft => ({
  property: { id: property, data_type: 'wikibase-item' },
  value: { type: 'somevalue' },
  qualifiers: [],
  references: [],
});

/** One contribution and exact-slot comparison; all mutations belong to explicit confirmation events. */
export function RelationEditor({
  id,
  locale,
  transport,
  search,
  initial,
  onSelected,
}: {
  id: string;
  locale: string;
  transport: RelationTransport;
  search: EntityPickerSearch;
  initial?: RelationRead;
  onSelected?: () => void | Promise<void>;
}) {
  const options = { locale: locale as never };
  const [read, setRead] = useState(initial);
  const [draft, setDraft] = useState<RelationDraft>(() => blankDraft(''));
  const [slot, setSlot] = useState<RelationSlot>();
  const [candidate, setCandidate] = useState<Candidate>();
  const [rank, setRank] = useState<'normal' | 'preferred'>('normal');
  const [citation, setCitation] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CandidateFailure | undefined>(initial && !initial.ok ? initial : undefined);
  const [confirmation, setConfirmation] = useState<'propose' | 'accept' | 'reject' | 'adopt'>();
  const [result, setResult] = useState<Extract<RelationResult, { ok: true }>>();
  const [proposed, setProposed] = useState(false);
  const request = useRef<RelationProposal | RelationConfirmation | undefined>(undefined);
  const running = useRef(false);
  const picked = useRef<Record<string, EntityPickerSubject>>({});
  const remember = (items: EntityPickerSubject[]) => {
    for (const item of items) picked.current[item.id] = item;
  };
  const current = read?.ok ? read : undefined;
  const field = current?.fields.find((field) => field.id === draft.property.id);
  const publicRead = result?.public ?? current?.public;
  const concealed = failure?.reason === 'denied';
  const uncertain = failure?.reason === 'unavailable' && !!request.current;
  const frozen = busy || !!confirmation || uncertain || failure?.reason === 'stale';
  const name = (property: string) =>
    pickText(current?.names[property] ?? {}, locale).text || m.subject_value_unlabelled({}, options);
  const target = (value: unknown): EntityPickerSubject[] =>
    typeof value === 'string'
      ? [
          picked.current[value] ?? {
            id: value,
            title:
              pickText(current?.public.related[value]?.labels ?? {}, locale).text ||
              m.subject_value_unlabelled({}, options),
            types: [],
            typeLabel: '',
            cover: null,
          },
        ]
      : [];
  const selected =
    !!candidate &&
    !!slot &&
    !!field &&
    !!publicRead?.subject.statements[slot.property]?.some(
      (statement) =>
        statement.id === candidate.id && statement.rank !== 'deprecated' && relationSlotMatches(statement, slot, field),
    );

  function draftSlot(next = draft): RelationSlot | undefined {
    if (!field || !next.property.id) return;
    if (next.value.type === 'value' && typeof next.value.content === 'string') {
      const key = field.slotKey && next.qualifiers.find((snak) => snak.property.id === field.slotKey);
      const address = {
        property: next.property.id,
        target: next.value.content,
        ...(key && key.value.type === 'value' ? { key: String(key.value.content) } : {}),
      };
      return validRelationSlot(address) ? address : undefined;
    }
    const external = next.qualifiers.find((snak) => snak.property.id === 'schema:sameAs');
    if (
      next.value.type === 'somevalue' &&
      external?.value.type === 'value' &&
      typeof external.value.content === 'string'
    )
      return { property: next.property.id, sameAs: external.value.content };
  }
  function edit(next: RelationDraft) {
    setDraft(next);
    setSlot(undefined);
    setCandidate(undefined);
    setResult(undefined);
    setProposed(false);
    setFailure(undefined);
    request.current = undefined;
  }
  async function load(address = slot, cursor?: string) {
    if (running.current || uncertain) return;
    running.current = true;
    setBusy(true);
    setSlot(address);
    setFailure(undefined);
    setConfirmation(undefined);
    request.current = undefined;
    try {
      const next = await transport.read(address, cursor);
      if (!next.ok) {
        setFailure(next);
        return;
      }
      setRead(next);
      setSlot(address);
      setResult(undefined);
      setCandidate((previous) => next.page?.candidates.find((item) => item.id === previous?.id));
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  async function confirm() {
    if (running.current || !confirmation || !field) return;
    const address = confirmation === 'propose' ? draftSlot() : slot;
    if (!address || (!candidate && confirmation !== 'propose')) return;
    request.current ??=
      confirmation === 'propose'
        ? { id, slot: address, statement: structuredClone(draft), key: crypto.randomUUID() }
        : {
            id,
            slot: address,
            candidate: candidate!.id,
            operation: confirmation,
            head: confirmation !== 'adopt' ? candidate!.head : (current?.page?.adoption?.head ?? null),
            rank,
            key: crypto.randomUUID(),
          };
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const pending = request.current;
      if ('statement' in pending) {
        const next = await transport.propose(pending);
        if (!next.ok) {
          setFailure(next);
          return;
        }
        setProposed(true);
        setSlot(address);
        setConfirmation(undefined);
        request.current = undefined;
        const refreshed = await transport.read(address);
        if (refreshed.ok) {
          setRead(refreshed);
          setCandidate(refreshed.page?.candidates.find((item) => item.id === next.candidate));
        } else setFailure(refreshed);
      } else {
        const next = await transport.confirm(pending);
        if (!next.ok) {
          setFailure(next);
          return;
        }
        setResult(next);
        setConfirmation(undefined);
        request.current = undefined;
        if (next.kind === 'selected') await onSelected?.();
      }
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  const failureText =
    failure &&
    {
      denied: m.candidate_denied({}, options),
      stale: m.relation_stale({}, options),
      invalid: m.candidate_invalid({}, options),
      unavailable: m.candidate_unavailable({}, options),
    }[failure.reason];
  const action =
    confirmation === 'propose'
      ? m.relation_propose({}, options)
      : confirmation === 'accept'
        ? m.candidate_accept({}, options)
        : confirmation === 'reject'
          ? m.relation_reject({}, options)
          : m.candidate_adopt({}, options);
  return (
    <section aria-label={m.relation_title({}, options)} className="min-w-0 space-y-6" aria-busy={busy}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{m.relation_title({}, options)}</h1>
        <p className="text-sm text-muted-foreground">{m.relation_intro({}, options)}</p>
      </header>
      {busy && <p role="status">{m.candidate_loading({}, options)}</p>}
      {failureText && <p role="alert">{failureText}</p>}
      {!current && !busy && <Button onClick={() => load()}>{m.relation_open({}, options)}</Button>}
      {current && current.public.subject.context !== candidateContext ? (
        <p>{m.relation_context({}, options)}</p>
      ) : (
        current &&
        !concealed && (
          <>
            {!current.fields.length ? (
              <p>{m.relation_no_fields({}, options)}</p>
            ) : (
              <>
                <fieldset disabled={frozen} className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4">
                  <legend className="px-1 font-semibold">{m.relation_draft({}, options)}</legend>
                  <Field>
                    <FieldLabel htmlFor="relation-property">{m.relation_property({}, options)}</FieldLabel>
                    <NativeSelect
                      id="relation-property"
                      value={draft.property.id}
                      onChange={(event) => {
                        edit(blankDraft(event.target.value));
                        setCitation('');
                      }}
                    >
                      <NativeSelectOption value="">{m.candidate_choose_field({}, options)}</NativeSelectOption>
                      {current.fields.map((item) => (
                        <NativeSelectOption key={item.id} value={item.id}>
                          {item.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  {field && (
                    <>
                      {!!current.public.subject.statements[field.id]?.length && (
                        <div className="space-y-2">
                          <p className="text-sm font-medium">{m.relation_existing({}, options)}</p>
                          {current.public.subject.statements[field.id]!.map((statement) => (
                            <div key={statement.id} className="space-y-2 rounded-lg border border-border p-3">
                              <Statement
                                statement={statement}
                                publicRead={current.public}
                                names={current.names}
                                locale={locale}
                              />
                              <Button
                                variant="outline"
                                onClick={() => {
                                  edit(relationDraft(statement));
                                  setCitation('');
                                }}
                              >
                                {m.relation_edit_existing({}, options)}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                      <EntityPicker
                        label={m.relation_target({}, options)}
                        search={search}
                        src={coverSrc}
                        disabled={frozen}
                        value={draft.value.type === 'value' ? target(draft.value.content) : []}
                        onValueChange={(items) => {
                          remember(items);
                          edit({
                            ...draft,
                            value: items[0] ? { type: 'value', content: items[0].id } : { type: 'somevalue' },
                          });
                        }}
                      />
                      {draft.value.type === 'somevalue' && (
                        <p className="text-sm">{m.relation_unresolved({}, options)}</p>
                      )}
                      <div className="space-y-3">
                        {draft.qualifiers.map((snak, index) => (
                          <div key={`${snak.property.id}:${index}`} className="flex min-w-0 items-end gap-2">
                            <div className="min-w-0 flex-1">
                              <QualifierInput
                                definition={field.qualifiers.find((item) => item.id === snak.property.id)}
                                snak={snak}
                                index={index}
                                label={name(snak.property.id)}
                                search={search}
                                target={target}
                                remember={remember}
                                disabled={frozen}
                                onChange={(value) =>
                                  edit({
                                    ...draft,
                                    qualifiers: draft.qualifiers.map((item, at) =>
                                      at === index ? { ...item, value } : item,
                                    ),
                                  })
                                }
                              />
                            </div>
                            <Button
                              variant="outline"
                              aria-label={`${m.relation_remove({}, options)}: ${name(snak.property.id)}`}
                              onClick={() =>
                                edit({ ...draft, qualifiers: draft.qualifiers.filter((_, at) => at !== index) })
                              }
                            >
                              {m.relation_remove({}, options)}
                            </Button>
                          </div>
                        ))}
                        <Field>
                          <FieldLabel htmlFor="relation-add-qualifier">{m.relation_qualifier({}, options)}</FieldLabel>
                          <NativeSelect
                            id="relation-add-qualifier"
                            value=""
                            onChange={(event) => {
                              const definition = field.qualifiers.find((item) => item.id === event.target.value);
                              if (definition)
                                edit({
                                  ...draft,
                                  qualifiers: [
                                    ...draft.qualifiers,
                                    {
                                      property: { id: definition.id, data_type: definition.datatype },
                                      value: { type: 'value', content: '' },
                                    },
                                  ],
                                });
                            }}
                          >
                            <NativeSelectOption value="">{m.relation_add_qualifier({}, options)}</NativeSelectOption>
                            {field.qualifiers
                              .filter((item) =>
                                ['string', 'external-id', 'url', 'wikibase-item'].includes(item.datatype),
                              )
                              .map((item) => (
                                <NativeSelectOption key={item.id} value={item.id}>
                                  {item.label}
                                </NativeSelectOption>
                              ))}
                          </NativeSelect>
                        </Field>
                      </div>
                      {!!draft.references.length && (
                        <div className="space-y-2">
                          <p className="text-sm font-medium">{m.candidate_source({}, options)}</p>
                          {draft.references.map((reference, index) => (
                            <div key={index}>
                              {reference.parts.map((snak, at) => (
                                <CandidateValue key={at} snak={snak} related={current.public.related} locale={locale} />
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                      <Field>
                        <FieldLabel htmlFor="relation-citation">{m.relation_citation({}, options)}</FieldLabel>
                        <Input
                          id="relation-citation"
                          type="url"
                          value={citation}
                          onChange={(event) => setCitation(event.target.value)}
                        />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={!/^https?:\/\/\S+$/.test(citation)}
                          onClick={() => {
                            edit({
                              ...draft,
                              references: [
                                ...draft.references,
                                {
                                  parts: [
                                    {
                                      property: { id: 'schema:url', data_type: 'url' },
                                      value: { type: 'value', content: citation },
                                    },
                                  ],
                                },
                              ],
                            });
                            setCitation('');
                          }}
                        >
                          {m.relation_add_citation({}, options)}
                        </Button>
                        <Button variant="outline" disabled={!draftSlot()} onClick={() => load(draftSlot())}>
                          {m.relation_review_slot({}, options)}
                        </Button>
                        <Button
                          disabled={!draftSlot() || !draft.references.length || proposed}
                          onClick={() => setConfirmation('propose')}
                        >
                          {m.relation_propose({}, options)}
                        </Button>
                      </div>
                    </>
                  )}
                </fieldset>
                {slot && field && current.page && (
                  <section className="space-y-4" aria-label={m.relation_review_slot({}, options)}>
                    <h2 className="text-lg font-semibold">{m.relation_review_slot({}, options)}</h2>
                    {publicRead?.subject.resolution[slot.property] === 'unresolved' && (
                      <p>{m.relation_unresolved_selection({}, options)}</p>
                    )}
                    <p className="text-sm text-muted-foreground">{m.relation_slot_hint({}, options)}</p>
                    {!current.page.candidates.length && <p>{m.candidate_empty({}, options)}</p>}
                    <ul className="space-y-3">
                      {current.page.candidates.map((item) => (
                        <li key={item.id} className="space-y-2 rounded-lg border border-border p-3">
                          <Statement
                            statement={item.statement}
                            publicRead={current.public}
                            names={current.names}
                            locale={locale}
                          />
                          <p>
                            {item.decision === 'accepted'
                              ? m.relation_accepted({}, options)
                              : item.decision === 'rejected'
                                ? m.relation_rejected({}, options)
                                : m.relation_unreviewed({}, options)}
                            {item.rank && item.rank !== 'deprecated'
                              ? ` · ${item.rank === 'preferred' ? m.relation_preferred({}, options) : m.relation_normal({}, options)}`
                              : ''}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {item.source && 'source' in item.source
                              ? m.candidate_provenance({}, options)
                              : m.candidate_editorial({}, options)}
                          </p>
                          {item.source && 'source' in item.source && (
                            <details>
                              <summary>{m.candidate_provenance({}, options)}</summary>
                              <p>
                                {item.source.source} · {item.source.external_id}
                              </p>
                              <p>
                                {m.candidate_source_revision({}, options)}: {item.source.record_revision}
                              </p>
                              <p>
                                {m.candidate_converter({}, options)}: {item.source.converter_revision}
                              </p>
                            </details>
                          )}
                          <Button
                            variant="outline"
                            disabled={frozen || item.retracted !== null || item.rank === 'deprecated'}
                            onClick={() => {
                              setCandidate(item);
                              setResult(undefined);
                              setFailure(undefined);
                              request.current = undefined;
                            }}
                          >
                            {item.retracted !== null
                              ? m.candidate_retracted({}, options)
                              : item.rank === 'deprecated'
                                ? m.relation_deprecated({}, options)
                                : m.candidate_review({}, options)}
                          </Button>
                        </li>
                      ))}
                    </ul>
                    {current.page.next && (
                      <Button variant="outline" disabled={frozen} onClick={() => load(slot, current.page!.next!)}>
                        {m.candidate_more({}, options)}
                      </Button>
                    )}
                    {candidate && (
                      <div className="space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                          <section className="min-w-0 space-y-2 rounded-lg bg-muted p-4">
                            <h3 className="font-semibold">{m.candidate_current({}, options)}</h3>
                            {publicRead?.subject.statements[slot.property]?.filter((item) =>
                              relationSlotMatches(item, slot, field),
                            ).length ? (
                              publicRead.subject.statements[slot.property]!.filter((item) =>
                                relationSlotMatches(item, slot, field),
                              ).map((item) => (
                                <Statement
                                  key={item.id}
                                  statement={item}
                                  publicRead={publicRead}
                                  names={current.names}
                                  locale={locale}
                                />
                              ))
                            ) : (
                              <p>{m.candidate_no_current({}, options)}</p>
                            )}
                          </section>
                          <section className="min-w-0 space-y-2 rounded-lg border border-border p-4">
                            <h3 className="font-semibold">{m.candidate_proposed({}, options)}</h3>
                            <Statement
                              statement={candidate.statement}
                              publicRead={current.public}
                              names={current.names}
                              locale={locale}
                            />
                          </section>
                        </div>
                        {selected ? (
                          <p role="status">{m.candidate_selected({}, options)}</p>
                        ) : result ? (
                          <p role="status">
                            {result.kind === 'accepted'
                              ? m.candidate_accepted({}, options)
                              : result.kind === 'rejected'
                                ? m.relation_rejected({}, options)
                                : m.candidate_pending({}, options)}
                          </p>
                        ) : (
                          !confirmation && (
                            <>
                              {candidate.decision === 'accepted' && (
                                <Field>
                                  <FieldLabel htmlFor="relation-rank">{m.relation_rank({}, options)}</FieldLabel>
                                  <NativeSelect
                                    id="relation-rank"
                                    value={rank}
                                    disabled={frozen}
                                    onChange={(event) => setRank(event.target.value as 'normal' | 'preferred')}
                                  >
                                    <NativeSelectOption value="normal">
                                      {m.relation_normal({}, options)}
                                    </NativeSelectOption>
                                    <NativeSelectOption value="preferred">
                                      {m.relation_preferred({}, options)}
                                    </NativeSelectOption>
                                  </NativeSelect>
                                </Field>
                              )}
                              <Button
                                disabled={frozen || candidate.retracted !== null}
                                onClick={() => setConfirmation(candidate.decision === 'accepted' ? 'adopt' : 'accept')}
                              >
                                {candidate.decision === 'accepted'
                                  ? m.candidate_adopt({}, options)
                                  : m.candidate_accept({}, options)}
                              </Button>
                              {candidate.decision !== 'rejected' && (
                                <Button variant="outline" disabled={frozen} onClick={() => setConfirmation('reject')}>
                                  {m.relation_reject({}, options)}
                                </Button>
                              )}
                            </>
                          )
                        )}
                        {selected && publicRead && (
                          <a
                            className="text-primary underline"
                            href={
                              subjectHref({ id, label: pickText(publicRead.subject.labels, locale).text }, locale).href
                            }
                          >
                            {m.candidate_view_public({}, options)}
                          </a>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </>
        )
      )}
      {proposed && <p role="status">{m.relation_proposed({}, options)}</p>}
      {confirmation && !concealed && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold">{m.candidate_confirm_title({ action }, options)}</h2>
          <p>
            {confirmation === 'adopt'
              ? m.relation_confirm_adopt({}, options)
              : confirmation === 'accept'
                ? m.candidate_confirm_accept({}, options)
                : confirmation === 'reject'
                  ? m.relation_confirm_reject({}, options)
                  : m.relation_confirm_propose({}, options)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || (!!failure && failure.reason !== 'unavailable')} onClick={confirm}>
              {action}
            </Button>
            <Button variant="outline" disabled={busy || !!request.current} onClick={() => setConfirmation(undefined)}>
              {m.candidate_cancel({}, options)}
            </Button>
          </div>
        </div>
      )}
      {current && !uncertain && (
        <Button variant="outline" disabled={busy} onClick={() => load(slot)}>
          {m.candidate_reload({}, options)}
        </Button>
      )}
    </section>
  );
}

function QualifierInput({
  definition,
  snak,
  index,
  label,
  search,
  target,
  remember,
  disabled,
  onChange,
}: {
  definition: RelationQualifier | undefined;
  snak: Snak;
  index: number;
  label: string;
  search: EntityPickerSearch;
  target: (value: unknown) => EntityPickerSubject[];
  remember: (items: EntityPickerSubject[]) => void;
  disabled: boolean;
  onChange: (value: Snak['value']) => void;
}) {
  const value = snak.value.type === 'value' ? snak.value.content : undefined;
  if (definition?.datatype === 'wikibase-item')
    return (
      <EntityPicker
        label={label}
        search={search}
        src={coverSrc}
        disabled={disabled}
        value={value ? target(value) : []}
        onValueChange={(items) => {
          remember(items);
          onChange({ type: 'value', content: items[0]?.id ?? '' });
        }}
      />
    );
  return (
    <Field>
      <FieldLabel htmlFor={`relation-qualifier-${index}`}>{label}</FieldLabel>
      <Input
        id={`relation-qualifier-${index}`}
        value={typeof value === 'string' ? value : ''}
        readOnly={typeof value !== 'string'}
        onChange={(event) => onChange({ type: 'value', content: event.target.value })}
      />
    </Field>
  );
}

function Statement({
  statement,
  publicRead,
  names,
  locale,
}: {
  statement: RelationDraft;
  publicRead: SubjectRead;
  names: Record<string, Record<string, string>>;
  locale: string;
}) {
  return (
    <div className="min-w-0 space-y-1 break-words text-sm">
      <CandidateValue snak={statement} related={publicRead.related} locale={locale} />
      {statement.qualifiers.map((snak, index) => (
        <div key={index}>
          <span className="text-muted-foreground">
            {pickText(names[snak.property.id] ?? {}, locale).text ||
              m.subject_value_unlabelled({}, { locale: locale as never })}
            :{' '}
          </span>
          <CandidateValue snak={snak} related={publicRead.related} locale={locale} />
        </div>
      ))}
      {statement.references.map((reference, index) => (
        <div key={index}>
          {reference.parts.map((snak, at) => (
            <CandidateValue key={at} snak={snak} related={publicRead.related} locale={locale} />
          ))}
        </div>
      ))}
    </div>
  );
}
