import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { useRef, useState, type ReactNode } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { ViewHeading } from '../pages/view-heading';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import { createTypes, type CreateTransport, type InitialSubject } from './create-subject';
import { CreateSubjectForm } from './create-subject-form';
import { EditorFailure, ScalarControl } from './statement-editor-view';
import type { StatementInput } from './statement-editor';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { isLiteraryType, literaryFields, literaryInitialItem, type LiteraryRead } from './literary-profile';

export type LiteraryTransport = Pick<CreateTransport, 'submit' | 'read'> & { load: () => Promise<LiteraryRead> };
type Ready = Extract<LiteraryRead, { ok: true }>;
type InitialRow = { id: string; statement: StatementInput };
const coarseTarget = 'max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const wrappingLink = `${coarseTarget} max-w-full whitespace-normal break-words`;
const keyboardFocus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const touchAction = `${coarseTarget} max-md:w-full pointer-coarse:w-full`;
const disclosureSummary = `min-h-8 min-w-0 cursor-pointer break-words text-xl font-semibold max-md:min-h-11 pointer-coarse:min-h-11 ${keyboardFocus} [overflow-wrap:anywhere]`;

/** Optional initial facts share the scalar codecs. A row exists only after an explicit Add action. */
function InitialFacts({
  type,
  read,
  locale,
  disabled,
  rows,
  change,
}: {
  type: string;
  read: Ready;
  locale: string;
  disabled: boolean;
  rows: InitialRow[];
  change: (rows: InitialRow[]) => void;
}) {
  const o = { locale: locale as never };
  const [property, setProperty] = useState('');
  if (!isLiteraryType(type)) return null;
  const fields = literaryFields(read.release, type, locale).scalars;
  const context = { release: read.release, public: { related: {} } };
  const update = (id: string, statement: StatementInput) =>
    change(rows.map((row) => (row.id === id ? { ...row, statement } : row)));
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
      <legend className="px-1 font-semibold">{m.literary_bibliography({}, o)}</legend>
      <p className="text-sm text-muted-foreground">{m.literary_initial_help({}, o)}</p>
      {rows.map(({ id, statement }) => {
        const definition = read.release.properties[statement.property.id];
        if (!definition)
          return (
            <section key={id} className="min-w-0 space-y-3">
              <EditorFailure locale={locale} reason="stale" />
              <Button
                type="button"
                variant="ghost"
                className={touchAction}
                onClick={() => change(rows.filter((row) => row.id !== id))}
              >
                {m.literary_remove_fact({}, o)}
              </Button>
            </section>
          );
        const label = pickText(definition.labels, locale);
        const description = pickText(definition.descriptions ?? {}, locale);
        const citation = statement.references[0]?.parts[0] ?? {
          property: { id: 'schema:url' },
          value: { type: 'value' as const, content: '' },
        };
        return (
          <section
            id={`literary-fact-${id}`}
            key={id}
            aria-label={label.text}
            className="min-w-0 space-y-3 rounded-lg border border-border p-4"
          >
            <h3 lang={label.lang ?? undefined} className="break-words font-semibold [overflow-wrap:anywhere]">
              {label.text}
            </h3>
            {description.text && (
              <p
                lang={description.lang ?? undefined}
                className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
              >
                {description.text}
              </p>
            )}
            <ScalarControl
              part={statement}
              definition={definition}
              read={context}
              locale={locale}
              onChange={(value) => update(id, { ...statement, value })}
            />
            <h4 className="text-sm font-medium">{m.correction_references({}, o)}</h4>
            <ScalarControl
              part={citation}
              definition={read.release.properties['schema:url']}
              read={context}
              locale={locale}
              onChange={(value) =>
                update(id, {
                  ...statement,
                  references:
                    value.type === 'value' && value.content === '' ? [] : [{ parts: [{ ...citation, value }] }],
                })
              }
            />
            <Button
              type="button"
              variant="ghost"
              className={touchAction}
              onClick={() => change(rows.filter((row) => row.id !== id))}
            >
              {m.literary_remove_fact({}, o)}
            </Button>
          </section>
        );
      })}
      <div className="flex flex-wrap items-end gap-3 max-md:flex-col max-md:items-stretch pointer-coarse:flex-col pointer-coarse:items-stretch">
        <Field className="w-full min-w-0 flex-1">
          <FieldLabel htmlFor="literary-initial-property">{m.refinement_property({}, o)}</FieldLabel>
          <NativeSelect
            id="literary-initial-property"
            className={`${coarseTarget} w-full max-w-full`}
            value={fields.includes(property) ? property : ''}
            onChange={(event) => setProperty(event.target.value)}
          >
            <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
            {fields
              .filter(
                (id) =>
                  read.release.properties[id]!.multivalued || !rows.some((row) => row.statement.property.id === id),
              )
              .map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {pickText(read.release.properties[id]!.labels, locale).text}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Field>
        <Button
          type="button"
          variant="outline"
          className={touchAction}
          disabled={
            !fields.includes(property) ||
            rows.length >= 12 ||
            (!read.release.properties[property]?.multivalued &&
              rows.some((row) => row.statement.property.id === property))
          }
          onClick={() => {
            change([
              ...rows,
              {
                id: crypto.randomUUID(),
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
      </div>
    </fieldset>
  );
}

export function LiteraryProfile({
  id,
  locale,
  session,
  transport,
  facts,
  review,
  relations,
  authored,
}: {
  id?: string | undefined;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: LiteraryTransport;
  facts: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  relations?: ReactNode;
  authored?: ReactNode;
}) {
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: ['literary-profile', id, locale],
    queryFn: transport.load,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const lastRead = useRef<{ id: string | undefined; locale: string; value: Ready } | undefined>(undefined);
  if (query.data?.ok) lastRead.current = { id, locale, value: query.data };
  // A failed metadata refresh must not unmount the entered terms, facts or sealed create command.
  const previous = lastRead.current;
  const read = previous && previous.id === id && previous.locale === locale ? previous.value : undefined;
  const [drafts, setDrafts] = useState<Record<string, InitialRow[]>>({});
  // Keep independently entered facts when switching Types; only the currently chosen Type is submitted.
  const [opened, setOpened] = useState({ relations: false, authored: false });
  const latest = useRef(drafts);
  const submittingType = useRef('');
  latest.current = drafts;
  const heading = (
    <header className="space-y-3">
      <ViewHeading label={m.literary_title({}, o)} headingClassName="font-sans" />
      <p className="text-muted-foreground">{m.literary_intro({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.literary_grain({}, o)}</p>
    </header>
  );
  if (!read)
    return (
      <article className="mx-auto max-w-4xl space-y-5 py-6">
        {heading}
        {query.isPending ? (
          <p role="status">{m.candidate_loading({}, o)}</p>
        ) : (
          <>
            <EditorFailure locale={locale} reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} />
            <Button variant="outline" className={coarseTarget} onClick={() => void query.refetch()}>
              {m.correction_retry({}, o)}
            </Button>
          </>
        )}
      </article>
    );
  if (!id)
    return (
      <section className="mx-auto max-w-3xl space-y-6 py-6">
        {heading}
        <CreateSubjectForm
          locale={locale}
          session={session}
          onNavigate={() => {
            /* Keep the exact current-reader link visible. */
          }}
          transport={{
            ...transport,
            definitions: async (refresh) => {
              const metadata = refresh || query.data?.ok === false ? (await query.refetch()).data : read;
              return metadata?.ok
                ? { ok: true, types: createTypes(metadata.release, locale).filter((type) => isLiteraryType(type.id)) }
                : { ok: false };
            },
          }}
          profile={{
            scope: 'literary',
            title: m.literary_title({}, o),
            hideHeading: true,
            href: `/${locale}/catalogue/literary`,
            labelLanguage: (type) => pickText(read.release.types[type]?.labels ?? {}, locale).lang ?? undefined,
            descriptionLanguage: (type) =>
              pickText(read.release.types[type]?.descriptions ?? {}, locale).lang ?? undefined,
            control: (pointer) => {
              const [, kind, escaped, index] = pointer.split('/');
              if (kind !== 'statements') return undefined;
              const property = escaped?.replaceAll('~1', '/').replaceAll('~0', '~');
              const rows = (latest.current[submittingType.current] ?? []).filter(
                (row) => row.statement.property.id === property,
              );
              return rows[Number(index) || 0] ? `literary-fact-${rows[Number(index) || 0]!.id}` : undefined;
            },
            errorLabel: (id) => {
              const row = Object.values(latest.current)
                .flat()
                .find((row) => `literary-fact-${row.id}` === id);
              return row
                ? pickText(read.release.properties[row.statement.property.id]?.labels ?? {}, locale).text
                : undefined;
            },
            fields: (type, disabled) => (
              <InitialFacts
                type={type}
                read={read}
                locale={locale}
                disabled={disabled}
                rows={drafts[type] ?? []}
                change={(rows) => setDrafts((previous) => ({ ...previous, [type]: rows }))}
              />
            ),
            prepare: (item: InitialSubject) => {
              submittingType.current = item.type;
              return literaryInitialItem(
                read.release,
                item,
                (latest.current[item.type] ?? []).map((row) => row.statement),
                locale,
              );
            },
          }}
        />
      </section>
    );
  const current = read.current;
  if (!current) return <EditorFailure locale={locale} reason="unavailable" />;
  const subject = current.public.subject;
  const title = pickText(subject.labels, locale);
  const typeName = pickText(read.release.types[subject.type]?.labels ?? {}, locale);
  const fields = literaryFields(read.release, subject.type, locale);
  const href = subjectHref({ id: subject.id, label: title.text }, locale).href;
  return (
    <article className="mx-auto max-w-4xl space-y-6 py-6">
      {heading}
      <section
        aria-label={m.literary_identity({}, o)}
        className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
      >
        <h2 className="break-words text-xl font-semibold [overflow-wrap:anywhere]">{m.literary_identity({}, o)}</h2>
        <p className="min-w-0 break-words [overflow-wrap:anywhere]">
          <a
            lang={title.lang ?? undefined}
            href={href}
            className={`inline-flex min-h-8 min-w-0 items-center font-sans text-xl underline ${wrappingLink} ${keyboardFocus} [overflow-wrap:anywhere]`}
          >
            {title.text || m.subject_value_unlabelled({}, o)}
          </a>{' '}
          · <span lang={typeName.lang ?? undefined}>{typeName.text}</span>
        </p>
        <p className="min-w-0 break-all text-sm text-muted-foreground">
          {subject.id} · {subject.type}
        </p>
        {Object.entries(subject.labels).map(([language, label]) => (
          <div key={language} className="min-w-0 space-y-1">
            <p lang={language} className="break-words [overflow-wrap:anywhere]">
              {label} <span className="text-sm text-muted-foreground">({language})</span>
            </p>
            {subject.descriptions[language] && (
              <p lang={language} className="break-words [overflow-wrap:anywhere]">
                {subject.descriptions[language]}
              </p>
            )}
            {!!subject.aliases[language]?.length && (
              <p lang={language} className="break-words text-sm [overflow-wrap:anywhere]">
                {subject.aliases[language]!.join(' · ')}
              </p>
            )}
          </div>
        ))}
        <a
          href={`${href}/terms`}
          className={buttonVariants({ variant: 'outline', className: `${wrappingLink} ${keyboardFocus}` })}
        >
          {m.catalogue_terms_title({}, o)}
        </a>
        <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {m.literary_terms_help({}, o)}
        </p>
      </section>
      {session !== 'signed-in' ? (
        <EditorFailure locale={locale} reason={session === 'signed-out' ? 'denied' : 'unavailable'} />
      ) : (
        <>
          <section aria-label={m.literary_bibliography({}, o)} className="space-y-4">
            <h2 className="text-xl font-semibold">{m.literary_bibliography({}, o)}</h2>
            <SubjectFacts initial={current} locale={locale} transport={facts} review={review} />
          </section>
          {!!fields.relations.length && (
            <details
              onToggle={(event) => {
                if (event.currentTarget.open) setOpened((previous) => ({ ...previous, relations: true }));
              }}
              className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6"
            >
              <summary className={disclosureSummary}>{m.literary_relations({}, o)}</summary>
              <p className="my-4 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {m.literary_relations_help({}, o)}
              </p>
              {opened.relations && relations}
            </details>
          )}
          {!!fields.authored.length && (
            <details
              onToggle={(event) => {
                if (event.currentTarget.open) setOpened((previous) => ({ ...previous, authored: true }));
              }}
              className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6"
            >
              <summary className={disclosureSummary}>{m.authored_title({}, o)}</summary>
              <p className="my-4 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {m.literary_authored_help({}, o)}
              </p>
              {opened.authored && authored}
            </details>
          )}
        </>
      )}
      <nav className="flex min-w-0 flex-wrap gap-3">
        <a className={buttonVariants({ variant: 'outline', className: wrappingLink })} href={href}>
          {m.candidate_view_public({}, o)}
        </a>
        <a className={buttonVariants({ variant: 'outline', className: wrappingLink })} href={`${href}/changes`}>
          {m.changes_title({}, o)}
        </a>
      </nav>
    </article>
  );
}
