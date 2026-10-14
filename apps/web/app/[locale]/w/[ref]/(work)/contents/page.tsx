import type { Metadata } from 'next';
import { workPageMetadata, workTitle } from '../../../../../../features/seo/work.ts';
import {
  BooksContentsRecordedPage, contentsReadsInventory, readContentsInventory, ContentsLabelSearch,
} from '../../../../../../features/work-page/books-contents-recorded-page.tsx';
import { loadWork, readContents, reader, resolveWork } from '../../../../../../features/work-page/read.ts';
import { iriOf, parseContentsQuery, workHref } from '../../../../../../features/work-page/route.ts';
import { WorkContents } from '../../../../../../features/work-page/work-views.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, { t }] = await Promise.all([resolveWork(ref, locale), getTranslation('workPage', [locale])]);
  return { title: await workTitle(work, t.contents),
    ...await workPageMetadata(work, { tab: 'contents' }, query, locale) };
}

export default async function WorkContentsPage({ params, searchParams }: Props) {
  const [{ ref }, search, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  const query = parseContentsQuery(search);
  // loadWork already read this header through readWorkHeader, which is cached for the request.
  // The contents operation does not accept a label, so `q` stays off this read.
  const contents = query ? await readContents(work.id, query) : { ok: false as const, failure: 'invalid' as const };
  // Contents did not answer. The chapter inventory is paged at the proved size, and each cursor stays opaque.
  if (query && contentsReadsInventory(contents, query)) {
    const host = await reader();
    const language = query.language ?? work.header.selectedLanguage ?? undefined;
    const view = await readContentsInventory(host, {
      workId: work.id, workRef: ref, workIri: iriOf(work.id), locale, language,
      q: query.q, limit: query.limit, cursor: query.cursor, title: work.header.title,
    });
    return <BooksContentsRecordedPage locale={locale} messages={messages} view={view} />;
  }
  // Group selection on a capped contents page stays in WorkContents. This route reads once
  // only to choose the chapter inventory when that contents answer cannot stand for the work.
  return <>
    {query && !query.parent ? <ContentsLabelSearch action={workHref(ref, 'contents')} language={query.language}
      q={query.q} limit={query.limit} locale={locale} messages={messages} /> : null}
    <WorkContents workRef={ref} id={work.id} work={work.header} query={query} locale={locale} messages={messages} /></>;
}
