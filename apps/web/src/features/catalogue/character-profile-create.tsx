import { useId, useRef, useState } from 'react';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import { ScalarControl, EditorFailure } from './statement-editor-view';
import { editableScalar, type StatementInput } from './statement-editor';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import { characterDraft, characterGroups, type CharacterCommand, type CharacterTransport } from './character-profile';

/** Initial terms and explicitly added facts use the existing validators, scalar controls and subject POST. */
export function CharacterProfileCreate({
  release,
  locale,
  transport,
  onCreated,
}: {
  release: Release;
  locale: string;
  transport: CharacterTransport;
  onCreated: (result: Extract<CreateResult, { ok: true }>) => void;
}) {
  const o = { locale: locale as never };
  const termsId = useId();
  const nextTermId = useRef(1);
  const [terms, setTerms] = useState<(TermDraft & { id: number })[]>([
    { id: 0, language: locale, label: '', description: '', aliases: '' },
  ]);
  const [facts, setFacts] = useState<StatementInput[]>([]);
  const [field, setField] = useState('');
  const [failure, setFailure] = useState<CreateFailure>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<CharacterCommand | null>(null);
  const running = useRef(false);
  const locked = busy || !!pending.current;
  const available = Object.values(characterGroups(release))
    .flat()
    .filter((id) => editableScalar(release.properties[id]) && id !== 'schema:alternateName');
  async function submit() {
    if (running.current || failure?.reason === 'conflict') return;
    if (!pending.current) {
      const draft = characterDraft(release, terms, facts);
      if (draft.errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      pending.current = { item: draft.item, key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    try {
      const result = await transport.create(pending.current);
      if (result.ok) {
        pending.current = null;
        onCreated(result);
      } else {
        setFailure(result);
        if (result.reason !== 'unavailable' && result.reason !== 'conflict') pending.current = null;
      }
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <a
        className={buttonVariants({ variant: 'outline' })}
        href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
      >
        {m.catalogue_create_search({}, o)}
      </a>
      <p className="text-sm text-muted-foreground">{m.character_create_help({}, o)}</p>
      <fieldset disabled={locked} className="space-y-5">
        <legend className="font-semibold">{m.catalogue_create_terms({}, o)}</legend>
        {terms.map((term, index) => (
          <fieldset key={term.id} id={`${termsId}-${term.id}`} className="min-w-0 space-y-3">
            <legend className="sr-only">{term.language || m.catalogue_create_language({}, o)}</legend>
            {(['language', 'label', 'description', 'aliases'] as const).map((key) => (
              <Field key={key}>
                <FieldLabel htmlFor={`${termsId}-${key}-${term.id}`}>
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
                    id={`${termsId}-${key}-${term.id}`}
                    value={term[key]}
                    onChange={(event) =>
                      setTerms((previous) =>
                        previous.map((row) => (row.id === term.id ? { ...row, [key]: event.target.value } : row)),
                      )
                    }
                  />
                ) : (
                  <Input
                    id={`${termsId}-${key}-${term.id}`}
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
                focusId={
                  terms[index + 1]
                    ? `${termsId}-language-${terms[index + 1]!.id}`
                    : `${termsId}-add`
                }
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
            setTerms((previous) => [...previous, { id, language: '', label: '', description: '', aliases: '' }]);
          }}
        >
          {m.catalogue_create_add_language({}, o)}
        </Button>
        <Field>
          <FieldLabel htmlFor="character-initial-field">{m.character_initial_fact({}, o)}</FieldLabel>
          <NativeSelect
            id="character-initial-field"
            className="w-full [&>select]:min-h-11"
            value={field}
            onChange={(event) => setField(event.target.value)}
          >
            <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
            {available.map((id) => (
              <NativeSelectOption key={id} value={id}>
                {pickText(release.properties[id]!.labels, locale).text}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={!field}
          onClick={() => {
            setFacts([
              ...facts,
              {
                property: { id: field },
                value: { type: 'value', content: '' },
                qualifiers: [],
                references: [],
                rank: 'normal',
              },
            ]);
            setField('');
          }}
        >
          {m.character_add_fact({}, o)}
        </Button>
        {facts.map((fact, index) => (
          <section key={index} className="space-y-3 rounded-xl border border-border p-4">
            <h3 className="font-semibold">{pickText(release.properties[fact.property.id]!.labels, locale).text}</h3>
            <ScalarControl
              part={fact}
              definition={release.properties[fact.property.id]}
              locale={locale}
              read={{ release, public: { related: {} } }}
              onChange={(value) => setFacts(facts.map((row, at) => (at === index ? { ...row, value } : row)))}
            />
            <Button type="button" variant="ghost" onClick={() => setFacts(facts.filter((_, at) => at !== index))}>
              {m.recipe_remove_field({}, o)}
            </Button>
          </section>
        ))}
      </fieldset>
      {failure && (
        <div role="alert" className="space-y-2">
          <EditorFailure reason={failure.reason === 'conflict' ? 'stale' : failure.reason} locale={locale} />
          {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, o)}</p>}
          {!!failure.errors?.length && (
            <ul className="break-words text-sm">
              {failure.errors.map((error, index) => (
                <li key={index}>
                  {error.pointer}: {error.code}
                </li>
              ))}
            </ul>
          )}
          {failure.reason === 'conflict' && (
            <Button
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
      <Button type="submit" disabled={busy || failure?.reason === 'conflict'}>
        {busy
          ? m.catalogue_create_saving({}, o)
          : pending.current
            ? m.correction_retry({}, o)
            : m.character_create({}, o)}
      </Button>
    </form>
  );
}
