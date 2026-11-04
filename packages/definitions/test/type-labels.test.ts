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
  'schema:Quotation': ['引文', '引文', '引用'],
};

const authoredDescriptions = {
  de: 'Eine animierte Fernsehserie als Werk mit ihren Staffeln und Folgen, unabhängig von einer bestimmten Veröffentlichung.',
  en: 'An animated television series as a work spanning its seasons and episodes, distinct from a particular publication release.',
  es: 'Una serie de animación televisiva como obra que abarca temporadas y episodios, distinta de una edición distribuida concreta.',
  fr: 'Une série télévisée d’animation en tant qu’œuvre regroupant saisons et épisodes, distincte d’une édition donnée.',
  ja: 'シーズンやエピソードを含む作品としてのテレビアニメシリーズ。特定の刊行版とは別です。',
  ko: '시즌과 에피소드를 아우르는 TV 애니메이션 시리즈 작품입니다. 특정 발행판과는 별개입니다.',
  'zh-Hans': '包含各季和各集的电视动画作品系列，与某一具体发行版分开。',
  'zh-Hant': '包含各季與各集的電視動畫作品系列，與某個具體發行版分開。',
};

test('every type a page shows reads as an interface word in Chinese and Japanese', () => {
  expect(Object.keys(bundledRelease.types).sort()).toEqual(Object.keys(labels).sort());
  for (const [key, expected] of Object.entries(labels)) {
    expect(['zh-Hans', 'zh-Hant', 'ja'].map((tag) => bundledRelease.types[key]!.labels[tag])).toEqual(expected);
  }
});

test('an authored type description is published in all locales', () => {
  expect(bundledRelease.types['schema:TVSeries']?.descriptions).toEqual(authoredDescriptions);
});
