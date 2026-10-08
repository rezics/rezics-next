'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { communityText } from '../communities/messages.ts';
import { CommandDialog } from './command-dialog.tsx';
import { newKey, type CommandFailure } from './commands.ts';
import { browserSpaceAccessApi, type RealmSettingsCommand, type RealmSettingsReceipt, type RealmSettingsView,
  type SettingsCommand, type SpaceAccessApi, type SpaceSettings, type SpaceSettingsView } from './settings-api.ts';
import { accessMessages, type AccessMessages } from './settings-messages.ts';

/** The create form's three participation levels, in the same order. */
export const PARTICIPATION = ['public', 'restricted', 'private'] as const;
export type Participation = typeof PARTICIPATION[number];

const helpKey = { public: 'publicHelp', restricted: 'restrictedHelp', private: 'privateHelp' } as const;

const groups = [
  ['listing', [['listed', 'listed', 'listedHelp'], ['unlisted', 'unlisted', 'unlistedHelp']]],
  ['history', [['everything', 'everything', 'everythingHelp'], ['from-admission', 'fromAdmission', 'fromAdmissionHelp']]],
  ['admission', [['open', 'open', 'openHelp'], ['request', 'request', 'requestHelp'], ['invitation', 'invitation', 'invitationHelp']]],
] as const;

/** Access records public or private. Private exactly when the Realm is private; restricted stays public there. */
export function projectedSpaceVisibility(visibility: Participation): SpaceSettings['visibility'] {
  return visibility === 'private' ? 'private' : 'public';
}

export function isParticipation(value: string | null | undefined): value is Participation {
  return value === 'public' || value === 'restricted' || value === 'private';
}

/** Words and help from the create form, so Manage does not keep a second copy. */
export function participationCopy(locale: UiLocale, visibility: Participation) {
  return { title: communityText.visibility[locale], label: communityText[visibility][locale],
    help: communityText[helpKey[visibility]][locale] };
}

function discoveryChanged(current: SpaceSettings, draft: SpaceSettings) {
  return current.listing !== draft.listing || current.history !== draft.history || current.admission !== draft.admission;
}

export interface AccessCommitInput {
  api: Pick<SpaceAccessApi, 'save' | 'saveRealm'>;
  actingSubject: string;
  reason: string;
  space: SpaceSettingsView;
  /** Listing, history and admission. Space visibility is never taken from this draft. */
  spaceDraft: SpaceSettings;
  realm: RealmSettingsView;
  participation: Participation;
  keyFor: (kind: 'realm' | 'space', body: string) => string;
}

export type AccessCommit = { ok: true; space: SpaceSettingsView; realm: RealmSettingsView }
  | { ok: false; failure: CommandFailure; realm: RealmSettingsView | null };

function realmView(receipt: RealmSettingsReceipt): RealmSettingsView {
  return { generation: receipt.generation, settings: receipt.settings, ruleBasis: receipt.ruleBasis };
}

/**
 * Participation is a Realm settings write. Listing, history and admission stay
 * on the Space settings command, whose visibility is only the projection — a
 * direct public/private write would collapse restricted.
 * Both commands share the Realm management generation, so a participation
 * write's receipt is the generation the discovery write must expect.
 */
export async function commitAccessEdits(input: AccessCommitInput): Promise<AccessCommit> {
  const participationChanged = input.realm.settings.visibility !== input.participation;
  const discovery = discoveryChanged(input.space.settings, input.spaceDraft);
  let realm = input.realm;
  if (participationChanged) {
    const command: RealmSettingsCommand = { actingSubject: input.actingSubject, expectedGeneration: realm.generation,
      reason: input.reason, expectedRulesRevision: realm.ruleBasis.revision,
      settings: { ...realm.settings, visibility: input.participation } };
    const saved = await input.api.saveRealm(command, input.keyFor('realm', JSON.stringify(command)));
    if (!saved.ok) return { ok: false, failure: saved.failure, realm: null };
    realm = realmView(saved.data);
  }
  let space = input.space;
  if (discovery) {
    const command: SettingsCommand = { actingSubject: input.actingSubject,
      expectedGeneration: participationChanged ? realm.generation : space.generation, reason: input.reason,
      settings: { visibility: projectedSpaceVisibility(input.participation), listing: input.spaceDraft.listing,
        history: input.spaceDraft.history, admission: input.spaceDraft.admission } };
    const saved = await input.api.save(command, input.keyFor('space', JSON.stringify(command)));
    if (!saved.ok) return { ok: false, failure: saved.failure, realm: participationChanged ? realm : null };
    space = saved.data;
  } else if (participationChanged) {
    space = { ...space, generation: realm.generation, settings: { ...space.settings,
      visibility: projectedSpaceVisibility(input.participation) } };
  }
  return { ok: true, space, realm };
}

