import type { MouseEvent, ReactNode } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { definitionText } from './definition-guide';
import { EditorFailure, PartValue, StatementFields, type StatementFieldsRead } from './statement-editor-view';
import { presentStatementViolations, type PresentedViolation } from './statement-validation-presentation';
import { emptyCreationStatement, type StatementInput } from './statement-editor';
import { ReferenceReusePanel } from './reference-reuse-view';
import {
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import type { FactDraft } from './subject-facts';
import type { PeopleRead } from './people-profile';
import { peopleCreateFactsRead } from './people-create-model';

const action =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

export type PeopleReuseState = {
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};

export function PeopleCreateFields({
  type,
  disabled,
  canEdit,
  read,
  locale,
  fields,
  errors,
  rowId,
  fieldsets,
  reuse,
  focusCopy,
  onAdd,
  onChange,
  onRemove,
  onReuse,
  onReuseSelected,
  onReuseApply,
  onReuseCancel,
  onReuseRefresh,
  onReuseOpen,
  requestAddition,
  removeControl,
}: {
  type: string;
  disabled: boolean;
  canEdit: () => boolean;
  read: Extract<PeopleRead, { ok: true }>;
  locale: string;
  fields: Record<string, StatementInput>;
  errors: readonly { pointer: string; code: string }[];
  rowId: (type: string, property: string) => string;
  fieldsets: { current: Map<string, HTMLFieldSetElement> };
  reuse: PeopleReuseState | null;
  focusCopy?: { holder: string; index: number; nonce: number };
  onAdd: (property: string, statement: StatementInput) => string | undefined;
  onChange: (property: string, id: string, statement: StatementInput) => void;
  onRemove: (property: string, id: string) => void;
  onReuse: (property: string, index: number) => void;
  onReuseSelected: (holders: string[]) => void;
  onReuseApply: () => void;
  onReuseCancel: () => void;
  onReuseRefresh: () => void;
  onReuseOpen: (holder: string, index: number) => void;
  requestAddition: (
    id: string,
    type: string,
    property: string,
    opener: HTMLButtonElement,
    canEdit: () => boolean,
  ) => void;
  removeControl: (property: string, statement: StatementInput, id: string) => ReactNode;
}) {
  const o = { locale: locale as never };
  const profile = read.profiles.find((entry) => entry.id === type);
  const context: StatementFieldsRead = {
    release: read.release,
    source: null,
    public: { related: {}, subject: { type } },
  };
  const drafts: FactDraft[] = Object.entries(fields).map(([property, statement]) => ({
    holder: rowId(type, property),
    property,
    source: null,
    baseline: null,
    statement,
    included: true,
  }));
  const factsRead = peopleCreateFactsRead(read.release, type);
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
                  className={action}
                  disabled={disabled}
                  onClick={(event?: MouseEvent<HTMLButtonElement>) => {
                    const opener = event?.currentTarget;
                    const keyboard = event?.detail === 0 && opener?.ownerDocument.activeElement === opener;
                    const added = onAdd(id, emptyCreationStatement(id, read.release));
                    if (added && keyboard && opener) requestAddition(added, type, id, opener, canEdit);
                  }}
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
          const supported = !!profile?.fields.includes(property);
          const id = rowId(type, property);
          const presented: PresentedViolation[] = presentStatementViolations(
            errors.flatMap((error) => {
              const prefix = `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}/0`;
              if (error.pointer !== prefix && !error.pointer.startsWith(`${prefix}/`)) return [];
              return [{ pointer: `/statement${error.pointer.slice(prefix.length)}`, code: error.code as never }];
            }),
            statement,
            read.release,
            locale,
            id,
          );
          return (
            <fieldset
              key={id}
              ref={(node) => {
                if (node) fieldsets.current.set(id, node);
                else fieldsets.current.delete(id);
              }}
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
                  <StatementFields
                    creation
                    localDraft
                    stablePartAddresses
                    draft={statement}
                    current={context}
                    locale={locale}
                    feedback={{ id, errors: presented }}
                    heading="h4"
                    guideReturn={`/${locale}/catalogue/people`}
                    change={(next) => onChange(property, id, next)}
                    reuse={
                      canEdit() && Object.keys(fields).length > 1
                        ? { disabled, onReuse: (index) => onReuse(property, index) }
                        : undefined
                    }
                    focusReference={focusCopy && focusCopy.holder === id ? focusCopy : undefined}
                  />
                ) : (
                  <>
                    <EditorFailure reason="stale" locale={locale} />
                    <PartValue part={statement} read={context} locale={locale} />
                  </>
                )}
                {removeControl(property, statement, id)}
              </ContentItemFrame>
            </fieldset>
          );
        })}
        {reuse && (
          <ReferenceReusePanel
            source={reuse.source}
            drafts={drafts}
            selected={reuse.selected}
            read={factsRead}
            locale={locale}
            capture={reuse.capture}
            applied={reuse.applied}
            refused={reuse.refused}
            onSelected={onReuseSelected}
            onApply={onReuseApply}
            onCancel={onReuseCancel}
            onRefresh={onReuseRefresh}
            onOpen={onReuseOpen}
          />
        )}
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
}

export function capturePeopleReuse(
  fields: Record<string, StatementInput>,
  type: string,
  property: string,
  index: number,
  holder: (type: string, property: string) => string,
): PeopleReuseState | null {
  const statement = fields[property];
  const group = statement?.references[index];
  if (!statement || !group) return null;
  const drafts = Object.entries(fields).map(([id, value]) => ({
    holder: holder(type, id),
    property: id,
    source: null,
    baseline: null,
    statement: value,
    included: true,
  }));
  const source = {
    holder: holder(type, property),
    property,
    groupIndex: index,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    source,
    selected: [],
    capture: captureReuse(source, drafts),
    applied: [],
    refused: [],
  };
}
