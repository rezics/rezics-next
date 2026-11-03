import { useState, type ReactNode } from 'react';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@rezics/ui/shadcn/code-block';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { MAX_WIDE_CODE_BYTES, type WideDocumentDescriptor } from './wide-document-reading';
import type { WideDocumentCopyState } from './wide-document-copy';
import type { WideDocumentInspection } from './wide-document-inspector';

export function WideDocumentCode({
  descriptor,
  children,
  language,
  documentLanguage,
  direction,
  locale,
  copyState,
  onCopy,
  onInspect,
}: {
  descriptor: WideDocumentDescriptor;
  children: ReactNode;
  language?: string | undefined;
  documentLanguage?: string | undefined;
  direction?: 'ltr' | 'rtl' | 'auto' | undefined;
  locale: string;
  copyState?: WideDocumentCopyState | undefined;
  onCopy: (descriptor: WideDocumentDescriptor) => void;
  onInspect: (inspection: WideDocumentInspection, trigger: HTMLButtonElement) => void;
}) {
  const [wrap, setWrap] = useState(true);
  const options = { locale: locale as never };
  const feedback = copyState?.blockOrder === descriptor.order ? copyState : undefined;
  const copyAvailable = (descriptor.codeBytes ?? MAX_WIDE_CODE_BYTES + 1) <= MAX_WIDE_CODE_BYTES;
  const codeTitle = m.wide_document_code_title({}, options);

  return (
    <CodeBlock className="wide-document-code" data-wide-document-code="true">
      <CodeBlockHeader className="flex-col items-start gap-2 pb-1">
        <CodeBlockTitle className="max-w-full truncate">
          {codeTitle}
          {language ? <span className="ms-2 rounded bg-background/70 px-2 py-1 text-xs">{language}</span> : null}
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
            onClick={(event) =>
              onInspect(
                {
                  kind: 'code',
                  descriptor,
                  children,
                  language,
                  documentLanguage,
                  direction,
                  wrap,
                },
                event.currentTarget,
              )
            }
          >
            {m.wide_document_code_inspect({}, options)}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11 max-w-full whitespace-normal px-3 text-start [overflow-wrap:anywhere]"
            disabled={!copyAvailable}
            onClick={() => onCopy(descriptor)}
          >
            {m.wide_document_code_copy({}, options)}
          </Button>
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent
        wrap={wrap}
        dir={direction ?? 'ltr'}
        lang={documentLanguage}
        className="wide-document-code-content"
      >
        {children}
      </CodeBlockContent>
      {feedback ? (
        <CodeBlockFooter className="wide-document-code-feedback">
          <WideDocumentCopyFeedback state={feedback} locale={locale} />
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

export function WideDocumentCopyFeedback({
  state,
  locale,
}: {
  state: WideDocumentCopyState;
  locale: string;
}) {
  const options = { locale: locale as never };
  if (state.status === 'pending') {
    return <p role="status">{m.wide_document_code_copying({}, options)}</p>;
  }
  if (state.status === 'copied') {
    return <p role="status">{m.wide_document_code_copied({}, options)}</p>;
  }

  return (
    <div className="wide-document-code-recovery">
      <p role="status">
        {state.status === 'failed'
          ? m.wide_document_code_copy_failed({}, options)
          : m.wide_document_code_clipboard_unavailable({}, options)}
      </p>
      <label className="grid min-w-0 gap-1 text-xs">
        <span>{m.wide_document_code_manual_copy({}, options)}</span>
        <textarea
          readOnly
          rows={3}
          value={state.text}
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
          className="min-h-20 w-full min-w-0 resize-y rounded-md border bg-background p-2 font-mono text-xs leading-relaxed text-foreground"
        />
      </label>
    </div>
  );
}
