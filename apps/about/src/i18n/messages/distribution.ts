import { defineCopy } from '../define.ts';
import type { PageCopy } from './page.ts';

export const distribution = defineCopy<PageCopy>({
  en: {
    meta: {
      title: 'Publishing: publish and sell books and games',
      description:
        'Bring finished books and games to readers, state the rights clearly and sell them in a way buyers can keep.',
    },
    hero: {
      title: 'Bring what you made to readers.',
      lede: 'Publish a book or a game with its rights and translations stated plainly. Sell it if you want to; buyers keep what they buy.',
    },
    scene: {
      title: 'An edition on sale',
      body: 'Format, price, language and rights appear next to the cover, so a reader knows exactly what they are getting.',
    },
    featuresTitle: 'What publishing will offer',
  },
  'zh-Hant': {
    meta: {
      title: '出版：出版並販售書籍與遊戲',
      description: '把完成的書與遊戲交到讀者手上，清楚註明權利，並以買家能長久保有的方式販售。',
    },
    hero: {
      title: '把你的作品交到讀者手上。',
      lede: '出版一本書或一款遊戲，清楚註明權利與翻譯。想販售就販售；買家買到的內容永遠屬於他們。',
    },
    scene: {
      title: '上架中的版本',
      body: '格式、價格、語言與權利就放在封面旁，讀者清楚知道自己買到什麼。',
    },
    featuresTitle: '出版將提供的功能',
  },
  'zh-Hans': {
    meta: {
      title: '出版：出版并销售书籍与游戏',
      description: '把完成的书和游戏交到读者手上，清楚注明权利，并以买家能长久保有的方式销售。',
    },
    hero: {
      title: '把你的作品交到读者手上。',
      lede: '出版一本书或一款游戏，清楚注明权利和翻译。想销售就销售；买家买到的内容永远属于他们。',
    },
    scene: {
      title: '上架中的版本',
      body: '格式、价格、语言和权利就放在封面旁，读者清楚知道自己买到什么。',
    },
    featuresTitle: '出版将提供的功能',
  },
  ja: {
    meta: {
      title: '出版：本とゲームを公開し、販売する',
      description:
        '完成した本やゲームを読者に届け、権利を明示し、購入者が手元に残せる形で販売できます。',
    },
    hero: {
      title: '作ったものを、読者のもとへ。',
      lede: '本やゲームを、権利と翻訳をはっきり示して公開します。販売したければ販売でき、購入者は買ったものを手元に残せます。',
    },
    scene: {
      title: '販売中の版',
      body: '形式、価格、言語、権利が表紙の横に並び、読者は何を手に入れるのかを正確に知れます。',
    },
    featuresTitle: '出版で提供されること',
  },
  ko: {
    meta: {
      title: '출판: 책과 게임을 출판하고 판매',
      description:
        '완성한 책과 게임을 독자에게 전하고, 권리를 분명히 밝히며, 구매자가 계속 보관할 수 있는 방식으로 판매합니다.',
    },
    hero: {
      title: '만든 것을 독자에게 전하세요.',
      lede: '책이나 게임을 권리와 번역 정보를 분명히 밝혀 출판합니다. 원하면 판매하고, 구매자는 산 것을 계속 보관합니다.',
    },
    scene: {
      title: '판매 중인 판본',
      body: '형식, 가격, 언어, 권리가 표지 옆에 나타나 독자가 무엇을 얻는지 정확히 알 수 있습니다.',
    },
    featuresTitle: '출판이 제공할 것',
  },
  de: {
    meta: {
      title: 'Veröffentlichen: Bücher und Spiele veröffentlichen und verkaufen',
      description:
        'Bring fertige Bücher und Spiele zu Lesern, benenne die Rechte klar und verkaufe so, dass Käufer das Gekaufte behalten.',
    },
    hero: {
      title: 'Bring, was du gemacht hast, zu den Lesern.',
      lede: 'Veröffentliche ein Buch oder ein Spiel mit klar benannten Rechten und Übersetzungen. Verkaufe es, wenn du willst; Käufer behalten, was sie kaufen.',
    },
    scene: {
      title: 'Eine Ausgabe im Verkauf',
      body: 'Format, Preis, Sprache und Rechte stehen neben dem Cover, damit Leser genau wissen, was sie bekommen.',
    },
    featuresTitle: 'Was das Veröffentlichen bieten wird',
  },
  fr: {
    meta: {
      title: 'Édition : publier et vendre livres et jeux',
      description:
        'Amenez livres et jeux terminés jusqu’aux lecteurs, indiquez clairement les droits et vendez de façon que les acheteurs conservent ce qu’ils achètent.',
    },
    hero: {
      title: 'Amenez ce que vous avez créé jusqu’aux lecteurs.',
      lede: 'Publiez un livre ou un jeu avec ses droits et ses traductions clairement indiqués. Vendez-le si vous le souhaitez ; les acheteurs gardent ce qu’ils achètent.',
    },
    scene: {
      title: 'Une édition en vente',
      body: 'Format, prix, langue et droits apparaissent à côté de la couverture : le lecteur sait exactement ce qu’il obtient.',
    },
    featuresTitle: 'Ce que l’édition offrira',
  },
  es: {
    meta: {
      title: 'Publicación: publica y vende libros y juegos',
      description:
        'Lleva libros y juegos terminados a los lectores, indica los derechos con claridad y véndelos de forma que los compradores conserven lo comprado.',
    },
    hero: {
      title: 'Lleva lo que creaste a los lectores.',
      lede: 'Publica un libro o un juego con sus derechos y traducciones claramente indicados. Véndelo si quieres; los compradores conservan lo que compran.',
    },
    scene: {
      title: 'Una edición a la venta',
      body: 'Formato, precio, idioma y derechos aparecen junto a la portada, para que el lector sepa exactamente qué obtiene.',
    },
    featuresTitle: 'Lo que ofrecerá la publicación',
  },
});
