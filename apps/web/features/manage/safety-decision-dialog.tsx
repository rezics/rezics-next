'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect } from '@rezics/ui/native-select';
import { Textarea } from '@rezics/ui/textarea';
import { CircleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { Confirm } from '../safety/form-parts.tsx';
import type { CommandFailure } from './commands.ts';
import type { ManageMessages } from './messages.ts';
import type { SafetyApi } from './safety-api.ts';
import { type Attempt, refusedForGood, settleDecision } from './safety-pending.ts';
import { type Offer, restricts } from './safety-state.ts';
import type { GovernanceRule, ReportEvidence, SafetyCase, SafetyDecisionInput, SafetyDecisionResult,
  SafetyEffect, SafetyItem, SafetyOutcome, SafetyReasons, SafetyTarget } from './safety-types.ts';

const RULE_MEMORY = 'rezics:manage:safety-rule';
const APPEAL_ROUTE = '/v1/public-reports/{caseId}/correspondence' as const;
const effects: ReadonlyArray<{ effect: SafetyEffect; label: 'effectDisclosure' | 'effectPublication' | 'effectSearch'
  | 'effectMedia' | 'effectRaw' | 'effectExport' }> = [
  { effect: 'disclosure', label: 'effectDisclosure' }, { effect: 'publication', label: 'effectPublication' },
  { effect: 'search', label: 'effectSearch' }, { effect: 'media_delivery', label: 'effectMedia' },
  { effect: 'raw_delivery', label: 'effectRaw' }, { effect: 'export', label: 'effectExport' }];

const writing = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'];
function languageLabel(code: string, locale: UiLocale): string {
  if (code === 'und') return '—';
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code; } catch { return code; }
}
const recall = () => { try { return globalThis.localStorage?.getItem(RULE_MEMORY) ?? ''; } catch { return ''; } };
const remember = (ref: string) => { try { globalThis.localStorage?.setItem(RULE_MEMORY, ref); } catch { /* private mode */ } };

/** The words a decision button and its dialog use for an outcome. */
export const decideLabelKey = { restrict: 'decideRestrict', interim_restrict: 'decideInterim',
  final_restrict: 'decideFinal', dismiss: 'decideDismiss', restore: 'decideRestore', reverse: 'decideReverse' } as const;

/**
 * What a decision plans to act on. A restriction takes the exact evidence
 * Main retained for the case (its revision is also the head Main compares); a
 * reversal or restoration repeats the targets of the decision it releases, as
 * Main requires. Without readable evidence the queue's own target is used at
 * component scope.
 */
export function planTargets(outcome: SafetyOutcome, item: Pick<SafetyItem, 'target'>, detail: Pick<SafetyCase, 'targets'>,
  evidence: ReportEvidence | null, effect: SafetyEffect, expiresAt: string | null): SafetyTarget[] {
  if (outcome === 'dismiss') return [];
  if (!restricts(outcome)) {
    return detail.targets.map(target => ({ ...target, expiresAt: target.expiresAt ?? null }));
  }
  const retained = evidence?.evidence.filter(entry => entry.state === 'available') ?? [];
  const found = retained.length ? retained.map(entry => ({ owner: entry.owner, resource: entry.resource,
    component: entry.component, revision: entry.revision }))
    : [{ ...item.target, revision: null }];
  return found.map(entry => ({ owner: entry.owner as SafetyTarget['owner'], resource: entry.resource,
    component: entry.component as SafetyTarget['component'], locator: null,
    scopeKind: entry.revision ? 'exact_revision' : 'component', revision: entry.revision,
    expectedHead: entry.revision, effect, ...expiresAt ? { expiresAt } : {} }));
}

export type DecisionState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'accepted' }
  | { kind: 'failed'; reason: 'stale' | 'invalid' | 'denied' | 'conflict' | 'failed' };

const failureReason = (outcome: { failure: CommandFailure }) =>
  outcome.failure === 'stale' ? 'stale' : outcome.failure === 'invalid' || outcome.failure === 'budget' ? 'invalid'
    : outcome.failure === 'denied' || outcome.failure === 'missing' ? 'denied'
      : outcome.failure === 'conflict' ? 'conflict' : 'failed';

/**
 * Asks for the statement of reasons a platform decision must carry and shows
 * it as the affected person will read it. The rule is looked up from Main, so
 * its revision and digest are what the decision cites. The same key is kept
 * until the words change, so resuming or pressing twice never records twice.
 */
