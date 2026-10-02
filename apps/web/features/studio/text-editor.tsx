'use client';

import { Button } from '@rezics/ui/button';
import { SendIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { localDraftKey, browserStorage, clearLocalDraft, readLocalDraft, writeLocalDraft } from './local-draft.ts';
import { ManuscriptEditor, type ManuscriptStore } from './manuscript-editor.tsx';
import type { StudioMessages } from './messages.ts';
import { textHref, workHref } from './agent.ts';
import { languageName } from './parts.tsx';
import { PublishDialog } from './publish-dialog.tsx';
import { studioAgentName } from './studio-frame.tsx';
import { readLatest, readTextRevision, saveText } from './text-api.ts';
import { directionOf, type MainClient, type MyText } from './types.ts';

export interface TextEditorProps {
  agent: AgentOption;
  work: { id: string; title: { value: string; language: string }; mainVersion: string; book: boolean };
  language: string;
  /** The text (contribution) being edited, or null for a new text in `language`. */
  text: string | null;
  /** Main's text at `head`: its current draft head when known, else the revision the address pinned. */
  initial: { head: string | null; body: string; publication: MyText['publication'] | null; publicationHead: string | null };
  locale: UiLocale;
  messages: StudioMessages;
  /** Autosave pause in milliseconds; stories shorten it. */
  delay?: number;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: MainClient;
}

/** A text that moves to its own identity after its first save; the store follows it. */
function textStore(agent: AgentOption, work: TextEditorProps['work'], language: string, initial: string | null,
  main: MainClient | undefined): ManuscriptStore & { text(): string | null } {
  const storage = browserStorage();
  let text = initial;
  let deviceKey = localDraftKey(agent.iri, work.id, initial ?? `new:${language}`);
  return {
    text: () => text,
    deviceKey: () => deviceKey,
    channel: () => text,
    href: head => text ? textHref(agent, work.id, text, head) : null,
    save: (body, head, key) => saveText({ actingSubject: agent.iri, work: work.id, language }, text, body, head, key,
      created => {
        text = created;
        // The device copy follows the text to its own key.
        const copy = readLocalDraft(storage, deviceKey);
        clearLocalDraft(storage, deviceKey);
        deviceKey = localDraftKey(agent.iri, work.id, created);
        if (copy) writeLocalDraft(storage, deviceKey, copy);
      }, main),
    theirs: async head => {
      if (!text) return null;
      if (head) {
        const body = await readTextRevision(agent.iri, text, head, main);
        return body === null ? null : { head, body };
      }
      return readLatest(agent.iri, text, main);
    },
  };
}

/** A Work's own text in one language: written like a chapter, published as the text readers open for the Work. */
export function TextEditor({ agent, work, language, text, initial, locale, messages, delay, main }: TextEditorProps) {
  const t = materializeData(messages, { locale });
  const [store] = useState(() => textStore(agent, work, language, text, main));
  const [publishing, setPublishing] = useState(false);
  const [publicationHead, setPublicationHead] = useState(initial.publicationHead);
  return <ManuscriptEditor store={store} language={language} direction={directionOf(language)}
    actingSubject={agent.iri} mediaTarget={work.id}
    back={{ href: workHref(agent, work.id, 'text'), label: t.backToWork, title: work.title }}
    context={[languageName(language, locale), `${t.writingAs} ${studioAgentName(agent, t)}`].join(' · ')}
    title={work.title} initial={initial} label={t.textLabel} locale={locale} messages={messages} delay={delay}
    publish={slot => <>
      <Button type="button" size="sm" disabled={!slot.ready}
        onClick={() => void slot.prepare().then(saved => { if (saved) setPublishing(true); })}>
        <SendIcon aria-hidden="true" />{publicationHead ? t.publishUpdate : t.publish}</Button>
      {store.text() && slot.head ? <PublishDialog open={publishing} onOpenChange={setPublishing} locale={locale}
        messages={messages} main={main} onPublished={result => setPublicationHead(result.publicationDecision)}
        target={{ agent, work: work.id, title: work.title, mainVersion: work.mainVersion, language, text: store.text()!,
          head: slot.head, body: slot.body, publicationHead, book: work.book }} /> : null}
    </>} />;
}
