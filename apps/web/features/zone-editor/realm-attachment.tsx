'use client';

import { Button } from '@rezics/ui/button';
import { useState, type FormEvent } from 'react';
import { browserMainApi } from '../api/browser.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ZoneEditorMessages } from './messages.ts';

const handlePattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,28})[A-Za-z0-9]$/;
const fieldClass = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The Zone author attaches one Realm by the handle of its Space, or removes it. */
export function RealmAttachmentEditor({ zoneId, actingSubject, copy, zoneHead, attachedName, signInHref, startingNotice = null }: {
  zoneId: string;
  actingSubject: string;
  copy: ZoneEditorMessages;
  zoneHead: string;
  attachedName: string | null;
  signInHref: string;
  /** Storybook shows a refusal before an attach request. The page leaves this unset. */
  startingNotice?: null | 'limit';
}) {
  const [head, setHead] = useState(zoneHead);
  const [attached, setAttached] = useState<string | null>(attachedName);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<null | 'attach' | 'remove'>(null);
  const [notice, setNotice] = useState<null | 'saved' | 'removed' | 'unavailable' | 'limit' | 'sign-in' | 'failed'>(startingNotice);

  async function currentHead(fallback: string): Promise<string | null> {
    const read = await browserMainApi().v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject } });
    const revision = read.data && typeof read.data === 'object' && 'revision' in read.data ? read.data.revision : null;
    return typeof revision === 'string' ? revision : read.error ? null : fallback;
  }

  async function write(next: string | null, key: string, started: string) {
    const body = { expectedHead: started, actingSubject, defaultRealm: next };
    const send = (expectedHead: string, idempotency: string) => browserMainApi().v1.zones({ id: zoneId }).configuration.put(
      { ...body, expectedHead }, { headers: { 'idempotency-key': idempotency } });
    let answer = await send(started, key);
    if (answer.error?.status === 409) {
      const moved = await currentHead(started);
      if (!moved) return answer;
      setHead(moved);
      answer = await send(moved, crypto.randomUUID());
    }
    const revision = answer.data && typeof answer.data === 'object' && 'revision' in answer.data
      ? answer.data.revision : null;
    if (typeof revision === 'string') setHead(revision);
    return answer;
  }

  async function attach(event: FormEvent) {
    event.preventDefault();
    const typed = handle.trim().replace(/^@/, '');
    if (!handlePattern.test(typed)) {
      setNotice('unavailable');
      return;
    }
    setBusy('attach');
    setNotice(null);
    try {
      const resolved = await browserMainApi().v1.addresses.resolve.get({
        query: { scope: 'space', key: typed, actingSubject } });
      const realm = resolved.data && typeof resolved.data === 'object' && 'capabilities' in resolved.data
        ? resolved.data.capabilities?.realm : null;
      const resolveStatus: number | undefined = resolved.error?.status;
      if (resolved.error || resolved.data?.status !== 'resolved' || typeof realm !== 'string') {
        setNotice(resolveStatus === 401 ? 'sign-in' : 'unavailable');
        return;
      }
      const answer = await write(realm, crypto.randomUUID(), head);
      if (answer.error) {
        const status: number | undefined = answer.error.status;
        const code = typeof answer.error.value === 'object' && answer.error.value !== null
          && 'code' in answer.error.value && typeof answer.error.value.code === 'string'
          ? answer.error.value.code : undefined;
        setNotice(code === 'realm_attachment_limit' ? 'limit' : status === 401 ? 'sign-in' : status === 400 ? 'unavailable' : 'failed');
        return;
      }
      const named = await browserMainApi().v1.realms({ realm: realm.slice(-36) }).get({ query: { actingSubject } });
      const value = named.data && typeof named.data === 'object' && 'name' in named.data
        && named.data.name && typeof named.data.name === 'object' && 'value' in named.data.name
        ? named.data.name.value : null;
      setAttached(typeof value === 'string' && value.trim() ? value : typed);
      setHandle('');
      setNotice('saved');
    } catch {
      setNotice('failed');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setNotice(null);
    try {
      const answer = await write(null, crypto.randomUUID(), head);
      if (answer.error) {
        const status: number | undefined = answer.error.status;
        setNotice(status === 401 ? 'sign-in' : 'failed');
        return;
      }
      setAttached(null);
      setNotice('removed');
    } catch {
      setNotice('failed');
    } finally {
      setBusy(null);
    }
  }

  return <section className="grid min-w-0 max-w-xl gap-3" aria-labelledby="zone-realm-title">
    <div className="min-w-0 space-y-2">
      <h2 id="zone-realm-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.realmTitle}</h2>
      <p className="text-pretty text-muted-foreground text-sm">{copy.realmHelp}</p>
    </div>
    {notice === 'saved' ? <p className="text-sm" role="status">{copy.realmSaved}</p> : null}
    {notice === 'removed' ? <p className="text-sm" role="status">{copy.realmRemoved}</p> : null}
    {notice === 'unavailable' ? <p className="text-pretty text-destructive text-sm" role="alert">{copy.realmUnavailable}</p> : null}
    {notice === 'limit' ? <p className="text-pretty text-destructive text-sm" role="alert">{copy.realmAttachmentLimit}</p> : null}
    {notice === 'failed' ? <p className="text-pretty text-sm" role="alert">{copy.unavailableBody}</p> : null}
    {notice === 'sign-in' ? <p className="text-sm" role="alert"><LocalizedLink href={signInHref} className="underline-offset-4 hover:underline">{copy.signInTitle}</LocalizedLink></p> : null}
    {attached ? <div className="grid min-w-0 gap-2 rounded-xl border border-border/60 p-3">
      <p className="truncate font-medium">{attached}</p>
      <p className="text-pretty text-muted-foreground text-sm">{copy.realmAttached}</p>
      <Button variant="outline" size="sm" className="justify-self-start" disabled={busy !== null}
        isLoading={busy === 'remove'} onClick={() => void remove()}>{busy === 'remove' ? copy.realmRemoving : copy.realmRemove}</Button>
    </div> : <p className="text-pretty text-muted-foreground text-sm">{copy.realmNone}</p>}
    {attached ? null : <form className="grid min-w-0 gap-2" onSubmit={event => void attach(event)}>
      <label className="grid gap-1 text-sm">
        <span className="text-muted-foreground">{copy.realmHandle}</span>
        <input className={fieldClass} name="realm-handle" aria-label={copy.realmHandle} value={handle}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={30}
          onChange={event => setHandle(event.target.value)} />
      </label>
      <Button type="submit" variant="secondary" size="sm" className="justify-self-start" disabled={busy !== null || !handle.trim()}
        isLoading={busy === 'attach'}>{busy === 'attach' ? copy.realmAttaching : copy.realmAttach}</Button>
    </form>}
  </section>;
}
