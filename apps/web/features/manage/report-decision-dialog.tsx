'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Kbd } from '@rezics/ui/kbd';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { materializeData } from 'native-i18n';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { actionLabel } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import type { Decision } from './queue-state.ts';
import { needsDetails, NOTE_LIMIT, type ReasonId, reasonLabelOf, reasonsFor, reasonsOf, recallReason, rememberReason, type ReportAction,
  STATEMENT_LIMIT, statementFor } from './reason-presets.ts';

/** The language a statement is written in, as the moderator's own language names it. */
function languageName(locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale; } catch { return locale; }
}

/**
 * Asks why a report is kept, removed or restricted, and shows the statement
 * the affected people will read before it is sent. One reason is always
 * picked (the one used last time for this decision, else the first), so
 * `A`, Enter keeps and `R`, Enter removes the way the last item was; a
 * reason's number picks another. The decision is not sent here; it enters
 * the undo window. The private note stays with moderators.
 */
export function ReportDecisionDialog({ action, count, rule, rules, about, automation, realm, locale, messages, onDecide,
  onClose, finalFocus }: {
  action: ReportAction | null; count: number;
  /** The Realm rule the reports cite, when they all cite the same one. */
  rule: { number: number; title: string } | null;
  /** The published rules (reference and revision) the decision cites, when every case reads the same; as Main records it. */
  rules: { ref: string; revision: string } | null;
  /** What the decision acts on, as the reader knows it; null for several items. */
  about: string | null;
  /** Whether the evidence records automation: unknown until every case is read, and Main's own read decides on sending. */
  automation: boolean | null;
  /** Keys the remembered reason; without it nothing is remembered. */
  realm?: string; locale: UiLocale; messages: ManageMessages;
  onDecide: (decision: Decision) => void; onClose: () => void;
  /** Where focus goes when the dialog closes: the queue's next item, so shortcuts keep working. */
  finalFocus?: () => HTMLElement | null;
}) {
  const t = materializeData(messages, { locale });
  const [shown, setShown] = useState<ReportAction>(action ?? 'keep');
  const [opened, setOpened] = useState(action !== null);
  const [reason, setReason] = useState<ReasonId>('not-a-breach');
  const [own, setOwn] = useState('');
  const [note, setNote] = useState('');
  const [recalled, setRecalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const reasons = reasonsFor(shown);

  // A fresh decision starts from the reason used last time; the words stay while the last dialog animates out.
  if ((action !== null) !== opened) {
    setOpened(action !== null);
    if (action) {
      const last = recallReason(realm, action);
      setShown(action); setReason(last ?? reasonsFor(action)[0]!); setRecalled(last !== null);
      setOwn(''); setNote(''); setError(null);
    }
  }
  useEffect(() => { if (needsDetails(reason) && opened) ownRef.current?.focus(); }, [reason, opened]);

  const statement = statementFor(shown, reason, t, own, rule);
  const pick = (next: ReasonId) => { setReason(next); setRecalled(false); setError(null); };
  const title = shown === 'keep' ? t.reasonKeepTitle(count) : shown === 'remove' ? t.reasonRemoveTitle(count)
    : shown === 'interim-restrict' ? t.reasonInterimTitle(count) : t.reasonFinalTitle(count);
  const submit = () => {
    if (!statement) { setError(reason === 'other' ? t.rsnRequired : t.rsnDetailsRequired); ownRef.current?.focus(); return; }
    if (statement.facts.length > STATEMENT_LIMIT || note.length > NOTE_LIMIT) { setError(t.reasonTooLong); return; }
    rememberReason(realm, shown, reason);
    onDecide({ action: shown, reason: statement.facts, note: note.trim() || null,
      reasons: reasonsOf(statement, locale, automation === true) });
  };
  const preview: ReadonlyArray<readonly [string, string]> = [[t.factsLabel, statement?.facts ?? t.previewEmpty],
    [t.scopeLabel, statement?.scope ?? t.previewEmpty], [t.decisionDurationLabel, statement?.duration ?? t.previewEmpty]];
  return <Dialog open={action !== null} onOpenChange={details => { if (!details.open) onClose(); }}
    initialFocusEl={() => groupRef.current?.querySelector<HTMLElement>('input:checked')
      ?? groupRef.current?.querySelector<HTMLElement>('input') ?? null}
    {...finalFocus ? { finalFocusEl: finalFocus } : {}}>
    <DialogContent size="md">
      <form noValidate onSubmit={event => { event.preventDefault(); submit(); }} className="contents">
        <DialogHeader title={title} description={t.undoHint} />
        <DialogBody className="grid gap-4">
          <RadioGroup ref={groupRef} value={reason} className="gap-2"
            onValueChange={details => { if (details.value) pick(details.value as ReasonId); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
              const number = /^[1-9]$/.test(event.key) ? Number(event.key) : null;
              if (number !== null && number <= reasons.length) {
                event.preventDefault();
                pick(reasons[number - 1]!);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}>
            <RadioGroupLabel>{t.rsnGroup}</RadioGroupLabel>
            {reasons.map((id, index) => <RadioGroupItem key={id} value={id}>
              <span className="flex items-baseline gap-2"><Kbd aria-hidden="true">{index + 1}</Kbd>{reasonLabelOf(id, t)}</span>
            </RadioGroupItem>)}
            <p className="text-muted-foreground text-xs">{recalled ? `${t.ruleRemembered} ` : ''}{t.rsnKeys}</p>
          </RadioGroup>
          <Field invalid={error !== null}>
            <FieldLabel>{reason === 'other' ? t.rsnOtherLabel : t.rsnDetailsLabel}</FieldLabel>
            <Textarea ref={ownRef} value={own} rows={3} maxLength={STATEMENT_LIMIT + 200}
              onChange={event => { setOwn(event.currentTarget.value); setError(null); }}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }} />
            {error ? <FieldError>{error}</FieldError>
              : <FieldHelper>{(reason === 'other' ? t.rsnOtherHelp : needsDetails(reason) ? t.rsnDetailsRequiredHelp
                : t.rsnDetailsHelp)({ language: languageName(locale) })}</FieldHelper>}
          </Field>
          <section aria-label={t.previewHeading} className="grid gap-2 rounded-2xl border border-border/60 bg-muted/40 p-4">
            <h3 className="font-semibold text-sm">{t.previewHeading}</h3>
            <p className="text-muted-foreground text-xs">{t.previewLanguage({ language: languageName(locale) })}</p>
            <dl className="grid gap-2 text-sm" lang={locale}>
              {preview.map(([name, value]) => <div key={name} className="grid gap-0.5">
                <dt className="text-muted-foreground text-xs">{name}</dt>
                <dd className="whitespace-pre-line [overflow-wrap:anywhere]">{value}</dd>
              </div>)}
            </dl>
            {about ? <p className="text-sm">{t.rsnPreviewAbout({ target: about })}</p> : null}
            {rules ? <p className="text-sm">{t.rsnPreviewRules({ ref: rules.ref, revision: rules.revision })}</p> : null}
            <p className="text-sm">{automation === null ? t.rsnAutomationChecked
              : automation ? t.previewAutomation : t.previewNoAutomation}</p>
            <p className="text-sm">{t.previewAppeal}</p>
          </section>
          <Field>
            <FieldLabel>{t.noteLabel}</FieldLabel>
            <Textarea value={note} rows={2} maxLength={NOTE_LIMIT} onChange={event => setNote(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }} />
            <FieldHelper>{t.rsnNoteHelp}</FieldHelper>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t.cancel}</Button>
          <Button type="submit" variant={shown === 'keep' ? 'default' : 'destructive'}>{actionLabel(shown, t)}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
