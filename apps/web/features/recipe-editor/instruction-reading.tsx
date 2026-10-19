'use client';

import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '@rezics/ui/document-body';
import { directionOf } from '../studio/types.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { instructionDocument, procedureDefinition, type Instruction, type ProcedureItem } from './instructions.ts';
import { InstructionRecording } from './instruction-recording.tsx';

function Procedure({ items }: { items: ProcedureItem[] }) {
  return <ol className="grid gap-4">{items.map(item => <li key={item.id} data-procedure-item={item.id}>
    {item.type === 'HowToSection' ? <section className="grid gap-3">
      <h4 className="font-semibold" lang={item.name.language} dir={directionOf(item.name.language)}>{item.name.value}</h4>
      <Procedure items={item.items} />
    </section> : <DocumentBody document={item.document} />}
  </li>)}</ol>;
}

function InstructionDocument({ document }: { document: DocumentSnapshot }) {
  return <div className="grid gap-4">{document.doc.content?.map((node, index) =>
    node.type === 'extensionBlock' && node.attrs?.definition === procedureDefinition
      ? <Procedure key={String(node.attrs.id ?? index)} items={(node.attrs.payload as { items: ProcedureItem[] }).items} />
      : <DocumentBody key={String(node.attrs?.id ?? index)} document={{ ...document, doc: { type: 'doc', content: [node] } }} />)}</div>;
}

/** Each occurrence stays visible in Structure order; selected sources and transformations have separate credit. */
export function InstructionReading({ instructions, messages: t, recordingFetch, stepText = false }: {
  instructions: readonly Instruction[]; messages: WorkPageMessages; recordingFetch?: typeof fetch;
  /** Recipe readers identify the displayed method separately from its attribution and evidence. */
  stepText?: boolean;
}) {
  return <ol className="grid min-w-0 gap-6">{instructions.map(item => {
    const document = instructionDocument(item);
    const recording = item.details?.recording;
    const body = item.status !== 'available' ? <p role="status">{t.contentsUnavailable}</p>
        : document && checkDocument(document) ? <InstructionDocument document={document} />
          : item.text !== undefined ? <p className="whitespace-pre-wrap">{item.text}</p>
            : recording ? <InstructionRecording key={JSON.stringify([recording, item.details?.actingSubject])}
              instruction={item} messages={t} fetcher={recordingFetch} />
              : <p role="status">{t.contentsUnavailable}</p>;
    return <li key={item.occurrence} data-instruction-occurrence={item.occurrence} className="grid min-w-0 gap-3 break-words">
      {stepText ? <div data-step-text={item.occurrence} className="min-w-0">{body}</div> : body}
      {item.details?.author ? <p className="text-xs text-muted-foreground">{t.author}: {item.details.creditNames?.[item.details.author] ?? t.creditsUnavailable}</p> : null}
      {item.details?.derivations?.items.map(record => <div key={record.derivation} className="grid gap-1 text-xs text-muted-foreground">
        <p>{t.instructionTransformation}: {typeof record.responsibleAgent === 'string'
          ? item.details?.creditNames?.[record.responsibleAgent] ?? t.creditsUnavailable : t.creditsUnavailable}</p>
        <p>{t.instructionTransformationNotice}</p>
      </div>)}
      {item.details?.derivations?.nextCursor ? <p>{t.moreCredits}</p> : null}
      {item.details?.references?.length ? <details className="text-xs text-muted-foreground"><summary>{t.fullFacts}</summary>
        <ul className="grid gap-1">{item.details.references.map((reference, index) =>
        <li key={index}>{reference.status === 'unavailable' ? t.contentsUnavailable
          : <span className="break-all">{reference.reference.target} · {reference.reference.selector.grain}
            {'revision' in reference.reference.selector ? ` · ${reference.reference.selector.revision}` : ''}</span>}</li>)}</ul></details> : null}
      {item.details?.refusals.map((refusal, index) => <p key={index} role="alert" data-status={refusal.status}>
        {t.contentsUnavailable} ({refusal.status})</p>)}
    </li>;
  })}</ol>;
}
