import { defineCopy } from '../define.ts';
import type { PageCopy } from './page.ts';

export const wikis = defineCopy<PageCopy>({
  en: {
    meta: {
      title: 'Wikis and worldbuilding',
      description:
        'Build a wiki for a story or a world, with citations, history and review, and let agents help draft it.',
    },
    hero: {
      title: 'Worldbuilding that stays accurate.',
      lede: 'Every Realm can keep a wiki with sources, links between pages and a history of each change. Assistants can draft; people decide what is published.',
    },
    scene: {
      title: 'A page and its history',
      body: 'Each page cites its sources and keeps every revision. Changes are compared and reviewed before they replace what was there.',
    },
    featuresTitle: 'What wikis will offer',
  },
  'zh-Hant': {
    meta: {
      title: 'Wiki 與世界觀設定',
      description: '為一部作品或一個世界建立 Wiki，含引用、歷史與審閱，並讓代理協助起草。',
    },
    hero: {
      title: '始終準確的世界觀設定。',
      lede: '每個社群都能維護一個 Wiki，有來源、頁面間的連結，以及每次變更的歷史。助理可以起草；發布什麼由人決定。',
    },
    scene: {
      title: '一個頁面與它的歷史',
      body: '每個頁面都標明來源並保留每個修訂版。變更經比較與審閱後才會取代原有內容。',
    },
    featuresTitle: 'Wiki 將提供的功能',
  },
  'zh-Hans': {
    meta: {
      title: 'Wiki 与世界观设定',
      description: '为一部作品或一个世界建立 Wiki，含引用、历史和审阅，并让智能体协助起草。',
    },
    hero: {
      title: '始终准确的世界观设定。',
      lede: '每个社区都能维护一个 Wiki，有来源、页面间的链接，以及每次变更的历史。助手可以起草；发布什么由人决定。',
    },
    scene: {
      title: '一个页面与它的历史',
      body: '每个页面都标明来源并保留每个修订版。变更经比较和审阅后才会取代原有内容。',
    },
    featuresTitle: 'Wiki 将提供的功能',
  },
  ja: {
    meta: {
      title: 'ウィキと世界観設定',
      description:
        '物語や世界のためのウィキを、出典、履歴、レビュー付きで作り、エージェントに下書きを手伝ってもらえます。',
    },
    hero: {
      title: '正確さを保つ世界観づくり。',
      lede: 'コミュニティごとに、出典、ページ間のリンク、変更の履歴を備えたウィキを持てます。アシスタントが下書きし、公開するかどうかは人が決めます。',
    },
    scene: {
      title: 'ページとその履歴',
      body: 'ページは出典を示し、すべての改訂を残します。変更は比較・確認されてから、それまでの内容を置き換えます。',
    },
    featuresTitle: 'ウィキで提供されること',
  },
  ko: {
    meta: {
      title: '위키와 세계관 구축',
      description:
        '이야기나 세계를 위한 위키를 출처, 이력, 검토와 함께 만들고 에이전트에게 초안을 맡길 수 있습니다.',
    },
    hero: {
      title: '정확함을 유지하는 세계관 구축.',
      lede: '커뮤니티마다 출처, 문서 간 링크, 변경 이력을 갖춘 위키를 둘 수 있습니다. 어시스턴트가 초안을 쓰고 무엇을 공개할지는 사람이 정합니다.',
    },
    scene: {
      title: '문서와 그 이력',
      body: '문서는 출처를 밝히고 모든 개정본을 남깁니다. 변경은 비교와 검토를 거친 뒤에야 기존 내용을 대체합니다.',
    },
    featuresTitle: '위키가 제공할 것',
  },
  de: {
    meta: {
      title: 'Wikis und Weltenbau',
      description:
        'Baue ein Wiki für eine Geschichte oder eine Welt, mit Quellenangaben, Versionsgeschichte und Prüfung, und lass Agenten beim Entwurf helfen.',
    },
    hero: {
      title: 'Weltenbau, der stimmig bleibt.',
      lede: 'Jedes Realm kann ein Wiki mit Quellen, Links zwischen Seiten und einer Geschichte jeder Änderung führen. Assistenten können entwerfen; Menschen entscheiden, was erscheint.',
    },
    scene: {
      title: 'Eine Seite und ihre Geschichte',
      body: 'Jede Seite nennt ihre Quellen und behält jede Fassung. Änderungen werden verglichen und geprüft, bevor sie das Bisherige ersetzen.',
    },
    featuresTitle: 'Was Wikis bieten werden',
  },
  fr: {
    meta: {
      title: 'Wikis et construction d’univers',
      description:
        'Construisez un wiki pour une histoire ou un monde, avec citations, historique et relecture, et laissez des agents aider à le rédiger.',
    },
    hero: {
      title: 'Un univers qui reste cohérent.',
      lede: 'Chaque Realm peut tenir un wiki avec des sources, des liens entre pages et l’historique de chaque modification. Les assistants rédigent ; les personnes décident de ce qui est publié.',
    },
    scene: {
      title: 'Une page et son historique',
      body: 'Chaque page cite ses sources et garde chaque révision. Les changements sont comparés et relus avant de remplacer l’existant.',
    },
    featuresTitle: 'Ce que les wikis offriront',
  },
  es: {
    meta: {
      title: 'Wikis y construcción de mundos',
      description:
        'Crea una wiki para una historia o un mundo, con citas, historial y revisión, y deja que los agentes ayuden a redactarla.',
    },
    hero: {
      title: 'Mundos que se mantienen coherentes.',
      lede: 'Cada Realm puede mantener una wiki con fuentes, enlaces entre páginas y el historial de cada cambio. Los asistentes redactan; las personas deciden qué se publica.',
    },
    scene: {
      title: 'Una página y su historial',
      body: 'Cada página cita sus fuentes y conserva cada revisión. Los cambios se comparan y se revisan antes de sustituir lo anterior.',
    },
    featuresTitle: 'Lo que ofrecerán las wikis',
  },
});
