'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { GitCompareArrowsIcon, PencilIcon, ScaleIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { type AdminApi, bffAdminApi } from './admin-api.ts';
import { CommandDialog } from './command-dialog.tsx';
import { newKey } from './commands.ts';
import type { ManageMessages } from './messages.ts';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { REASON_LIMIT } from './reason-dialog.tsx';
import { RevisionBadge, RuleList, ruleLanguageName } from './rule-list.tsx';
import { compareRules, nextRevision, type RuleChange, ruleProblems, type RuleProblem, restoredRule, shownRule } from './rules.ts';
import { draftsOf, type RuleDraft, RulesEditor } from './rules-editor.tsx';
import type { RealmRule, SettingsView as Settings, WhoMaySubmit } from './types.ts';

const submitChoices = [['granted', 'submitGranted', 'submitGrantedHelp'], ['members', 'submitMembers', 'submitMembersHelp'],
  ['closed', 'submitClosed', 'submitClosedHelp']] as const satisfies ReadonlyArray<readonly [WhoMaySubmit, string, string]>;

const storageKey = (realm: string) => `rezics:manage:rules-draft:${realm}`;
interface StoredDraft { base: string | null; drafts: RuleDraft[]; whoMaySubmit: WhoMaySubmit }

/**
 * Realm settings and its rules. Rules keep their recorded languages, compared
 * with the published revision, then published as the next revision; a
 * publication by someone else in the meantime keeps this draft for review.
 */
