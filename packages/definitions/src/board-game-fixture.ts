import type { compileCatalogue } from './compile.ts';

/** Authored acceptance vocabulary, deliberately separate from the launch bundle. */
export const boardGameFixture = {
  type: 'example:BoardGame',
  players: 'example:players',
  duration: 'example:playingMinutes',
  filter: 'board-game/all',
  context: 'board-game',
  citation: 'https://example.org/board-game-fixture/rules',
  title: 'Table Orchard — authored board-game fixture',
} as const;

const words = {
  en: ['Board game', 'Number of players', 'Playing time', 'Board-game community', 'All board games'],
  de: ['Brettspiel', 'Spielerzahl', 'Spieldauer', 'Brettspielgemeinschaft', 'Alle Brettspiele'],
  es: [
    'Juego de mesa',
    'Número de jugadores',
    'Duración de la partida',
    'Comunidad de juegos de mesa',
    'Todos los juegos de mesa',
  ],
  fr: [
    'Jeu de société',
    'Nombre de joueurs',
    'Durée de la partie',
    'Communauté des jeux de société',
    'Tous les jeux de société',
  ],
  ja: ['ボードゲーム', 'プレイ人数', 'プレイ時間', 'ボードゲームコミュニティ', 'すべてのボードゲーム'],
  ko: ['보드게임', '플레이 인원', '플레이 시간', '보드게임 커뮤니티', '모든 보드게임'],
  'zh-Hans': ['桌面游戏', '玩家人数', '游戏时长', '桌面游戏社区', '所有桌面游戏'],
  'zh-Hant': ['桌上遊戲', '玩家人數', '遊戲時間', '桌上遊戲社群', '全部桌上遊戲'],
} as const;

export const boardGameLocales = Object.keys(words) as (keyof typeof words)[];

const descriptions: Record<keyof typeof words, readonly [string, string, string]> = {
  en: [
    'An authored fixture for a tabletop game.',
    'The supported number of players in the cited rules.',
    'The playing time in minutes stated by the cited rules.',
  ],
  de: [
    'Ein verfasstes Beispiel für ein Brettspiel.',
    'Die in den zitierten Regeln angegebene Spielerzahl.',
    'Die in den zitierten Regeln angegebene Spieldauer in Minuten.',
  ],
  es: [
    'Un ejemplo creado de un juego de mesa.',
    'El número de jugadores indicado en las reglas citadas.',
    'La duración en minutos indicada en las reglas citadas.',
  ],
  fr: [
    'Un exemple rédigé de jeu de société.',
    'Le nombre de joueurs indiqué dans les règles citées.',
    'La durée en minutes indiquée dans les règles citées.',
  ],
  ja: [
    '検証用に作成したボードゲームの例。',
    '引用したルールに記載されたプレイ人数。',
    '引用したルールに記載されたプレイ時間（分）。',
  ],
  ko: [
    '검증을 위해 작성한 보드게임 예시.',
    '인용한 규칙에 명시된 플레이 인원.',
    '인용한 규칙에 명시된 플레이 시간(분).',
  ],
  'zh-Hans': ['为验证而编写的桌面游戏示例。', '引用规则中规定的玩家人数。', '引用规则中规定的游戏时长，以分钟计。'],
  'zh-Hant': ['為驗證而編寫的桌上遊戲範例。', '引用規則中規定的玩家人數。', '引用規則中規定的遊戲時間，以分鐘計。'],
};

type Sources = Parameters<typeof compileCatalogue>[0];

/** Register through ordinary compiler imports, presentation groups, filters and Context settings. */
export function boardGameFixtureSources(base: Sources): Sources {
  const labels = (index: number) =>
    Object.fromEntries(boardGameLocales.map((locale) => [locale, words[locale][index]]));
  const schema = {
    id: 'https://example.org/board-game-fixture',
    name: 'board-game',
    version: '1.0.0',
    description: 'Authored board-game acceptance fixture; no external catalogue identity is claimed.',
    prefixes: {
      linkml: 'https://w3id.org/linkml/',
      schema: 'http://schema.org/',
      wd: 'http://www.wikidata.org/entity/',
      example: 'https://example.org/board-game-fixture/',
    },
    imports: ['linkml:types', 'core'],
    default_range: 'string',
    classes: {
      BoardGame: {
        is_a: 'Thing',
        class_uri: boardGameFixture.type,
        description: 'An authored tabletop game fixture.',
        slots: ['players', 'playingMinutes'],
        annotations: {
          facets: 'players playingMinutes',
          cover_ratio: '1:1',
          schema_org_type: 'https://schema.org/Game',
          list_presentation: { imageAspect: 'square', keyFacts: [boardGameFixture.players, boardGameFixture.duration] },
        },
      },
    },
    slots: {
      players: {
        slot_uri: boardGameFixture.players,
        description: 'The supported player count stated in the cited rules.',
        range: 'integer',
        minimum_value: 1,
        annotations: { datatype: 'quantity', units: '1' },
      },
      playingMinutes: {
        slot_uri: boardGameFixture.duration,
        description: 'The playing time stated in the cited rules, in minutes.',
        range: 'integer',
        minimum_value: 1,
        annotations: { datatype: 'quantity', units: 'wd:Q7727' },
      },
    },
  };
  const root = Bun.YAML.parse(base.schemas[base.root]!) as { imports: string[] };
  root.imports.push('board-game');
  return {
    ...base,
    schemas: { ...base.schemas, [base.root]: Bun.YAML.stringify(root), 'board-game.yaml': Bun.YAML.stringify(schema) },
    presentation: {
      ...base.presentation,
      ...Object.fromEntries(
        boardGameLocales.map((locale) => [
          `board-game/${locale}`,
          Bun.YAML.stringify({
            types: { [boardGameFixture.type]: words[locale][0] },
            properties: { [boardGameFixture.players]: words[locale][1], [boardGameFixture.duration]: words[locale][2] },
            typeDescriptions: { [boardGameFixture.type]: descriptions[locale][0] },
            propertyDescriptions: {
              [boardGameFixture.players]: descriptions[locale][1],
              [boardGameFixture.duration]: descriptions[locale][2],
            },
          }),
        ]),
      ),
    },
    contexts: { ...base.contexts, 'board-game': Bun.YAML.stringify({ labels: labels(3), defaults: {} }) },
    filters: {
      ...base.filters,
      'board-game': Bun.YAML.stringify({
        all: { labels: labels(4), filter: { type: { in: [boardGameFixture.type] } } },
      }),
    },
  };
}

/** Ordinary inert TypeList composition; consumers resolve the type from the published catalogue. */
export function boardGameZoneStarter() {
  return {
    labels: Object.fromEntries(boardGameLocales.map((locale) => [locale, words[locale][0]])),
    scope: [boardGameFixture.filter],
    pages: [
      {
        route: '',
        document: {
          root: { props: {} },
          content: [
            {
              type: 'TypeList',
              props: {
                id: 'board-games',
                title: Object.fromEntries(boardGameLocales.map((locale) => [locale, words[locale][4]])),
                types: [boardGameFixture.type],
                sort: 'name',
                limit: 24,
              },
            },
          ],
        },
      },
    ],
  };
}
