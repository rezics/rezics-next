import type { WorkAt } from '../work-page/route.ts';
import { readAnimeRelationsPreview } from '../work-page/anime-relations-recorded-page.ts';
import type { SuppliedClient } from '../work-page/read.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { copyOf } from './messages.ts';
import {
  ConnectionsPreviewView,
  EditionsPreviewView,
  PartsPreviewView,
} from './previews.tsx';
import {
  namesOf,
  readParts,
  readPeople,
  readRealizations,
  readReleases,
  readRelations,
  readWholes,
} from './read.ts';

// The previews a Work hub page and a franchise Zone embed. Each reads Main for
// the Work it is given and renders a few items with a link into the full page;
// an embedder that already holds the answers uses the `…View` components.

interface Embedded {
  id: string;
  client?: SuppliedClient;
  workRef: WorkAt;
  locale: UiLocale;
  pageMessages: WorkPageMessages;
}

export async function PartsPreview({ id, workRef, locale, pageMessages, client }: Embedded) {
  const t = copyOf(locale);
  const { parts, wholes, names } = await readAnimeRelationsPreview({
    readParts: (key, query) => readParts(key, query, client),
    readWholes: (key, query) => readWholes(key, query, client),
    namesOf: (resources, position) => namesOf(resources, position, client),
  }, id);
  return (
    <PartsPreviewView
      parts={parts}
      wholes={wholes}
      names={names}
      workRef={workRef}
      pageMessages={pageMessages}
      t={t}
    />
  );
}

export async function ConnectionsPreview({ id, workRef, locale, pageMessages, client }: Embedded) {
  const t = copyOf(locale);
  const relations = await readRelations(id, { limit: 20 }, client);
  const people = relations.ok ? await readPeople(relations.data.items, client) : undefined;
  return (
    <ConnectionsPreviewView
      relations={relations}
      people={people}
      workRef={workRef}
      locale={locale}
      pageMessages={pageMessages}
      t={t}
    />
  );
}

export async function EditionsPreview({ id, workRef, locale, pageMessages }: Embedded) {
  const t = copyOf(locale);
  const [realizations, releases] = await Promise.all([readRealizations(id), readReleases(id)]);
  return (
    <EditionsPreviewView
      realizations={realizations}
      releases={releases}
      workRef={workRef}
      locale={locale}
      pageMessages={pageMessages}
      t={t}
    />
  );
}
