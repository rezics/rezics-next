import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readRealmChoices, readStudioText, readWorkHeader } from '../../../../../../../../features/studio/read.ts';
import { studioAgent } from '../../../../../../../../features/studio/route.ts';
import { TextEditor } from '../../../../../../../../features/studio/text-editor.tsx';
import { iri } from '../../../../../../../../features/studio/types.ts';
import { WriteUnavailable } from '../../../../../../../../features/studio/write-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../../../i18n/server.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.textLabel, robots: { index: false } };
}

/**
 * One text to keep writing: Main's current draft when it can say which that is,
 * otherwise the exact revision the address pins (Studio keeps it current after every save).
 */
export default async function TextPage({ params, searchParams }: {
  params: Promise<{ agent: string; work: string; text: string }>; searchParams: Promise<{ revision?: string }>;
}) {
  const [{ agent: segment, work, text }, query] = await Promise.all([params, searchParams]);
  if (!uuid.test(work) || !uuid.test(text)) notFound();
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  const revision = typeof query.revision === 'string' && uuid.test(query.revision) ? query.revision : null;
  const [header, opened, realms, messages] = await Promise.all([readWorkHeader(agent.iri, work, locale),
    readStudioText(agent.iri, text, revision), readRealmChoices(locale), getMessages('studio', locale)]);
  if (!header.ok) return <WriteUnavailable agent={agent} failure={header.failure} locale={locale} messages={messages} />;
  if (!opened.draft.ok) {
    return <WriteUnavailable agent={agent} failure={opened.draft.failure} position={!opened.head && !revision}
      work={header.data.id} locale={locale} messages={messages} />;
  }
  const draft = opened.draft.data;
  if (draft.work !== iri(work)) notFound();
  const { data } = header;
  return <TextEditor agent={agent} work={{ id: data.id, title: data.title, mainVersion: data.mainVersion }}
    language={draft.language} text={draft.contribution}
    initial={{ head: opened.head ?? draft.revision, body: draft.body, publication: opened.publication }}
    realms={realms} locale={locale} messages={messages} />;
}
