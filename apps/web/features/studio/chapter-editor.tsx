'use client';

import { Button } from '@rezics/ui/button';
import { SendIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { type ChapterPublication, type ChapterTarget, type DraftBasis, readChapterRevision, saveChapterDraft }
  from './content-api.ts';
import { manuscriptLength } from './counts.ts';
import { browserStorage, chapterMemoryKey, localDraftKey, readChapterMemory, rememberChapter } from './local-draft.ts';
import { ManuscriptEditor, type ManuscriptStore, type PublishSlot } from './manuscript-editor.tsx';
import type { StudioMessages } from './messages.ts';
import { chapterHref, workHref } from './agent.ts';
import { languageName } from './parts.tsx';
import { ChapterPublishDialog } from './publish-dialog.tsx';
import type { StudioChapter } from './read.ts';
import { studioAgentName } from './studio-frame.tsx';
import type { MainClient } from './types.ts';

export interface ChapterEditorProps {
  agent: AgentOption;
  book: { id: string; title: { value: string; language: string } };
  chapter: StudioChapter;
  locale: UiLocale;
  messages: StudioMessages;
  /** Autosave pause in milliseconds; stories shorten it. */
  delay?: number;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: MainClient;
}

/**
 * One chapter of a Book, written into its Content draft. Saves carry the head
 * they were typed on, so a save from another tab or device is met as a
 * conflict naming the head that won. Publishing sends the exact saved bytes;
 * an update names the publication it replaces.
 */
export function ChapterEditor({ agent, book, chapter: data, locale, messages, delay, main }: ChapterEditorProps) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const target: ChapterTarget = useMemo(() => ({ actingSubject: agent.iri, chapter: data.chapter.id, variant: data.variant,
    language: data.chapter.language, direction: data.chapter.direction }), [agent.iri, data]);
  const memoryKey = chapterMemoryKey(agent.iri, data.variant);
  const storage = useMemo(browserStorage, []);
  // What publishing needs about the saved bytes: from Main on opening, then from every save.
  const basis = useRef<DraftBasis | null>(data.head && data.digest
    ? { head: data.head, digest: data.digest, epoch: data.epoch ?? '' } : null);
  const [current, setCurrent] = useState<ChapterPublication | null>(data.publication
    ? { publication: data.publication, eligibility: data.eligibility } : null);
  const [publishing, setPublishing] = useState<(DraftBasis & { body: string }) | null>(null);

  /** Publishing names the exact saved bytes: the last save's, or the saved head's as Main reads it. */
  const open = async (slot: PublishSlot) => {
    if (!await slot.prepare() || !slot.head) return;
    let known = basis.current?.head === slot.head ? basis.current : null;
    const epoch = known?.epoch || readChapterMemory(storage, memoryKey)?.epoch || data.epoch;
    if (!known?.digest) {
      const read = await readChapterRevision(agent.iri, slot.head, main).catch(() => null);
      known = read ? { head: slot.head, digest: read.digest, epoch: epoch ?? '' } : null;
    }
    if (!known || !epoch) { slot.say(t.publishNeedsSave); return; }
    setPublishing({ ...known, epoch, body: slot.body });
  };

  // Main does not yet let a writer read their variant heads. When the address named none, reopen this device's last save.
  useEffect(() => {
    const known = readChapterMemory(storage, memoryKey);
    if (!current && known?.publication) setCurrent({ publication: known.publication, eligibility: known.eligibility });
    if (basis.current && !basis.current.epoch && known?.epoch) basis.current = { ...basis.current, epoch: known.epoch };
    if (data.basis === 'none' && known?.head) router.replace(chapterHref(agent, book.id, data.chapter.id, known.head));
  }, []);

  const [store] = useState((): ManuscriptStore => ({
    deviceKey: () => localDraftKey(agent.iri, data.chapter.id, data.variant),
    channel: () => data.variant,
    href: head => chapterHref(agent, book.id, data.chapter.id, head),
    save: (body, head, key) => saveChapterDraft(target, body, head, key, saved => {
      basis.current = saved;
      rememberChapter(storage, memoryKey, { head: saved.head, digest: saved.digest, epoch: saved.epoch,
        length: manuscriptLength(body, data.chapter.language).value, savedAt: new Date().toISOString() });
    }, main),
    theirs: async head => {
      if (!head) return null;
      const read = await readChapterRevision(agent.iri, head, main);
      return read ? { head, body: read.body } : null;
    },
  }));

  return <ManuscriptEditor store={store} language={data.chapter.language} direction={data.chapter.direction}
    back={{ href: workHref(agent, book.id, 'chapters'), label: t.backToChapters, title: book.title }}
    context={[book.title.value, languageName(data.chapter.language, locale), `${t.writingAs} ${studioAgentName(agent, t)}`]
      .join(' · ')}
    title={data.chapter.title} initial={{ head: data.head, body: data.body }} label={t.chapterLabel} locale={locale}
    messages={messages} delay={delay}
    publish={slot => <>
      <Button type="button" size="sm" disabled={!slot.ready} onClick={() => void open(slot)}>
        <SendIcon aria-hidden="true" />{current ? t.publishUpdate : t.publish}</Button>
      {publishing ? <ChapterPublishDialog open onOpenChange={next => { if (!next) setPublishing(null); }} agent={agent}
        book={book.title} title={data.chapter.title} target={target} basis={publishing} current={current} locale={locale}
        messages={messages} main={main} onPublished={(publication, published) => {
          setCurrent(publication);
          rememberChapter(storage, memoryKey, { publication: publication.publication,
            eligibility: publication.eligibility, publishedHead: published.head });
        }} /> : null}
    </>} />;
}
