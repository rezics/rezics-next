import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { copyOf } from './messages.ts';
import { ConnectionsPreviewView, EditionsPreviewView, PartsPreviewView, PREVIEW_COUNTS } from './previews.tsx';
import { namesOf, readParts, readRealizations, readReleases, readRelations, readWholes } from './read.ts';

// The previews a Work hub page and a franchise Zone embed. Each reads Main for
// the Work it is given and renders a few items with a link into the full page;
// an embedder that already holds the answers uses the `…View` components.

interface Embedded { id: string; workRef: string; locale: UiLocale; pageMessages: WorkPageMessages }

export async function PartsPreview({ id, workRef, locale, pageMessages }: Embedded) {
  const t = copyOf(locale);
  const [parts, wholes] = await Promise.all([readParts(id, { limit: PREVIEW_COUNTS.parts + 1 }),
    readWholes(id, { limit: PREVIEW_COUNTS.wholes })]);
  const names = await namesOf([...(parts.ok ? parts.data.parts.flatMap(part => part.work ?? []) : []),
    ...(wholes.ok ? wholes.data.wholes.map(whole => whole.work) : [])]);
  return <PartsPreviewView parts={parts} wholes={wholes} names={names} workRef={workRef} pageMessages={pageMessages} t={t} />;
}

export async function ConnectionsPreview({ id, workRef, locale, pageMessages }: Embedded) {
  const t = copyOf(locale);
  const relations = await readRelations(id, { limit: 20 });
  return <ConnectionsPreviewView relations={relations} workRef={workRef} locale={locale}
    pageMessages={pageMessages} t={t} />;
}

export async function EditionsPreview({ id, workRef, locale, pageMessages }: Embedded) {
  const t = copyOf(locale);
  const [realizations, releases] = await Promise.all([readRealizations(id), readReleases(id)]);
  return <EditionsPreviewView realizations={realizations} releases={releases} workRef={workRef} locale={locale}
    pageMessages={pageMessages} t={t} />;
}
