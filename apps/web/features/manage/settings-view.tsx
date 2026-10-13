'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { GitCompareArrowsIcon, PencilIcon, ScaleIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { type AdminApi, bffAdminApi } from './admin-api.ts';
import { CommandDialog } from './command-dialog.tsx';
import { newKey } from './commands.ts';
import { attemptStorage, performCommand, readCommand } from './safety-pending.ts';
import type { ManageMessages } from './messages.ts';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { REASON_LIMIT } from './reason-dialog.tsx';
import { RevisionBadge, RuleList, ruleLanguageName } from './rule-list.tsx';
import { compareRules, nextRevision, type RuleChange, ruleProblems, type RuleProblem, shownRule } from './rules.ts';
import { draftsOf, type RuleDraft, RulesEditor } from './rules-editor.tsx';
import type { RealmRule, SettingsView as Settings, WhoMaySubmit } from './types.ts';

const submitChoices = [['granted', 'submitGranted', 'submitGrantedHelp'], ['members', 'submitMembers', 'submitMembersHelp'],
  ['closed', 'submitClosed', 'submitClosedHelp']] as const satisfies ReadonlyArray<readonly [WhoMaySubmit, string, string]>;

export const newestSettings = (a: Settings, b: Settings): Settings => BigInt(a.generation) >= BigInt(b.generation) ? a : b;
type SettingsCommand = Parameters<AdminApi['saveSettings']>[0];

/**
 * Realm settings and its rules. Rules keep their recorded languages, compared
 * with the published revision, then published as the next revision; a
 * publication by someone else in the meantime keeps this draft for review.
 */
