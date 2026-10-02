'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CommandDialog } from './command-dialog.tsx';
import { browserSpaceAccessApi, newKey, sameSpaceSettings, type SpaceAccessApi, type SpaceSettings, type SpaceSettingsView } from './settings-api.ts';
import { accessMessages, type AccessMessages } from './settings-messages.ts';

const groups = [
  ['visibility', [['public', 'public', 'publicHelp'], ['private', 'private', 'privateHelp']]],
  ['listing', [['listed', 'listed', 'listedHelp'], ['unlisted', 'unlisted', 'unlistedHelp']]],
  ['history', [['everything', 'everything', 'everythingHelp'], ['from-admission', 'fromAdmission', 'fromAdmissionHelp']]],
  ['admission', [['open', 'open', 'openHelp'], ['request', 'request', 'requestHelp'], ['invitation', 'invitation', 'invitationHelp']]],
] as const;

export function SettingsAccess({ initial, actingSubject, locale, api: provided }: {
  initial: SpaceSettingsView; actingSubject: string; locale: UiLocale; api?: SpaceAccessApi;
}) {
  const t = accessMessages[locale];
  const api = useMemo(() => provided ?? browserSpaceAccessApi(initial.space, initial.realm, actingSubject),
    [provided, initial.space, initial.realm, actingSubject]);
  const [current, setCurrent] = useState(initial);
  const [draft, setDraft] = useState(initial.settings);
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const intent = useRef<{ body: string; key: string } | null>(null);
  const changed = !sameSpaceSettings(current.settings, draft);

  async function save() {
    if (busy || !reason.trim()) return;
    setBusy(true); setError(null);
    const body = { actingSubject, expectedGeneration: current.generation, settings: draft, reason: reason.trim() };
    const encoded = JSON.stringify(body);
    if (intent.current?.body !== encoded) intent.current = { body: encoded, key: newKey() };
    const result = await api.save(body, intent.current.key);
    if (result.ok) {
      setCurrent(result.data); setDraft(result.data.settings); setReview(false); setReason(''); setSaved(true);
      intent.current = null;
    } else if (result.failure === 'stale') {
      const fresh = await api.settings();
      if (fresh.ok) { setCurrent(fresh.data); setConflict(true); setReview(false); intent.current = null; }
      else setError(t.failed);
    } else setError(result.failure === 'denied' ? t.denied : t.failed);
    setBusy(false);
  }

  return <section aria-labelledby="space-access-title" className="grid max-w-3xl gap-5 border-border/60 border-b pb-8">
    <h2 id="space-access-title" className="font-semibold text-xl">{t.title}</h2>
    {saved ? <p role="status">{t.saved}</p> : null}
    {conflict ? <Alert variant="warning"><AlertDescription className="grid gap-3">
      <p>{t.conflict}</p><SettingsSummary settings={current.settings} t={t} title={t.current} />
      <div className="flex flex-wrap gap-2"><Button onClick={() => { setConflict(false); setReview(true); }}>{t.reviewAgain}</Button>
        <Button variant="outline" onClick={() => { setDraft(current.settings); setConflict(false); }}>{t.discard}</Button></div>
    </AlertDescription></Alert> : null}
    {groups.map(([field, choices]) => <section key={field} aria-labelledby={`space-${field}`} className="grid gap-3">
      <h3 id={`space-${field}`} className="font-semibold">{t[field]}</h3>
      <RadioGroup value={draft[field]} onValueChange={({ value }) => {
        if (value) { setDraft(previous => ({ ...previous, [field]: value })); setSaved(false); }
      }}><RadioGroupLabel className="sr-only">{t[field]}</RadioGroupLabel>
        {choices.map(([value, label, help]) => <RadioGroupItem key={value} value={value}>
          <span className="grid gap-1"><span className="font-medium">{t[label]}</span>
            <span className="text-muted-foreground text-sm">{t[help]}</span></span>
        </RadioGroupItem>)}
      </RadioGroup>
    </section>)}
    <Button className="w-fit" disabled={!changed || conflict} onClick={() => { setReview(true); setError(null); }}>{t.review}</Button>
    <CommandDialog open={review} title={t.review} confirm={t.save} pending={busy} disabled={!changed || !reason.trim()}
      cancel={t.cancel} error={error} onClose={() => setReview(false)} onConfirm={() => void save()}>
      <SettingsSummary settings={draft} t={t} />
      <p className="text-sm">{t.consequence}</p>
      <Field><FieldLabel>{t.reason}</FieldLabel><Textarea maxLength={2000} value={reason}
        onChange={event => setReason(event.currentTarget.value)} /></Field>
    </CommandDialog>
  </section>;
}

function SettingsSummary({ settings, t, title }: { settings: SpaceSettings; t: AccessMessages; title?: string }) {
  return <div className="grid gap-2 text-sm">{title ? <h3 className="font-semibold">{title}</h3> : null}
    <dl className="grid gap-3">{groups.map(([field, choices]) => {
      const choice = choices.find(([value]) => value === settings[field])!;
      return <div key={field}><dt className="font-medium">{t[field]} · {t[choice[1]]}</dt><dd>{t[choice[2]]}</dd></div>;
    })}</dl></div>;
}
