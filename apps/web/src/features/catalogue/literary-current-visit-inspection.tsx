import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { correctionInspectionAvailability, type EditorRead } from './statement-editor';
import { EditorFailure, PartValue } from './statement-editor-view';
import type { FactsCurrent } from './subject-facts';
import { literaryFields } from './literary-profile';
import type { LiteraryCurrentVisit } from './literary-current-visit';
import { pageText } from '../pages/shared';

type Assertion = FactsCurrent['public']['subject']['statements'][string][number];
type Locator = { property: string; statement: string };
type Attempt = {
  key: string;
  locator: Locator;
  opener: HTMLButtonElement;
  keyboard: boolean;
  release: () => void;
};

function locatorKey(locator: Locator): string {
  return JSON.stringify([locator.property, locator.statement]);
}

function assertionEvidence(statement: Assertion): string {
  return JSON.stringify({
    property: statement.property.id,
    value: statement.value,
    qualifiers: statement.qualifiers,
    references: statement.references.map((reference) => reference.parts),
  });
}

/** A deliberate, exact assertion choice is re-read under the current reader before its evidence is revealed. */
export function LiteraryCurrentAssertionInspection({
  read,
  locale,
  visit,
  reader,
  effectiveReader,
  revision,
  active,
  refresh,
  observe,
}: {
  read: FactsCurrent;
  locale: string;
  visit?: LiteraryCurrentVisit | undefined;
  reader: string;
  effectiveReader: () => string;
  revision: string;
  active: () => boolean;
  refresh: () => Promise<EditorRead>;
  observe: (next: EditorRead) => void;
}) {
  const o = { locale: locale as never };
  const [selected, setSelected] = useState('');
  const [inspection, setInspection] = useState<{ key: string; selection: string; evidence: string }>();
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const visible = active();
  const availability = correctionInspectionAvailability(read.actions);
  const subject = read.public.subject;
  const key = JSON.stringify([
    subject.id,
    subject.type,
    subject.context,
    subject.release,
    reader,
    visit?.context,
    visit?.realm,
    visit?.source,
    subject.revision,
    revision,
  ]);
  const statements = literaryFields(read.release, subject.type, locale).scalars.flatMap((property) =>
    (subject.statements[property] ?? []).map((statement, index) => ({
      locator: { property, statement: statement.id },
      statement,
      index,
      label: pageText(read.release.properties[property]?.labels, locale).text,
    })),
  );
  const currentChoice = statements.find(({ locator }) => locatorKey(locator) === selected);
  const currentEvidence = currentChoice ? assertionEvidence(currentChoice.statement) : undefined;
  const live = useRef({ key, selected, visible, availability, active, reader, effectiveReader, read, currentEvidence });
  live.current = { key, selected, visible, availability, active, reader, effectiveReader, read, currentEvidence };
  const revealed =
    availability === 'allowed' &&
    visible &&
    inspection?.key === key &&
    inspection.selection === selected &&
    inspection.evidence === currentEvidence
      ? currentChoice
      : undefined;

  function retireAttempt() {
    attemptRef.current?.release();
    attemptRef.current = undefined;
  }

  useLayoutEffect(() => {
    if (!visible || availability !== 'allowed') {
      retireAttempt();
      setSelected('');
      setInspection(undefined);
      setFailure(undefined);
      setBusy(false);
      return;
    }
    setSelected('');
    setInspection(undefined);
    setFailure(undefined);
    setBusy(false);
    retireAttempt();
  }, [key, visible, availability]);

  useLayoutEffect(() => {
    const attempt = attemptRef.current;
    if (attempt && attempt.key !== key) {
      retireAttempt();
      setBusy(false);
    }
    if (inspection && (inspection.selection !== selected || inspection.evidence !== currentEvidence)) {
      setInspection(undefined);
      setFailure('stale');
    }
  }, [key, selected, currentEvidence, inspection]);

  useLayoutEffect(() => () => retireAttempt(), []);

  function choose(value: string) {
    retireAttempt();
    setSelected(value);
    setInspection(undefined);
    setFailure(undefined);
    setBusy(false);
  }

  async function inspect(opener: HTMLButtonElement, detail: number) {
    const choice = statements.find(({ locator }) => locatorKey(locator) === selected);
    if (!choice || availability !== 'allowed' || !visible || !active()) return;
    retireAttempt();
    const document = opener.ownerDocument;
    const moved = (event: FocusEvent) => {
      const current = attemptRef.current;
      if (current?.opener === opener && event.target !== opener) current.keyboard = false;
    };
    const pointed = () => {
      const current = attemptRef.current;
      if (current?.opener === opener) current.keyboard = false;
    };
    const attempt: Attempt = {
      key,
      locator: choice.locator,
      opener,
      keyboard: detail === 0 && document.activeElement === opener,
      release: () => {
        document.removeEventListener('focusin', moved);
        document.removeEventListener('pointerdown', pointed, true);
      },
    };
    attemptRef.current = attempt;
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', pointed, true);
    setBusy(true);
    setInspection(undefined);
    setFailure(undefined);
    let revealedCurrent = false;
    try {
      const fresh = await refresh();
      const admission = live.current;
      if (
        attemptRef.current !== attempt ||
        !admission.visible ||
        admission.availability !== 'allowed' ||
        !admission.active() ||
        attempt.key !== admission.key ||
        locatorKey(attempt.locator) !== admission.selected ||
        admission.reader !== reader ||
        admission.effectiveReader() !== reader ||
        admission.currentEvidence !== assertionEvidence(choice.statement)
      )
        return;
      if (!fresh.ok) {
        setFailure(fresh.reason);
        return;
      }
      const freshSubject = fresh.public.subject;
      const admitted = admission.read;
      const exact = freshSubject.statements[choice.locator.property]?.find(
        (statement) => statement.id === choice.locator.statement,
      );
      const isCurrent =
        freshSubject.id === admitted.public.subject.id &&
        freshSubject.type === admitted.public.subject.type &&
        freshSubject.context === admitted.public.subject.context &&
        (!visit || freshSubject.context === visit.context) &&
        freshSubject.release === admitted.public.subject.release &&
        !!fresh.release.properties[choice.locator.property] &&
        literaryFields(fresh.release, freshSubject.type, locale).scalars.includes(choice.locator.property) &&
        reader.length > 0 &&
        admission.effectiveReader() === reader &&
        correctionInspectionAvailability(fresh.actions) === 'allowed' &&
        !!exact &&
        assertionEvidence(exact) === admission.currentEvidence;
      if (!isCurrent) {
        setFailure('stale');
        return;
      }
      observe(fresh);
      setInspection({ key, selection: selected, evidence: assertionEvidence(exact) });
      revealedCurrent = true;
    } catch (error) {
      // The lifetime fence rejects an in-flight read after this visit is replaced.
      if (!(error instanceof Error) || error.message !== 'Retired catalogue editor') throw error;
    } finally {
      if (attemptRef.current === attempt) {
        setBusy(false);
        if (!revealedCurrent) retireAttempt();
      } else attempt.release();
    }
  }

  useLayoutEffect(() => {
    const attempt = attemptRef.current;
    if (!revealed || !attempt || attempt.key !== key) return;
    if (attempt.keyboard && attempt.opener.ownerDocument.activeElement === attempt.opener && active())
      heading.current?.focus();
    retireAttempt();
  }, [revealed, key, active]);

  if (!visible) return null;
  if (availability !== 'allowed')
    return (
      <p role="status" data-literary-assertion-inspection="">
        {availability === 'denied' ? m.candidate_denied({}, o) : m.candidate_actions_unavailable({}, o)}
      </p>
    );

  return (
    <section data-literary-assertion-inspection="" className="min-w-0 space-y-3 border-t border-border pt-4">
      <h3 className="font-semibold">{m.literary_visit_inspect({}, o)}</h3>
      <label className="block min-w-0 space-y-2">
        <span>{m.literary_visit_statement({}, o)}</span>
        <NativeSelect
          aria-label={m.literary_visit_statement({}, o)}
          className="w-full min-w-0 [&>select]:min-h-11"
          value={selected}
          disabled={busy}
          onChange={(event) => choose(event.currentTarget.value)}
        >
          <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
          {statements.map(({ locator, index, label }) => (
            <NativeSelectOption key={locator.statement} value={locatorKey(locator)}>
              {label || locator.property} · {m.facts_selected_value({ number: index + 1 }, o)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={!currentChoice || busy}
        onClick={(event) => void inspect(event.currentTarget, event.detail)}
      >
        {m.literary_visit_inspect({}, o)}
      </Button>
      {busy && <p role="status">{m.candidate_loading({}, o)}</p>}
      {failure === 'stale' && <p role="status">{m.literary_visit_currentness({}, o)}</p>}
      {failure && failure !== 'stale' && <EditorFailure reason={failure} locale={locale} />}
      {revealed && currentChoice && (
        <article className="min-w-0 space-y-3 border-t border-border pt-3">
          <h4 ref={heading} tabIndex={-1} className="font-medium focus-visible:outline-2 focus-visible:outline-ring">
            {currentChoice.label || currentChoice.locator.property} ·{' '}
            {m.facts_selected_value({ number: currentChoice.index + 1 }, o)}
          </h4>
          <div className="break-words">
            <PartValue part={revealed.statement} read={read} locale={locale} />
          </div>
          {!!revealed.statement.qualifiers.length && (
            <dl className="space-y-2 text-sm">
              {revealed.statement.qualifiers.map((part, index) => (
                <div key={index}>
                  <dt className="text-muted-foreground">
                    {pageText(read.release.properties[part.property.id]?.labels, locale).text || part.property.id}
                  </dt>
                  <dd>
                    <PartValue part={part} read={read} locale={locale} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {!!revealed.statement.references.length && (
            <details>
              <summary className="min-h-11 cursor-pointer py-2">{m.correction_references({}, o)}</summary>
              <ol className="space-y-3">
                {revealed.statement.references.map((reference, index) => (
                  <li key={index} className="border-s-2 border-border ps-3">
                    <ul className="space-y-2">
                      {reference.parts.map((part, partIndex) => (
                        <li key={partIndex}>
                          <span className="text-muted-foreground">
                            {pageText(read.release.properties[part.property.id]?.labels, locale).text ||
                              part.property.id}
                            :{' '}
                          </span>
                          <PartValue part={part} read={read} locale={locale} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </article>
      )}
    </section>
  );
}