export function SettingsAccess({ initial, realmSettings, actingSubject, locale, api: provided }: {
  initial: SpaceSettingsView; realmSettings: RealmSettingsView; actingSubject: string; locale: UiLocale; api?: SpaceAccessApi;
}) {
  const t = accessMessages[locale];
  const api = useMemo(() => provided ?? browserSpaceAccessApi(initial.space, initial.realm, actingSubject),
    [provided, initial.space, initial.realm, actingSubject]);
  const [current, setCurrent] = useState(initial);
  const [realm, setRealm] = useState(realmSettings);
  const [draft, setDraft] = useState(initial.settings);
  const [participation, setParticipation] = useState<Participation>(realmSettings.settings.visibility);
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const intents = useRef<{ realm: { body: string; key: string } | null; space: { body: string; key: string } | null }>({
    realm: null, space: null });
  const changed = realm.settings.visibility !== participation || discoveryChanged(current.settings, draft);

  function keyFor(kind: 'realm' | 'space', body: string) {
    const held = intents.current[kind];
    if (held?.body === body) return held.key;
    const key = newKey();
    intents.current[kind] = { body, key };
    return key;
  }

  async function save() {
    if (busy || !reason.trim()) return;
    setBusy(true); setError(null);
    const result = await commitAccessEdits({ api, actingSubject, reason: reason.trim(), space: current, spaceDraft: draft,
      realm, participation, keyFor });
    if (result.realm) setRealm(result.realm);
    if (result.ok) {
      setCurrent(result.space); setDraft(result.space.settings); setParticipation(result.realm.settings.visibility);
      setReview(false); setReason(''); setSaved(true);
      intents.current = { realm: null, space: null };
    } else if (result.failure === 'stale') {
      const [freshSpace, freshRealm] = await Promise.all([api.settings(), api.realm()]);
      if (freshSpace.ok) setCurrent(freshSpace.data);
      if (freshRealm.ok) setRealm(freshRealm.data);
      if (freshSpace.ok || freshRealm.ok) {
        setConflict(true); setReview(false); intents.current = { realm: null, space: null };
      } else setError(t.failed);
    } else {
      // Participation already committed. A later discovery retry must expect that generation,
      // and must send the projection rather than the visibility from before the write.
      if (result.realm) {
        const committed = result.realm;
        intents.current.realm = null;
        setCurrent(previous => ({ ...previous, generation: committed.generation, settings: { ...previous.settings,
          visibility: projectedSpaceVisibility(committed.settings.visibility) } }));
      }
      setError(result.failure === 'denied' ? t.denied : t.failed);
    }
    setBusy(false);
  }

  return <section aria-labelledby="space-access-title" className="grid max-w-3xl gap-5 border-border/60 border-b pb-8">
    <h2 id="space-access-title" className="font-semibold text-xl">{t.title}</h2>
    {saved ? <p role="status">{t.saved}</p> : null}
    {conflict ? <Alert variant="warning"><AlertDescription className="grid gap-3">
      <p>{t.conflict}</p>
      <SettingsSummary settings={current.settings} participation={realm.settings.visibility} locale={locale} t={t} title={t.current} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => { setConflict(false); setReview(true); }}>{t.reviewAgain}</Button>
        <Button variant="outline" onClick={() => { setDraft(current.settings); setParticipation(realm.settings.visibility); setConflict(false); }}>{t.discard}</Button>
      </div>
    </AlertDescription></Alert> : null}
    <section aria-labelledby="space-participation" className="grid gap-3">
      <h3 id="space-participation" className="font-semibold">{communityText.visibility[locale]}</h3>
      <RadioGroup value={participation} onValueChange={({ value }) => {
        if (isParticipation(value)) { setParticipation(value); setSaved(false); }
      }}><RadioGroupLabel className="sr-only">{communityText.visibility[locale]}</RadioGroupLabel>
        {PARTICIPATION.map(value => {
          const choice = participationCopy(locale, value);
          return <RadioGroupItem key={value} value={value}>
            <span className="grid gap-1"><span className="font-medium">{choice.label}</span>
              <span className="text-muted-foreground text-sm">{choice.help}</span></span>
          </RadioGroupItem>;
        })}
      </RadioGroup>
    </section>
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
      <SettingsSummary settings={draft} participation={participation} locale={locale} t={t} />
      <p className="text-sm">{t.consequence}</p>
      <Field><FieldLabel>{t.reason}</FieldLabel><Textarea maxLength={2000} value={reason}
        onChange={event => setReason(event.currentTarget.value)} /></Field>
    </CommandDialog>
  </section>;
}

function SettingsSummary({ settings, participation, locale, t, title }: {
  settings: SpaceSettings; participation: Participation; locale: UiLocale; t: AccessMessages; title?: string;
}) {
  const choice = participationCopy(locale, participation);
  return <div className="grid gap-2 text-sm">{title ? <h3 className="font-semibold">{title}</h3> : null}
    <dl className="grid gap-3">
      <div><dt className="font-medium">{choice.title} · {choice.label}</dt><dd>{choice.help}</dd></div>
      {groups.map(([field, choices]) => {
        const selected = choices.find(([value]) => value === settings[field])!;
        return <div key={field}><dt className="font-medium">{t[field]} · {t[selected[1]]}</dt><dd>{t[selected[2]]}</dd></div>;
      })}
    </dl></div>;
}
