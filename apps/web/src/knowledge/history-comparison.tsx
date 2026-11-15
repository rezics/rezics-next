import { knowledgeAuthoringImageSelection } from './media';
import { useKnowledgeImageRenderer } from './media-view';
import { KnowledgeDetails } from './workspace';
import { useId, useMemo, useState } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '../document-body';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { m } from '../paraglide/messages.js';
import type { KnowledgeHistoryComparison, KnowledgeHistoryRevision } from './history';

type DocumentBlock = NonNullable<DocumentSnapshot['doc']['content']>[number];

function Value({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

function RevisionMetadata({
  revision,
  side,
  locale,
}: {
  revision: KnowledgeHistoryRevision;
  side: 'left' | 'right';
  locale: string;
}) {
  const options = { locale: locale as never };
  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={side === 'left' ? m.knowledge_history_left({}, options) : m.knowledge_history_right({}, options)}
    >
      <h3 className="break-words text-lg font-semibold leading-snug [overflow-wrap:anywhere]">
        {side === 'left' ? m.knowledge_history_left({}, options) : m.knowledge_history_right({}, options)}
        {' · '}
        {revision.title}
      </h3>
      <KnowledgeDetails label={m.knowledge_workspace_details({}, options)}>
        <dl className="min-w-0 space-y-3">
          <Value label={m.knowledge_private_revision({}, options)}>{revision.revisionId}</Value>
          <Value label={m.knowledge_private_document_title({}, options)}>{revision.title}</Value>
          <Value label={m.knowledge_private_language({}, options)}>{revision.language ?? '—'}</Value>
          <Value label={m.knowledge_private_licence({}, options)}>{revision.licence}</Value>
          <Value label={m.knowledge_history_digest({}, options)}>{revision.sha256}</Value>
          <Value label={m.knowledge_private_subject_ids({}, options)}>{revision.subjectIds.join('\n')}</Value>
          <Value label={m.knowledge_history_provenance({}, options)}>
            {revision.provenance ? JSON.stringify(revision.provenance, null, 2) : '—'}
          </Value>
        </dl>
      </KnowledgeDetails>
      <details className="min-w-0 space-y-3 border-t border-border pt-3">
        <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.knowledge_history_references({}, options)}
        </summary>
        {revision.references.length ? (
          <dl className="min-w-0 space-y-3">
            {revision.references.map((reference) => (
              <Value key={reference.id} label={`${reference.id} · ${reference.role}`}>
                {reference.sourceBlockId ? `${reference.sourceBlockId}\n` : ''}
                {reference.target === null
                  ? m.knowledge_history_reference_unavailable({}, options)
                  : JSON.stringify(reference.target, null, 2)}
              </Value>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{m.knowledge_history_no_references({}, options)}</p>
        )}
      </details>
      <details className="min-w-0 space-y-3 border-t border-border pt-3">
        <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.knowledge_history_source({}, options)}
        </summary>
        <pre className="min-w-0 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
          {revision.source}
        </pre>
      </details>
    </section>
  );
}

function RevisionBlock({
  revision,
  block,
  side,
  change,
  locale,
  renderImage,
}: {
  renderImage: ReturnType<typeof useKnowledgeImageRenderer>;
  revision: KnowledgeHistoryRevision;
  block: DocumentBlock;
  side: 'left' | 'right';
  change: 'same' | 'changed' | 'only';
  locale: string;
}) {
  const options = { locale: locale as never };
  const id = block.attrs!.id as string;
  return (
    <section className="min-w-0 space-y-2" data-revision-difference={change}>
      <h4 className="text-sm font-medium">
        {side === 'left' ? m.knowledge_history_left({}, options) : m.knowledge_history_right({}, options)}
        {' · '}
        {change === 'same'
          ? m.knowledge_history_unchanged({}, options)
          : change === 'changed'
            ? m.knowledge_history_changed({}, options)
            : m.knowledge_history_only_here({}, options)}
      </h4>
      <DocumentBody
        document={{ ...revision.body, doc: { type: 'doc', content: [block] } }}
        locale={locale}
        renderImage={renderImage}
        visitKey={`${revision.documentId}:${revision.revisionId}:${id}`}
      />
    </section>
  );
}

/** Exact saved snapshots are read-only. The local draft has no revision identity. */
export function KnowledgeHistoryComparisonView({
  comparison,
  draft,
  locale,
}: {
  comparison: KnowledgeHistoryComparison;
  draft: DocumentSnapshot | null;
  locale: string;
}) {
  const options = { locale: locale as never };
  const viewId = useId();
  const [view, setView] = useState<'both' | 'left' | 'right'>('both');
  const leftImage = useKnowledgeImageRenderer(
    comparison.left.body,
    knowledgeAuthoringImageSelection(comparison.left),
    locale,
  );
  const rightImage = useKnowledgeImageRenderer(
    comparison.right.body,
    knowledgeAuthoringImageSelection(comparison.right),
    locale,
  );
  // Stable document block identity supplies correspondence. No text alignment guesses or quadratic diff.
  const blockPairs = useMemo(() => {
    const leftBlocks = comparison.left.body.doc.content!;
    const rightBlocks = comparison.right.body.doc.content!;
    const leftById = new Map(leftBlocks.map((block) => [block.attrs!.id as string, block] as const));
    const rightById = new Map(rightBlocks.map((block) => [block.attrs!.id as string, block] as const));
    const ids = [...leftById.keys(), ...[...rightById.keys()].filter((id) => !leftById.has(id))];
    return ids.map((id) => {
      const left = leftById.get(id);
      const right = rightById.get(id);
      return {
        id,
        left,
        right,
        change:
          left === undefined || right === undefined
            ? 'only'
            : JSON.stringify(left) === JSON.stringify(right)
              ? 'same'
              : 'changed',
      } as const;
    });
  }, [comparison.left.body, comparison.right.body]);
  return (
    <div className="min-w-0 space-y-5">
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.knowledge_history_difference_help({}, options)}
      </p>
      <div className="grid min-w-0 gap-8 lg:grid-cols-2">
        <RevisionMetadata revision={comparison.left} side="left" locale={locale} />
        <RevisionMetadata revision={comparison.right} side="right" locale={locale} />
      </div>
      <FieldSet className="sticky top-0 z-10 min-w-0 border-y border-border bg-background/95 py-2">
        <FieldLegend variant="label">{m.knowledge_history_comparison({}, options)}</FieldLegend>
        <RadioGroup
          aria-label={m.knowledge_history_comparison({}, options)}
          value={view}
          onValueChange={(value) => {
            if (value === 'both' || value === 'left' || value === 'right') setView(value);
          }}
          className="grid min-w-0 grid-cols-3 gap-2"
        >
          {(['both', 'left', 'right'] as const).map((choice) => {
            const inputId = `${viewId}-${choice}`;
            const label =
              choice === 'both'
                ? `${m.knowledge_history_left({}, options)} · ${m.knowledge_history_right({}, options)}`
                : choice === 'left'
                  ? m.knowledge_history_left({}, options)
                  : m.knowledge_history_right({}, options);
            return (
              <Field key={choice} orientation="horizontal" className="min-h-11 min-w-0 items-center gap-2">
                <RadioGroupItem id={inputId} value={choice} />
                <FieldLabel htmlFor={inputId} className="min-w-0 break-words">
                  {label}
                </FieldLabel>
              </Field>
            );
          })}
        </RadioGroup>
      </FieldSet>
      <ol className="min-w-0 space-y-5">
        {blockPairs.map((pair) => {
          const hiddenOnlySide =
            view === 'left' && !pair.left && pair.right
              ? 'right'
              : view === 'right' && !pair.right && pair.left
                ? 'left'
                : null;
          return (
            <li key={pair.id} data-revision-block-id={pair.id} className="min-w-0 border-t border-border pt-4">
              {hiddenOnlySide ? (
                <p className="mb-3 text-sm font-medium">
                  {hiddenOnlySide === 'left'
                    ? m.knowledge_history_left({}, options)
                    : m.knowledge_history_right({}, options)}
                  {' · '}
                  {m.knowledge_history_only_here({}, options)}
                </p>
              ) : null}
              <div className="grid min-w-0 gap-6 lg:grid-cols-2">
                {pair.left && view !== 'right' ? (
                  <RevisionBlock
                    revision={comparison.left}
                    block={pair.left}
                    side="left"
                    renderImage={leftImage}
                    change={pair.change}
                    locale={locale}
                  />
                ) : null}
                {pair.right && view !== 'left' ? (
                  <RevisionBlock
                    revision={comparison.right}
                    block={pair.right}
                    side="right"
                    renderImage={rightImage}
                    change={pair.change}
                    locale={locale}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {draft ? (
        <section
          className="min-w-0 space-y-4 border-t border-border pt-6"
          aria-label={m.knowledge_private_your_draft({}, options)}
        >
          <h3 className="text-lg font-semibold">{m.knowledge_private_your_draft({}, options)}</h3>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.knowledge_history_local_draft({}, options)}
          </p>
          <DocumentBody document={draft} locale={locale} renderImage={rightImage} />
        </section>
      ) : null}
    </div>
  );
}