export function SafetyDecisionDialog({ item, detail, outcome, evidence, offer, api, actingSubject, locale, messages,
  onClose, onDone, onAttempt, finalFocus }: {
  /** The case, its read, its evidence and the offer as they were when the dialog opened: a later re-read cannot change the request. */
  item: SafetyItem; detail: SafetyCase; outcome: SafetyOutcome | null; evidence: ReportEvidence | null;
  offer: Offer | null; api: Pick<SafetyApi, 'rule' | 'decide'>; actingSubject: string; locale: UiLocale;
  messages: ManageMessages; onClose: () => void; finalFocus?: () => HTMLElement | null;
  onDone: (result: SafetyDecisionResult, reasons: SafetyReasons) => void;
  /** The request is kept (or dropped, with `null`) by the queue, which offers Resume once the dialog is closed. */
  onAttempt: (attempt: Attempt | null) => void;
}) {
  const t = materializeData(messages, { locale });
  const [shown, setShown] = useState<SafetyOutcome>(outcome ?? 'restrict');
  const [opened, setOpened] = useState(outcome !== null);
  const [ref, setRef] = useState('');
  const [rule, setRule] = useState<GovernanceRule | null>(null);
  const [lookup, setLookup] = useState<'idle' | 'looking' | 'missing'>('idle');
  const [facts, setFacts] = useState('');
  const [scope, setScope] = useState('');
  const [duration, setDuration] = useState('');
  const [automation, setAutomation] = useState(false);
  const [effect, setEffect] = useState<SafetyEffect>('disclosure');
  const [expiry, setExpiry] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [state, setState] = useState<DecisionState>({ kind: 'idle' });
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const [written, setWritten] = useState(item.contentLanguage ?? 'und');
  const factsRef = useRef<HTMLTextAreaElement>(null);
  const ruleInput = useRef<HTMLInputElement>(null);

  // A fresh decision starts empty, except the rule last used on this device; the words stay while the dialog animates out.
  if ((outcome !== null) !== opened) {
    setOpened(outcome !== null);
    if (outcome) {
      setShown(outcome); setRef(recall()); setRule(null); setLookup('idle'); setFacts(''); setScope(''); setDuration('');
      setAutomation(false); setEffect('disclosure'); setExpiry(''); setNote(''); setTried(false);
      setWritten(item.contentLanguage ?? 'und');
      setState({ kind: 'idle' }); attempt.current = null;
    }
  }
  const language = written;
  const languages = [...new Set([item.contentLanguage ?? 'und', ...writing, 'und'])];
  const languageName = languageLabel(language, locale);
  const label = t[decideLabelKey[shown]];
  const missing = (value: string) => tried && !value.trim() ? t.decisionFieldRequired : null;

  async function find() {
    const wanted = ref.trim();
    if (!wanted) return;
    setLookup('looking'); setRule(null);
    const read = await api.rule(wanted);
    if (!read.ok) { setLookup('missing'); return; }
    setRule(read.data); setLookup('idle');
  }

  async function submit() {
    if (state.kind === 'sending') return;
    if (!rule || [facts, scope, duration].some(value => !value.trim())) {
      setTried(true);
      (rule ? factsRef.current : ruleInput.current)?.focus();
      return;
    }
    const reasons: SafetyReasons = { facts: facts.trim(), scope: scope.trim(), duration: duration.trim(), automation,
      appealRoute: APPEAL_ROUTE, contentLanguage: language };
    const targets = planTargets(shown, item, detail, evidence, effect, expiry ? new Date(expiry).toISOString() : null);
    const body: Omit<SafetyDecisionInput, 'idempotencyKey'> = { caseId: item.caseId, expectedGeneration: detail.generation,
      actingSubject, outcome: shown, targets, reasons, rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
      evidenceDigest: detail.reports[0]?.evidenceDigest ?? '', reversesDecisionId: shown === 'reverse' ? item.decisionHead : null,
      answersStepId: offer?.step?.stepId ?? null, rationale: note.trim() || null, disclosure: 'parties' };
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) attempt.current = { body: serialized, key: crypto.randomUUID() };
    setState({ kind: 'sending' });
    const input = { ...body, idempotencyKey: attempt.current.key };
    // Written down before it is sent: a lost response leaves the request on record, and only this key can finish it.
    onAttempt({ caseId: item.caseId, input, reasons });
    setState({ kind: 'sending' });
    const settled = await settleDecision(api.decide, input);
    if (settled.kind === 'failed') {
      if (!settled.recorded && refusedForGood(settled.failure)) onAttempt(null);
      setState({ kind: 'failed', reason: failureReason(settled) });
      return;
    }
    remember(rule.ref);
    if (settled.kind === 'completed') { onAttempt(null); setState({ kind: 'idle' }); onDone(settled.result, reasons); return; }
    // Recorded, but not every effect is confirmed: the dialog stays and the request waits for Resume.
    setState({ kind: 'accepted' });
  }

  const problem = state.kind === 'failed' ? { stale: t.decisionStale, invalid: t.decisionInvalid, denied: t.decisionDenied,
    conflict: t.decisionConflict, failed: t.decisionFailed }[state.reason] : null;
  const preview: Array<[string, string]> = [[t.factsLabel, facts], [t.scopeLabel, scope], [t.decisionDurationLabel, duration]];
  return <Dialog open={outcome !== null} onOpenChange={details => { if (!details.open) onClose(); }}
    initialFocusEl={() => factsRef.current} {...finalFocus ? { finalFocusEl: finalFocus } : {}}>
    <DialogContent size="lg">
      <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }} className="contents">
        <DialogHeader title={t.decisionTitle({ action: label })} description={t.decisionIntro} />
        <DialogBody className="grid gap-4">
          <Field invalid={(tried && !rule) || lookup === 'missing'}>
            <FieldLabel>{t.ruleRefLabel}</FieldLabel>
            <div className="flex gap-2">
              <Input ref={ruleInput} value={ref} maxLength={512} className="min-w-0 flex-1"
                onChange={event => { setRef(event.currentTarget.value); setRule(null); setLookup('idle'); }}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void find(); } }} />
              <Button type="button" variant="outline" onClick={() => void find()} isLoading={lookup === 'looking'}
                disabled={!ref.trim() || lookup === 'looking'}>{lookup === 'looking' ? t.ruleLooking : t.ruleLookup}</Button>
            </div>
            {tried && !rule ? <FieldError>{t.ruleRequired}</FieldError>
              : lookup === 'missing' ? <FieldError>{t.ruleMissing}</FieldError>
                : <FieldHelper>{rule ? t.ruleFound({ revision: rule.revision, digest: rule.digest.slice(0, 12) })
                  : t.ruleRefHelp}</FieldHelper>}
          </Field>
          <Field invalid={missing(facts) !== null}>
            <FieldLabel>{t.factsLabel}</FieldLabel>
            <Textarea ref={factsRef} value={facts} rows={3} maxLength={4000} onChange={event => setFacts(event.currentTarget.value)} />
            {missing(facts) ? <FieldError>{missing(facts)}</FieldError> : <FieldHelper>{t.factsHelp}</FieldHelper>}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field invalid={missing(scope) !== null}>
              <FieldLabel>{t.scopeLabel}</FieldLabel>
              <Textarea value={scope} rows={2} maxLength={4000} onChange={event => setScope(event.currentTarget.value)} />
              {missing(scope) ? <FieldError>{missing(scope)}</FieldError> : <FieldHelper>{t.scopeHelp}</FieldHelper>}
            </Field>
            <Field invalid={missing(duration) !== null}>
              <FieldLabel>{t.decisionDurationLabel}</FieldLabel>
              <Textarea value={duration} rows={2} maxLength={4000} onChange={event => setDuration(event.currentTarget.value)} />
              {missing(duration) ? <FieldError>{missing(duration)}</FieldError> : <FieldHelper>{t.durationHelp}</FieldHelper>}
            </Field>
          </div>
          <Confirm checked={automation} onChange={setAutomation}>{t.automationLabel}</Confirm>
          <Field>
            <FieldLabel>{t.reasonLanguageLabel}</FieldLabel>
            <NativeSelect value={written} onChange={event => setWritten(event.currentTarget.value)}>
              {languages.map(code => <option key={code} value={code}>{languageLabel(code, locale)}</option>)}
            </NativeSelect>
          </Field>
          {restricts(shown) ? <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>{t.effectLabel}</FieldLabel>
              <NativeSelect value={effect} onChange={event => setEffect(event.currentTarget.value as SafetyEffect)}>
                {effects.map(entry => <option key={entry.effect} value={entry.effect}>{t[entry.label]}</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel>{t.expiryLabel}</FieldLabel>
              <Input type="datetime-local" value={expiry} onChange={event => setExpiry(event.currentTarget.value)} />
              <FieldHelper>{t.expiryHelp}</FieldHelper>
            </Field>
          </div> : null}
          <Field>
            <FieldLabel>{t.decisionNoteLabel}</FieldLabel>
            <Textarea value={note} rows={2} maxLength={8000} onChange={event => setNote(event.currentTarget.value)} />
            <FieldHelper>{t.decisionNoteHelp}</FieldHelper>
          </Field>
          <section aria-labelledby="safety-preview" className="grid gap-2 rounded-2xl border border-border/60 bg-muted/40 p-4">
            <h3 id="safety-preview" className="font-semibold text-sm">{t.previewHeading}</h3>
            <p className="text-muted-foreground text-xs">{t.previewLanguage({ language: languageName })}</p>
            <dl className="grid gap-2 text-sm" lang={language === 'und' ? undefined : language}>
              {preview.map(([name, value]) => <div key={name} className="grid gap-0.5">
                <dt className="text-muted-foreground text-xs">{name}</dt>
                <dd className="whitespace-pre-line [overflow-wrap:anywhere]">{value.trim() || t.previewEmpty}</dd>
              </div>)}
            </dl>
            <p className="text-sm">{automation ? t.previewAutomation : t.previewNoAutomation}</p>
            {rule ? <p className="text-sm">{t.previewRule({ ref: rule.ref, revision: rule.revision })}</p> : null}
            <p className="text-sm">{t.previewAppeal}</p>
          </section>
          {problem ? <Alert variant="destructive" role="alert"><CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{problem}</AlertDescription></Alert> : null}
          {state.kind === 'accepted' ? <Alert role="status"><AlertDescription>{t.decisionAccepted}</AlertDescription></Alert>
            : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t.cancel}</Button>
          <Button type="submit" isLoading={state.kind === 'sending'} disabled={state.kind === 'sending'}
            variant={restricts(shown) ? 'destructive' : 'default'}>
            {state.kind === 'accepted' ? t.decisionResume : state.kind === 'sending' ? t.decisionSending : t.decisionSend}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
