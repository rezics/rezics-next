'use client';

import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { Switch } from '@rezics/ui/switch';
import { SettingsCard, SettingsRow } from './account-shell.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import type { ContentPreferences, ContentPreferenceChange } from '../api/content-preferences.ts';
import type { Read } from '../api/server.ts';
import { useLocale, useTranslation } from '../../i18n/client.ts';
import { failureText } from './failure-text.ts';

type Category = keyof ContentPreferences['categories'];
const countries = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
  + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ '
  + 'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ '
  + 'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');

/** The API owns defaults and permission checks. The form retains no inferred age. */
export function ContentSettings({ initial }: { initial: Read<ContentPreferences> }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const locale = useLocale().current;
  const { api, refresh } = useAccountClient();
  const [saved, setSaved] = useState(initial.status === 'ok' ? initial.data : null);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<Category>();
  const [birth, setBirth] = useState(saved?.birthDate ?? '');
  const [country, setCountry] = useState(saved?.country ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  const regions = [...new Set(countries)].map(code => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));

  async function save(change: Omit<ContentPreferenceChange, 'expectedRevision'>) {
    if (!saved || busy) return;
    setBusy(true); setError('');
    const result = await api.setContentPreferences({ expectedRevision: saved.revision, ...change });
    setBusy(false);
    if (!result.ok) {
      const kind = result.kind;
      setError(kind === 'invalid-birth-date' ? t.birthdayInvalid
        : kind === 'birth-date-required' ? t.birthdayRequired
          : kind === 'age-ineligible' ? t.contentAgeDenied
            : kind === 'market-restricted' || kind === 'market-unavailable' ? t.contentMarketDenied
              : failureText(kind, common));
      if (kind === 'conflict') refresh();
      return;
    }
    setSaved(result.data); setBirth(result.data.birthDate ?? ''); setCountry(result.data.country ?? '');
    setEditing(false); setPending(undefined);
    if (!result.data.accountEligible) refresh();
  }
  function open(category?: Category) {
    setBirth(saved?.birthDate ?? ''); setCountry(saved?.country ?? '');
    setPending(category); setError(''); setEditing(true);
  }
  function toggle(category: Category, checked: boolean) {
    if (checked && category !== 'general' && !saved?.birthDate) return open(category);
    void save({ categories: { [category]: checked } });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending && !birth) return setError(t.birthdayRequired);
    void save({ birthDate: birth || null, ...(country ? { country } : {}),
      ...(pending ? { categories: { [pending]: true } } : {}) });
  }
  const descriptions = { general: t.generalHelp, r15: t.r15Help, r18: t.r18Help, r18g: t.r18gHelp };
  const labels = { general: t.generalLabel, r15: 'R15', r18: 'R18', r18g: 'R18G' };
  return <SettingsCard title={t.contentTitle}>
    {!saved ? <p role="status" className="px-5 py-4 text-sm text-muted-foreground">{common.unavailableBody}</p> : <>
      <p className="px-5 pt-4 text-sm text-muted-foreground sm:px-6">{t.contentHelp}</p>
      <SettingsRow label={t.birthdayLabel} action={<Button variant="ghost" disabled={busy || editing}
        onClick={() => open()} aria-label={`${t.edit} · ${t.birthdayLabel}`}>{t.edit}</Button>}>
        <span>{saved.birthDate ?? t.birthdayNotSet}</span>
      </SettingsRow>
      {editing ? <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5 sm:px-6">
        {pending ? <p className="text-sm">{t.birthdayPrompt}</p> : null}
        <Field><FieldLabel htmlFor="birth-date">{t.birthdayLabel}</FieldLabel>
          <Input id="birth-date" type="date" autoFocus autoComplete="bday" min="1900-01-01"
            max={new Date().toISOString().slice(0, 10)} value={birth} disabled={busy}
            onChange={event => setBirth(event.currentTarget.value)} /></Field>
        <Field><FieldLabel htmlFor="birth-country">{t.birthdayCountry}</FieldLabel>
          <ChoiceSelect id="birth-country" label={t.birthdayCountry} value={country} disabled={busy}
            onValueChange={setCountry} options={[{ value: '', label: t.birthdayCountryUnknown },
              ...regions.map(region => ({ value: region.code, label: region.name }))]} /></Field>
        <p className="text-sm text-muted-foreground">{t.birthdayPrivacy}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => {
            setEditing(false); setPending(undefined); setError('');
          }}>{t.cancel}</Button>
          <Button type="submit" isLoading={busy}>{t.save}</Button>
        </div>
      </form> : null}
      <SettingsRow label={t.birthdayPublic} action={<Switch aria-label={t.birthdayPublic}
        checked={saved.birthdayPublic} disabled={busy || editing || !saved.birthDate}
        onCheckedChange={({ checked }) => void save({ birthdayPublic: checked })} />}>
        <p className="text-sm text-muted-foreground">{t.birthdayPublicHelp}</p>
        {saved.birthdayPublic && saved.publicId ? <a className="text-sm text-primary underline underline-offset-4"
          href={`/birthday/${saved.publicId}`}>{t.birthdayPublicLink}</a> : null}
      </SettingsRow>
      {(Object.keys(labels) as Category[]).map(category => <SettingsRow key={category} label={labels[category]}
        action={<Switch aria-label={labels[category]} checked={saved.categories[category]} disabled={busy || editing}
          onCheckedChange={({ checked }) => toggle(category, checked)} />}>
        <p className="text-sm text-muted-foreground">{descriptions[category]}</p>
      </SettingsRow>)}
      <SettingsRow label={t.nsfwDisplayLabel} action={<Switch aria-label={t.nsfwDisplayLabel}
        checked={saved.nsfwDisplay === 'mask'} disabled={busy || editing}
        onCheckedChange={({ checked }) => void save({ nsfwDisplay: checked ? 'mask' : 'show' })} />}>
        <p className="text-sm text-muted-foreground">{t.nsfwDisplayHelp}</p>
      </SettingsRow>
      {!saved.adultAvailable ? <p className="px-5 pb-4 text-sm text-muted-foreground sm:px-6">{t.contentMarketHelp}</p> : null}
    </>}
    {error ? <Alert role="alert" variant="destructive" className="mx-5 mb-4 sm:mx-6">
      <AlertDescription>{error}</AlertDescription></Alert> : null}
  </SettingsCard>;
}
