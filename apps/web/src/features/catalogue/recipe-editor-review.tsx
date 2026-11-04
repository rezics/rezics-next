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
import type { SnakInput, StatementInput } from './statement-editor';
import { StatementSummary } from './statement-summary';

type ReviewStatement = Omit<StatementInput, 'rank'> & { rank?: StatementInput['rank'] | 'deprecated' };

const wrap =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type RecipeReviewRow = {
  id: string;
  statement: StatementInput;
  definition: RecipeProperty;
  original?: boolean | undefined;
  source?: ReviewStatement | undefined;
};

// Authored evidence and comparison entries stay local; ordinary assertions use StatementSummary.
function RecipeEvidencePart({ part, read, locale }: { part: SnakInput; read: StatementFieldsRead; locale: string }) {
  const label = pickText(read.release.properties[part.property.id]?.labels ?? {}, locale);
  return (
    <div className="min-w-0 space-y-1">
      <dt lang={label.lang ?? undefined} className="text-muted-foreground">
        {label.text || part.property.id}
      </dt>
      <dd className="min-w-0 space-y-1">
        <code className="break-all">{part.property.id}</code>
        <PartValue part={part} read={read} locale={locale} />
      </dd>
    </div>
  );
}

function RecipeReferenceGroup({
  group,
  read,
  locale,
}: {
  group: StatementInput['references'][number];
  read: StatementFieldsRead;
  locale: string;
}) {
  return group.parts.length ? (
    <dl className="min-w-0 space-y-2">
      {group.parts.map((part, index) => (
        <RecipeEvidencePart key={index} part={part} read={read} locale={locale} />
      ))}
    </dl>
  ) : (
    <p className="text-muted-foreground">{m.facts_reuse_empty({}, { locale: locale as never })}</p>
  );
}

function RecipeAuthoredPreview({ statement, locale }: { statement: ReviewStatement; locale: string }) {
  const o = { locale: locale as never };
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  const authored =
    content && typeof content === 'object' && !Array.isArray(content)
      ? (content as { language?: string; licence?: string; document?: unknown })
      : undefined;
  const document = authored?.document;
  if (!authored) return <p className="text-sm text-muted-foreground">{m.correction_error_required({}, o)}</p>;
  return (
    <div className="min-w-0 space-y-2">
      <dl className="min-w-0 space-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">{m.catalogue_create_language({}, o)}</dt>
          <dd>
            {typeof authored.language === 'string' && authored.language
              ? authored.language
              : m.correction_error_required({}, o)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.subject_source_licence({}, o)}</dt>
          <dd>
            {typeof authored.licence === 'string' && authored.licence
              ? authored.licence
              : m.correction_error_required({}, o)}
          </dd>
        </div>
      </dl>
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
  statement: ReviewStatement;
  definition: RecipeProperty;
  read: StatementFieldsRead;
  locale: string;
  original?: boolean | undefined;
}) {
  const o = { locale: locale as never };
  if (definition.datatype !== 'document') return <StatementSummary statement={statement} read={read} locale={locale} />;
  const label = pickText(definition.labels, locale);
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <p lang={label.lang ?? undefined} className="text-muted-foreground">
        {label.text || statement.property.id}
      </p>
      <code className="break-all">{statement.property.id}</code>
      <RecipeAuthoredPreview statement={statement} locale={locale} />
      {original !== undefined && <p>{original ? m.recipe_original({}, o) : m.correction_error_required({}, o)}</p>}
      {(statement.qualifiers ?? []).length > 0 && (
        <div className="min-w-0 space-y-2">
          <p className="font-medium">{m.correction_qualifiers({}, o)}</p>
          <ol className="min-w-0 space-y-3">
            {(statement.qualifiers ?? []).map((part, index) => (
              <li key={index} className="min-w-0 space-y-1 border-s-2 border-border ps-3">
                <p className="text-muted-foreground">
                  {m.correction_qualifiers({}, o)} {index + 1}
                </p>
                <dl>
                  <RecipeEvidencePart part={part} read={read} locale={locale} />
                </dl>
              </li>
            ))}
          </ol>
        </div>
      )}
      <ol className="min-w-0 space-y-3">
        {statement.references.map((group, index) => (
          <li key={index} className="min-w-0 space-y-1 border-s-2 border-border ps-3">
            <p className="text-muted-foreground">
              {m.correction_references({}, o)} {index + 1}
            </p>
            <RecipeReferenceGroup group={group} read={read} locale={locale} />
          </li>
        ))}
      </ol>
      <p>
        {statement.rank === 'preferred'
          ? m.candidate_rank_preferred({}, o)
          : statement.rank === 'deprecated'
            ? m.changes_rank_deprecated({}, o)
            : m.candidate_rank_normal({}, o)}
      </p>
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
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]" aria-label={m.recipe_review_title({}, o)}>
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
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]" aria-label={m.recipe_review_statement({}, o)}>
      <ContentItemHeading level={3} className="text-base font-semibold" lang={label.lang ?? undefined}>
        {label.text || row.statement.property.id}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">
        <DefinitionMeaning values={row.definition.descriptions} locale={locale} />
      </p>
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
            <RecipeAssertionPreview statement={current} definition={row.definition} read={read} locale={locale} />
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
      <ol className="min-w-0 space-y-3 text-sm" aria-label={m.correction_references({}, o)}>
        {groups.map((group, index) => (
          <li key={index} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
            <p className="font-medium">
              {m.correction_references({}, o)} {index + 1} · {changeLabel[group.change]}
            </p>
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              {group.current && (
                <div className="min-w-0 space-y-2">
                  <p className="font-medium text-muted-foreground">{m.recipe_review_current({}, o)}</p>
                  <RecipeReferenceGroup group={group.current} read={read} locale={locale} />
                </div>
              )}
              {group.next && (
                <div className="min-w-0 space-y-2">
                  <p className="font-medium">{m.recipe_review_statement({}, o)}</p>
                  <RecipeReferenceGroup group={group.next} read={read} locale={locale} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <Button type="button" variant="outline" className={wrap} onClick={() => onJump(row.id)}>
        {m.facts_review_open_field({}, o)}
      </Button>
    </section>
  );
}
