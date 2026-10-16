'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { textAttributes, UNSPECIFIED } from '../content-language/writing-language.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { communityText } from './messages.ts';
import { realmSiteCreationClient, type RealmSiteCreationClient, type RealmSiteCreationIntent,
  type RealmSiteCreationReceipt, type RealmSiteDestination } from './realm-site-creation-api.ts';
import { realmSiteCreationMessages } from './realm-site-creation-messages.ts';

interface Attempt {
  body: RealmSiteCreationIntent;
  createKey: string;
  prepareKey: string;
  receipt?: RealmSiteCreationReceipt;
  prepared: boolean;
}

/** Embedded in the creation entry; the existing management route owns attachment and publication. */
interface RealmSiteCreationProps {
  actingSubject: string; locale: UiLocale; client?: RealmSiteCreationClient;
}

export function RealmSiteCreation(props: RealmSiteCreationProps) {
  return <RealmSiteCreationForm key={props.actingSubject} {...props} />;
}

function RealmSiteCreationForm({ actingSubject, locale, client }: RealmSiteCreationProps) {
  const copy = realmSiteCreationMessages[locale];
  const id = useId();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [locked, setLocked] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [destination, setDestination] = useState<RealmSiteDestination | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const api = useRef<RealmSiteCreationClient | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || destination || !language || !name.trim()) return;
    busyRef.current = true;
    setBusy(true); setLocked(true); setFailure(null);
    api.current ??= client ?? realmSiteCreationClient();
    attempt.current ??= { body: { profile: 'space-zone-v1', name: name.trim(), language,
      capabilities: ['zone'], actingSubject }, createKey: crypto.randomUUID(), prepareKey: crypto.randomUUID(), prepared: false };
    const chosen = attempt.current;
    try {
      if (!chosen.receipt) {
        const created = await api.current.create(chosen.body, chosen.createKey);
        if (!created.ok) {
          setFailure(created.title ?? copy.failed);
          // A refusal after an uncertain response cannot prove that no Space was created.
          // Keep this intent and both command keys until its receipt is recovered.
          return;
        }
        chosen.receipt = created.data;
      }
      if (!chosen.prepared) {
        const prepared = await api.current.prepare(chosen.receipt, chosen.body.actingSubject, chosen.prepareKey);
        if (!prepared.ok) { setFailure(prepared.title ?? copy.failed); return; }
        chosen.prepared = true;
      }
      const address = await api.current.destination(chosen.receipt, chosen.body.actingSubject, locale);
      if (!address.ok) { setFailure(address.title ?? copy.failed); return; }
      setDestination(address.data);
    } finally { busyRef.current = false; setBusy(false); }
  }

  return <section className="grid min-w-0 max-w-2xl gap-4" aria-labelledby={`${id}-title`}>
    <div className="grid gap-2">
      <h2 id={`${id}-title`} className="text-xl font-semibold">{copy.title}</h2>
      <p className="text-pretty text-sm text-muted-foreground">{copy.help}</p>
    </div>
    {destination ? <div className="grid justify-items-start gap-3">
      <p role="status">{copy.created}</p>
      <p {...textAttributes(language ?? UNSPECIFIED, name)}>{name}</p>
      <LocalizedLink href={destination.attachmentPath} className={buttonVariants()}>{copy.attach}</LocalizedLink>
    </div> : <form onSubmit={event => void submit(event)} className="grid justify-items-start gap-4">
      <div className="grid w-full gap-1.5 text-sm font-medium">
        <label htmlFor={`${id}-name`}>{copy.name}</label>
        <Input id={`${id}-name`} required maxLength={120} value={name} disabled={locked}
          {...textAttributes(language ?? UNSPECIFIED, name)} onChange={event => setName(event.currentTarget.value)} />
      </div>
      <LanguageSelect value={language} onChange={setLanguage} locale={locale} disabled={locked}
        label={communityText.nameLanguage[locale]} />
      {failure ? <p role="alert" className="text-pretty text-sm">{failure}</p> : null}
      <Button type="submit" disabled={busy || !language || !name.trim()}>{busy ? copy.creating : copy.create}</Button>
    </form>}
  </section>;
}
