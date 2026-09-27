import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { readRealmChoices, readStudioWork } from '../../../../../../../features/studio/read.ts';
import { studioAgent } from '../../../../../../../features/studio/route.ts';
import { textHref } from '../../../../../../../features/studio/studio-home.tsx';
import { TextEditor } from '../../../../../../../features/studio/text-editor.tsx';
import { WriteUnavailable } from '../../../../../../../features/studio/write-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../../i18n/server.ts';
import { localizedPath } from '../../../../../../../i18n/locale.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.writeFirst, robots: { index: false } };
}

/** A new text for a Work in one language. The first save creates it; an existing one opens instead. */
export default async function NewTextPage({ params, searchParams }: {
  params: Promise<{ agent: string; work: string }>; searchParams: Promise<{ language?: string }>;
}) {
  const [{ agent: segment, work }, query] = await Promise.all([params, searchParams]);
  if (!uuid.test(work)) notFound();
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  const language = typeof query.language === 'string' && tag.test(query.language) ? query.language : locale;
  const [loaded, realms, messages] = await Promise.all([readStudioWork(agent.iri, work, locale),
    readRealmChoices(locale), getMessages('studio', locale)]);
  if (!loaded.ok) return <WriteUnavailable agent={agent} failure={loaded.failure} locale={locale} messages={messages} />;
  const existing = loaded.data.texts.ok
    ? loaded.data.texts.data.find(text => text.language.toLowerCase() === language.toLowerCase()) : undefined;
  if (existing) redirect(localizedPath(textHref(agent, loaded.data.header.id, existing.id, existing.revision), locale));
  const { header } = loaded.data;
  return <TextEditor agent={agent} work={{ id: header.id, title: header.title, mainVersion: header.mainVersion }}
    language={language} text={null} initial={{ head: null, body: '', publication: null }} realms={realms}
    locale={locale} messages={messages} />;
}
