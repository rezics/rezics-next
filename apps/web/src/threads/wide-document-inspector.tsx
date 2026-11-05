import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { DocumentNode } from '@rezics/document';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@rezics/ui/shadcn/code-block';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@rezics/ui/shadcn/dialog';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { DocumentBody } from '../document-body';
import {
  currentClipboard,
  selectedCodeForCopy,
  writeCodeToClipboard,
  type WideDocumentCopyState,
} from './wide-document-copy';
import { WideDocumentCode, WideDocumentCopyFeedback } from './wide-document-code';
import { WideDocumentTable } from './wide-document-table';
import { MAX_WIDE_CODE_BYTES, registerWideDocumentBlocks, type WideDocumentDescriptor } from './wide-document-reading';

type TextDirection = 'ltr' | 'rtl' | 'auto';

export type WideDocumentInspection = Readonly<
  | {
      kind: 'code';
      descriptor: WideDocumentDescriptor;
      children: ReactNode;
      language?: string | undefined;
      documentLanguage?: string | undefined;
      direction?: TextDirection | undefined;
      wrap: boolean;
    }
  | {
      kind: 'table';
      descriptor: WideDocumentDescriptor;
      children: ReactNode;
      caption?: string | undefined;
      language?: string | undefined;
      direction?: TextDirection | undefined;
    }
>;

type Props = ComponentProps<typeof DocumentBody> & {
  visitKey: string;
  focusBoundaryRef: { readonly current: HTMLElement | null };
  disclosedSpoilers?: ReadonlySet<number>;
  isReadingCurrent?: () => boolean;
};

type PendingCopy = { text: string; operation: number };
const noDisclosures: ReadonlySet<number> = new Set();

