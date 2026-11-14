import type { Locale } from '../paraglide/runtime.js';

/** Short navigation labels; existing editing, release and failure messages retain their owners. */
const en = {
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
    draftActions: '草稿操作',
    publication: '準備與發布',
    workDetails: '關於此工作區',
    chapter: '章節草稿',
    article: '文章草稿',
    column: '專欄',
  },
  'zh-Hans': {
    draftActions: '草稿操作',
    publication: '准备与发布',
    workDetails: '关于此工作区',
    chapter: '章节草稿',
    article: '文章草稿',
    column: '专栏',
  },
  ja: {
    draftActions: '下書きの操作',
    publication: '公開の準備',
    workDetails: 'このワークスペースについて',
    chapter: '章の下書き',
    article: '記事の下書き',
    column: '連載',
  },
  ko: {
    draftActions: '초안 작업',
    publication: '공개 준비 및 게시',
    workDetails: '이 작업 공간 정보',
    chapter: '장 초안',
    article: '글 초안',
    column: '연재',
  },
  de: {
    draftActions: 'Entwurfsaktionen',
    publication: 'Vorbereiten und veröffentlichen',
    workDetails: 'Über diesen Arbeitsbereich',
    chapter: 'Kapitelentwurf',
    article: 'Artikelentwurf',
    column: 'Kolumne',
  },
  fr: {
    draftActions: 'Actions sur le brouillon',
    publication: 'Préparer et publier',
    workDetails: 'À propos de cet espace',
    chapter: 'Brouillon de chapitre',
    article: 'Brouillon d’article',
    column: 'Chronique',
  },
  es: {
    draftActions: 'Acciones del borrador',
    publication: 'Preparar y publicar',
    workDetails: 'Acerca de este espacio',
    chapter: 'Borrador del capítulo',
    article: 'Borrador del artículo',
    column: 'Columna',
  },
};
