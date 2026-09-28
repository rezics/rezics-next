'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Kbd } from '@rezics/ui/kbd';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { materializeData } from 'native-i18n';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { actionLabel } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import type { Decision, QueueAction } from './queue-state.ts';
import type { PublishedRule } from './types.ts';

export const REASON_LIMIT = 2000;

/** Decisions whose reason can cite a Realm rule; an escalation is a note to the owners instead. */
const citing = (action: QueueAction) => action !== 'escalate' && action !== 'approve' && action !== 'keep';
/** One remembered rule per kind of answer: removals and restrictions share one, as they share a key. */
const ruleSlot = (action: QueueAction) => action === 'request-changes' ? 'changes'
  : action === 'reject' ? 'reject' : 'remove';

/** Where the last rule cited for a kind of decision in a Realm is kept, on this device only. */
export const ruleMemoryKey = (realm: string, action: QueueAction) => `rezics:manage:rule:${realm}:${ruleSlot(action)}`;

function recall(realm: string | undefined, action: QueueAction): string | null {
  if (!realm) return null;
  try { return globalThis.localStorage?.getItem(ruleMemoryKey(realm, action)) ?? null; } catch { return null; }
}
function remember(realm: string | undefined, action: QueueAction, rule: string | null) {
  if (!realm) return;
  try { globalThis.localStorage?.setItem(ruleMemoryKey(realm, action), rule ?? ''); } catch { /* private mode */ }
}

/**
 * Asks for the reason Main requires before a rejection, a change request, a
 * removal or an escalation. The decision is not sent here; it enters the undo
 * window. A removal's reason goes to the reporter and the author; Main keeps
 * no separate private note for it.
 *
 * When the Realm has published rules, the reason starts from the rule it
 * breaks. The rule picked last time for this kind of decision is picked
 * again (as Reddit's removal reasons are), so R then Enter decides the next
 * item the same way; a rule's number picks it.
 */
