import { defineCopy } from '../define.ts';
import type { PageCopy } from './page.ts';

export const lightNovels = defineCopy<PageCopy>({
  en: {
    meta: {
      title: 'Light novels: track a series across editions',
      description:
        'Follow a light-novel series volume by volume, across editions and translations, and see what is out, owned, read and next.',
    },
    hero: {
      title: 'Every volume, every edition, in the language you read.',
      lede: 'Light novels come as parts, volumes, omnibuses and translations that rarely line up. REZICS keeps each one distinct and shows where you are in the series.',
    },
    scene: {
      title: 'A series, tracked',
      body: 'Volumes sit on a timeline by edition. Read, owned and upcoming volumes look different, so the next one is never a guess.',
    },
    featuresTitle: 'What series tracking will do',
  },
  'zh-Hant': {
    meta: {
      title: '輕小說：跨版本追蹤系列',
      description: '逐冊追蹤輕小說系列，跨版本與翻譯，看到哪些已出版、已擁有、已讀完，以及下一步。',
    },
    hero: {
      title: '每一冊、每個版本，用你閱讀的語言。',
      lede: '輕小說有分冊、單行本、合訂本與各種翻譯，彼此很少對得上。REZICS 讓每一種保持獨立，並顯示你讀到系列的哪裡。',
    },
    scene: {
      title: '被追蹤的系列',
      body: '各冊依版本排在時間軸上。已讀、已擁有與即將出版的冊數看起來不同，下一冊不必再猜。',
    },
    featuresTitle: '系列追蹤將做到的事',
  },
  'zh-Hans': {
    meta: {
      title: '轻小说：跨版本追踪系列',
      description: '逐册追踪轻小说系列，跨版本与翻译，看到哪些已出版、已拥有、已读完，以及下一步。',
    },
    hero: {
      title: '每一册、每个版本，用你阅读的语言。',
      lede: '轻小说有分册、单行本、合订本和各种翻译，彼此很少对得上。REZICS 让每一种保持独立，并显示你读到系列的哪里。',
    },
    scene: {
      title: '被追踪的系列',
      body: '各册按版本排在时间轴上。已读、已拥有和即将出版的册数看起来不同，下一册不必再猜。',
    },
    featuresTitle: '系列追踪将做到的事',
  },
  ja: {
    meta: {
      title: 'ライトノベル：版をまたいでシリーズを追う',
      description:
        'ライトノベルのシリーズを巻ごとに、版と翻訳をまたいで追い、発売済み・所有・読了・次の巻を確認できます。',
    },
    hero: {
      title: 'すべての巻、すべての版を、読む言語で。',
      lede: 'ライトノベルは分冊、単行本、合本、翻訳と、なかなか揃いません。REZICS はそれぞれを区別したまま、シリーズのどこまで読んだかを示します。',
    },
    scene: {
      title: '追跡されるシリーズ',
      body: '巻は版ごとに時間軸に並びます。読了、所有、発売予定の巻は見た目が違い、次の巻を推測する必要はありません。',
    },
    featuresTitle: 'シリーズ追跡でできるようになること',
  },
  ko: {
    meta: {
      title: '라이트 노벨: 판본을 넘나드는 시리즈 추적',
      description:
        '라이트 노벨 시리즈를 권 단위로, 판본과 번역을 넘나들며 추적하고 출간·보유·완독·다음 권을 확인합니다.',
    },
    hero: {
      title: '모든 권, 모든 판본을 읽는 언어로.',
      lede: '라이트 노벨은 분책, 단행본, 합본, 번역이 좀처럼 맞아떨어지지 않습니다. REZICS는 각각을 구분해 두고 시리즈에서 어디까지 읽었는지 보여 줍니다.',
    },
    scene: {
      title: '추적되는 시리즈',
      body: '권은 판본별로 타임라인에 놓입니다. 읽은 권, 가진 권, 나올 권이 다르게 보여 다음 권을 짐작할 필요가 없습니다.',
    },
    featuresTitle: '시리즈 추적이 하게 될 일',
  },
  de: {
    meta: {
      title: 'Light Novels: eine Reihe über Ausgaben verfolgen',
      description:
        'Verfolge eine Light-Novel-Reihe Band für Band, über Ausgaben und Übersetzungen hinweg, und sieh, was erschienen ist, was du besitzt, gelesen hast und was als Nächstes kommt.',
    },
    hero: {
      title: 'Jeder Band, jede Ausgabe, in der Sprache, in der du liest.',
      lede: 'Light Novels erscheinen als Teile, Bände, Sammelbände und Übersetzungen, die selten zusammenpassen. REZICS hält jede getrennt und zeigt, wo du in der Reihe stehst.',
    },
    scene: {
      title: 'Eine Reihe, verfolgt',
      body: 'Bände liegen nach Ausgabe auf einer Zeitleiste. Gelesene, besessene und kommende Bände sehen verschieden aus, der nächste ist nie geraten.',
    },
    featuresTitle: 'Was die Reihenverfolgung können wird',
  },
  fr: {
    meta: {
      title: 'Light novels : suivre une série entre éditions',
      description:
        'Suivez une série de light novels tome par tome, entre éditions et traductions, et voyez ce qui est paru, possédé, lu et la suite.',
    },
    hero: {
      title: 'Chaque tome, chaque édition, dans la langue où vous lisez.',
      lede: 'Les light novels paraissent en parties, tomes, intégrales et traductions qui s’alignent rarement. REZICS garde chacun distinct et montre où vous en êtes dans la série.',
    },
    scene: {
      title: 'Une série suivie',
      body: 'Les tomes s’alignent sur une frise par édition. Lus, possédés et à paraître se distinguent, si bien que le suivant n’est jamais une devinette.',
    },
    featuresTitle: 'Ce que le suivi de séries saura faire',
  },
  es: {
    meta: {
      title: 'Light novels: sigue una serie entre ediciones',
      description:
        'Sigue una serie de light novels volumen a volumen, entre ediciones y traducciones, y ve qué ha salido, qué tienes, qué has leído y qué viene.',
    },
    hero: {
      title: 'Cada volumen, cada edición, en el idioma en que lees.',
      lede: 'Las light novels llegan en partes, volúmenes, ediciones integrales y traducciones que rara vez encajan. REZICS mantiene cada una por separado y muestra dónde vas en la serie.',
    },
    scene: {
      title: 'Una serie, seguida',
      body: 'Los volúmenes se sitúan en una línea de tiempo por edición. Los leídos, los que tienes y los próximos se ven distintos, así que el siguiente nunca es una suposición.',
    },
    featuresTitle: 'Lo que hará el seguimiento de series',
  },
});