export function SettingsView({ realm, actingSubject, initial, locale, messages, api: givenApi }: {
  realm: string; actingSubject: string; initial: Settings; locale: UiLocale; messages: ManageMessages; api?: AdminApi;
}) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const api = useMemo(() => givenApi ?? bffAdminApi(realm, actingSubject), [givenApi, realm, actingSubject]);
  const router = useRouter();
  const reading = useReadingLanguages(actingSubject);
  const [current, setCurrent] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => draftsOf(initial.settings.rules));
  const [who, setWho] = useState<WhoMaySubmit>(initial.settings.whoMaySubmit);
  const [problems, setProblems] = useState<RuleProblem[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [conflict, setConflict] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // A draft survives a reload until it is published or discarded.
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey(realm)) ?? 'null') as StoredDraft | null;
      if (!stored) return;
      const restored = stored.drafts.map(draft => ({ ...draft, rule: restoredRule(draft.rule) }));
      setDrafts(restored);
      setWho(stored.whoMaySubmit);
      setEditing(true);
      if (stored.base !== initial.ruleBasis.revision) setConflict(initial);
    } catch { /* an unreadable draft is ignored */ }
  }, [realm, initial]);
  useEffect(() => {
    if (!editing) return;
    const stored: StoredDraft = { base: current.ruleBasis.revision, drafts, whoMaySubmit: who };
    try { localStorage.setItem(storageKey(realm), JSON.stringify(stored)); } catch { /* storage may be full or off */ }
  }, [editing, drafts, who, current.ruleBasis.revision, realm]);

  const rules = drafts.map(draft => draft.rule);
  const changes = compareRules(current.settings.rules, rules);
  const whoChanged = who !== current.settings.whoMaySubmit;

  function discard(to: Settings = current) {
    try { localStorage.removeItem(storageKey(realm)); } catch { /* nothing to remove */ }
    setCurrent(to);
    setDrafts(draftsOf(to.settings.rules));
    setWho(to.settings.whoMaySubmit);
    setEditing(false);
    setProblems(null);
    setConflict(null);
  }

  function review() {
    const found = ruleProblems(rules);
    setProblems(found);
    if (!found.length) setReviewing(true);
  }

  async function published(result: Settings, revision: string | null) {
    discard(result);
    setReviewing(false);
    setStatus(revision ? t.rulesPublished({ revision }) : t.settingsSaved);
    router.refresh();
  }

  return <div className="grid gap-8">
    <div role="status" aria-live="polite" className="empty:hidden">{status ? <p className="text-sm">{status}</p> : null}</div>
    <section aria-labelledby="realm-submissions" className="grid max-w-3xl gap-3">
      <div className="space-y-1">
        <h2 id="realm-submissions" className="font-semibold text-xl tracking-tight">{t.submissionsTitle}</h2>
      </div>
      <RadioGroup value={who} onValueChange={details => {
        if (!details.value) return;
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
      {editing ? <RulesEditor drafts={drafts} published={current.settings.rules} problems={problems} locale={locale}
        messages={messages} reading={reading} onChange={next => { setDrafts(next); if (problems) setProblems(ruleProblems(next.map(item => item.rule))); }} />
        : current.settings.rules.length ? <RuleList rules={current.settings.rules} locale={locale} messages={messages} />
          : <EmptyState icon={ScaleIcon} title={t.noRulesTitle} description={t.noRulesHelp}>
            <Button size="sm" onClick={() => setEditing(true)}>{t.addRule}</Button></EmptyState>}
    </section>
    {editing ? <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-2
      rounded-2xl border border-border/60 bg-popover/95 p-3 shadow-(--aura-shadow-card) backdrop-blur md:bottom-4">
      <Button onClick={review} disabled={conflict !== null}><GitCompareArrowsIcon aria-hidden="true" />{t.reviewChanges}</Button>
      <Button variant="ghost" onClick={() => discard()}>{t.discardChanges}</Button>
      {problems?.length ? <p role="alert" className="text-destructive-foreground text-sm">{t.fixProblems}</p> : null}
    </div> : null}
    <PublishDialog open={reviewing} current={current} changes={changes} whoMaySubmit={who} whoChanged={whoChanged}
      rules={rules} api={api} actingSubject={actingSubject} locale={locale} messages={messages}
      onClose={() => setReviewing(false)} onPublished={(result, revision) => void published(result, revision)}
      onConflict={theirs => { setReviewing(false); setConflict(theirs); }} />
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

function PublishDialog({ open, current, changes, whoMaySubmit, whoChanged, rules, api, actingSubject, locale, messages,
  onClose, onPublished, onConflict }: {
  open: boolean; current: Settings; changes: RuleChange[]; whoMaySubmit: WhoMaySubmit; whoChanged: boolean;
  rules: RealmRule[]; api: AdminApi; actingSubject: string; locale: UiLocale; messages: ManageMessages;
  onClose: () => void; onPublished: (result: Settings, revision: string | null) => void;
  onConflict: (theirs: Settings) => void;
}) {
  const t = materializeData(messages, { locale });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (open) { setError(null); } }, [open]);
  const choice = submitChoices.find(([value]) => value === whoMaySubmit)!;

  async function publish() {
    if (!reason.trim() || reason.trim().length > REASON_LIMIT) { setError(t.reasonRequired); return; }
    setPending(true); setError(null);
    let basis = current;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await api.saveSettings({ actingSubject, expectedGeneration: basis.generation, reason: reason.trim(),
        settings: { ...basis.settings, whoMaySubmit, rules }, expectedRulesRevision: basis.ruleBasis.revision }, newKey());
      if (result.ok) {
        setPending(false); setReason('');
        onPublished({ generation: result.data.generation, settings: result.data.settings, ruleBasis: result.data.ruleBasis },
          result.data.ruleBasis.revision);
        return;
      }
      if (result.failure !== 'stale') {
        setPending(false);
        setError(result.failure === 'denied' ? t.settingsDenied : result.failure === 'invalid' ? t.settingsInvalid
          : t.failedNotice);
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

  return <CommandDialog open={open} title={t.reviewTitle} confirm={t.publish} pending={pending} error={error}
    cancel={t.keepEditing} onClose={onClose} onConfirm={() => void publish()} disabled={!changes.length && !whoChanged}>
    {changes.length || whoChanged ? <ul className="grid gap-1.5 text-sm">
      {whoChanged ? <li>{t.changeSubmissions({ choice: t[choice[1]] })}</li> : null}
      {changes.map(change => <li key={`${change.kind}-${change.rule.id}`}>{changeText(change, t, locale)}
        {change.kind === 'edited' && change.check.length ? <span className="block text-warning-foreground text-xs">
          {t.checkHelp({ changed: change.languages.map(language => ruleLanguageName(language, t, locale)).join(', '),
            other: change.check.map(language => ruleLanguageName(language, t, locale)).join(', ') })}</span> : null}</li>)}
    </ul> : <p className="text-sm">{t.noChanges}</p>}
    <p className="rounded-xl bg-muted/40 p-3 text-muted-foreground text-sm">
      {t.publishNote({ revision: nextRevision(current.ruleBasis) })}</p>
    <Field invalid={error === t.reasonRequired}>
      <FieldLabel>{t.publishReasonLabel}</FieldLabel>
      <Textarea value={reason} rows={2} maxLength={REASON_LIMIT} onChange={event => setReason(event.currentTarget.value)} />
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
