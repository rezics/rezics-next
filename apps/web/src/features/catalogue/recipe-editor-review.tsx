import { pickText } from '@rezics/composition';
import { checkDocument } from '@rezics/document';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../../document-body';
import { m } from '../../paraglide/messages.js';
import { DefinitionMeaning } from './definition-meaning';
import { recipeEvidenceChanges, type RecipeProperty } from './recipe-editor';
import type { TermDraft } from './create-subject';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
import type { StatementInput } from './statement-editor';

const wrap =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type RecipeReviewRow = {
  id: string;
  statement: StatementInput;
  definition: RecipeProperty;
  original?: boolean;
  source?: StatementInput | undefined;
};

function RecipeEvidenceList({
  statement,
  read,
  locale,
}: {
  statement: StatementInput;
  read: StatementFieldsRead;
  locale: string;
}) {
  const o = { locale: locale as never };
  if (!statement.references.length) return null;
  return (
    <ol className="min-w-0 space-y-3">
      {statement.references.map((group, index) => (
        <li key={index} className="min-w-0 space-y-1 border-s-2 border-border ps-3 text-sm">
          <p className="text-muted-foreground">
            {m.correction_references({}, o)} {index + 1}
          </p>
          <ul className="min-w-0 space-y-1">
            {group.parts.map((part, partIndex) => (
              <li key={partIndex} className="min-w-0">
                <PartValue part={part} read={read} locale={locale} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function RecipeAuthoredPreview({ statement, locale }: { statement: StatementInput; locale: string }) {
  const o = { locale: locale as never };
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  const authored =
    content && typeof content === 'object'
      ? (content as { language?: string; licence?: string; document?: unknown })
      : undefined;
  const document = authored?.document;
  if (!authored) return <p className="text-sm text-muted-foreground">{m.correction_error_required({}, o)}</p>;
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm">
        {m.catalogue_create_language({}, o)}: {authored.language || m.correction_error_required({}, o)}
      </p>
      <p className="text-sm">
        {m.subject_source_licence({}, o)}: {authored.licence || m.correction_error_required({}, o)}
      </p>
      {checkDocument(document) ? (
        <DocumentBody document={document} locale={locale} />
      ) : (
        <p role="status" className="text-sm">
          {m.correction_error_invalid_format({}, o)} {m.recipe_method_help({}, o)}
        </p>
      )}
    </div>
  );
}

function RecipeAssertionPreview({
  statement,
  definition,
  read,
  locale,
  original,
}: {
  statement: StatementInput;
  definition: RecipeProperty;
  read: StatementFieldsRead;
  locale: string;
  original?: boolean;
}) {
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-3">
      {definition.datatype === 'document' ? (
        <RecipeAuthoredPreview statement={statement} locale={locale} />
      ) : (
        <div className="min-w-0 text-base leading-relaxed">
          <PartValue part={statement} read={read} locale={locale} />
        </div>
      )}
      {definition.datatype === 'document' && (
        <p className="text-sm">{original ? m.recipe_original({}, o) : m.correction_error_required({}, o)}</p>
      )}
      {(statement.qualifiers ?? []).length > 0 && (
        <dl className="min-w-0 space-y-2 text-sm">
          {(statement.qualifiers ?? []).map((part, index) => (
            <div key={index} className="min-w-0 space-y-1">
              <dt className="text-muted-foreground">
                {pickText(read.release.properties[part.property.id]?.labels ?? {}, locale).text ||
                  m.subject_value_unlabelled({}, o)}
              </dt>
              <dd>
                <PartValue part={part} read={read} locale={locale} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <RecipeEvidenceList statement={statement} read={read} locale={locale} />
    </div>
  );
}

export function RecipeCreateReview({
  terms,
  rows,
  read,
  locale,
  stale,
  onJump,
}: {
  terms: (TermDraft & { id: number })[];
  rows: RecipeReviewRow[];
  read: StatementFieldsRead;
  locale: string;
  stale: boolean;
  onJump: (target: string) => void;
}) {
  const o = { locale: locale as never };
  return (
    <section className="min-w-0 space-y-4" aria-label={m.recipe_review_title({}, o)}>
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.recipe_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.recipe_review_intro({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.recipe_review_stale({}, o)}
        </p>
      )}
      <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
        <ContentItemHeading level={3} className="text-base font-semibold">
          {m.catalogue_create_terms({}, o)}
        </ContentItemHeading>
        <dl className="min-w-0 space-y-3 text-sm">
          {terms.map((term, index) => (
            <div key={term.id} className="min-w-0 space-y-1">
              <dt className="font-medium">
                {m.catalogue_create_terms({}, o)} {index + 1} · {term.language}
              </dt>
              <dd lang={term.language || undefined} className="min-w-0 space-y-1">
                <p>
                  {m.catalogue_create_label({}, o)}: {term.label}
                </p>
                <p>
                  {m.catalogue_create_description({}, o)}: {term.description}
                </p>
                <p>
                  {m.catalogue_create_aliases({}, o)}: {term.aliases}
                </p>
                <Button type="button" variant="outline" className={wrap} onClick={() => onJump(`term-${term.id}`)}>
                  {m.facts_review_open_field({}, o)}
                </Button>
              </dd>
            </div>
          ))}
        </dl>
      </ContentItemFrame>
      {rows.map((row) => {
        const label = pickText(row.definition.labels, locale);
        return (
          <ContentItemFrame key={row.id} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
            <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang ?? undefined}>
              {label.text || row.statement.property.id}
            </ContentItemHeading>
            <p className="text-sm text-muted-foreground">
              <DefinitionMeaning values={row.definition.descriptions} locale={locale} />
            </p>
            <RecipeAssertionPreview
              statement={row.statement}
              definition={row.definition}
              read={read}
              locale={locale}
              original={row.original}
            />
            <Button type="button" variant="outline" className={wrap} onClick={() => onJump(row.id)}>
              {m.facts_review_open_field({}, o)}
            </Button>
          </ContentItemFrame>
        );
      })}
    </section>
  );
}

export function RecipeCorrectionReview({
  row,
  read,
  locale,
  stale,
  onJump,
}: {
  row: RecipeReviewRow;
  read: StatementFieldsRead;
  locale: string;
  stale: boolean;
  onJump: (target: string) => void;
}) {
  const o = { locale: locale as never };
  const label = pickText(row.definition.labels, locale);
  const current = row.source;
  const groups = recipeEvidenceChanges(current?.references, row.statement.references);
  const changeLabel: Record<(typeof groups)[number]['change'], string> = {
    retained: m.recipe_evidence_retained({}, o),
    added: m.recipe_evidence_added({}, o),
    edited: m.recipe_evidence_edited({}, o),
    removed: m.recipe_evidence_removed({}, o),
  };
  return (
    <section className="min-w-0 space-y-4" aria-label={m.recipe_review_statement({}, o)}>
      <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang ?? undefined}>
        {label.text || row.statement.property.id}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.recipe_review_intro({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.recipe_review_stale({}, o)}
        </p>
      )}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <ContentItemFrame as="div" className="min-w-0 space-y-2 rounded-xl bg-muted/30 p-4">
          <h4 className="text-sm font-semibold text-muted-foreground">{m.recipe_review_current({}, o)}</h4>
          {current ? (
            <RecipeAssertionPreview
              statement={current}
              definition={row.definition}
              read={read}
              locale={locale}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>
          )}
        </ContentItemFrame>
        <ContentItemFrame as="div" className="min-w-0 space-y-2 rounded-xl bg-card p-4">
          <h4 className="text-sm font-semibold">{m.recipe_review_statement({}, o)}</h4>
          <RecipeAssertionPreview
            statement={row.statement}
            definition={row.definition}
            read={read}
            locale={locale}
            original={row.original}
          />
        </ContentItemFrame>
      </div>
      <ul className="min-w-0 space-y-2 text-sm">
        {groups.map((group, index) => (
          <li key={index}>
            {changeLabel[group.change]}
            {(group.next ?? group.current)?.parts.map((part, partIndex) => (
              <span key={partIndex} className="ms-2">
                <PartValue part={part} read={read} locale={locale} />
              </span>
            ))}
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" className={wrap} onClick={() => onJump(row.id)}>
        {m.facts_review_open_field({}, o)}
      </Button>
    </section>
  );
}
