import type { KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
import { useKnowledgeImageRenderer } from './media-view';
import { useLayoutEffect, useId, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import type { DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '../document-body';
import { subjectHref } from '../subject/subject-href';
import { knowledgeExactHref, knowledgeLiveHref } from './public-read';
import { referenceCopy } from './reference-copy';
import { referenceLabel, type KnowledgeReference, type KnowledgeReferenceTarget } from './reference-model';
import type { ReferenceInspection, ReferenceInspector } from './reference-read';
import { inspectKnowledgePublicReferenceRequest } from './reference-server';

export const referenceControl =
  'h-auto min-h-7 max-w-full whitespace-normal break-words text-start leading-snug';
export const referenceInput =
  'min-w-0 w-full max-w-full text-foreground';
const publicInspector: ReferenceInspector = (input) => inspectKnowledgePublicReferenceRequest({ data: input });
type InspectionContext = {
  reference: KnowledgeReference;
  target: KnowledgeReferenceTarget;
  notebookId: string | null;
};
type ReferenceWorkspace = {
  sourceKey: string;
  context: InspectionContext;
  result: ReferenceInspection | { state: 'loading' };
};

/** The native source manifest is the disclosure authority. No target metadata is inferred or cached here. */
export function ReferenceIdentity({ reference, locale }: { reference: KnowledgeReference; locale: string }) {
  const copy = referenceCopy(locale);
  const target = reference.target;
  return (
    <dl className="grid min-w-0 gap-2 text-sm [overflow-wrap:anywhere]">
      <div>
        <dt className="font-medium">{copy.role}</dt>
        <dd>{copy.roles[reference.role]}</dd>
      </div>
      {reference.sourceBlockId !== undefined ? (
        <div>
          <dt className="font-medium">{copy.sourceBlock}</dt>
          <dd>{reference.sourceBlockId}</dd>
        </div>
      ) : null}
      {target === null ? (
        <div>
          <dd>{copy.unavailable}</dd>
        </div>
      ) : (
        <>
          <div>
            <dt className="font-medium">{copy.kind}</dt>
            <dd>{target.kind === 'subject' ? copy.subject : target.kind === 'document' ? copy.live : copy.exact}</dd>
          </div>
          <div>
            <dt className="font-medium">{target.kind === 'subject' ? copy.subjectId : copy.documentId}</dt>
            <dd>{target.kind === 'subject' ? target.subjectId : target.documentId}</dd>
          </div>
          {target.kind === 'revision' ? (
            <>
              <div>
                <dt className="font-medium">{copy.revisionId}</dt>
                <dd>{target.revisionId}</dd>
              </div>
              <div>
                <dt className="font-medium">{copy.digest}</dt>
                <dd>{target.sha256}</dd>
              </div>
              {target.blockId !== undefined ? (
                <div>
                  <dt className="font-medium">{copy.blockId}</dt>
                  <dd>{target.blockId}</dd>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </dl>
  );
}

export function referenceHref(reference: KnowledgeReference, locale: string): string | null {
  const target = reference.target;
  if (!target) return null;
  if (target.kind === 'subject') return subjectHref({ id: target.subjectId, label: '' }, locale).href;
  if (target.kind === 'document') return knowledgeLiveHref(locale, target.documentId);
  // The citation's digest and block remain in the review. The full visit still selects only this exact revision.
  return knowledgeExactHref(locale, target.documentId, target.revisionId);
}

/** One selected target at a time. Body rendering intentionally has no reference expansion controls. */
export function KnowledgeReferenceList({
  body,
  references = [],
  locale,
  inspect = publicInspector,
  privateTargets = false,
  inspectable = true,
}: {
  body: DocumentSnapshot;
  references?: readonly KnowledgeReference[] | undefined;
  locale: string;
  inspect?: ReferenceInspector | undefined;
  privateTargets?: boolean;
  inspectable?: boolean;
}) {
  const copy = referenceCopy(locale);
  const heading = useId();
  const notebookField = useId();
  const [workspace, setWorkspace] = useState<ReferenceWorkspace | null>(null);
  const [notebookId, setNotebookId] = useState('');
  const key = JSON.stringify([body, references, locale, privateTargets, inspectable]);
  const current = useRef({ key: '', generation: 0, active: true, context: null as InspectionContext | null });
  if (current.current.key !== key) {
    current.current.key = key;
    current.current.generation++;
    current.current.context = null;
    setWorkspace(null);
    setNotebookId('');
  }
  useLayoutEffect(() => {
    current.current.active = true;
    return () => {
      current.current.active = false;
      current.current.generation++;
      current.current.context = null;
    };
  }, []);
  const activeWorkspace = workspace?.sourceKey === key ? workspace : null;
  const reference = activeWorkspace?.context.reference;
  const result = activeWorkspace?.result ?? null;
  function currentInspection(generation: number, context: InspectionContext) {
    return (
      current.current.active &&
      current.current.generation === generation &&
      current.current.key === key &&
      current.current.context === context
    );
  }
  async function read(item: KnowledgeReference, privateNotebook: string | null) {
    if (!current.current.active || current.current.key !== key || !item.target || item.target.kind === 'subject')
      return;
    const target: KnowledgeReferenceTarget = { ...item.target };
    const context: InspectionContext = {
      reference: { ...item, target },
      target,
      notebookId: privateNotebook,
    };
    const generation = ++current.current.generation;
    current.current.context = context;
    setWorkspace({ sourceKey: key, context, result: { state: 'loading' } });
    try {
      const next = await inspect({ target: context.target, locale, notebookId: context.notebookId });
      if (currentInspection(generation, context)) setWorkspace({ sourceKey: key, context, result: next });
    } catch {
      if (currentInspection(generation, context))
        setWorkspace({ sourceKey: key, context, result: { state: 'unavailable' } });
    }
  }
  function close() {
    current.current.generation++;
    current.current.context = null;
    setWorkspace(null);
    setNotebookId('');
  }
  if (!references.length) return null;
  return (
    <section className="min-w-0 space-y-4 border-t border-border pt-5" aria-labelledby={heading}>
      <h3 id={heading} className="text-base font-semibold">
        {copy.title} ({references.length}/64)
      </h3>
      <ol className="min-w-0 divide-y divide-border">
        {references.map((item) => {
          const href = referenceHref(item, locale);
          const label = referenceLabel(body, item.id);
          return (
            <li key={item.id} className="min-w-0 space-y-3 py-4" data-reference-id={item.id}>
              {label ? <p className="font-medium [overflow-wrap:anywhere]">{label}</p> : null}
              <ReferenceIdentity reference={item} locale={locale} />
              <p className="text-sm text-muted-foreground">
                {item.target?.kind === 'document'
                  ? copy.liveHint
                  : item.target?.kind === 'revision'
                    ? copy.exactHint
                    : null}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                {href ? (
                  <a
                    href={href}
                    className="inline-flex max-w-full items-center text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {copy.open}
                  </a>
                ) : null}
                {inspectable && item.target && item.target.kind !== 'subject' ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={referenceControl}
                    onClick={() => {
                      setNotebookId('');
                      void read(item, null);
                    }}
                  >
                    {copy.inspect}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {reference ? (
        <div className="min-w-0 space-y-4 border-t border-border pt-4" aria-label={copy.inspect}>
          <ReferenceIdentity reference={reference} locale={locale} />
          {privateTargets ? (
            <div className="min-w-0 space-y-2">
              <label htmlFor={notebookField} className="block text-sm font-medium">
                {copy.privateNotebook}
              </label>
              <Input
                id={notebookField}
                className={referenceInput}
                value={notebookId}
                maxLength={36}
                onChange={(event) => setNotebookId(event.currentTarget.value)}
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className={referenceControl}
                  onClick={() => void read(reference, null)}
                >
                  {copy.publicMode}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={referenceControl}
                  disabled={!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(notebookId)}
                  onClick={() => void read(reference, notebookId)}
                >
                  {copy.privateMode}
                </Button>
              </div>
            </div>
          ) : null}
          {result?.state === 'loading' ? (
            <p role="status">{copy.loading}</p>
          ) : result?.state === 'ready' ? (
            <div className="min-w-0 space-y-3">
              <h4 className="font-semibold [overflow-wrap:anywhere]">{result.title}</h4>
              <KnowledgeReferenceBody
                document={result.body}
                locale={locale}
                inspectable={false}
                mediaSelection={result.mediaSelection ?? null}
                visitKey={`${reference.id}:${result.documentId}:${result.revisionId}`}
              />
            </div>
          ) : result ? (
            <p role="status">{copy.unavailable}</p>
          ) : null}
          <Button type="button" variant="outline" className={referenceControl} onClick={close}>
            {copy.close}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function KnowledgeReferenceBody({
  references,
  inspectable = true,
  mediaSelection = null,
  visitKey,
  ...props
}: {
  document: DocumentSnapshot;
  references?: readonly KnowledgeReference[] | undefined;
  locale: string;
  inspectable?: boolean;
  mediaSelection?: KnowledgeMediaSelection | null;
  visitKey?: string;
}) {
  const renderImage = useKnowledgeImageRenderer(props.document, mediaSelection, props.locale);
  return (
    <>
      <DocumentBody {...props} {...(visitKey === undefined ? {} : { visitKey })} renderImage={renderImage} />
      <KnowledgeReferenceList
        body={props.document}
        references={references}
        locale={props.locale}
        inspectable={inspectable}
      />
    </>
  );
}
