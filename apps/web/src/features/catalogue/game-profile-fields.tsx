import { useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { gameGroups, gameTarget, type GameRead } from './game-profile';
import { StatementFields, PartValue, EditorFailure, type StatementFieldsRead } from './statement-editor-view';
import { statementInput, type SnakInput, type StatementInput } from './statement-editor';
import { factChanged, factLocked, sealFacts, sendFacts, type FactDraft, type FactsTransport } from './subject-facts';

type Ready = Extract<GameRead, { ok: true }>;
export function gameGroupLabel(group: string, locale: string) {
  const o = { locale: locale as never };
  return group === 'credits'
    ? m.game_profile_credits({}, o)
    : group === 'classification'
      ? m.game_profile_classification({}, o)
      : group === 'relations'
        ? m.game_profile_relations({}, o)
        : m.game_profile_facts({}, o);
}
function GameItemControl({
  part,
  context,
  locale,
  search,
  change,
}: {
  part: SnakInput;
  context: StatementFieldsRead;
  locale: string;
  search: EntityPickerSearch;
  change: (value: SnakInput['value']) => void;
}) {
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const property = part.property.id;
  const definition = context.release.properties[property]!;
  const label = pickText(definition.labels, locale);
  const value = part.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : '';
  const target = value ? picked.find((item) => item.id === value) : undefined;
  return (
    <EntityPicker
      label={label.text}
      src={coverSrc}
      value={
        value
          ? [
              target ?? {
                id: value,
                title:
                  pickText(context.public.related[value]?.labels ?? {}, locale).text ||
                  m.subject_value_unlabelled({}, { locale: locale as never }),
                types: [],
                typeLabel: '',
                cover: null,
              },
            ]
          : []
      }
      search={async (text, signal) =>
        (await search(text, signal)).filter((item) =>
          item.types.some((type) => gameTarget(context.release, property, type)),
        )
      }
      onValueChange={(items) => {
        setPicked(items);
        change({ type: 'value', content: items[0]?.id ?? '' });
      }}
    />
  );
}
export function GameStatementFields({
  statement,
  context,
  locale,
  search,
  change,
}: {
  statement: StatementInput;
  context: StatementFieldsRead;
  locale: string;
  search: EntityPickerSearch;
  change: (next: StatementInput) => void;
}) {
  const control = (part: SnakInput, update: (value: SnakInput['value']) => void) =>
    context.release.properties[part.property.id]?.datatype === 'wikibase-item' ? (
      <GameItemControl part={part} context={context} locale={locale} search={search} change={update} />
    ) : undefined;
  return (
    <StatementFields
      draft={statement}
      current={context}
      locale={locale}
      change={change}
      valueControl={control(statement, (value) => change({ ...statement, value }))}
      partControl={control}
    />
  );
}
export function GameInitialFacts({
  type,
  release,
  locale,
  search,
  statements,
  disabled,
  change,
}: {
  type: string;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  statements: { key: string; statement: StatementInput }[];
  disabled: boolean;
  change: (rows: { key: string; statement: StatementInput }[]) => void;
}) {
  const [property, setProperty] = useState('');
  const o = { locale: locale as never };
  const groups = gameGroups(release, type);
  const context: StatementFieldsRead = { release, source: null, public: { subject: { type }, related: {} } };
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-5">
      <legend className="font-sans text-lg font-semibold">{m.game_profile_initial({}, o)}</legend>
      <p className="text-sm text-muted-foreground">{m.game_profile_optional({}, o)}</p>
      <Field>
        <FieldLabel>{m.publication_field({}, o)}</FieldLabel>
        <NativeSelect
          aria-label={m.publication_field({}, o)}
          value={property}
          onChange={(event) => setProperty(event.target.value)}
        >
          <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
          {Object.entries(groups)
            .filter(([, ids]) => ids.length)
            .map(([group, ids]) => (
              <optgroup key={group} label={gameGroupLabel(group, locale)}>
                {ids
                  .filter(
                    (id) =>
                      release.properties[id]!.multivalued ||
                      !statements.some((row) => row.statement.property.id === id),
                  )
                  .map((id) => {
                    const label = pickText(release.properties[id]!.labels, locale);
                    return (
                      <NativeSelectOption key={id} value={id} lang={label.lang ?? undefined}>
                        {label.text}
                      </NativeSelectOption>
                    );
                  })}
              </optgroup>
            ))}
        </NativeSelect>
      </Field>
      <Button
        type="button"
        variant="outline"
        disabled={!Object.values(groups).flat().includes(property) || statements.length >= 32}
        onClick={() => {
          change([
            ...statements,
            {
              key: crypto.randomUUID(),
              statement: {
                property: { id: property },
                value: { type: 'value', content: '' },
                qualifiers: [],
                references: [],
                rank: 'normal',
              },
            },
          ]);
          setProperty('');
        }}
      >
        {m.correction_add({}, o)}
      </Button>
      {statements.map((row) => {
        const label = pickText(release.properties[row.statement.property.id]?.labels ?? {}, locale);
        return (
          <section key={row.key} className="space-y-4 rounded-xl border border-border p-4">
            <h2 className="font-sans text-lg font-semibold" lang={label.lang ?? undefined}>
              {label.text}
            </h2>
            <GameStatementFields
              statement={row.statement}
              context={context}
              locale={locale}
              search={search}
              change={(statement) =>
                change(statements.map((item) => (item.key === row.key ? { ...item, statement } : item)))
              }
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => change(statements.filter((item) => item.key !== row.key))}
            >
              {m.recipe_remove_field({}, o)}
            </Button>
          </section>
        );
      })}
    </fieldset>
  );
}
/** Common per-field sealing/retry and review, with item controls for native classification slots. */
export function GameClassifications({
  read,
  locale,
  search,
  transport,
  review,
}: {
  read: Ready & { public: NonNullable<Ready['public']> };
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
}) {
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [address, setAddress] = useState<{ property: string; candidate: string; session?: string | undefined }>();
  const [comparison, setComparison] = useState<CandidateTransport>();
  const o = { locale: locale as never };
  const context = { ...read, source: null };
  const fields = gameGroups(read.release, read.public.subject.type).classification;
  async function submit() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const sealed = sealFacts(read.public.subject.id, read.release, drafts);
    setDrafts(sealed);
    try {
      await sendFacts(sealed, transport.propose, (property, result) =>
        setDrafts((rows) => rows.map((row) => (row.property === property ? { ...row, result } : row))),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="space-y-5" aria-busy={busy}>
      <h2 className="font-sans text-xl font-semibold">{m.game_profile_classification({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.facts_separate_results({}, o)}</p>
      {fields.map((property) => {
        const label = pickText(read.release.properties[property]!.labels, locale);
        const selected = read.public.subject.statements[property] ?? [];
        const draft = drafts.find((row) => row.property === property);
        const stage = (source: (typeof selected)[number] | null) => {
          const baseline = source ? statementInput(source) : null;
          setDrafts((rows) => [
            ...rows,
            {
              property,
              source: source?.id ?? null,
              baseline,
              included: true,
              statement: baseline
                ? structuredClone(baseline)
                : {
                    property: { id: property },
                    value: { type: 'value', content: '' },
                    qualifiers: [],
                    references: [],
                    rank: 'normal',
                  },
            },
          ]);
        };
        return (
          <section key={property} className="space-y-4 rounded-xl border border-border bg-card p-4">
            <h3 className="font-sans font-semibold" lang={label.lang ?? undefined}>
              {label.text}
            </h3>
            {!selected.length && <p>{m.facts_no_value({}, o)}</p>}
            {selected.map((statement) => (
              <div key={statement.id} className="space-y-2 border-s-2 ps-3">
                <PartValue part={statement} read={context} locale={locale} />
                {statement.qualifiers.map((part, i) => (
                  <div key={i}>
                    <span>{pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).text}: </span>
                    <PartValue part={part} read={context} locale={locale} />
                  </div>
                ))}
                {statement.references.map((reference, i) => (
                  <div key={i}>
                    {reference.parts.map((part, j) => (
                      <PartValue key={j} part={part} read={context} locale={locale} />
                    ))}
                  </div>
                ))}
                {!draft && (
                  <Button type="button" variant="outline" disabled={busy} onClick={() => stage(statement)}>
                    {m.facts_edit_field({}, o)}
                  </Button>
                )}
              </div>
            ))}
            {!draft && (!selected.length || read.release.properties[property]!.multivalued) && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => stage(null)}>
                {m.facts_add_value({}, o)}
              </Button>
            )}
            {draft && (
              <>
                <fieldset className="space-y-4" disabled={busy || factLocked(draft) || !!draft.command}>
                  <GameStatementFields
                    statement={draft.statement}
                    context={context}
                    locale={locale}
                    search={search}
                    change={(statement) =>
                      setDrafts((rows) =>
                        rows.map((row) =>
                          row.property === property
                            ? { ...row, statement, result: undefined, command: undefined }
                            : row,
                        ),
                      )
                    }
                  />
                </fieldset>
                {draft.result && !draft.result.ok && <EditorFailure reason={draft.result.reason} locale={locale} />}
                {draft.result?.ok && (
                  <div role="status">
                    <p>{m.correction_proposed({}, o)}</p>
                    <Button
                      type="button"
                      onClick={() => {
                        if (draft.result?.ok) {
                          setAddress({ property, candidate: draft.result.candidate, session: draft.result.session });
                          setComparison(review(property, draft.result.session));
                        }
                      }}
                    >
                      {m.correction_review({}, o)}
                    </Button>
                  </div>
                )}
                {draft.command && draft.result && !draft.result.ok && !factLocked(draft) && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setDrafts((rows) =>
                        rows.map((row) =>
                          row.property === property ? { ...row, command: undefined, result: undefined } : row,
                        ),
                      )
                    }
                  >
                    {m.catalogue_create_review_new({}, o)}
                  </Button>
                )}
              </>
            )}
          </section>
        );
      })}
      <Button
        type="button"
        disabled={
          busy ||
          drafts.some((row) => row.result && !row.result.ok && row.result.reason === 'stale') ||
          !drafts.some((row) => factChanged(row) && !row.result?.ok)
        }
        onClick={() => void submit()}
      >
        {m.facts_submit({}, o)}
      </Button>
      {address && comparison && (
        <CandidateReview
          key={address.candidate}
          id={read.public.subject.id}
          locale={locale}
          initialProperty={address.property}
          exactCandidate={address.candidate}
          transport={comparison}
        />
      )}
    </section>
  );
}
