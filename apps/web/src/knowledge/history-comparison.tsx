import { useMemo } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import type { KnowledgeHistoryComparison, KnowledgeHistoryRevision } from './history';

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

function RevisionReading({
  revision,
  other,
  side,
  locale,
}: {
  revision: KnowledgeHistoryRevision;
  other: KnowledgeHistoryRevision;
  side: 'left' | 'right';
  locale: string;
}) {
  const options = { locale: locale as never };
  // Stable document block identity supplies correspondence. No text alignment guesses or quadratic diff.
  const otherBlocks = useMemo(
    () => new Map(other.body.doc.content!.map((block) => [block.attrs!.id as string, JSON.stringify(block)])),
    [other.body],
  );
  return (
    <section
      className="min-w-0 space-y-5"
      aria-label={side === 'left' ? m.knowledge_history_left({}, options) : m.knowledge_history_right({}, options)}
    >
      <h3 className="text-lg font-semibold leading-snug">
        {side === 'left' ? m.knowledge_history_left({}, options) : m.knowledge_history_right({}, options)}
      </h3>
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
      <div className="min-w-0 space-y-4">
        {revision.body.doc.content!.map((block) => {
          const id = block.attrs!.id as string;
          const counterpart = otherBlocks.get(id);
          const change =
            counterpart === undefined ? 'only' : counterpart === JSON.stringify(block) ? 'same' : 'changed';
          return (
            <div key={id} className="min-w-0 space-y-2 border-t border-border pt-3" data-revision-difference={change}>
              <p className="text-sm font-medium">
                {change === 'same'
                  ? m.knowledge_history_unchanged({}, options)
                  : change === 'changed'
                    ? m.knowledge_history_changed({}, options)
                    : m.knowledge_history_only_here({}, options)}
              </p>
              <DocumentBody
                document={{ ...revision.body, doc: { type: 'doc', content: [block] } }}
                locale={locale}
                visitKey={`${revision.documentId}:${revision.revisionId}:${id}`}
              />
            </div>
          );
        })}
      </div>
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
  return (
    <div className="min-w-0 space-y-5">
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.knowledge_history_difference_help({}, options)}
      </p>
      <div className="grid min-w-0 gap-8 md:grid-cols-2">
        <RevisionReading revision={comparison.left} other={comparison.right} side="left" locale={locale} />
        <RevisionReading revision={comparison.right} other={comparison.left} side="right" locale={locale} />
      </div>
      {draft ? (
        <section
          className="min-w-0 space-y-4 border-t border-border pt-6"
          aria-label={m.knowledge_private_your_draft({}, options)}
        >
          <h3 className="text-lg font-semibold">{m.knowledge_private_your_draft({}, options)}</h3>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.knowledge_history_local_draft({}, options)}
          </p>
          <DocumentBody document={draft} locale={locale} />
        </section>
      ) : null}
    </div>
  );
}