export function SettingsView({ principal, realm, actingSubject, initial, locale, messages, api: givenApi }: {
  principal: string; realm: string; actingSubject: string; initial: Settings; locale: UiLocale; messages: ManageMessages; api?: AdminApi;
}) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const api = useMemo(() => givenApi ?? bffAdminApi(realm, actingSubject), [givenApi, realm, actingSubject]);
  const router = useRouter();
  const store = useMemo(() => attemptStorage(principal), [principal]);
  const reading = useReadingLanguages(actingSubject);
  const [current, setCurrent] = useState(initial);
  const latestSettings = useRef(current);
  latestSettings.current = newestSettings(current, initial);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => draftsOf(initial.settings.rules));
  const [who, setWho] = useState<WhoMaySubmit>(initial.settings.whoMaySubmit);
  const [problems, setProblems] = useState<RuleProblem[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [conflict, setConflict] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Counts what this person changed in the draft, so a result that lands later can tell whether the draft moved on.
  const draftEdits = useRef(0);
  const editingNow = useRef(editing);
  editingNow.current = editing;

  // Only dispatched operations survive a reload; unsent edits belong to this page.
  useEffect(() => {
    const attempt = readCommand<SettingsCommand>(realm, actingSubject, 'settings', store);
    if (attempt) {
      setRecovering(true);
      setDrafts(draftsOf(attempt.input.settings.rules));
      setWho(attempt.input.settings.whoMaySubmit);
      setEditing(true);
      setReviewing(true);
    }
  }, [realm, actingSubject, initial, store]);

  useEffect(() => {
    if (!editing && !recovering && BigInt(initial.generation) > BigInt(current.generation)) {
      setCurrent(initial);
      setDrafts(draftsOf(initial.settings.rules));
      setWho(initial.settings.whoMaySubmit);
    }
  }, [initial, editing, recovering, current.generation]);

  const rules = drafts.map(draft => draft.rule);
  const changes = compareRules(current.settings.rules, rules);
  const whoChanged = who !== current.settings.whoMaySubmit;

  function discard(to: Settings = current) {
    setCurrent(to);
    setDrafts(draftsOf(to.settings.rules));
    setWho(to.settings.whoMaySubmit);
    setEditing(false);
    setProblems(null);
    setConflict(null);
  }

  /** A refused command keeps its retry key and the last accepted rules. The draft is not the published revision. */
  function refusedAmendment(title: string) {
    discard(current);
    setRecovering(false);
    setReviewing(false);
    setRefusal(title);
  }

  function review() {
    const found = ruleProblems(rules);
    setProblems(found);
    if (!found.length) setReviewing(true);
  }

  async function published(result: Settings, revision: string | null, editsAtPublish: number) {
    setRecovering(false);
    const fresh = await api.settings();
    const latest = newestSettings(latestSettings.current, fresh.ok ? fresh.data : result);
    const newest = newestSettings(latest, result);
    // What was changed after Publish is a newer draft and it was written against this publication. It stays on that
    // basis: a newer rules revision is shown as a conflict to review, never merged into the draft, and a save sends
    // the basis it was written against, so Main refuses a stale one.
    if (draftEdits.current !== editsAtPublish && editingNow.current) {
      const moved = newest.ruleBasis.revision !== result.ruleBasis.revision
        || newest.settings.whoMaySubmit !== result.settings.whoMaySubmit;
      setCurrent(moved ? result : newest);
      setConflict(moved ? newest : null);
    } else discard(newest);
    setReviewing(false);
    setRefusal(null);
    setStatus(revision && BigInt(result.generation) >= BigInt(latest.generation) ? t.rulesPublished({ revision }) : t.settingsSaved);
    router.refresh();
  }

  return <div className="grid gap-8">
    <div role="status" aria-live="polite" className="empty:hidden">{status ? <p className="text-sm">{status}</p> : null}</div>
    {refusal ? <p role="alert">{refusal}</p> : null}
    <section aria-labelledby="realm-submissions" className="grid max-w-3xl gap-3">
      <div className="space-y-1">
        <h2 id="realm-submissions" className="font-semibold text-xl tracking-tight">{t.submissionsTitle}</h2>
      </div>
      <RadioGroup disabled={recovering} value={who} onValueChange={details => {
        if (!details.value) return;
        draftEdits.current++;
        setWho(details.value as WhoMaySubmit);
        setEditing(true);
      }}>
        <RadioGroupLabel className="sr-only">{t.submissionsTitle}</RadioGroupLabel>
        {submitChoices.map(([value, label, help]) => <RadioGroupItem key={value} value={value}>
          <span className="grid gap-0.5"><span className="font-medium">{t[label]}</span>
            <span className="text-muted-foreground text-sm">{t[help]}</span></span>
        </RadioGroupItem>)}
      </RadioGroup>
    </section>
    <section aria-labelledby="realm-rules" className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="realm-rules" className="font-semibold text-xl tracking-tight">{t.rulesTitle}</h2>
            <RevisionBadge meaning={current.ruleBasis} locale={locale} messages={messages} />
          </div>
          <p className="max-w-2xl text-muted-foreground text-sm">{t.rulesHelp}</p>
        </div>
        {!editing ? <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <PencilIcon aria-hidden="true" />{t.editRules}</Button> : null}
      </div>
      {conflict ? <ConflictPanel theirs={conflict} mine={rules} locale={locale} messages={messages}
        onDiscard={() => discard(conflict)}
        onKeep={() => { setCurrent(conflict); setConflict(null); review(); }} /> : null}
      {editing ? <fieldset disabled={recovering} className="contents"><RulesEditor drafts={drafts} published={current.settings.rules} problems={problems} locale={locale}
        messages={messages} reading={reading} onChange={next => { draftEdits.current++; setDrafts(next); if (problems) setProblems(ruleProblems(next.map(item => item.rule))); }} /></fieldset>
        : current.settings.rules.length ? <RuleList rules={current.settings.rules} locale={locale} messages={messages} />
          : <EmptyState icon={ScaleIcon} title={t.noRulesTitle} description={t.noRulesHelp}>
            <Button size="sm" onClick={() => setEditing(true)}>{t.addRule}</Button></EmptyState>}
    </section>
    {editing ? <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-2
      rounded-2xl border border-border/60 bg-popover/95 p-3 shadow-(--aura-shadow-card) backdrop-blur md:bottom-4">
      <Button onClick={recovering ? () => setReviewing(true) : review} disabled={!recovering && conflict !== null}>
        <GitCompareArrowsIcon aria-hidden="true" />{recovering ? t.decisionResume : t.reviewChanges}</Button>
      <Button variant="ghost" disabled={recovering} onClick={() => discard()}>{t.discardChanges}</Button>
      {problems?.length ? <p role="alert" className="text-destructive-foreground text-sm">{t.fixProblems}</p> : null}
    </div> : null}
    <PublishDialog principal={principal} realm={realm} open={reviewing} current={current} changes={changes} whoMaySubmit={who} whoChanged={whoChanged}
      rules={rules} api={api} actingSubject={actingSubject} locale={locale} messages={messages}
      onRecovery={setRecovering} draftEdits={() => draftEdits.current}
      onClose={() => setReviewing(false)} onPublished={(result, revision, edits) => void published(result, revision, edits)}
      onConflict={theirs => { setReviewing(false); setConflict(theirs); }} onRefused={refusedAmendment} />
  </div>;
}

