import { useRef, useState } from 'react';
import { useId } from 'react';
import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { StatementConsentLink } from './statement-consent-view';
import { consentAddress, type ConsentAddress } from './statement-consent';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { EntityPicker, type EntityPickerSubject, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { CandidateValue } from '../pages/data';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { DefinitionGuideLink } from './definition-guide-view';
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
export { QualifierInput };
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
  composition,
}: {
  id: string;
  locale: string;
  transport: RelationTransport;
  search: EntityPickerSearch;
  initial?: RelationRead;
  onSelected?: () => void | Promise<void>;
  /** A composition correction keeps every non-order qualifier and native slot key intact. */
  composition?: {
    statement: RelationDraft;
    slot?: RelationSlot;
    positionEditable: boolean;
    session?: string | undefined;
  };
}) {
  const options = { locale: locale as never };
  const formId = useId();
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
  const [proposedId, setProposedId] = useState<string>();
  const [compositionSeed, setCompositionSeed] = useState<typeof composition>();
  // Reset only for a different explicit seed; ordinary rerenders preserve the editor's draft and key.
  if (composition && composition !== compositionSeed) {
    setCompositionSeed(composition);
    setDraft(structuredClone(composition.statement));
    setSlot(composition.slot);
  }
  const [ownConsent, setOwnConsent] = useState(false);
  const [consentEntry, setConsentEntry] = useState<ConsentAddress>();
  const nativeSession = useRef<string | undefined>(undefined);
  if (!nativeSession.current && composition?.session) nativeSession.current = composition.session;
  const request = useRef<RelationProposal | RelationConfirmation | undefined>(undefined);
  const pageCursor = useRef<string | undefined>(undefined);
  const running = useRef(false);
  const proposedCandidate = useRef<string | undefined>(undefined);
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
    setOwnConsent(false);
    setConsentEntry(undefined);
    setRead((previous) => (previous?.ok ? { ...previous, page: null } : previous));
    setSlot(undefined);
    setCandidate(undefined);
    setResult(undefined);
    setProposed(false);
    setProposedId(undefined);
    proposedCandidate.current = undefined;
    setFailure(undefined);
    request.current = undefined;
    pageCursor.current = undefined;
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
      const next = await transport.read(address, cursor, nativeSession.current);
      if (!next.ok) {
        setFailure(next);
        return;
      }
      nativeSession.current = next.session ?? nativeSession.current;
      setRead(next);
      pageCursor.current = cursor;
      setSlot(address);
      setResult(undefined);
      setCandidate((previous) => next.page?.candidates.find((item) => item.id === previous?.id));
      if (proposedCandidate.current)
        setCandidate(next.page?.candidates.find((item) => item.id === proposedCandidate.current));
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
            ...(pageCursor.current ? { cursor: pageCursor.current } : {}),
            ...(nativeSession.current ? { session: nativeSession.current } : {}),
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
        setProposedId(next.candidate);
        proposedCandidate.current = next.candidate;
        nativeSession.current = next.session ?? nativeSession.current;
        if (field.disclosure === 'sourceOrConsent' && !pending.statement.references.length)
          setConsentEntry(
            consentAddress({
              id,
              candidate: next.candidate,
              property: address.property,
              slot: { target: address.target, sameAs: address.sameAs, key: address.key },
            }),
          );
        setSlot(address);
        setConfirmation(undefined);
        request.current = undefined;
        const refreshed = await transport.read(address, undefined, nativeSession.current);
        if (refreshed.ok) {
          pageCursor.current = undefined;
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
        if ('session' in next) nativeSession.current = next.session ?? nativeSession.current;
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
        {composition ? (
          <h2 className="font-sans text-2xl font-semibold">{m.relation_title({}, options)}</h2>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">{m.relation_title({}, options)}</h1>
          </>
        )}
        <p className="text-sm text-muted-foreground">{m.relation_intro({}, options)}</p>
      </header>
      {consentEntry && (
        <StatementConsentLink
          address={consentEntry}
          label={pickText(current?.public.subject.labels ?? {}, locale).text}
          locale={locale}
        />
      )}
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
                    {composition ? (
                      <FieldLabel htmlFor={`${formId}-property`}>{m.relation_property({}, options)}</FieldLabel>
                    ) : (
                      <>
                        <FieldLabel htmlFor="relation-property">{m.relation_property({}, options)}</FieldLabel>
                      </>
                    )}
                    <DefinitionGuideLink
                      locale={locale}
                      field={!!field}
                      address={{
                        type: current.public.subject.type,
                        property: field?.id,
                        returnTo: `${subjectHref({ id, label: pickText(current.public.subject.labels, locale).text }, locale).href}/relation-edit`,
                      }}
                    />
                    <NativeSelect
                      id="relation-property"
                      {...(composition ? { id: `${formId}-property` } : {})}
                      disabled={!!composition}
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
                      {!composition && (
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
                        </>
                      )}
                      <EntityPicker
                        label={m.relation_target({}, options)}
                        search={search}
                        src={coverSrc}
                        disabled={frozen}
                        {...(composition ? { disabled: true } : {})}
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
                              <fieldset
                                disabled={
                                  !!composition &&
                                  (!composition.positionEditable ||
                                    snak.property.id !== 'schema:position' ||
                                    !field.qualifiers.some((item) => item.id === 'schema:position'))
                                }
                              >
                                <QualifierInput
                                  definition={field.qualifiers.find((item) => item.id === snak.property.id)}
                                  snak={snak}
                                  index={index}
                                  label={name(snak.property.id)}
                                  scope={composition ? formId : undefined}
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
                              </fieldset>
                            </div>
                            <Button
                              variant="outline"
                              disabled={!!composition}
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
                          {composition ? (
                            <FieldLabel htmlFor={`${formId}-add-qualifier`}>
                              {m.relation_qualifier({}, options)}
                            </FieldLabel>
                          ) : (
                            <>
                              <FieldLabel htmlFor="relation-add-qualifier">
                                {m.relation_qualifier({}, options)}
                              </FieldLabel>
                            </>
                          )}
                          <NativeSelect
                            id="relation-add-qualifier"
                            {...(composition ? { id: `${formId}-add-qualifier` } : {})}
                            disabled={
                              !!composition &&
                              (!composition.positionEditable ||
                                draft.qualifiers.some((part) => part.property.id === 'schema:position'))
                            }
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
                              .filter((item) => !composition || item.id === 'schema:position')
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
                        {composition ? (
                          <FieldLabel htmlFor={`${formId}-citation`}>{m.relation_citation({}, options)}</FieldLabel>
                        ) : (
                          <>
                            <FieldLabel htmlFor="relation-citation">{m.relation_citation({}, options)}</FieldLabel>
                          </>
                        )}
                        <Input
                          id="relation-citation"
                          {...(composition ? { id: `${formId}-citation` } : {})}
                          type="url"
                          value={citation}
                          onChange={(event) => setCitation(event.target.value)}
                        />
                      </Field>
                      {field.disclosure === 'sourceOrConsent' && !draft.references.length && (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">{m.statement_consent_unsourced({}, options)}</p>
                          <Field orientation="horizontal">
                            <Checkbox
                              id="relation-own-consent"
                              {...(composition ? { id: `${formId}-own-consent` } : {})}
                              checked={ownConsent}
                              onCheckedChange={(checked) => setOwnConsent(checked === true)}
                            />
                            {composition ? (
                              <FieldLabel htmlFor={`${formId}-own-consent`}>
                                {m.statement_consent_own({}, options)}
                              </FieldLabel>
                            ) : (
                              <>
                                <FieldLabel htmlFor="relation-own-consent">
                                  {m.statement_consent_own({}, options)}
                                </FieldLabel>
                              </>
                            )}
                          </Field>
                        </div>
                      )}
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
                          disabled={
                            !draftSlot() ||
                            (!draft.references.length && !(field.disclosure === 'sourceOrConsent' && ownConsent)) ||
                            proposed
                          }
                          onClick={() => setConfirmation('propose')}
                        >
                          {m.relation_propose({}, options)}
                        </Button>
                      </div>
                    </>
                  )}
                  {composition && !field && <p role="status">{m.work_parts_not_admitted({}, options)}</p>}
                </fieldset>
                {slot && field && current.page && (
                  <section className="space-y-4" aria-label={m.relation_review_slot({}, options)}>
                    <h2 className="text-lg font-semibold">{m.relation_review_slot({}, options)}</h2>
                    {publicRead?.subject.resolution[slot.property] === 'unresolved' && (
                      <p>{m.relation_unresolved_selection({}, options)}</p>
                    )}
                    <p className="text-sm text-muted-foreground">{m.relation_slot_hint({}, options)}</p>
                    {composition && (
                      <p className="break-all text-xs">
                        {id} · {slot.property} · {slot.target ?? slot.sameAs} {slot.key ?? ''}
                      </p>
                    )}
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
                    {candidate &&
                      field.disclosure === 'sourceOrConsent' &&
                      !candidate.statement.references.length &&
                      candidate.retracted === null && (
                        <StatementConsentLink
                          address={{ id, property: field.id, candidate: candidate.id, ...(slot ? { slot } : {}) }}
                          label={pickText(current.public.subject.labels, locale).text}
                          locale={locale}
                        />
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
                                  {composition ? (
                                    <FieldLabel htmlFor={`${formId}-rank`}>{m.relation_rank({}, options)}</FieldLabel>
                                  ) : (
                                    <>
                                      <FieldLabel htmlFor="relation-rank">{m.relation_rank({}, options)}</FieldLabel>
                                    </>
                                  )}
                                  <NativeSelect
                                    id="relation-rank"
                                    {...(composition ? { id: `${formId}-rank` } : {})}
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
      {composition && proposedId && (
        <p className="break-all text-sm">{m.work_parts_candidate({ candidate: proposedId }, options)}</p>
      )}
      {confirmation && !concealed && (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action }, options)}
          className="space-y-3 rounded-lg border border-border bg-card p-4"
        >
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
          {composition && confirmation === 'propose' && current && (
            <Statement statement={draft} publicRead={current.public} names={current.names} locale={locale} />
          )}
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
        <Button variant="outline" disabled={busy} onClick={() => load(slot, pageCursor.current)}>
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
  scope,
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
  scope?: string | undefined;
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
      {scope ? (
        <FieldLabel htmlFor={`${scope}-qualifier-${index}`}>{label}</FieldLabel>
      ) : (
        <>
          <FieldLabel htmlFor={`relation-qualifier-${index}`}>{label}</FieldLabel>
        </>
      )}
      <Input
        id={`relation-qualifier-${index}`}
        {...(scope ? { id: `${scope}-qualifier-${index}` } : {})}
        disabled={disabled}
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
