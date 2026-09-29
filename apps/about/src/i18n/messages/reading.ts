import { defineCopy } from '../define.ts';
import type { PageCopy } from './page.ts';

export const reading = defineCopy<PageCopy>({
  en: {
    meta: {
      title: 'Reading and the portable library',
      description:
        'Keep one library of everything you read, across editions, formats and devices, and take it with you.',
    },
    hero: {
      title: 'A library that goes where you read.',
      lede: 'Track what you read, in which edition and in what format. Import your history, export all of it, and keep your shelves whatever happens to any one service.',
    },
    scene: {
      title: 'One book, three ways you read it',
      body: 'A single work can be a paperback, an ebook and a translation. REZICS keeps them together and remembers your place in each.',
    },
    featuresTitle: 'What the library will do',
  },
  'zh-Hant': {
    meta: {
      title: '閱讀與隨身書庫',
      description: '用一個書庫收納你讀過的一切，跨版本、格式與裝置，並能隨時帶走。',
    },
    hero: {
      title: '跟著你閱讀的書庫。',
      lede: '記錄你讀了什麼、哪個版本、什麼格式。匯入你的歷史、完整匯出，不論任何一項服務發生什麼事，書架都是你的。',
    },
    scene: {
      title: '一本書，三種讀法',
      body: '同一部作品可能是平裝本、電子書與翻譯本。REZICS 把它們放在一起，並記住你在每一種裡讀到哪裡。',
    },
    featuresTitle: '書庫將做到的事',
  },
  'zh-Hans': {
    meta: {
      title: '阅读与随身书库',
      description: '用一个书库收纳你读过的一切，跨版本、格式和设备，并能随时带走。',
    },
    hero: {
      title: '跟着你阅读的书库。',
      lede: '记录你读了什么、哪个版本、什么格式。导入你的历史、完整导出，无论任何一项服务发生什么，书架都是你的。',
    },
    scene: {
      title: '一本书，三种读法',
      body: '同一部作品可能是平装本、电子书和翻译本。REZICS 把它们放在一起，并记住你在每一种里读到哪里。',
    },
    featuresTitle: '书库将做到的事',
  },
  ja: {
    meta: {
      title: '読書とポータブルなライブラリ',
      description:
        '読んだものすべてをひとつのライブラリに。版、形式、端末をまたいで、持ち出すこともできます。',
    },
    hero: {
      title: '読む場所についてくるライブラリ。',
      lede: '何を、どの版で、どの形式で読んだかを記録します。履歴を取り込み、すべて書き出せます。どのサービスに何が起きても、本棚はあなたのものです。',
    },
    scene: {
      title: '一冊の本、三つの読み方',
      body: 'ひとつの作品が、紙の本、電子書籍、翻訳版であることがあります。REZICS はそれらをまとめ、それぞれの読みかけの位置を覚えています。',
    },
    featuresTitle: 'ライブラリでできるようになること',
  },
  ko: {
    meta: {
      title: '독서와 휴대 가능한 서재',
      description:
        '읽은 모든 것을 하나의 서재에 담고, 판본과 형식과 기기를 넘나들며 가져갈 수 있습니다.',
    },
    hero: {
      title: '읽는 곳마다 따라오는 서재.',
      lede: '무엇을, 어떤 판본으로, 어떤 형식으로 읽었는지 기록합니다. 기록을 가져오고 전부 내보내세요. 어느 서비스에 무슨 일이 생겨도 서가는 내 것입니다.',
    },
    scene: {
      title: '한 권, 세 가지 읽는 방법',
      body: '하나의 작품이 종이책, 전자책, 번역본일 수 있습니다. REZICS는 이들을 함께 묶고 각각에서 읽던 위치를 기억합니다.',
    },
    featuresTitle: '서재가 하게 될 일',
  },
  de: {
    meta: {
      title: 'Lesen und die portable Bibliothek',
      description:
        'Eine Bibliothek für alles, was du liest, über Ausgaben, Formate und Geräte hinweg, und du kannst sie mitnehmen.',
    },
    hero: {
      title: 'Eine Bibliothek, die dahin geht, wo du liest.',
      lede: 'Halte fest, was du gelesen hast, in welcher Ausgabe und in welchem Format. Importiere deinen Verlauf, exportiere alles und behalte deine Regale, was auch mit einem einzelnen Dienst geschieht.',
    },
    scene: {
      title: 'Ein Buch, drei Arten zu lesen',
      body: 'Ein Werk kann ein Taschenbuch, ein E-Book und eine Übersetzung sein. REZICS hält sie zusammen und merkt sich deine Stelle in jeder.',
    },
    featuresTitle: 'Was die Bibliothek können wird',
  },
  fr: {
    meta: {
      title: 'La lecture et la bibliothèque portable',
      description:
        'Une seule bibliothèque pour tout ce que vous lisez, entre éditions, formats et appareils, et vous pouvez l’emporter.',
    },
    hero: {
      title: 'Une bibliothèque qui va où vous lisez.',
      lede: 'Notez ce que vous lisez, dans quelle édition et sous quel format. Importez votre historique, exportez-le en entier, et gardez vos étagères quoi qu’il arrive à un service.',
    },
    scene: {
      title: 'Un livre, trois façons de le lire',
      body: 'Une même œuvre peut être un poche, un ebook et une traduction. REZICS les garde ensemble et retient votre page dans chacun.',
    },
    featuresTitle: 'Ce que la bibliothèque saura faire',
  },
  es: {
    meta: {
      title: 'Lectura y la biblioteca portátil',
      description:
        'Una sola biblioteca para todo lo que lees, entre ediciones, formatos y dispositivos, y puedes llevártela.',
    },
    hero: {
      title: 'Una biblioteca que va donde tú lees.',
      lede: 'Registra qué lees, en qué edición y en qué formato. Importa tu historial, expórtalo entero y conserva tus estantes pase lo que pase con un servicio.',
    },
    scene: {
      title: 'Un libro, tres formas de leerlo',
      body: 'Una misma obra puede ser un libro de bolsillo, un ebook y una traducción. REZICS los mantiene juntos y recuerda por dónde vas en cada uno.',
    },
    featuresTitle: 'Lo que hará la biblioteca',
  },
});