function changeText(change: RuleChange, t: ReturnType<typeof materializeData<ManageMessages>>, locale: UiLocale) {
  const title = shownRule(change.rule, locale).title.text || change.rule.id;
  switch (change.kind) {
    case 'added': return t.changeAdded({ title });
    case 'removed': return t.changeRemoved({ title });
    case 'moved': return t.changeMoved({ title, position: String(change.to + 1) });
    case 'edited': return t.changeEdited({ title, languages: change.languages.map(language => ruleLanguageName(language, t, locale))
      .join(', ') });
  }
}

function PublishDialog({ principal, realm, open, current, changes, whoMaySubmit, whoChanged, rules, api, actingSubject, locale, messages, onRecovery,
  draftEdits, onClose, onPublished, onConflict, onRefused }: {
  principal: string; realm: string; open: boolean; current: Settings; changes: RuleChange[]; whoMaySubmit: WhoMaySubmit; whoChanged: boolean;
  rules: RealmRule[]; api: AdminApi; actingSubject: string; locale: UiLocale; messages: ManageMessages;
  onClose: () => void; onPublished: (result: Settings, revision: string | null, edits: number) => void;
  onConflict: (theirs: Settings) => void;
  onRefused: (title: string) => void;
  onRecovery: (recovering: boolean) => void;
  draftEdits: () => number;
}) {
  const t = materializeData(messages, { locale });
  const store = useMemo(() => attemptStorage(principal), [principal]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [recovering, setRecovering] = useState(() => readCommand<SettingsCommand>(realm, actingSubject, 'settings', store) !== null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    const stored = readCommand<SettingsCommand>(realm, actingSubject, 'settings', store);
    if (stored) setReason(stored.input.reason);
    setRecovering(stored !== null);
  }, [open, realm, actingSubject, store]);
  const choice = submitChoices.find(([value]) => value === whoMaySubmit)!;

  async function publish() {
    if (!recovering && (!reason.trim() || reason.trim().length > REASON_LIMIT)) { setError(t.reasonRequired); return; }
    setPending(true); setError(null);
    const edits = draftEdits();
    let basis = current;
    for (let attempt = 0; attempt < 2; attempt++) {
      const attempt = readCommand<SettingsCommand>(realm, actingSubject, 'settings', store) ?? { realm, actingSubject, key: newKey(), status: 'recorded' as const,
        input: { actingSubject, expectedGeneration: basis.generation, reason: reason.trim(),
          settings: { ...basis.settings, whoMaySubmit, rules }, expectedRulesRevision: basis.ruleBasis.revision } };
      const result = await performCommand('settings', attempt,
        attempt => api.saveSettings(attempt.input, attempt.key), store);
      const retained = !result.ok && readCommand(realm, actingSubject, 'settings', store) !== null;
      setRecovering(retained); onRecovery(retained);
      if (result.ok) {
        setPending(false); setReason('');
        onPublished({ generation: result.data.generation, settings: result.data.settings, ruleBasis: result.data.ruleBasis },
          result.data.ruleBasis.revision, edits);
        return;
      }
      if (result.failure === 'conflict') {
        setPending(false);
        onRecovery(false);
        onRefused(result.title ?? t.failedNotice);
        return;
      }
      if (retained || result.failure !== 'stale') {
        setPending(false);
        setError(retained ? t.decisionStillPending : result.failure === 'denied' ? t.settingsDenied : result.failure === 'invalid' ? t.settingsInvalid
          : result.title ?? t.failedNotice);
        return;
      }
      // Stale: another management change moved the Realm. Only a different rules revision or submission
      // setting is a conflict with this draft; anything else is retried on the new basis.
      const fresh = await api.settings();
      if (!fresh.ok) break;
      if (fresh.data.ruleBasis.revision !== current.ruleBasis.revision
        || fresh.data.settings.whoMaySubmit !== current.settings.whoMaySubmit) {
        setPending(false);
        onConflict(fresh.data);
        return;
      }
      basis = fresh.data;
    }
    setPending(false);
    setError(t.failedNotice);
  }

  return <CommandDialog open={open} title={t.reviewTitle} confirm={recovering ? t.decisionResume : t.publish} pending={pending} error={error}
    cancel={t.keepEditing} onClose={onClose} onConfirm={() => void publish()} disabled={!recovering && !changes.length && !whoChanged}>
    {changes.length || whoChanged ? <ul className="grid gap-1.5 text-sm">
      {whoChanged ? <li>{t.changeSubmissions({ choice: t[choice[1]] })}</li> : null}
      {changes.map(change => <li key={`${change.kind}-${change.rule.id}`}>{changeText(change, t, locale)}
        {change.kind === 'edited' && change.check.length ? <span className="block text-warning-foreground text-xs">
          {t.checkHelp({ changed: change.languages.map(language => ruleLanguageName(language, t, locale)).join(', '),
            other: change.check.map(language => ruleLanguageName(language, t, locale)).join(', ') })}</span> : null}</li>)}
    </ul> : <p className="text-sm">{t.noChanges}</p>}
    {!recovering ? <p className="rounded-xl bg-muted/40 p-3 text-muted-foreground text-sm">
      {t.publishNote({ revision: nextRevision(current.ruleBasis) })}</p> : null}
    <Field invalid={error === t.reasonRequired}>
      <FieldLabel>{t.publishReasonLabel}</FieldLabel>
      <Textarea disabled={recovering || pending} value={reason} rows={2} maxLength={REASON_LIMIT} onChange={event => setReason(event.currentTarget.value)} />
      {error === t.reasonRequired ? <FieldError>{error}</FieldError> : <FieldHelper>{t.publishReasonHelp}</FieldHelper>}
    </Field>
  </CommandDialog>;
}