export function ReasonDialog({ action, count, onDecide, onClose, finalFocus, rules = [], realm, locale, messages }: {
  action: Exclude<QueueAction, 'approve' | 'keep'> | null; count: number; onDecide: (decision: Decision) => void;
  onClose: () => void; locale: UiLocale; messages: ManageMessages;
  /** Where focus goes when the dialog closes: the queue's next item, so shortcuts keep working. */
  finalFocus?: () => HTMLElement | null;
  /** The Realm's published rules, numbered as readers see them. */
  rules?: readonly PublishedRule[];
  /** Keys the remembered rule; without it nothing is remembered. */
  realm?: string;
}) {
  const t = materializeData(messages, { locale });
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [rule, setRule] = useState<string | null>(null);
  const [recalled, setRecalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const rulesRef = useRef<HTMLDivElement>(null);
  // The words a picked rule wrote; the moderator's own words are never replaced.
  const written = useRef('');
  // The dialog animates out after `action` clears; keep its words until it is gone.
  const [shown, setShown] = useState(action ?? 'reject');
  const [opened, setOpened] = useState(action !== null);
  const cites = citing(shown) && rules.length > 0;
  const citation = (id: string | null) => {
    const index = rules.findIndex(item => item.id === id);
    return index < 0 ? '' : t.ruleReason({ number: String(index + 1), title: rules[index]!.title.value });
  };
  // A fresh decision starts empty, or from the rule picked last time; the text stays while the last dialog animates out.
  if ((action !== null) !== opened) {
    setOpened(action !== null);
    if (action) {
      const last = citing(action) ? recall(realm, action) : null;
      const kept = last && rules.some(item => item.id === last) ? last : null;
      written.current = kept ? citation(kept) : '';
      setShown(action); setReason(written.current); setNote(''); setError(null); setRule(kept);
      setRecalled(kept !== null);
    }
  }
  const pick = (id: string | null) => {
    setRule(id);
    setRecalled(false);
    setError(null);
    if (!reason.trim() || reason === written.current) setReason(citation(id));
    written.current = citation(id);
  };
  const escalating = shown === 'escalate';
  const removing = shown === 'remove' || shown === 'interim-restrict' || shown === 'final-restrict';
  const title = shown === 'reject' ? t.reasonRejectTitle(count) : shown === 'request-changes' ? t.reasonChangesTitle(count)
    : shown === 'interim-restrict' ? t.reasonInterimTitle(count)
      : shown === 'final-restrict' ? t.reasonFinalTitle(count)
        : removing ? t.reasonRemoveTitle(count) : t.reasonEscalateTitle(count);
  const close = () => onClose();
  const submit = () => {
    const text = reason.trim();
    if (!text) { setError(t.reasonRequired); return; }
    if (text.length > REASON_LIMIT || note.length > 4000) { setError(t.reasonTooLong); return; }
    if (cites) remember(realm, shown, rule);
    onDecide({ action: shown, reason: text, note: escalating || removing ? null : note.trim() || null });
  };
  return <Dialog open={action !== null} onOpenChange={details => { if (!details.open) close(); }}
    initialFocusEl={() => (cites ? rulesRef.current?.querySelector<HTMLElement>('input:checked')
      ?? rulesRef.current?.querySelector<HTMLElement>('input') : null) ?? reasonRef.current}
    {...finalFocus ? { finalFocusEl: finalFocus } : {}}>
    <DialogContent size="md">
      <form noValidate onSubmit={event => { event.preventDefault(); submit(); }} className="contents">
        <DialogHeader title={title} description={t.undoHint} />
        <DialogBody className="grid gap-4">
          {cites ? <RadioGroup ref={rulesRef} value={rule ?? ''} className="gap-2"
            onValueChange={details => pick(details.value || null)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
              const number = /^[0-9]$/.test(event.key) ? Number(event.key) : null;
              if (number !== null && number <= rules.length) {
                event.preventDefault();
                pick(number === 0 ? null : rules[number - 1]!.id);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}>
            <RadioGroupLabel>{t.whichRule}</RadioGroupLabel>
            {rules.map((item, index) => <RadioGroupItem key={item.id} value={item.id}>
              <span className="flex items-baseline gap-2">
                <Kbd aria-hidden="true">{index + 1}</Kbd>
                <span lang={item.title.language} dir={item.title.direction}>{item.title.value}</span>
              </span>
            </RadioGroupItem>)}
            <RadioGroupItem value=""><span className="flex items-baseline gap-2"><Kbd aria-hidden="true">0</Kbd>
              {t.noRule}</span></RadioGroupItem>
            <p className="text-muted-foreground text-xs">{recalled ? `${t.ruleRemembered} ` : ''}{t.ruleKeys}</p>
          </RadioGroup> : null}
          <Field invalid={error !== null}>
            <FieldLabel>{escalating ? t.escalateReasonLabel : removing ? t.removeReasonLabel : t.publicReasonLabel}</FieldLabel>
            <Textarea ref={reasonRef} value={reason} maxLength={REASON_LIMIT + 200} rows={4}
              onChange={event => { setReason(event.currentTarget.value); setError(null); }}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }} />
            {error ? <FieldError>{error}</FieldError>
              : <FieldHelper>{escalating ? t.escalateReasonHelp : removing ? t.removeReasonHelp : t.publicReasonHelp}
              </FieldHelper>}
          </Field>
          {escalating || removing ? null : <Field>
            <FieldLabel>{t.noteLabel}</FieldLabel>
            <Textarea value={note} rows={2} maxLength={4000} onChange={event => setNote(event.currentTarget.value)} />
            <FieldHelper>{t.noteHelp}</FieldHelper>
          </Field>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>{t.cancel}</Button>
          <Button type="submit" variant={shown === 'reject' || removing ? 'destructive' : 'default'}>
            {actionLabel(shown, t)}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
