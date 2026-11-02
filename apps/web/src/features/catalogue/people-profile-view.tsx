import { CatalogueCurrentReading, catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import { ViewHeading, ViewHeadingActions } from '../pages/view-heading';
import { CreateSubjectForm } from './create-subject-form';
import { definitionText } from './definition-guide';
import { EditorFailure, ScalarControl } from './statement-editor-view';
import type { StatementInput } from './statement-editor';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import type { CreateFailure } from './create-subject';
import { presentStatementViolations, type PresentedViolation } from './statement-validation-presentation';
import type { Violation } from '@rezics/definitions/validate';
import {
  peopleInitialItem,
  peopleProfiles,
  validatePeopleItem,
  type PeopleRead,
  type PeopleTransport,
} from './people-profile';

type Current = Extract<PeopleRead, { ok: true }>;
type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
type CorrectionReloadIntent = { opener: HTMLButtonElement; scope: string; completed: boolean };

const peopleActionTarget =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';
const peopleLinkTarget =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';
const peopleInputTarget = 'h-11 md:pointer-fine:h-8';
const peopleProfileSurface = [
  'min-w-0 w-full [overflow-wrap:anywhere]',
  '[&>article>header>p:first-of-type_a]:inline-flex',
  '[&>article>header>p:first-of-type_a]:min-h-11',
  '[&>article>header>p:first-of-type_a]:min-w-11',
  '[&>article>header>p:first-of-type_a]:max-w-full',
  '[&>article>header>p:first-of-type_a]:min-w-0',
  '[&>article>header>p:first-of-type_a]:items-center',
  '[&>article>header>p:first-of-type_a]:py-2',
  '[&>article>header>p:first-of-type_a]:[overflow-wrap:anywhere]',
  '[&>article>header>p:first-of-type_a]:focus-visible:outline-2',
  '[&>article>header>p:first-of-type_a]:focus-visible:outline-offset-2',
  '[&>article>header>p:first-of-type_a]:focus-visible:outline-ring',
  'md:pointer-fine:[&>article>header>p:first-of-type_a]:min-h-8',
  'md:pointer-fine:[&>article>header>p:first-of-type_a]:min-w-0',
  'md:pointer-fine:[&>article>header>p:first-of-type_a]:py-1',
  '[&>article>nav>a]:h-auto',
  '[&>article>nav>a]:min-h-11',
  '[&>article>nav>a]:min-w-11',
  '[&>article>nav>a]:max-w-full',
  '[&>article>nav>a]:whitespace-normal',
  '[&>article>nav>a]:py-2',
  '[&>article>nav>a]:[overflow-wrap:anywhere]',
  'md:pointer-fine:[&>article>nav>a]:min-h-8',
  'md:pointer-fine:[&>article>nav>a]:min-w-0',
  'md:pointer-fine:[&>article>nav>a]:py-1',
].join(' ');
const peopleRelationsSurface = [
  'min-w-0 max-w-full [overflow-wrap:anywhere]',
  '[&_details]:min-w-0',
  '[&_details]:max-w-full',
  '[&_details>summary]:min-h-11',
  '[&_details>summary]:min-w-11',
  '[&_details>summary]:max-w-full',
  '[&_details>summary]:cursor-pointer',
  '[&_details>summary]:whitespace-normal',
  '[&_details>summary]:py-2',
  '[&_details>summary]:[overflow-wrap:anywhere]',
  '[&_details>summary]:focus-visible:outline-2',
  '[&_details>summary]:focus-visible:outline-offset-2',
  '[&_details>summary]:focus-visible:outline-ring',
  'md:pointer-fine:[&_details>summary]:min-h-8',
  'md:pointer-fine:[&_details>summary]:min-w-0',
  'md:pointer-fine:[&_details>summary]:py-1',
].join(' ');

function ProfileIntro({ read, locale }: { read: Current; locale: string }) {
  const o = { locale: locale as never };
  const subject = read.public?.subject;
  const profile = read.profiles.find((entry) => entry.id === subject?.type);
  const work = read.work?.subject;
  const workTitle = definitionText(work?.labels, locale);
  return (
    <div className="min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]">
      <p>{m.people_profile_intro({}, o)}</p>
      {profile && <p lang={profile.descriptionLang ?? undefined}>{profile.description}</p>}
      {subject && (
        <dl className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
          {[
            ...new Set([
              ...Object.keys(subject.labels),
              ...Object.keys(subject.descriptions),
              ...Object.keys(subject.aliases),
            ]),
          ].map((language) => (
            <div key={language} className="min-w-0">
              <dt className="text-muted-foreground">{language}</dt>
              {subject.labels[language] && (
                <dd lang={language} className="min-w-0 font-medium [overflow-wrap:anywhere]">
                  {subject.labels[language]}
                </dd>
              )}
              {subject.descriptions[language] && (
                <dd lang={language} className="min-w-0 [overflow-wrap:anywhere]">
                  {subject.descriptions[language]}
                </dd>
              )}
              {!!subject.aliases[language]?.length && (
                <dd lang={language} className="min-w-0 [overflow-wrap:anywhere]">
                  {subject.aliases[language]!.join(' · ')}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}
      <p className="text-muted-foreground">{m.people_profile_terms({}, o)}</p>
      <p className="text-muted-foreground">{m.people_profile_disclosure({}, o)}</p>
      {work && (
        <section className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
          <h2 className="font-semibold">{m.people_profile_credit({}, o)}</h2>
          <ContentItemFrame
            as="div"
            data-slot="profile-work-reference"
            className="flex min-w-0 flex-col gap-2 py-3 sm:py-4"
          >
            <ContentItemHeading level={3} className="min-w-0 text-lg leading-snug font-semibold md:text-xl">
              <ContentItemTitleLink
                stretch={false}
                lang={workTitle.lang ?? undefined}
                className={peopleLinkTarget + ' underline underline-offset-4'}
                href={subjectHref({ id: work.id, label: workTitle.text }, locale).href}
              >
                {workTitle.text || m.subject_value_unlabelled({}, o)}
              </ContentItemTitleLink>
            </ContentItemHeading>
            <p>{m.people_profile_credit_help({}, o)}</p>
            {read.credits.length ? (
              <a
                className={buttonVariants({ variant: 'outline', className: peopleActionTarget + ' self-start' })}
                href={`${subjectHref({ id: work.id, label: workTitle.text }, locale).href}/relation-edit`}
              >
                {m.relation_title({}, o)}
              </a>
            ) : (
              <p role="status">{m.people_profile_no_credit({}, o)}</p>
            )}
            <details
              className="min-w-0 max-w-full text-sm"
              aria-label={`${m.people_profile_credit({}, o)} · ${m.profile_work_reference_details({}, o)}`}
            >
              <summary
                className={
                  peopleActionTarget +
                  ' cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                }
              >
                {m.profile_work_reference_details({}, o)}
              </summary>
              <dl className="grid min-w-0 gap-2 py-2">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{m.profile_work_reference_subject({}, o)}</dt>
                  <dd className="min-w-0">
                    <code
                      tabIndex={0}
                      className="block max-w-full select-text whitespace-normal [overflow-wrap:anywhere]"
                    >
                      {work.id}
                    </code>
                  </dd>
                </div>
              </dl>
            </details>
          </ContentItemFrame>
        </section>
      )}
    </div>
  );
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

function PeopleCreate({
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
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [drafts, setDrafts] = useState<Record<string, Record<string, StatementInput>>>({});
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<string>();
  const scope = useId();
  const rowIds = useRef(new Map<string, string>());
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
  // Resolve only this producer's single assertion and editable scalar/citation parts.
  // Capture these IDs at rejection so a removed/re-added fact cannot inherit an old error link.
  function corrections(type: string, errors: readonly Violation[]) {
    const results = new Map<string, PresentedViolation>();
    for (const error of errors) {
      const match = /^\/statements\/((?:[^/~]|~[01])+)\/0(\/.*)?$/.exec(error.pointer);
      if (!match) continue;
      const property = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~');
      const statement = drafts[type]?.[property];
      const profile = read.profiles.find((entry) => entry.id === type);
      if (!statement || !profile?.fields.includes(property)) continue;
      const id = rowId(type, property);
      const path = match[2] ?? '';
      const [presented] = presentStatementViolations(
        [{ ...error, pointer: `/statement${path}` }],
        statement,
        read.release,
        locale,
        id,
      );
      if (!presented) continue;
      if (path === '/references' || path === '/references/0/parts/0/value/content') {
        // A required missing citation is editable too; arbitrary reference indices are not.
        if (path !== '/references' && !statement.references[0]?.parts[0]) continue;
        presented.target = `${id}-citation`;
        presented.label = m.relation_citation({}, o);
      } else if (!presented.target.startsWith(`${id}-fact-`)) continue;
      const name = definitionText(read.release.properties[property]?.labels, locale).text;
      presented.label = [name, presented.label].filter(Boolean).join(' · ');
      presented.id = `${id}-error-${results.size}`;
      results.set(error.pointer, presented);
    }
    return results;
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
    if (change && !metadata.current.profiles.find((entry) => entry.id === type)?.fields.includes(property)) return;
    if (change) rowId(type, property);
    else rowIds.current.delete(key);
    setDrafts((previous) => {
      const fields = { ...previous[type] };
      if (change) fields[property] = change(fields[property]!);
      else delete fields[property];
      return { ...previous, [type]: fields };
    });
    setFailure((previous) => {
      if (!previous?.errors) return previous;
      const pointer = `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      const errors = previous.errors.filter(
        (error) => error.pointer !== pointer && !error.pointer.startsWith(`${pointer}/`),
      );
      return errors.length === previous.errors.length ? previous : errors.length ? { ...previous, errors } : undefined;
    });
  }
  return (
    <section className="mx-auto min-w-0 w-full max-w-3xl space-y-6 [overflow-wrap:anywhere]">
      <ViewHeading
        label={m.people_profile_title({}, o)}
        headingClassName="font-sans"
        headingRef={headingRef}
        headingTabIndex={-1}
      />
      {current && <ProfileIntro read={read} locale={locale} />}
      {created && (
        <p role="status">
          {m.people_profile_created_id({}, o)} <code className="break-all">{created}</code>
        </p>
      )}
      <CreateSubjectForm
        locale={locale}
        session={session}
        onCreated={(result) => setCreated(result.id)}
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
            return result;
          },
          read: transport.read,
        }}
        profile={{
          title: m.people_profile_title({}, o),
          hideHeading: true,
          scope: 'people-profile',
          metadata: {
            ready: current,
            pending: recovering,
            failure: recovery,
            types: read.profiles,
          },
          href: `/${locale}/catalogue/people${work ? `?work=${encodeURIComponent(work)}` : ''}`,
          labelLanguage: (type) => read.profiles.find((profile) => profile.id === type)?.lang ?? undefined,
          descriptionLanguage: (type) =>
            read.profiles.find((profile) => profile.id === type)?.descriptionLang ?? undefined,
          control: (pointer, type) => {
            const error = corrections(type, [{ pointer, code: 'invalid_format' }]).get(pointer);
            return error ? { id: error.target, label: error.label } : undefined;
          },
          prepare: (initial) => {
            const item = peopleInitialItem(initial, drafts[initial.type] ?? {});
            const errors = validatePeopleItem(item, read.release);
            setFailure(errors.length ? { ok: false, reason: 'invalid', errors } : undefined);
            return { item, errors };
          },
          fields: (type, disabled, canEdit) => {
            const profile = read.profiles.find((entry) => entry.id === type);
            const fields = drafts[type] ?? {};
            const feedback = [...corrections(type, failure?.errors ?? []).values()];
            return (
              (profile || Object.keys(fields).length > 0) && (
                <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
                  <h2 className="text-xl font-semibold">{m.people_profile_initial({}, o)}</h2>
                  <p className="text-sm text-muted-foreground">{m.people_profile_initial_help({}, o)}</p>
                  <p lang={profile?.descriptionLang ?? undefined}>{profile?.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {(profile?.fields ?? [])
                      .filter((id) => !fields[id])
                      .map((id) => {
                        const name = definitionText(read.release.properties[id]?.labels, locale);
                        return (
                          <Button
                            key={id}
                            type="button"
                            variant="outline"
                            className={peopleActionTarget}
                            disabled={disabled}
                            onClick={() =>
                              update(type, id, undefined, canEdit, () => ({
                                property: { id },
                                value: { type: 'value', content: '' },
                                qualifiers: [],
                                references: [],
                                rank: 'normal',
                              }))
                            }
                          >
                            <span lang={name.lang ?? undefined} className="min-w-0 [overflow-wrap:anywhere]">
                              {m.people_profile_add_fact({ field: name.text }, o)}
                            </span>
                          </Button>
                        );
                      })}
                  </div>
                  {Object.entries(fields).map(([property, statement]) => {
                    const name = definitionText(read.release.properties[property]?.labels, locale);
                    const description = definitionText(read.release.properties[property]?.descriptions, locale);
                    const supported = profile?.fields.includes(property);
                    const citation = statement.references[0]?.parts[0]?.value;
                    const id = rowId(type, property);
                    const errors = feedback.filter((error) => error.id.startsWith(`${id}-error-`));
                    const citationErrors = errors.filter((error) => error.target === `${id}-citation`);
                    return (
                      <fieldset
                        key={id}
                        id={`people-fact-${property}`}
                        disabled={disabled}
                        className="min-w-0 max-w-full"
                      >
                        <legend className="min-w-0 max-w-full" lang={name.lang ?? undefined}>
                          <ContentItemHeading
                            level={3}
                            className="min-w-0 text-lg leading-snug font-semibold [overflow-wrap:anywhere]"
                          >
                            {name.text || m.candidate_value_unavailable({}, o)}
                          </ContentItemHeading>
                        </legend>
                        <ContentItemFrame
                          as="div"
                          data-slot="people-initial-fact"
                          className="flex min-w-0 flex-col gap-3 py-3 sm:py-4 [&_label]:min-w-0 [&_label]:max-w-full [&_label]:flex-wrap [&_label]:whitespace-normal [&_label]:[overflow-wrap:anywhere]"
                        >
                          {description.text && (
                            <p className="min-w-0 text-sm text-muted-foreground" lang={description.lang ?? undefined}>
                              {description.text}
                            </p>
                          )}
                          {supported ? (
                            <ScalarControl
                              part={statement}
                              definition={read.release.properties[property]}
                              read={{ release: read.release, public: { related: {} } }}
                              locale={locale}
                              feedback={{ id, address: 'fact', errors }}
                              onChange={(value) =>
                                update(type, property, id, canEdit, (latest) => ({ ...latest, value }))
                              }
                            />
                          ) : (
                            <EditorFailure reason="stale" locale={locale} />
                          )}
                          <Field>
                            <FieldLabel htmlFor={`${id}-citation`}>{m.relation_citation({}, o)}</FieldLabel>
                            <Input
                              id={`${id}-citation`}
                              aria-invalid={citationErrors.length ? true : undefined}
                              aria-describedby={citationErrors.map((error) => error.id).join(' ') || undefined}
                              className={peopleInputTarget}
                              type="url"
                              value={citation?.type === 'value' ? String(citation.content) : ''}
                              onChange={(event) => {
                                const value = event.target.value;
                                update(type, property, id, canEdit, (latest) => ({
                                  ...latest,
                                  references: value.trim()
                                    ? [
                                        {
                                          parts: [
                                            {
                                              property: { id: 'schema:url' },
                                              value: { type: 'value', content: value },
                                            },
                                          ],
                                        },
                                      ]
                                    : [],
                                }));
                              }}
                            />
                          </Field>
                          {errors.map((error) => (
                            <FieldError key={error.id} id={error.id}>
                              {error.instruction}
                            </FieldError>
                          ))}
                          <PeopleInitialFactRemove
                            key={id}
                            id={id}
                            statement={statement}
                            disabled={disabled || !current || recovering}
                            locale={locale}
                            onRemove={() => update(type, property, id, canEdit)}
                          />
                        </ContentItemFrame>
                      </fieldset>
                    );
                  })}
                  {!!profile?.unsupported.length && (
                    <p className="text-sm text-muted-foreground">
                      {m.people_profile_unsupported({}, o)}{' '}
                      {profile.unsupported.map((id) => {
                        const name = definitionText(read.release.properties[id]?.labels, locale);
                        return (
                          <span key={id} className="me-2" lang={name.lang ?? undefined}>
                            {name.text}
                          </span>
                        );
                      })}
                    </p>
                  )}
                </section>
              )
            );
          },
        }}
      />
    </section>
  );
}

/** One guided surface composed from the existing creation, multi-field and exact native review controls. */
export const PeopleProfileEditor = catalogueEditor(PeopleProfileEditorLive);

function PeopleProfileEditorLive({
  id,
  work,
  locale,
  session,
  transport,
  propose,
  review,
  relations,
  onNavigate,
}: {
  id?: string;
  work?: string;
  locale: string;
  session: Session;
  transport: PeopleTransport;
  propose: FactsTransport['propose'];
  review: (property: string, session?: string) => CandidateTransport;
  relations?: ReactNode;
  onNavigate: (href: string) => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const client = useQueryClient();
  const retryHeading = useRef<HTMLHeadingElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const correctionRetryButton = useRef<HTMLButtonElement>(null);
  const nextRetryOrigin = useRef(0);
  const retryInFlight = useRef(false);
  const [retryOrigin, setRetryOrigin] = useState(0);
  const [retryCompleted, setRetryCompleted] = useState(0);
  const correctionIntent = useRef<CorrectionReloadIntent | undefined>(undefined);
  const correctionScope = JSON.stringify([id ?? null, work ?? null, locale, session, lifetime.generation]);
  const correctionScopeRef = useRef(correctionScope);
  if (correctionScopeRef.current !== correctionScope) {
    correctionScopeRef.current = correctionScope;
    correctionIntent.current = undefined;
  }
  // Retained metadata supports private holders; only an admitted query supplies public authority.
  const retained = useRef<Current | undefined>(undefined);
  function matching(next: PeopleRead): PeopleRead {
    const expectedWork = work ?? retained.current?.work?.subject.id;
    if (id && next.ok) {
      const subject = next.public?.subject;
      const originalType = retained.current?.public?.subject.type;
      if (
        !subject ||
        subject.id !== id ||
        (originalType !== undefined && subject.type !== originalType) ||
        !['schema:Person', 'schema:Organization'].includes(subject.type) ||
        !next.release.types[subject.type] ||
        !next.profiles.some((profile) => profile.id === subject.type) ||
        ((work !== undefined || retained.current !== undefined) && next.work?.subject.id !== expectedWork)
      )
        return { ok: false, reason: 'stale' };
    }
    const anchored = work !== undefined || retained.current !== undefined;
    if (!id && next.ok && (next.public || (anchored && next.work?.subject.id !== expectedWork)))
      return { ok: false, reason: 'stale' };
    return next;
  }
  const query = useQuery({
    queryKey: [...['people-profile', id ?? 'new', work ?? '', locale], lifetime.generation],
    queryFn: async () => matching(await transport.load()),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const observed = query.data && matching(query.data);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingNow = useRef(false);
  // Commit the pause before I/O so nested holders retire callbacks even for an immediate read.
  useEffect(() => {
    if (!refreshing) return;
    void query.refetch({ cancelRefetch: false }).finally(() => {
      if (!lifetime.active()) {
        correctionIntent.current = undefined;
        return;
      }
      const intent = correctionIntent.current;
      if (intent?.scope === correctionScopeRef.current) intent.completed = true;
      else correctionIntent.current = undefined;
      refreshingNow.current = false;
      setRefreshing(false);
    });
  }, [refreshing]);
  useEffect(() => {
    const cancel = (event: Event) => {
      const intent = correctionIntent.current;
      if (!intent) return;
      if (event.type === 'pointerdown') {
        correctionIntent.current = undefined;
        return;
      }
      if (event.target !== intent.opener && event.target !== document.body && event.target !== document.documentElement)
        correctionIntent.current = undefined;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, []);
  function reloadCorrection(event: MouseEvent<HTMLButtonElement>) {
    if (!lifetime.active() || refreshingNow.current || query.isFetching) return;
    correctionIntent.current =
      event.detail === 0 && event.currentTarget === document.activeElement && event.currentTarget.isConnected
        ? { opener: event.currentTarget, scope: correctionScopeRef.current, completed: false }
        : undefined;
    refreshingNow.current = true;
    setRefreshing(true);
  }
  const read = query.isError || (id && (query.isFetching || refreshing)) ? undefined : observed;
  const current = !!read?.ok && !query.isFetching;
  if (current && read?.ok) retained.current = read;
  const retryPending = retryOrigin !== 0 && (retryCompleted !== retryOrigin || query.isFetching);
  function retryInitialRead() {
    if (!lifetime.active() || retryInFlight.current || query.isFetching) return;
    const origin = ++nextRetryOrigin.current;
    retryInFlight.current = true;
    setRetryOrigin(origin);
    void query.refetch().finally(() => {
      if (!lifetime.active()) return;
      retryInFlight.current = false;
      setRetryCompleted(origin);
    });
  }
  useEffect(() => {
    if (!retryOrigin || retryCompleted !== retryOrigin || query.isFetching || !lifetime.active()) return;
    if (read?.ok) retryHeading.current?.focus();
    else retryButton.current?.focus();
    setRetryOrigin((currentOrigin) => (currentOrigin === retryOrigin ? 0 : currentOrigin));
  }, [lifetime, query.dataUpdatedAt, query.errorUpdatedAt, query.isFetching, read?.ok, retryCompleted, retryOrigin]);
  useEffect(() => {
    const intent = correctionIntent.current;
    if (!intent) return;
    if (!lifetime.active() || intent.scope !== correctionScopeRef.current) {
      correctionIntent.current = undefined;
      return;
    }
    if (!intent.completed || refreshing || query.isFetching) return;
    const active = document.activeElement;
    if (intent.opener.isConnected && active === intent.opener) {
      correctionIntent.current = undefined;
      return;
    }
    if (active && active !== document.body && active !== document.documentElement) {
      correctionIntent.current = undefined;
      return;
    }
    correctionIntent.current = undefined;
    (current && read?.ok ? retryHeading.current : correctionRetryButton.current)?.focus();
  }, [correctionScope, current, lifetime, query.isFetching, read?.ok, refreshing]);
  if (id && session === 'signed-in' && retained.current?.public) {
    const privateRead = retained.current;
    const visible = current;
    return (
      <div className={peopleProfileSurface}>
        {!visible && (
          <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6">
            <ViewHeadingActions label={m.people_profile_title({}, o)} headingClassName="font-sans" />
            {query.isFetching || refreshing ? (
              <p role="status">{m.catalogue_create_loading({}, o)}</p>
            ) : (
              <EditorFailure reason={observed && !observed.ok ? observed.reason : 'unavailable'} locale={locale} />
            )}
            <Button
              ref={correctionRetryButton}
              type="button"
              variant="outline"
              className={peopleActionTarget}
              aria-disabled={query.isFetching || refreshing}
              onClick={reloadCorrection}
            >
              {m.correction_retry({}, o)}
            </Button>
          </article>
        )}
        <CatalogueCurrentReading
          visible={visible}
          ready={visible}
          revision={`${query.dataUpdatedAt}:${query.errorUpdatedAt}`}
        >
          <SubjectFacts
            locale={locale}
            initial={{ ok: true, public: privateRead.public!, release: privateRead.release, source: null }}
            profile={{
              title: m.people_profile_title({}, o),
              intro: m.facts_intro({}, o),
              empty: m.facts_empty({}, o),
              path: 'people',
              properties: (current) =>
                peopleProfiles(current.release, locale).find((profile) => profile.id === current.public.subject.type)
                  ?.fields ?? [],
            }}
            profileHeadingRef={retryHeading}
            profileIntro={<ProfileIntro read={privateRead} locale={locale} />}
            transport={{
              propose,
              read: async () => {
                const next = matching(await transport.load());
                return next.ok && next.public
                  ? { ok: true, public: next.public, release: next.release, source: null }
                  : next.ok
                    ? { ok: false, reason: 'unavailable' }
                    : next;
              },
            }}
            onReload={reloadCorrection}
            review={review}
          />
          {relations && <div className={peopleRelationsSurface}>{relations}</div>}
        </CatalogueCurrentReading>
      </div>
    );
  }
  if (!id && retained.current)
    return (
      <PeopleCreate
        read={retained.current}
        current={current}
        recovering={query.isFetching}
        recovery={
          query.isFetching ? (
            <p role="status">{m.catalogue_create_loading({}, o)}</p>
          ) : (
            <EditorFailure reason={read && !read.ok ? read.reason : 'unavailable'} locale={locale} />
          )
        }
        refresh={async () => {
          const next = await query.refetch();
          if (!lifetime.active()) return { ok: false, reason: 'denied' };
          return next.isError || next.isFetching || !next.data
            ? { ok: false, reason: 'unavailable' }
            : matching(next.data);
        }}
        work={work ?? retained.current.work?.subject.id}
        locale={locale}
        session={session}
        transport={transport}
        onNavigate={onNavigate}
        headingRef={retryHeading}
      />
    );
  if (!read?.ok)
    return (
      <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6 [overflow-wrap:anywhere]">
        <ViewHeadingActions label={m.people_profile_title({}, o)} headingClassName="font-sans" />
        {query.isPending || retryPending ? (
          <p role="status">{m.catalogue_create_loading({}, o)}</p>
        ) : (
          <EditorFailure reason={read && !read.ok ? read.reason : 'unavailable'} locale={locale} />
        )}
        {!query.isPending && (
          <Button
            ref={retryButton}
            type="button"
            variant="outline"
            className={peopleActionTarget}
            aria-disabled={retryPending}
            onClick={retryInitialRead}
          >
            {m.catalogue_create_retry({}, o)}
          </Button>
        )}
      </article>
    );
  if (session !== 'signed-in')
    return (
      <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6 [overflow-wrap:anywhere]">
        <ViewHeading
          label={m.people_profile_title({}, o)}
          headingClassName="font-sans"
          headingRef={retryHeading}
          headingTabIndex={-1}
        />
        <ProfileIntro read={read} locale={locale} />
        <p role="status">
          {session === 'signed-out'
            ? m.catalogue_create_signed_out({}, o)
            : session === 'unavailable'
              ? m.catalogue_create_unavailable({}, o)
              : m.catalogue_create_loading({}, o)}
        </p>
        {session === 'unavailable' && (
          <Button
            type="button"
            variant="outline"
            className={peopleActionTarget}
            onClick={() => void client.invalidateQueries({ queryKey: ['session'] })}
          >
            {m.catalogue_create_retry({}, o)}
          </Button>
        )}
        {session === 'signed-out' && (
          <a
            className={peopleLinkTarget + ' underline'}
            href={`/auth/sign-in?return_to=${encodeURIComponent(
              id && read.public
                ? `${subjectHref({ id, label: definitionText(read.public.subject.labels, locale).text }, locale).href}/people`
                : `/${locale}/catalogue/people${work ? `?work=${encodeURIComponent(work)}` : ''}`,
            )}`}
          >
            {m.account_sign_in({}, o)}
          </a>
        )}
      </article>
    );
  return <EditorFailure reason="unavailable" locale={locale} />;
}
