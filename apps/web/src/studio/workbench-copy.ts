import type { Locale } from '../paraglide/runtime.js';

/** Short navigation labels; existing editing, release and failure messages retain their owners. */
const en = {
  closeHistory: 'Close history',
  historyHelp:
    'History compares saved versions. Your working draft stays in the editor; copying a version requires a separate confirmation.',
  draftActions: 'Draft actions',
  publication: 'Prepare and publish',
  workDetails: 'About this workspace',
  chapter: 'Chapter draft',
  article: 'Article draft',
  column: 'Column',
};
export const workbenchCopy: Record<Locale, typeof en> = {
  en,
  'zh-Hant': {
    closeHistory: '關閉歷史記錄',
    historyHelp: '歷史記錄比較已儲存的版本。編輯器會保留目前的草稿；複製版本需要另外確認。',
    draftActions: '草稿操作',
    publication: '準備與發布',
    workDetails: '關於此工作區',
    chapter: '章節草稿',
    article: '文章草稿',
    column: '專欄',
  },
  'zh-Hans': {
    closeHistory: '关闭历史记录',
    historyHelp: '历史记录比较已保存的版本。编辑器会保留当前草稿；复制版本需要另外确认。',
    draftActions: '草稿操作',
    publication: '准备与发布',
    workDetails: '关于此工作区',
    chapter: '章节草稿',
    article: '文章草稿',
    column: '专栏',
  },
  ja: {
    closeHistory: '履歴を閉じる',
    historyHelp: '履歴では保存済みの版を比較します。編集中の下書きは保持され、版をコピーするには別途確認が必要です。',
    draftActions: '下書きの操作',
    publication: '公開の準備',
    workDetails: 'このワークスペースについて',
    chapter: '章の下書き',
    article: '記事の下書き',
    column: '連載',
  },
  ko: {
    closeHistory: '기록 닫기',
    historyHelp:
      '저장된 버전을 비교합니다. 작성 중인 초안은 편집기에 유지되며 버전을 복사하려면 별도의 확인이 필요합니다.',
    draftActions: '초안 작업',
    publication: '공개 준비 및 게시',
    workDetails: '이 작업 공간 정보',
    chapter: '장 초안',
    article: '글 초안',
    column: '연재',
  },
  de: {
    closeHistory: 'Verlauf schließen',
    historyHelp:
      'Der Verlauf vergleicht gespeicherte Versionen. Dein Entwurf bleibt im Editor; das Kopieren einer Version erfordert eine eigene Bestätigung.',
    draftActions: 'Entwurfsaktionen',
    publication: 'Vorbereiten und veröffentlichen',
    workDetails: 'Über diesen Arbeitsbereich',
    chapter: 'Kapitelentwurf',
    article: 'Artikelentwurf',
    column: 'Kolumne',
  },
  fr: {
    closeHistory: 'Fermer l’historique',
    historyHelp:
      'L’historique compare les versions enregistrées. Le brouillon reste dans l’éditeur ; copier une version demande une confirmation distincte.',
    draftActions: 'Actions sur le brouillon',
    publication: 'Préparer et publier',
    workDetails: 'À propos de cet espace',
    chapter: 'Brouillon de chapitre',
    article: 'Brouillon d’article',
    column: 'Chronique',
  },
  es: {
    closeHistory: 'Cerrar historial',
    historyHelp:
      'El historial compara versiones guardadas. El borrador permanece en el editor; copiar una versión requiere una confirmación aparte.',
    draftActions: 'Acciones del borrador',
    publication: 'Preparar y publicar',
    workDetails: 'Acerca de este espacio',
    chapter: 'Borrador del capítulo',
    article: 'Borrador del artículo',
    column: 'Columna',
  },
};
