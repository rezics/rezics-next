import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const labels = {
  'rezics:AnimeRelease': ['动画发行版', '動畫發行版', 'アニメ刊行版'],
  'wd:Q2095': ['食物', '食物', '食品'],
  'wd:Q2620972': ['故事篇章', '故事篇章', 'ストーリー編'],
  'schema:Episode': ['集', '集', 'エピソード'],
  'schema:Movie': ['电影', '電影', '映画'],
  'schema:TVSeason': ['季', '季', 'シーズン'],
  'schema:TVSeries': ['TV 动画', 'TV 動畫', 'TVアニメ'],
  'bf:Instance': ['版本', '版本', '版'],
  'schema:Book': ['书籍', '書籍', '書籍'],
  'wd:Q95074': ['角色', '角色', 'キャラクター'],
  'skos:Concept': ['概念', '概念', '概念'],
  'skos:ConceptScheme': ['概念体系', '概念體系', '概念体系'],
  'schema:Organization': ['组织', '組織', '組織'],
  'schema:Person': ['人物', '人物', '人物'],
  'schema:SoftwareApplication': ['软件应用程序', '軟體應用程式', 'ソフトウェアアプリケーション'],
  'schema:VideoGame': ['电子游戏', '電子遊戲', 'コンピュータゲーム'],
  'wd:Q209163': ['追加内容', '追加內容', '追加コンテンツ'],
  'wd:Q20631656': ['版本', '版本', 'リリース'],
  'schema:PublicationVolume': ['卷', '卷', '巻'],
  'schema:ComicSeries': ['漫画', '漫畫', '漫画'],
  'schema:Recipe': ['食谱', '食譜', 'レシピ'],
  'schema:BookSeries': ['丛书', '叢書', '叢書'],
  'wd:Q7725310': ['系列', '系列', 'シリーズ'],
  'wd:Q689445': ['视觉小说', '視覺小說', 'ビジュアルノベル'],
  'schema:MusicAlbum': ['音乐专辑', '音樂專輯', 'アルバム'],
};

const glosses = {
  'schema:TVSeries': {
    'zh-Hans': '电视系列节目',
    'zh-Hant': '電視系列節目',
    ja: 'テレビ番組シリーズ',
  },
  'schema:TVSeason': {
    'zh-Hans': '编播季',
    'zh-Hant': '編播季',
    en: 'television series season',
    es: 'temporada televisiva',
    fr: 'saison de série télévisée',
  },
  'schema:Book': {
    'zh-Hans': '书面作品',
    de: 'Schrifttum',
    es: 'obra escrita',
    fr: 'œuvre écrite',
    ko: '저작물',
  },
  'bf:Instance': {
    'zh-Hans': '作品版本或翻译',
    de: 'Ausgabe oder Version',
    es: 'edición, traducción o versión',
    fr: 'version, édition ou traduction',
  },
  'schema:Person': {
    'zh-Hans': '人类',
    de: 'Mensch',
    es: 'ser humano',
    fr: 'être humain',
  },
  'wd:Q95074': {
    'zh-Hans': '虚构角色',
    'zh-Hant': '虛構角色',
    ja: '架空のキャラクター',
    de: 'fiktiver Charakter',
    fr: 'personnage de fiction',
    ko: '허구의 캐릭터',
  },
  'schema:ComicSeries': {
    'zh-Hans': '日本系列漫画',
    'zh-Hant': '日本系列漫畫',
    ja: '日本の連載漫画',
    ko: '일본의 만화 시리즈',
  },
  'wd:Q7725310': {
    'zh-Hans': '系列创意作品',
    'zh-Hant': '系列創意作品',
    en: 'series of creative works',
    de: 'Mehrteiler',
    es: 'serie de obras creativas',
    fr: "série d'œuvres",
  },
  'wd:Q20631656': {
    'zh-Hans': '软件发布',
    'zh-Hant': '軟體發布',
    en: 'software release',
    de: 'Softwareveröffentlichung',
    es: 'release',
    fr: 'publication de logiciels',
    ja: 'ソフトウェア・リリース',
    ko: '출시 버전',
  },
  'wd:Q209163': {
    'zh-Hans': '资料片',
    'zh-Hant': '資料片',
    en: 'expansion add-on',
    de: 'Computerspiel-Erweiterung',
    es: 'expansión',
    fr: 'extension de jeu vidéo',
    ja: '拡張パック',
    ko: '확장팩',
  },
};

test('every type a page shows reads as an interface word in Chinese and Japanese', () => {
  expect(Object.keys(bundledRelease.types).sort()).toEqual(Object.keys(labels).sort());
  for (const [key, expected] of Object.entries(labels)) {
    expect(['zh-Hans', 'zh-Hant', 'ja'].map((tag) => bundledRelease.types[key]!.labels[tag])).toEqual(expected);
  }
});

test("a type's Wikidata gloss is kept as its description", () => {
  for (const [key, expected] of Object.entries(glosses)) {
    expect(bundledRelease.types[key]).toHaveProperty('descriptions', expected);
  }
});
