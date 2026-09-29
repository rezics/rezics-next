import { defineCopy } from '../define.ts';
import type { PageCopy } from './page.ts';

export const communities = defineCopy<PageCopy>({
  en: {
    meta: {
      title: 'Realms: communities for stories and languages',
      description:
        'Join or start a Realm for one story, one language or one idea, with clear rules and fair moderation.',
    },
    hero: {
      title: 'Communities for one story, one language, one idea.',
      lede: 'A Realm has its own rules, its own moderators and its own wiki. You can follow a Realm without joining it, and post in any language.',
    },
    scene: {
      title: 'A Realm at a glance',
      body: 'Rules, members and recent activity sit on one page, in the language the reader chose.',
    },
    featuresTitle: 'What Realms will offer',
  },
  'zh-Hant': {
    meta: {
      title: '社群：為作品與語言而設',
      description: '加入或建立一個為某部作品、某種語言或某個想法而設的社群，規則清楚、管理公平。',
    },
    hero: {
      title: '為一部作品、一種語言、一個想法而設的社群。',
      lede: '每個社群有自己的規則、管理員與 Wiki。你可以只追蹤而不加入，也能用任何語言發文。',
    },
    scene: {
      title: '一眼看懂的社群',
      body: '規則、成員與近期動態集中在一頁，並以讀者選擇的語言呈現。',
    },
    featuresTitle: '社群將提供的功能',
  },
  'zh-Hans': {
    meta: {
      title: '社区：为作品与语言而设',
      description: '加入或创建一个为某部作品、某种语言或某个想法而设的社区，规则清楚、管理公平。',
    },
    hero: {
      title: '为一部作品、一种语言、一个想法而设的社区。',
      lede: '每个社区有自己的规则、管理员和 Wiki。你可以只关注而不加入，也能用任何语言发帖。',
    },
    scene: {
      title: '一眼看懂的社区',
      body: '规则、成员和近期动态集中在一页，并以读者选择的语言呈现。',
    },
    featuresTitle: '社区将提供的功能',
  },
  ja: {
    meta: {
      title: 'コミュニティ：物語と言語のために',
      description:
        'ひとつの物語、言語、関心のためのコミュニティに参加、または作れます。ルールは明確で、運営は公平です。',
    },
    hero: {
      title: 'ひとつの物語、ひとつの言語、ひとつの関心のためのコミュニティ。',
      lede: 'コミュニティには独自のルール、モデレーター、ウィキがあります。参加せずにフォローだけもでき、どの言語でも投稿できます。',
    },
    scene: {
      title: '一目でわかるコミュニティ',
      body: 'ルール、メンバー、最近の動きがひとつのページに、読み手が選んだ言語で並びます。',
    },
    featuresTitle: 'コミュニティで提供されること',
  },
  ko: {
    meta: {
      title: '커뮤니티: 이야기와 언어를 위한 공간',
      description:
        '하나의 이야기, 언어, 아이디어를 위한 커뮤니티에 참여하거나 만들 수 있습니다. 규칙은 분명하고 운영은 공정합니다.',
    },
    hero: {
      title: '하나의 이야기, 하나의 언어, 하나의 아이디어를 위한 커뮤니티.',
      lede: '커뮤니티에는 자체 규칙, 운영진, 위키가 있습니다. 가입하지 않고 팔로우만 할 수 있고, 어떤 언어로든 글을 쓸 수 있습니다.',
    },
    scene: {
      title: '한눈에 보는 커뮤니티',
      body: '규칙, 멤버, 최근 활동이 한 페이지에, 독자가 고른 언어로 놓입니다.',
    },
    featuresTitle: '커뮤니티가 제공할 것',
  },
  de: {
    meta: {
      title: 'Realms: Communitys für Geschichten und Sprachen',
      description:
        'Tritt einem Realm bei oder gründe eines, für eine Geschichte, eine Sprache oder eine Idee, mit klaren Regeln und fairer Moderation.',
    },
    hero: {
      title: 'Communitys für eine Geschichte, eine Sprache, eine Idee.',
      lede: 'Ein Realm hat eigene Regeln, eigene Moderatoren und ein eigenes Wiki. Du kannst einem Realm folgen, ohne beizutreten, und in jeder Sprache schreiben.',
    },
    scene: {
      title: 'Ein Realm auf einen Blick',
      body: 'Regeln, Mitglieder und aktuelle Aktivität stehen auf einer Seite, in der Sprache, die der Leser gewählt hat.',
    },
    featuresTitle: 'Was Realms bieten werden',
  },
  fr: {
    meta: {
      title: 'Realms : des communautés pour les histoires et les langues',
      description:
        'Rejoignez ou créez un Realm pour une histoire, une langue ou une idée, avec des règles claires et une modération équitable.',
    },
    hero: {
      title: 'Des communautés pour une histoire, une langue, une idée.',
      lede: 'Un Realm a ses propres règles, ses propres modérateurs et son propre wiki. Vous pouvez suivre un Realm sans le rejoindre, et publier dans n’importe quelle langue.',
    },
    scene: {
      title: 'Un Realm en un coup d’œil',
      body: 'Règles, membres et activité récente tiennent sur une page, dans la langue choisie par le lecteur.',
    },
    featuresTitle: 'Ce que les Realms offriront',
  },
  es: {
    meta: {
      title: 'Realms: comunidades para historias e idiomas',
      description:
        'Únete a un Realm o crea uno para una historia, un idioma o una idea, con normas claras y moderación justa.',
    },
    hero: {
      title: 'Comunidades para una historia, un idioma, una idea.',
      lede: 'Un Realm tiene sus propias normas, sus propios moderadores y su propia wiki. Puedes seguir un Realm sin unirte y publicar en cualquier idioma.',
    },
    scene: {
      title: 'Un Realm de un vistazo',
      body: 'Normas, miembros y actividad reciente están en una sola página, en el idioma que eligió el lector.',
    },
    featuresTitle: 'Lo que ofrecerán los Realms',
  },
});
