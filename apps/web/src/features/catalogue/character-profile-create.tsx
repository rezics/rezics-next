import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useId, useRef, useState, useLayoutEffect } from 'react';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import { DefinitionMeaning } from './definition-meaning';
import { ScalarControl, EditorFailure } from './statement-editor-view';
import { editableScalar, type StatementInput } from './statement-editor';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import {
  characterCreateCorrections,
  characterCorrectionTargets,
  characterFactId,
  type CharacterCorrection,
} from './character-create-guidance';
import { characterDraft, characterGroups, type CharacterCommand, type CharacterTransport } from './character-profile';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const labelClassName = 'min-w-0 max-w-full flex-wrap whitespace-normal [overflow-wrap:anywhere]';

/** Initial terms and explicitly added facts use the existing validators, scalar controls and subject POST. */
export const CharacterProfileCreate = catalogueEditor(CharacterProfileCreateLive);

function CharacterProfileCreateLive({
  release,
  locale,
  transport,
  onCreated,
  onRefreshDefinitions,
}: {
  release: Release;
  locale: string;
  transport: CharacterTransport;
  onCreated: (result: Extract<CreateResult, { ok: true }>) => void;
  onRefreshDefinitions?: () => Promise<unknown>;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const termsId = useId();
  const nextTermId = useRef(1);
  const form = useRef<HTMLFormElement>(null);
  const focusAfterChange = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusAfterChange.current || !lifetime.active()) return;
    form.current?.ownerDocument.getElementById(focusAfterChange.current)?.focus();
    focusAfterChange.current = null;
  });
  const [terms, setTerms] = useState<(TermDraft & { id: number })[]>([
    { id: 0, language: locale, label: '', description: '', aliases: '' },
  ]);
  const [facts, setFacts] = useState<StatementInput[]>([]);
  const [field, setField] = useState('');
  const [failure, setFailure] = useState<CreateFailure>();
  const [corrections, setCorrections] = useState<CharacterCorrection[]>([]);
  const factIds = useRef(new WeakMap<StatementInput, number>());
  const nextFactId = useRef(0);
  const factId = (fact: StatementInput) => {
    let id = factIds.current.get(fact);
    if (id === undefined) {
      id = nextFactId.current++;
      factIds.current.set(fact, id);
    }
    return id;
  };
  const addressedFacts = facts.map((fact) => ({ fact, id: factId(fact) }));
  const available = Object.values(characterGroups(release))
    .flat()
    .filter((id) => editableScalar(release.properties[id]) && id !== 'schema:alternateName');
  const targets = characterCorrectionTargets(
    termsId,
    terms,
    addressedFacts.filter(({ fact }) => available.includes(fact.property.id)),
    release,
  );
  const displayedCorrections =
    failure?.reason === 'invalid'
      ? corrections.map((error) =>
          error.target && targets.has(error.target)
            ? error
            : {
                ...error,
                target: undefined,
                instruction: `${error.reason} ${m.character_create_correction_fallback({}, o)}`,
              },
        )
      : [];
  const associated = new Map<string, string[]>();
  const scalarFeedback = new Map<string, (CharacterCorrection & { target: string })[]>();
  for (const error of displayedCorrections) {
    if (!error.target) continue;
    const ids = associated.get(error.target) ?? [];
    ids.push(error.id);
    associated.set(error.target, ids);
    const address = error.target.slice(0, error.target.lastIndexOf('-'));
    const scalarErrors = scalarFeedback.get(address) ?? [];
    scalarErrors.push({ ...error, target: error.target });
    scalarFeedback.set(address, scalarErrors);
  }
  const feedback = (target: string) => ({
    'aria-invalid': associated.has(target) ? (true as const) : undefined,
    'aria-describedby': associated.get(target)?.join(' '),
  });
  function reportFailure(next: CreateFailure) {
    setFailure(next);
    setCorrections(
      next.reason === 'invalid'
        ? characterCreateCorrections(next.errors ?? [], terms, addressedFacts, release, locale, termsId)
        : [],
    );
  }
  const [busy, setBusy] = useState(false);
  const pending = useRef<CharacterCommand | null>(null);
  const running = useRef(false);
  const locked = busy || !!pending.current;
  async function submit() {
    if (!lifetime.active()) return;
    if (running.current || failure?.reason === 'conflict') return;
    if (!pending.current) {
      const draft = characterDraft(release, terms, facts);
      if (draft.errors.length) {
        reportFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      pending.current = { item: draft.item, key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    try {
      const result = await transport.create(pending.current);
      if (!lifetime.active()) return;
      if (result.ok) {
        pending.current = null;
        onCreated(result);
      } else {
        reportFailure(result);
        if (result.reason !== 'unavailable' && result.reason !== 'conflict') pending.current = null;
        if (result.refreshDefinitions && onRefreshDefinitions) await onRefreshDefinitions();
      }
    } catch {
      if (!lifetime.active()) return;
      reportFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      ref={form}
      aria-label={m.character_create_correction_form({}, o)}
      aria-busy={busy}
      className="min-w-0 space-y-5 [overflow-wrap:anywhere]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <a
        className={buttonVariants({ variant: 'outline', className: actionClassName })}
        href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
      >
        {m.catalogue_create_search({}, o)}
      </a>
      <p className="text-sm text-muted-foreground">{m.character_create_help({}, o)}</p>
      <fieldset disabled={locked} className="min-w-0 space-y-5">
        <legend className="font-semibold">{m.catalogue_create_terms({}, o)}</legend>
        <p id={`${termsId}-language-help`} className="text-sm text-muted-foreground">
          {m.catalogue_create_language_help({}, o)}
        </p>
        <p id={`${termsId}-aliases-help`} className="text-sm text-muted-foreground">
          {m.catalogue_create_aliases_help({}, o)}
        </p>
        {terms.map((term, index) => (
          <fieldset
            key={term.id}
            id={`${termsId}-${term.id}`}
            className="min-w-0 space-y-3 border-s-2 border-border ps-4"
          >
            <legend className="mb-3 max-w-full font-medium">
              {m.character_create_correction_term({ number: index + 1 }, o)}
              {term.language && <span className="ms-2 text-sm text-muted-foreground">{term.language}</span>}
            </legend>
            {(['language', 'label', 'description', 'aliases'] as const).map((key) => (
              <Field key={key} className="min-w-0">
                <FieldLabel className={labelClassName} htmlFor={`${termsId}-${key}-${term.id}`}>
                  {
                    {
                      language: m.catalogue_create_language({}, o),
                      label: m.catalogue_create_label({}, o),
                      description: m.catalogue_create_description({}, o),
                      aliases: m.catalogue_create_aliases({}, o),
                    }[key]
                  }
                </FieldLabel>
                {key === 'aliases' ? (
                  <Textarea
                    className="min-w-0 max-w-full"
                    id={`${termsId}-${key}-${term.id}`}
                    {...feedback(`${termsId}-${key}-${term.id}`)}
                    aria-describedby={
                      [feedback(`${termsId}-${key}-${term.id}`)['aria-describedby'], `${termsId}-aliases-help`]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    lang={/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(term.language) ? term.language : undefined}
                    dir="auto"
                    value={term[key]}
                    onChange={(event) =>
                      setTerms((previous) =>
                        previous.map((row) => (row.id === term.id ? { ...row, [key]: event.target.value } : row)),
                      )
                    }
                  />
                ) : (
                  <Input
                    className="min-h-11 min-w-0 max-w-full md:pointer-fine:min-h-8"
                    id={`${termsId}-${key}-${term.id}`}
                    {...feedback(`${termsId}-${key}-${term.id}`)}
                    aria-describedby={
                      [
                        feedback(`${termsId}-${key}-${term.id}`)['aria-describedby'],
                        key === 'language' || key === 'aliases' ? `${termsId}-${key}-help` : undefined,
                      ]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    lang={
                      key !== 'language' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(term.language)
                        ? term.language
                        : undefined
                    }
                    dir={key === 'language' ? 'ltr' : 'auto'}
                    aria-required={key === 'label' || undefined}
                    value={term[key]}
                    onChange={(event) =>
                      setTerms((previous) =>
                        previous.map((row) => (row.id === term.id ? { ...row, [key]: event.target.value } : row)),
                      )
                    }
                  />
                )}
              </Field>
            ))}
            {index > 0 && (
              <CreateSubjectLanguageRemove
                locale={locale}
                rowId={`${termsId}-${term.id}`}
                focusId={terms[index + 1] ? `${termsId}-language-${terms[index + 1]!.id}` : `${termsId}-add`}
                disabled={locked}
                onRemove={() => {
                  if (locked || running.current || pending.current) return;
                  setTerms((previous) => previous.filter((row) => row.id !== term.id));
                  setFailure(undefined);
                }}
              />
            )}
          </fieldset>
        ))}
        <Button
          id={`${termsId}-add`}
          className="h-auto min-h-11 max-w-full whitespace-normal"
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => {
            if (locked || running.current || pending.current) return;
            const id = nextTermId.current++;
            focusAfterChange.current = `${termsId}-language-${id}`;
            setTerms((previous) => [...previous, { id, language: '', label: '', description: '', aliases: '' }]);
          }}
        >
          {m.catalogue_create_add_language({}, o)}
        </Button>
      </fieldset>
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        <legend className="mb-3 max-w-full font-semibold">{m.character_initial_fact({}, o)}</legend>
        <Field className="min-w-0">
          <FieldLabel className={labelClassName} htmlFor={`${termsId}-initial-field`}>
            {m.character_initial_fact({}, o)}
          </FieldLabel>
          <NativeSelect
            id={`${termsId}-initial-field`}
            className="w-full [&>select]:min-h-11"
            value={field}
            onChange={(event) => setField(event.target.value)}
          >
            <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
            {available.map((id) => (
              <NativeSelectOption
                key={id}
                value={id}
                lang={pickText(release.properties[id]!.labels, locale).lang ?? undefined}
              >
                {pickText(release.properties[id]!.labels, locale).text || m.candidate_value_unavailable({}, o)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Button
          className={actionClassName}
          type="button"
          variant="outline"
          disabled={!field}
          onClick={() => {
            if (locked || running.current || !available.includes(field)) return;
            const fact: StatementInput = {
              property: { id: field },
              value: { type: 'value', content: '' },
              qualifiers: [],
              references: [],
              rank: 'normal',
            };
            focusAfterChange.current = `${characterFactId(termsId, factId(fact))}-group`;
            setFacts([...facts, fact]);
            setField('');
          }}
        >
          {m.character_add_fact({}, o)}
        </Button>
        {facts.map((fact, index) => {
          const definition = release.properties[fact.property.id];
          const name = pickText(definition?.labels ?? {}, locale);
          const address = characterFactId(termsId, factId(fact));
          const supported = available.includes(fact.property.id);
          return (
            <fieldset key={factId(fact)} data-slot="character-initial-fact" className="min-w-0 max-w-full">
              <legend className="max-w-full" lang={name.lang ?? undefined}>
                <ContentItemHeading level={3} className="text-lg font-semibold">
                  {name.text || m.candidate_value_unavailable({}, o)}
                </ContentItemHeading>
              </legend>
              <ContentItemFrame
                as="div"
                id={`${address}-group`}
                tabIndex={-1}
                className="min-w-0 space-y-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&_label]:max-w-full [&_label]:flex-wrap [&_label]:whitespace-normal [&_label]:[overflow-wrap:anywhere]"
              >
                <p className="text-sm text-muted-foreground">
                  <DefinitionMeaning values={definition?.descriptions} locale={locale} />
                </p>
                {supported ? (
                  <ScalarControl
                    part={fact}
                    definition={definition}
                    locale={locale}
                    read={{ release, public: { related: {} } }}
                    feedback={{
                      id: address,
                      address: 'fact',
                      errors: scalarFeedback.get(`${address}-fact`) ?? [],
                    }}
                    onChange={(value) =>
                      setFacts(
                        facts.map((row, at) => {
                          if (at !== index) return row;
                          const next = { ...row, value };
                          factIds.current.set(next, factId(row));
                          return next;
                        }),
                      )
                    }
                  />
                ) : (
                  <>
                    <EditorFailure reason="stale" locale={locale} />
                    <details className="min-w-0 text-sm">
                      <summary className="min-h-11 cursor-pointer py-2">
                        {m.catalogue_creation_technical_details({}, o)}
                      </summary>
                      <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        <code>{JSON.stringify(fact, null, 2)}</code>
                      </pre>
                    </details>
                  </>
                )}
                <Button
                  className={actionClassName}
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (locked || running.current) return;
                    focusAfterChange.current = facts[index + 1]
                      ? `${characterFactId(termsId, factId(facts[index + 1]!))}-group`
                      : `${termsId}-initial-field`;
                    setFacts(facts.filter((_, at) => at !== index));
                  }}
                >
                  {m.recipe_remove_field({}, o)}
                </Button>
              </ContentItemFrame>
            </fieldset>
          );
        })}
      </fieldset>
      {failure && (
        <div role="alert" className="space-y-2">
          <EditorFailure reason={failure.reason === 'conflict' ? 'stale' : failure.reason} locale={locale} />
          {failure.reason === 'unavailable' && <p>{m.catalogue_create_uncertain({}, o)}</p>}
          {failure.reason === 'conflict' && <p>{m.catalogue_create_conflict({}, o)}</p>}
          {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, o)}</p>}
          {failure.reason === 'invalid' && displayedCorrections.length === 0 && (
            <p>{m.character_create_correction_fallback({}, o)}</p>
          )}
          {displayedCorrections.length > 0 && (
            <section aria-label={m.character_create_correction_summary({}, o)} className="min-w-0 space-y-2">
              <h2 className="font-semibold">{m.character_create_correction_summary({}, o)}</h2>
              <ul className="list-disc space-y-3 ps-5 text-sm">
                {displayedCorrections.map((error) => (
                  <li key={error.id} id={error.id}>
                    {error.target ? (
                      <a
                        className="inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        href={`#${encodeURIComponent(error.target)}`}
                        onClick={(event) => {
                          event.preventDefault();
                          if (!lifetime.active()) return;
                          const control = event.currentTarget.ownerDocument.getElementById(error.target!);
                          control?.focus();
                          control?.scrollIntoView?.({ block: 'center' });
                        }}
                      >
                        {error.label}
                      </a>
                    ) : (
                      <p className="font-medium">{error.label}</p>
                    )}
                    <p>{error.instruction}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!failure.errors?.length && (
            <details className="min-w-0 text-sm">
              <summary className="min-h-11 cursor-pointer py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                {m.catalogue_creation_technical_details({}, o)}
              </summary>
              <pre
                tabIndex={0}
                className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <code className="select-all">{JSON.stringify(failure.errors, null, 2)}</code>
              </pre>
            </details>
          )}
          {failure.reason === 'conflict' && (
            <Button
              className={actionClassName}
              type="button"
              onClick={() => {
                pending.current = null;
                setFailure(undefined);
              }}
            >
              {m.catalogue_create_review_new({}, o)}
            </Button>
          )}
        </div>
      )}
      <Button className={actionClassName} type="submit" disabled={busy || failure?.reason === 'conflict'}>
        {busy
          ? m.catalogue_create_saving({}, o)
          : pending.current
            ? m.correction_retry({}, o)
            : m.character_create({}, o)}
      </Button>
    </form>
  );
}
