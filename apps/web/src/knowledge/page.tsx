import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import {
  copyKnowledgeCitation,
  knowledgeCitationHref,
  knowledgeExactHref,
  knowledgeLiveHref,
  type KnowledgeCitationClipboard,
  type KnowledgeCitationCopyResult,
  type KnowledgePublicDocument,
  type KnowledgeReadRequest,
  type KnowledgeReadState,
} from './public-read';

export type KnowledgeDocumentPageProps = {
  request: KnowledgeReadRequest;
  page: KnowledgeReadState;
  onRetry?: () => void;
  retrying?: boolean;
  clipboard?: KnowledgeCitationClipboard | null;
  origin?: string;
};

function publicationTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

function admittedDocument(request: KnowledgeReadRequest, page: KnowledgeReadState): KnowledgePublicDocument | null {
  if (page.state !== 'ready') return null;
  if (page.document.documentId !== request.documentId) return null;
  if (request.revisionId !== null && page.document.revisionId !== request.revisionId) return null;
  return page.document;
}

function citationUrl(origin: string | undefined, href: string): string {
  if (!origin) return href;
  try {
    return new URL(href, origin).href;
  } catch {
    return href;
  }
}

function controlClass(extra = '') {
  return `h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] ${extra}`.trim();
}

function KnowledgeCitation({
  href,
  origin,
  clipboard,
}: {
  href: string;
  origin?: string;
  clipboard?: KnowledgeCitationClipboard | null;
}) {
  const statusId = useId();
  const fieldId = useId();
  const attempt = useRef(0);
  const [result, setResult] = useState<KnowledgeCitationCopyResult | null>(null);
  const destination = citationUrl(origin, href);

  useLayoutEffect(() => {
    attempt.current += 1;
    setResult(null);
  }, [destination]);

  async function copy() {
    const current = ++attempt.current;
    setResult(null);
    const next = await copyKnowledgeCitation(
      destination,
      clipboard === undefined && typeof navigator !== 'undefined' ? navigator.clipboard : clipboard,
    );
    if (attempt.current === current) setResult(next);
  }

  return (
    <section className="min-w-0 space-y-3" aria-labelledby={statusId}>
      <h2 id={statusId} className="text-sm font-medium text-foreground">
        {m.knowledge_citation_label()}
      </h2>
      <a
        href={href}
        className="inline-flex min-h-11 max-w-full items-center rounded-sm text-sm underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <bdi dir="ltr">{destination}</bdi>
      </a>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" className={controlClass()} onClick={() => void copy()}>
          {m.knowledge_citation_copy()}
        </Button>
      </div>
      {result === 'success' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.knowledge_citation_copied()}
        </p>
      ) : null}
      {result === 'denied' || result === 'unavailable' ? (
        <div className="min-w-0 space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {result === 'denied' ? m.knowledge_citation_copy_denied() : m.knowledge_citation_copy_unavailable()}
          </p>
          <label htmlFor={fieldId} className="block text-sm">
            {m.knowledge_citation_label()}
          </label>
          <input
            id={fieldId}
            type="text"
            dir="ltr"
            readOnly
            spellCheck={false}
            value={destination}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </div>
      ) : null}
    </section>
  );
}

/** Public Knowledge reader. Live and exact addresses stay distinct; null authorId is not an invented identity. */
export function KnowledgeDocumentPage({
  request,
  page,
  onRetry,
  retrying = false,
  clipboard,
  origin,
}: KnowledgeDocumentPageProps) {
  const locale = getLocale();
  const exact = request.revisionId !== null;
  const document = admittedDocument(request, page);
  const displayed: KnowledgeReadState =
    page.state === 'ready' && !document ? { state: 'unavailable', status: 502 } : page;
  const preparing = displayed.state === 'preparing' || retrying;
  const subject = document ? subjectHref({ id: document.subjectId, label: '' }, locale) : null;
  const liveHref = knowledgeLiveHref(locale, request.documentId);
  const exactHref = document
    ? knowledgeCitationHref(locale, document)
    : request.revisionId
      ? knowledgeExactHref(locale, request.documentId, request.revisionId)
      : liveHref;
  const retry =
    (displayed.state === 'unavailable' || displayed.state === 'denied') && onRetry ? (
      <Button type="button" className={controlClass()} disabled={retrying} onClick={onRetry}>
        {m.knowledge_retry()}
      </Button>
    ) : null;
  const currentOpen = exact ? (
    <a
      href={liveHref}
      className={buttonVariants({ variant: retry ? 'outline' : 'default', className: controlClass() })}
    >
      {m.knowledge_current_open()}
    </a>
  ) : null;

  return (
    <article
      className="mx-auto w-full min-w-0 max-w-3xl space-y-8 text-foreground [overflow-wrap:anywhere]"
      aria-busy={preparing}
    >
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">
          {exact ? m.knowledge_exact_kind() : m.knowledge_live_kind()}
        </p>
        <PageHeading>{document?.title ?? m.knowledge_heading()}</PageHeading>
        {document ? <p className="text-sm text-muted-foreground">{m.knowledge_unattributed()}</p> : null}
        {document ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-foreground">{m.knowledge_published()}</dt>
              <dd>
                <time dateTime={document.publishedAt}>{publicationTime(document.publishedAt, locale)}</time>
              </dd>
            </div>
            {document.language ? (
              <div>
                <dt className="font-medium text-foreground">{m.knowledge_language()}</dt>
                <dd>
                  <bdi dir="ltr">{document.language}</bdi>
                </dd>
              </div>
            ) : null}
            <div className={document.language ? 'sm:col-span-2' : undefined}>
              <dt className="font-medium text-foreground">{m.knowledge_licence()}</dt>
              <dd>{document.licence}</dd>
            </div>
          </dl>
        ) : null}
        {subject ? (
          <a
            href={subject.href}
            className="inline-flex min-h-11 max-w-full items-center rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.knowledge_subject()}
          </a>
        ) : null}
      </header>
      {preparing ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.knowledge_preparing()}
        </p>
      ) : null}
      {!preparing && displayed.state === 'not-found' ? (
        <div className="space-y-4">
          <p role="status">{m.knowledge_not_found()}</p>
          {currentOpen ? <div className="flex flex-wrap items-center gap-3">{currentOpen}</div> : null}
        </div>
      ) : null}
      {!preparing && displayed.state === 'denied' ? (
        <div className="space-y-4">
          <p role="status">{m.knowledge_denied()}</p>
          <div className="flex flex-wrap items-center gap-3">
            {retry}
            {currentOpen}
          </div>
        </div>
      ) : null}
      {!preparing && displayed.state === 'unavailable' ? (
        <div className="space-y-4">
          <p role="alert">{m.knowledge_unavailable()}</p>
          <div className="flex flex-wrap items-center gap-3">
            {retry}
            {currentOpen}
          </div>
        </div>
      ) : null}
      {!preparing && document ? (
        <>
          <DocumentBody
            key={`${document.documentId}:${document.revisionId}`}
            document={document.body}
            locale={locale}
          />
          <KnowledgeCitation href={exactHref} origin={origin} clipboard={clipboard} />
          {exact ? (
            <a
              href={liveHref}
              className="inline-flex min-h-11 max-w-full items-center rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.knowledge_current_open()}
            </a>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
