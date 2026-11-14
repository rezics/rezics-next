import type { CompositionDocument, ZoneConfiguration } from '@rezics/composition';
import mangaStarter from '../../../../../packages/definitions/presentation/manga/zone.json';
import type { ZonePublic } from '../appearance';

/** Choice: Manga stays a synthetic, gated/deferred preview until Web and Semantic approve an official instance mapping. */
const starter = mangaStarter as unknown as ZoneConfiguration;

export const mangaCandidateIds = {
  preview: '0193c000-0005-7000-8000-000000000000',
  empty: '0193c000-0005-7000-8000-000000000001',
  sparse: '0193c000-0005-7000-8000-000000000002',
  closed: '0193c000-0005-7000-8000-000000000003',
  unavailable: '0193c000-0005-7000-8000-000000000004',
  concealed: '0193c000-0005-7000-8000-000000000005',
} as const;

export const mangaCandidateSubjectIds = {
  clockworkKites: '0193c100-0005-7000-8000-000000000001',
  moonlitPostcards: '0193c100-0005-7000-8000-000000000002',
} as const;

export const mangaCandidateSubjects = [
  { id: mangaCandidateSubjectIds.clockworkKites, label: 'Clockwork Kites' },
  { id: mangaCandidateSubjectIds.moonlitPostcards, label: 'Moonlit Postcards' },
] as const;

const previewCopy =
  'Fictional examples for a gated development preview. No adopted official Manga site or public dynamic release is claimed.';
const volumesCopy = 'This is a static guide route; it does not list individual volumes or read Manga source data.';

function appendIntroCopy(document: CompositionDocument, copy: string): CompositionDocument {
  const [stack, ...remaining] = document.content;
  if (!stack || stack.type !== 'Stack') return document;

  return {
    ...document,
    content: [
      {
        ...stack,
        props: {
          ...stack.props,
          children: stack.props.children.map((child) =>
            child.type === 'Text' && child.props.id === 'intro'
              ? {
                  ...child,
                  props: {
                    ...child.props,
                    text: `${String(child.props.text)} ${copy}`,
                  },
                }
              : child,
          ),
        },
      },
      ...remaining,
    ],
  };
}

export const mangaCandidateConfiguration: ZoneConfiguration = {
  ...starter,
  pages: starter.pages.map((page) => {
    const copy = page.route === '' ? previewCopy : page.route === 'volumes' ? volumesCopy : undefined;
    return copy ? { ...page, document: appendIntroCopy(page.document, copy) } : page;
  }),
};

export function mangaCandidateShell(id: string): ZonePublic {
  return {
    id,
    revision: '1',
    labels: mangaCandidateConfiguration.labels,
    primaryLanguage: 'en',
    visibility: 'public',
    appearance: {},
    navigation: mangaCandidateConfiguration.pages.map(({ route }) => ({
      route,
    })),
  };
}

export function mangaCandidateDocument(route: string): CompositionDocument | undefined {
  return mangaCandidateConfiguration.pages.find((page) => page.route === route)?.document;
}
