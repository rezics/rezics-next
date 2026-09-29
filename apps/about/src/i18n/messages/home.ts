import { defineCopy } from '../define.ts';

export interface HomeCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string; primary: string; secondary: string };
  scenarios: { title: string; lede: string };
  lines: { title: string; lede: string };
  why: { title: string; lede: string };
  /** Text of the hero's Work-card illustration. */
  illustrationLabel: string;
}

export const home = defineCopy<HomeCopy>({
  en: {
    meta: {
      title: 'REZICS: your reading, in every language and edition',
      description:
        'REZICS is a home for readers and writers of novels, visual novels, anime and manga. Track every edition and translation, keep your library portable and talk in your own language.',
    },
    hero: {
      title: 'Your reading, in every language and edition.',
      lede: 'REZICS is a home for readers and writers of novels, visual novels, anime and manga. Track what you read in each edition and translation, keep a library you can take with you, and talk about it in your own language.',
      primary: 'Get notified',
      secondary: 'See the roadmap',
    },
    scenarios: {
      title: 'Four things to do first',
      lede: 'We start with the jobs readers repeat every week.',
    },
    lines: {
      title: 'Product lines',
      lede: 'One catalogue, presented the way each kind of story is read.',
    },
    why: { title: 'Why REZICS', lede: 'Four choices shape everything we build.' },
    illustrationLabel: 'One work in three languages, with your place in each',
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS：你的閱讀，跨越每一種語言與版本',
      description:
        'REZICS 是小說、視覺小說、動畫與漫畫讀者與作者的家。追蹤每個版本與翻譯，讓書庫隨身帶走，並用自己的語言交流。',
    },
    hero: {
      title: '你的閱讀，跨越每一種語言與版本。',
      lede: 'REZICS 是小說、視覺小說、動畫與漫畫讀者與作者的家。依版本與翻譯記錄你讀了什麼，擁有可以帶走的書庫，並用自己的語言討論。',
      primary: '通知我',
      secondary: '查看路線圖',
    },
    scenarios: { title: '最先要做的四件事', lede: '我們從讀者每週都重複的事情開始。' },
    lines: { title: '產品線', lede: '同一個目錄，依各類故事的閱讀方式呈現。' },
    why: { title: '為什麼是 REZICS', lede: '四項選擇決定了我們所做的一切。' },
    illustrationLabel: '同一部作品的三種語言版本，以及你在每一個裡讀到哪裡',
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS：你的阅读，跨越每一种语言与版本',
      description:
        'REZICS 是小说、视觉小说、动画与漫画读者和作者的家。追踪每个版本与翻译，让书库随身带走，并用自己的语言交流。',
    },
    hero: {
      title: '你的阅读，跨越每一种语言与版本。',
      lede: 'REZICS 是小说、视觉小说、动画与漫画读者和作者的家。按版本与翻译记录你读了什么，拥有可以带走的书库，并用自己的语言讨论。',
      primary: '通知我',
      secondary: '查看路线图',
    },
    scenarios: { title: '最先要做的四件事', lede: '我们从读者每周都重复的事情开始。' },
    lines: { title: '产品线', lede: '同一个目录，按各类故事的阅读方式呈现。' },
    why: { title: '为什么是 REZICS', lede: '四项选择决定了我们所做的一切。' },
    illustrationLabel: '同一部作品的三种语言版本，以及你在每一个里读到哪里',
  },
  ja: {
    meta: {
      title: 'REZICS：あなたの読書を、あらゆる言語と版で',
      description:
        'REZICS は、小説・ビジュアルノベル・アニメ・マンガの読者と作り手の場所です。版と翻訳ごとに記録し、ライブラリを持ち出し、自分の言語で語れます。',
    },
    hero: {
      title: 'あなたの読書を、あらゆる言語と版で。',
      lede: 'REZICS は、小説・ビジュアルノベル・アニメ・マンガの読者と作り手の場所です。版と翻訳ごとに読んだものを記録し、持ち出せるライブラリを持ち、自分の言語で語り合えます。',
      primary: '通知を受け取る',
      secondary: 'ロードマップを見る',
    },
    scenarios: { title: '最初に取り組む四つのこと', lede: '読者が毎週くり返すことから始めます。' },
    lines: { title: 'プロダクト', lede: 'ひとつのカタログを、物語の種類ごとの読み方に合わせて。' },
    why: { title: 'なぜ REZICS か', lede: '四つの選択が、私たちが作るすべてを形づくります。' },
    illustrationLabel: '三つの言語による一つの作品と、それぞれの読みかけの位置',
  },
  ko: {
    meta: {
      title: 'REZICS: 모든 언어와 판본에 걸친 나의 독서',
      description:
        'REZICS는 소설, 비주얼 노벨, 애니메이션, 만화의 독자와 작가를 위한 공간입니다. 판본과 번역별로 기록하고, 서재를 가져가고, 내 언어로 이야기하세요.',
    },
    hero: {
      title: '모든 언어와 판본에 걸친 나의 독서.',
      lede: 'REZICS는 소설, 비주얼 노벨, 애니메이션, 만화의 독자와 작가를 위한 공간입니다. 판본과 번역별로 읽은 것을 기록하고, 가져갈 수 있는 서재를 갖고, 내 언어로 이야기하세요.',
      primary: '알림 받기',
      secondary: '로드맵 보기',
    },
    scenarios: { title: '먼저 할 네 가지', lede: '독자가 매주 되풀이하는 일에서 시작합니다.' },
    lines: { title: '제품군', lede: '하나의 카탈로그를, 이야기 종류마다 읽는 방식에 맞게.' },
    why: { title: 'REZICS인 이유', lede: '네 가지 선택이 우리가 만드는 모든 것을 이끕니다.' },
    illustrationLabel: '세 언어로 된 하나의 작품과 각각에서 읽던 위치',
  },
  de: {
    meta: {
      title: 'REZICS: dein Lesen, in jeder Sprache und Ausgabe',
      description:
        'REZICS ist ein Zuhause für Leser und Autorinnen von Romanen, Visual Novels, Anime und Manga. Verfolge jede Ausgabe und Übersetzung, nimm deine Bibliothek mit und sprich in deiner Sprache.',
    },
    hero: {
      title: 'Dein Lesen, in jeder Sprache und Ausgabe.',
      lede: 'REZICS ist ein Zuhause für Leser und Autorinnen von Romanen, Visual Novels, Anime und Manga. Halte fest, was du in welcher Ausgabe und Übersetzung liest, nimm deine Bibliothek mit und sprich darüber in deiner Sprache.',
      primary: 'Benachrichtigen',
      secondary: 'Roadmap ansehen',
    },
    scenarios: {
      title: 'Vier Dinge zuerst',
      lede: 'Wir beginnen mit den Aufgaben, die Leser jede Woche wiederholen.',
    },
    lines: {
      title: 'Produktlinien',
      lede: 'Ein Katalog, so dargestellt, wie jede Art von Geschichte gelesen wird.',
    },
    why: { title: 'Warum REZICS', lede: 'Vier Entscheidungen prägen alles, was wir bauen.' },
    illustrationLabel: 'Ein Werk in drei Sprachen, mit deiner Stelle in jeder',
  },
  fr: {
    meta: {
      title: 'REZICS : vos lectures, dans toutes les langues et éditions',
      description:
        'REZICS est un lieu pour les lecteurs et les auteurs de romans, de visual novels, d’anime et de manga. Suivez chaque édition et traduction, emportez votre bibliothèque et parlez dans votre langue.',
    },
    hero: {
      title: 'Vos lectures, dans toutes les langues et éditions.',
      lede: 'REZICS est un lieu pour les lecteurs et les auteurs de romans, de visual novels, d’anime et de manga. Notez ce que vous lisez dans chaque édition et traduction, gardez une bibliothèque que vous emportez, et parlez-en dans votre langue.',
      primary: 'Être prévenu',
      secondary: 'Voir la feuille de route',
    },
    scenarios: {
      title: 'Quatre choses à faire d’abord',
      lede: 'Nous commençons par ce que les lecteurs refont chaque semaine.',
    },
    lines: {
      title: 'Gammes de produits',
      lede: 'Un seul catalogue, présenté comme chaque type d’histoire se lit.',
    },
    why: {
      title: 'Pourquoi REZICS',
      lede: 'Quatre choix façonnent tout ce que nous construisons.',
    },
    illustrationLabel: 'Une œuvre en trois langues, avec votre page dans chacune',
  },
  es: {
    meta: {
      title: 'REZICS: tu lectura, en cada idioma y edición',
      description:
        'REZICS es un hogar para lectores y autores de novelas, novelas visuales, anime y manga. Sigue cada edición y traducción, lleva tu biblioteca contigo y habla en tu idioma.',
    },
    hero: {
      title: 'Tu lectura, en cada idioma y edición.',
      lede: 'REZICS es un hogar para lectores y autores de novelas, novelas visuales, anime y manga. Registra lo que lees en cada edición y traducción, ten una biblioteca que puedes llevarte y habla de ello en tu idioma.',
      primary: 'Avísame',
      secondary: 'Ver la hoja de ruta',
    },
    scenarios: {
      title: 'Cuatro cosas para empezar',
      lede: 'Empezamos por lo que los lectores repiten cada semana.',
    },
    lines: {
      title: 'Líneas de producto',
      lede: 'Un solo catálogo, presentado como se lee cada tipo de historia.',
    },
    why: {
      title: 'Por qué REZICS',
      lede: 'Cuatro decisiones dan forma a todo lo que construimos.',
    },
    illustrationLabel: 'Una obra en tres idiomas, con tu posición en cada una',
  },
});
