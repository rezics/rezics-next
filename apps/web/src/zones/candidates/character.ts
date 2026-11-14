import type { SubjectRead } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import type { ZonePageResponse, ZonePublic } from '../appearance';
import definitions from '../../kernel/recorded/definitions-release.json';

const release = definitions.release as Release;
const characterType = 'wd:Q95074';
const characterContext = '00000000-0000-8000-8000-000000000000';
const fixtureTime = '2026-11-14T00:00:00.000Z';

export const characterCandidateZoneIds = {
  preview: '0193c000-0003-7000-8000-000000000000',
  readyEmpty: '0193c000-0003-7000-8000-000000000001',
  sparse: '0193c000-0003-7000-8000-000000000002',
  platformClosed: '0193c000-0003-7000-8000-000000000003',
  semanticNotReady: '0193c000-0003-7000-8000-000000000004',
  private: '0193c000-0003-7000-8000-000000000005',
  missing: '0193c000-0003-7000-8000-000000000006',
} as const;

export const characterCandidateLabels = {
  en: 'Characters',
  'zh-Hant': '角色',
  'zh-Hans': '角色',
  ja: 'キャラクター',
  ko: '캐릭터',
  de: 'Charaktere',
  fr: 'Personnages',
  es: 'Personajes',
};

const starterListTitle = {
  en: 'All characters',
  'zh-Hant': '全部角色',
  'zh-Hans': '所有角色',
  ja: 'すべてのキャラクター',
  ko: '모든 캐릭터',
  de: 'Alle Charaktere',
  fr: 'Tous les personnages',
  es: 'Todos los personajes',
};

export const characterCandidateCharacters = [
  {
    id: '0193c100-0003-7000-8000-000000000001',
    label: 'Aster Vale',
    story: 'Aster Vale draws maps to places that did not exist before she imagined them.',
  },
  {
    id: '0193c100-0003-7000-8000-000000000002',
    label: 'Juniper Quill',
    story: 'Juniper Quill keeps a sleepy clockwork moth company above her desk.',
  },
  {
    id: '0193c100-0003-7000-8000-000000000003',
    label: 'Rowan Finch',
    story: 'Rowan Finch plants paper stars in the garden after the evening rain.',
  },
] as const;

export type CharacterCandidateCharacter = (typeof characterCandidateCharacters)[number];
export type CharacterCandidateHome = 'preview' | 'ready-empty' | 'sparse';

export const characterCandidateCopy = {
  preview:
    'Gated and deferred development preview: these fictional names and stories are authored for this Storybook example. No official roster or live public release is claimed.',
  readyEmpty:
    'Gated and deferred development preview: this admitted example has no character results. It makes no claim about a live public catalogue.',
  sparse:
    'This gated and deferred sparse development preview has no supplied character facts or roster. Optional values are absent and empty Slots stay empty.',
} as const;

export const characterCandidateProfile = 'fictional-character-candidate-development-preview';

const slotNames = ['hero', 'entity', 'aside', 'footer'] as const;

function emptySlot(name: (typeof slotNames)[number]) {
  return { type: 'Slot', props: { id: name, name, children: [] } };
}

function homeDocument(state: CharacterCandidateHome): CompositionDocument {
  const children: unknown[] = [
    { type: 'Heading', props: { id: 'title', text: 'Characters', level: 2 } },
    { type: 'Text', props: { id: 'intro', text: 'A starting page for fictional characters.' } },
    { type: 'Text', props: { id: 'preview-note', text: characterCandidateCopy[state] } },
  ];

  if (state !== 'sparse') {
    children.push({
      type: 'TypeList',
      props: {
        id: 'works',
        title: starterListTitle,
        types: ['wd:Q95074'],
        sort: 'name',
        limit: 24,
      },
    });
  }
  children.push(...slotNames.map(emptySlot));

  return {
    root: { props: {} },
    content: [{ type: 'Stack', props: { id: 'page', gap: 'md', children } }],
  } as CompositionDocument;
}

export function characterCandidateSubjectDocument(character: CharacterCandidateCharacter): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'Stack',
        props: {
          id: 'page',
          gap: 'md',
          children: [
            { type: 'Heading', props: { id: 'title', text: character.label, level: 2 } },
            { type: 'Text', props: { id: 'story', text: character.story } },
            {
              type: 'Text',
              props: {
                id: 'preview-note',
                text: 'Fictional sample text for this gated, deferred development preview; no source roster or optional facts are implied.',
              },
            },
            { type: 'Sources', props: { id: 'sources' } },
          ],
        },
      },
    ],
  } as CompositionDocument;
}

function publicZone(id: string): ZonePublic {
  return {
    id,
    revision: '1',
    labels: characterCandidateLabels,
    primaryLanguage: 'en',
    visibility: 'public',
    appearance: {},
    navigation: [{ route: '' }],
  };
}

function characterCandidateSummary(character: CharacterCandidateCharacter): NonNullable<SubjectRead['summary']> {
  const types = [characterType, ...(release.types[characterType]?.bases ?? [])];
  return {
    id: character.id,
    type: characterType,
    types,
    creativeWork: types.includes('schema:CreativeWork'),
    label: { value: character.label, language: 'en' },
    cover: null,
  };
}

export function characterCandidateSubjectRead(character: CharacterCandidateCharacter): SubjectRead {
  const subject: SubjectRead['subject'] = {
    id: character.id,
    type: characterType,
    revision: 1,
    release: definitions.digest,
    context: characterContext,
    resolution: {},
    relationCounts: {},
    labels: { en: character.label },
    descriptions: {},
    aliases: {},
    statements: {},
    sourceRecords: [],
  };
  return {
    subject,
    summary: characterCandidateSummary(character),
    related: {},
    account: null,
  };
}

function listRows(state: CharacterCandidateHome) {
  if (state !== 'preview') return [];
  return characterCandidateCharacters.map((character) => ({
    id: character.id,
    type: characterType,
    labels: { en: character.label },
    summary: characterCandidateSummary(character),
  }));
}

function pageReads(document: CompositionDocument, subject: string | null, state: CharacterCandidateHome) {
  const planned = planReads(platformRegistry, document, { subject }).reads;
  const reads: Record<string, { status: number; body: unknown }> = {};
  for (const [key, read] of Object.entries(planned)) {
    if (read.kind === 'search') {
      reads[key] = { status: 200, body: { subjects: listRows(state), next: null, as_of: fixtureTime } };
    } else if (read.kind === 'subject' && subject) {
      const character = characterCandidateCharacters.find(({ id }) => id === subject);
      if (character) reads[key] = { status: 200, body: characterCandidateSubjectRead(character) };
    }
  }
  return reads;
}

/** A public-shaped Zone page fixture for the real reader; it carries no owner or mount metadata. */
export function characterCandidatePage(
  zoneId: string,
  state: CharacterCandidateHome,
  subjectId?: string,
): ZonePageResponse {
  const character = characterCandidateCharacters.find(({ id }) => id === subjectId);
  const document = character ? characterCandidateSubjectDocument(character) : homeDocument(state);
  return {
    profile: characterCandidateProfile,
    template: character ? { scope: 'generic', key: null } : { scope: 'route', key: '' },
    document,
    reads: pageReads(document, character?.id ?? null, state),
    zone: publicZone(zoneId),
    ...(character ? { subject: character.id } : {}),
  };
}