/** One current-visit registry and one active inspector for the published document. */
export function WideDocumentReading({
  document,
  visitKey,
  focusBoundaryRef,
  disclosedSpoilers = noDisclosures,
  isReadingCurrent,
  renderCodeBlock: callerCodeBlock,
  renderTable: callerTable,
  ...documentProps
}: Props) {
  const readingLocale = documentProps.locale ?? getLocale();
  const descriptors = useMemo(
    () => registerWideDocumentBlocks(document, disclosedSpoilers),
    [document, visitKey, disclosedSpoilers],
  );
  const descriptorsByNode = useMemo(() => {
    const result = new WeakMap<DocumentNode, WideDocumentDescriptor>();
    for (const descriptor of descriptors) result.set(descriptor.node, descriptor);
    return result;
  }, [descriptors]);
  const [active, setActive] = useState<WideDocumentInspection | null>(null);
  const activeRef = useRef<WideDocumentInspection | null>(null);
  activeRef.current = active;
  const [copyState, setCopyState] = useState<WideDocumentCopyState | undefined>();
  const copyStateRef = useRef<WideDocumentCopyState | undefined>(copyState);
  copyStateRef.current = copyState;
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingCopy = useRef<PendingCopy | null>(null);
  const lifetime = useRef({ visit: 0, operation: 0 });
  const wasOpen = useRef(false);
  const isCurrent = useCallback(() => isReadingCurrent?.() ?? true, [isReadingCurrent]);

  const updateCopyState = useCallback((next: WideDocumentCopyState | undefined) => {
    copyStateRef.current = next;
    setCopyState(next);
  }, []);

  const clearPendingCopy = useCallback(() => {
    lifetime.current.operation += 1;
    if (pendingCopy.current) pendingCopy.current.text = '';
    pendingCopy.current = null;
    if (copyStateRef.current?.status === 'pending') updateCopyState(undefined);
  }, [updateCopyState]);

  const inspect = useCallback(
    (inspection: WideDocumentInspection, trigger: HTMLButtonElement) => {
      if (!isCurrent()) return;
      clearPendingCopy();
      returnFocus.current = trigger;
      activeRef.current = inspection;
      setActive(inspection);
    },
    [clearPendingCopy, isCurrent],
  );

  const close = useCallback(() => {
    if (!activeRef.current) return;
    clearPendingCopy();
    activeRef.current = null;
    setActive(null);
  }, [clearPendingCopy]);

  useLayoutEffect(() => {
    if (!active) return;
    const current = descriptorsByNode.get(active.descriptor.node);
    if (!current || current.kind !== active.kind) close();
  }, [active, close, descriptorsByNode]);

  const copy = useCallback(
    async (descriptor: WideDocumentDescriptor) => {
      if (!isCurrent()) return;
      if (descriptor.kind !== 'code' || (descriptor.codeBytes ?? MAX_WIDE_CODE_BYTES + 1) > MAX_WIDE_CODE_BYTES) return;

      let text: string;
      try {
        text = selectedCodeForCopy(descriptor);
      } catch {
        return;
      }

      const operation = ++lifetime.current.operation;
      const visit = lifetime.current.visit;
      const pending = { text, operation };
      text = '';
      pendingCopy.current = pending;
      updateCopyState({ blockOrder: descriptor.order, status: 'pending' });
      const result = await writeCodeToClipboard(pending.text, currentClipboard());
      if (
        !isCurrent() ||
        lifetime.current.visit !== visit ||
        lifetime.current.operation !== operation ||
        pendingCopy.current !== pending
      ) {
        pending.text = '';
        return;
      }

      pendingCopy.current = null;
      if (result === 'copied') {
        pending.text = '';
        updateCopyState({ blockOrder: descriptor.order, status: 'copied' });
        return;
      }
      updateCopyState({ blockOrder: descriptor.order, status: result, text: pending.text });
      pending.text = '';
    },
    [isCurrent, updateCopyState],
  );

  useLayoutEffect(() => {
    if (wasOpen.current && !active) {
      if (isCurrent()) {
        const target = returnFocus.current?.isConnected ? returnFocus.current : focusBoundaryRef.current;
        target?.focus({ preventScroll: true });
      }
      returnFocus.current = null;
    }
    wasOpen.current = active !== null;
  }, [active, focusBoundaryRef, isCurrent]);

  useLayoutEffect(
    () => () => {
      lifetime.current.visit += 1;
      lifetime.current.operation += 1;
      if (pendingCopy.current) pendingCopy.current.text = '';
      pendingCopy.current = null;
      returnFocus.current = null;
      activeRef.current = null;
    },
    [focusBoundaryRef],
  );

  const renderCodeBlock = useCallback(
    (node: DocumentNode, children: ReactNode, defaultContent: ReactNode) => {
      const descriptor = descriptorsByNode.get(node);
      if (!descriptor || descriptor.kind !== 'code') {
        return callerCodeBlock ? callerCodeBlock(node, children, defaultContent) : defaultContent;
      }
      return (
        <WideDocumentCode
          key={descriptor.order}
          descriptor={descriptor}
          children={children}
          language={stringAttribute(node.attrs?.language)}
          documentLanguage={stringAttribute(node.attrs?.lang)}
          direction={textDirection(node.attrs?.dir)}
          locale={readingLocale}
          copyState={copyState?.blockOrder === descriptor.order ? copyState : undefined}
          onCopy={copy}
          onInspect={inspect}
        />
      );
    },
    [callerCodeBlock, copy, copyState, descriptorsByNode, inspect, readingLocale],
  );

  const renderTable = useCallback(
    (node: DocumentNode, children: ReactNode, defaultContent: ReactNode) => {
      const descriptor = descriptorsByNode.get(node);
      if (!descriptor || descriptor.kind !== 'table') {
        return callerTable ? callerTable(node, children, defaultContent) : defaultContent;
      }
      return (
        <WideDocumentTable
          key={descriptor.order}
          descriptor={descriptor}
          children={children}
          caption={typeof node.attrs?.caption === 'string' ? node.attrs.caption : undefined}
          language={stringAttribute(node.attrs?.lang)}
          direction={textDirection(node.attrs?.dir)}
          locale={readingLocale}
          onInspect={inspect}
        />
      );
    },
    [callerTable, descriptorsByNode, inspect, readingLocale],
  );

  return (
    <>
      <DocumentBody
        {...documentProps}
        document={document}
        visitKey={visitKey}
        renderCodeBlock={renderCodeBlock}
        renderTable={renderTable}
      />
      <WideDocumentInspector
        active={active}
        locale={readingLocale}
        copyState={copyState?.blockOrder === active?.descriptor.order ? copyState : undefined}
        onCopy={copy}
        onClose={close}
      />
    </>
  );
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function textDirection(value: unknown): TextDirection | undefined {
  return value === 'ltr' || value === 'rtl' || value === 'auto' ? value : undefined;
}

function WideDocumentInspector({
  active,
  locale,
  copyState,
  onCopy,
  onClose,
}: {
  active: WideDocumentInspection | null;
  locale: string;
  copyState?: WideDocumentCopyState | undefined;
  onCopy: (descriptor: WideDocumentDescriptor) => void;
  onClose: () => void;
}) {
  const options = { locale: locale as never };
  const title =
    active?.kind === 'table' ? m.wide_document_table_title({}, options) : m.wide_document_code_title({}, options);
  return (
    <Dialog open={active !== null} onOpenChange={(open) => !open && onClose()}>
      {active ? (
        <DialogContent
          showCloseButton={false}
          className="wide-document-inspector-content grid h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100dvw-1rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-h-none max-w-none grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden rounded-xl p-3 motion-reduce:animate-none motion-reduce:duration-0 motion-reduce:transition-none sm:h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:w-[calc(100dvw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] sm:p-5"
        >
          <DialogHeader className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="min-w-0 space-y-1">
              <DialogTitle className="[overflow-wrap:anywhere]">{title}</DialogTitle>
              <DialogDescription className="[overflow-wrap:anywhere]">
                {m.wide_document_inspector_description({}, options)}
              </DialogDescription>
            </div>
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 min-w-11 shrink-0 px-3"
                  aria-label={m.wide_document_inspector_close({}, options)}
                />
              }
            >
              {m.wide_document_inspector_close({}, options)}
            </DialogClose>
          </DialogHeader>
          {active.kind === 'code' ? (
            <CodeInspectionView
              key={active.descriptor.order}
              inspection={active}
              copyState={copyState}
              locale={locale}
              onCopy={onCopy}
            />
          ) : (
            <div
              className="wide-document-inspector-table-scroll"
              role="region"
              aria-label={m.wide_document_table_scroll({}, options)}
              tabIndex={0}
              lang={active.language}
              dir={active.direction}
            >
              <table>
                {active.caption !== undefined ? <caption>{active.caption}</caption> : null}
                <tbody>{active.children}</tbody>
              </table>
            </div>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function CodeInspectionView({
  inspection,
  copyState,
  locale,
  onCopy,
}: {
  inspection: Extract<WideDocumentInspection, { kind: 'code' }>;
  copyState?: WideDocumentCopyState | undefined;
  locale: string;
  onCopy: (descriptor: WideDocumentDescriptor) => void;
}) {
  const [wrap, setWrap] = useState(inspection.wrap);
  const options = { locale: locale as never };
  const copyAvailable = (inspection.descriptor.codeBytes ?? MAX_WIDE_CODE_BYTES + 1) <= MAX_WIDE_CODE_BYTES;
  return (
    <CodeBlock className="wide-document-inspector-code" data-wide-document-inspector-code="true">
      <CodeBlockHeader className="flex-col items-start gap-2 pb-1">
        <CodeBlockTitle className="max-w-full truncate">
          {m.wide_document_code_title({}, options)}
          {inspection.language ? (
            <span className="ms-2 rounded bg-background/70 px-2 py-1 text-xs">{inspection.language}</span>
          ) : null}
        </CodeBlockTitle>
        <CodeBlockActions className="!static !m-0 !w-full !shrink !flex-wrap !opacity-100">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11 max-w-full whitespace-normal px-3 text-start [overflow-wrap:anywhere]"
            aria-pressed={wrap}
            onClick={() => setWrap((current) => !current)}
          >
            {m.wide_document_code_wrap({}, options)}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11 max-w-full whitespace-normal px-3 text-start [overflow-wrap:anywhere]"
            disabled={!copyAvailable}
            onClick={() => onCopy(inspection.descriptor)}
          >
            {m.wide_document_code_copy({}, options)}
          </Button>
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap} dir={inspection.direction ?? 'ltr'} lang={inspection.documentLanguage}>
        {inspection.children}
      </CodeBlockContent>
      {copyState ? (
        <CodeBlockFooter className="wide-document-code-feedback">
          <WideDocumentCopyFeedback state={copyState} locale={locale} />
        </CodeBlockFooter>
      ) : null}
      {!copyAvailable ? (
        <CodeBlockFooter className="wide-document-code-feedback">
          <p role="status">{m.wide_document_code_too_large({}, options)}</p>
        </CodeBlockFooter>
      ) : null}
    </CodeBlock>
  );
}
