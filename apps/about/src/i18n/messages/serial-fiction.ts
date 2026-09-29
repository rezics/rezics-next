import { defineCopy } from '../define.ts';
import type { PageCopy } from './page.ts';

export const serialFiction = defineCopy<PageCopy>({
  en: {
    meta: {
      title: 'Serial fiction: write and read chapter by chapter',
      description:
        'Draft, schedule and publish serials, or follow them calmly and pick up exactly where you stopped.',
    },
    hero: {
      title: 'Serials, written and read one chapter at a time.',
      lede: 'Authors get drafts they can trust and a schedule that follows their own time zone. Readers get a quiet place to follow along, resume anywhere and discuss a chapter without spoilers.',
    },
    scene: {
      title: 'A chapter on its way',
      body: 'Scheduled chapters, the latest release and your reading position sit together, so you and your readers always know what comes next.',
    },
    featuresTitle: 'What serials will offer',
  },
  'zh-Hant': {
    meta: {
      title: '連載小說：一章一章地寫與讀',
      description: '起草、排程並發布連載，或安靜地追讀，從停下的位置繼續。',
    },
    hero: {
      title: '連載，一章一章地寫，一章一章地讀。',
      lede: '作者擁有值得信賴的草稿與依自己時區運作的排程；讀者有安靜的追讀空間，可隨處接續，並在不劇透的情況下討論章節。',
    },
    scene: {
      title: '即將發布的章節',
      body: '排程中的章節、最新一章與你的閱讀位置放在一起，你和讀者都清楚接下來是什麼。',
    },
    featuresTitle: '連載將提供的功能',
  },
  'zh-Hans': {
    meta: {
      title: '连载小说：一章一章地写与读',
      description: '起草、定时并发布连载，或安静地追读，从停下的位置继续。',
    },
    hero: {
      title: '连载，一章一章地写，一章一章地读。',
      lede: '作者拥有值得信赖的草稿和按自己时区运行的排期；读者有安静的追读空间，可随处接续，并在不剧透的情况下讨论章节。',
    },
    scene: {
      title: '即将发布的章节',
      body: '定时中的章节、最新一章和你的阅读位置放在一起，你和读者都清楚接下来是什么。',
    },
    featuresTitle: '连载将提供的功能',
  },
  ja: {
    meta: {
      title: '連載小説：一話ずつ書き、読む',
      description:
        '連載を下書きし、予約し、公開する。あるいは静かに追いかけ、止めたところから再開する。',
    },
    hero: {
      title: '連載を、一話ずつ書き、一話ずつ読む。',
      lede: '書き手には信頼できる下書きと、自分のタイムゾーンに沿った公開予定を。読者には、静かに追いかけ、どこからでも再開し、ネタバレなしで話について語れる場所を。',
    },
    scene: {
      title: '公開を待つ一話',
      body: '予約中の話、最新話、あなたの読書位置がひとつにまとまり、次に何が来るかを書き手も読者も把握できます。',
    },
    featuresTitle: '連載で提供されること',
  },
  ko: {
    meta: {
      title: '연재 소설: 한 화씩 쓰고 읽기',
      description: '연재를 초고 작성, 예약, 공개하거나 차분히 따라가며 멈춘 곳에서 이어 읽습니다.',
    },
    hero: {
      title: '연재를 한 화씩 쓰고, 한 화씩 읽습니다.',
      lede: '작가에게는 믿을 수 있는 초고와 자신의 시간대를 따르는 일정을, 독자에게는 차분히 따라가고 어디서든 이어 읽으며 스포일러 없이 회차를 이야기할 공간을 드립니다.',
    },
    scene: {
      title: '공개를 앞둔 한 화',
      body: '예약된 회차, 최신 회차, 내 읽기 위치가 한곳에 있어 작가와 독자 모두 다음이 무엇인지 알 수 있습니다.',
    },
    featuresTitle: '연재가 제공할 것',
  },
  de: {
    meta: {
      title: 'Serielle Literatur: Kapitel für Kapitel schreiben und lesen',
      description:
        'Serien entwerfen, planen und veröffentlichen, oder ruhig verfolgen und genau dort weiterlesen, wo du aufgehört hast.',
    },
    hero: {
      title: 'Serien, Kapitel für Kapitel geschrieben und gelesen.',
      lede: 'Autorinnen und Autoren bekommen Entwürfe, denen sie trauen können, und einen Zeitplan in der eigenen Zeitzone. Leser bekommen einen ruhigen Ort zum Mitverfolgen, Weiterlesen überall und Diskutieren ohne Spoiler.',
    },
    scene: {
      title: 'Ein Kapitel unterwegs',
      body: 'Geplante Kapitel, die neueste Veröffentlichung und deine Leseposition liegen beisammen, sodass alle wissen, was als Nächstes kommt.',
    },
    featuresTitle: 'Was Serien bieten werden',
  },
  fr: {
    meta: {
      title: 'Fiction en feuilleton : écrire et lire chapitre par chapitre',
      description:
        'Rédigez, programmez et publiez des feuilletons, ou suivez-les sereinement en reprenant exactement où vous vous étiez arrêté.',
    },
    hero: {
      title: 'Des feuilletons, écrits et lus chapitre par chapitre.',
      lede: 'Les auteurs disposent de brouillons fiables et d’un calendrier dans leur propre fuseau horaire. Les lecteurs trouvent un lieu calme pour suivre, reprendre n’importe où et discuter d’un chapitre sans divulgâcher.',
    },
    scene: {
      title: 'Un chapitre en route',
      body: 'Chapitres programmés, dernière parution et position de lecture sont réunis : auteurs et lecteurs savent toujours ce qui vient.',
    },
    featuresTitle: 'Ce que les feuilletons offriront',
  },
  es: {
    meta: {
      title: 'Ficción por entregas: escribe y lee capítulo a capítulo',
      description:
        'Redacta, programa y publica series, o síguelas con calma y retoma justo donde lo dejaste.',
    },
    hero: {
      title: 'Series, escritas y leídas capítulo a capítulo.',
      lede: 'Los autores tienen borradores de confianza y un calendario en su propia zona horaria. Los lectores tienen un lugar tranquilo para seguir, retomar donde sea y comentar un capítulo sin spoilers.',
    },
    scene: {
      title: 'Un capítulo en camino',
      body: 'Capítulos programados, la última entrega y tu posición de lectura están juntos, así que autores y lectores saben siempre qué viene.',
    },
    featuresTitle: 'Lo que ofrecerán las series',
  },
});