function ConflictPanel({ theirs, mine, locale, messages, onKeep, onDiscard }: {
  theirs: Settings; mine: readonly RealmRule[]; locale: UiLocale; messages: ManageMessages;
  onKeep: () => void; onDiscard: () => void;
}) {
  const t = materializeData(messages, { locale });
  const difference = compareRules(theirs.settings.rules, mine);
  return <Alert variant="warning">
    <GitCompareArrowsIcon aria-hidden="true" />
    <AlertTitle>{t.conflictTitle}</AlertTitle>
    <AlertDescription className="grid gap-4">
      <p>{t.conflictHelp({ revision: theirs.ruleBasis.revision ?? '1' })}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label={t.theirVersion} className="grid content-start gap-2">
          <h3 className="font-medium text-foreground text-sm">{t.theirVersion}</h3>
          <RuleList rules={theirs.settings.rules} locale={locale} messages={messages} />
        </section>
        <section aria-label={t.yourDraft} className="grid content-start gap-2">
          <h3 className="font-medium text-foreground text-sm">{t.yourDraft}</h3>
          <ul className="grid gap-1 text-foreground text-sm">
            {difference.length ? difference.map(change => <li key={`${change.kind}-${change.rule.id}`}>
              {changeText(change, t, locale)}</li>) : <li>{t.noChanges}</li>}
          </ul>
        </section>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onKeep}>{t.publishOnTop}</Button>
        <Button size="sm" variant="outline" onClick={onDiscard}>{t.discardDraft}</Button>
      </div>
    </AlertDescription>
  </Alert>;
}
