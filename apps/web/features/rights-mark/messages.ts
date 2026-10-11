import { defineMessages } from '../../i18n/define.ts';

// Duties the rights read names, in the reader's language. `source` is the label
// in front of the notice's own name. Non-English copy is machine-drafted and
// needs native review.
const en = {
  coverCredit: 'Cover credit: ',
  source: 'Source: ',
  shareAlike: 'Adaptations stay under the same terms.',
  noticeRetention: 'Keep this notice with the text.',
  changeIndication: 'Say what changed.',
  nonCommercial: 'Not for commercial use.',
  noDerivatives: 'No adaptations.',
  otherTerms: 'Other terms apply.',
};

export const messages = defineMessages({
  en,
  // Machine-drafted; needs native review.
  'zh-Hant': {
    coverCredit: '封面署名：',
    source: '來源：',
    shareAlike: '改作須以相同條款共享。',
    noticeRetention: '這段說明須與正文一同保留。',
    changeIndication: '請標明改了什麼。',
    nonCommercial: '不可用於商業用途。',
    noDerivatives: '不可改作。',
    otherTerms: '另有其他條款。',
  },
  // Machine-drafted; needs native review.
  'zh-Hans': {
    coverCredit: '封面署名：',
    source: '来源：',
    shareAlike: '改编须以相同条款共享。',
    noticeRetention: '这段说明须与正文一同保留。',
    changeIndication: '请标明改了什么。',
    nonCommercial: '不可用于商业用途。',
    noDerivatives: '不可改编。',
    otherTerms: '另有其他条款。',
  },
  // Machine-drafted; needs native review.
  ja: {
    coverCredit: '表紙クレジット：',
    source: '出典：',
    shareAlike: '翻案したものも、同じ条件で共有してください。',
    noticeRetention: 'この表示は本文と一緒に残してください。',
    changeIndication: '変更した点を示してください。',
    nonCommercial: '商用利用はできません。',
    noDerivatives: '翻案はできません。',
    otherTerms: 'その他の条件があります。',
  },
  // Machine-drafted; needs native review.
  ko: {
    coverCredit: '표지 크레딧: ',
    source: '출처: ',
    shareAlike: '각색한 내용도 같은 조건으로 공유해야 합니다.',
    noticeRetention: '이 안내를 글과 함께 남기세요.',
    changeIndication: '바꾼 내용을 밝히세요.',
    nonCommercial: '상업적으로 이용할 수 없습니다.',
    noDerivatives: '2차적 저작물을 만들 수 없습니다.',
    otherTerms: '그 밖의 조건이 있습니다.',
  },
  // Machine-drafted; needs native review.
  de: {
    coverCredit: 'Covernachweis: ',
    source: 'Quelle: ',
    shareAlike: 'Bearbeitungen bleiben unter denselben Bedingungen.',
    noticeRetention: 'Behalte diesen Hinweis beim Text.',
    changeIndication: 'Sag, was sich geändert hat.',
    nonCommercial: 'Nicht zur kommerziellen Nutzung.',
    noDerivatives: 'Keine Bearbeitungen.',
    otherTerms: 'Es gelten weitere Bedingungen.',
  },
  // Machine-drafted; needs native review.
  fr: {
    coverCredit: 'Crédit de couverture : ',
    source: 'Source : ',
    shareAlike: 'Les adaptations restent sous les mêmes conditions.',
    noticeRetention: 'Conservez cet avis avec le texte.',
    changeIndication: 'Indiquez ce qui a changé.',
    nonCommercial: 'Pas d’usage commercial.',
    noDerivatives: 'Pas d’adaptation.',
    otherTerms: 'D’autres conditions s’appliquent.',
  },
  // Machine-drafted; needs native review.
  es: {
    coverCredit: 'Crédito de portada: ',
    source: 'Fuente: ',
    shareAlike: 'Las adaptaciones siguen bajo las mismas condiciones.',
    noticeRetention: 'Conserva este aviso junto al texto.',
    changeIndication: 'Indica qué cambió.',
    nonCommercial: 'No para uso comercial.',
    noDerivatives: 'Sin adaptaciones.',
    otherTerms: 'Se aplican otras condiciones.',
  },
});

export type RightsMarkCopy = typeof en;
