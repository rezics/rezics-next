import { defineMessages } from '../../i18n/define.ts';

const en = {
  title: 'Create an independent site',
  help: 'Create a site in its own Space, then attach an existing Realm. Attaching requires authority over both the site and the Realm.',
  name: 'Site name', nameLanguage: 'Site name language', create: 'Create site', creating: 'Creating your site…',
  created: 'Your site is ready.', attach: 'Attach an existing Realm',
  failed: 'Your request could not be confirmed. Keep this page open and try again.',
};

export const realmSiteCreationMessages = defineMessages({ en,
  'zh-Hant': { title: '建立獨立網站', help: '在獨立的 Space 中建立網站，然後連結現有的 Realm。連結需要同時擁有網站及 Realm 的權限。', name: '網站名稱', nameLanguage: '網站名稱的語言', create: '建立網站', creating: '正在建立網站…', created: '網站已準備就緒。', attach: '連結現有的 Realm', failed: '無法確認請求。請保持此頁開啟並重試。' },
  'zh-Hans': { title: '创建独立网站', help: '在独立的 Space 中创建网站，然后关联现有的 Realm。关联需要同时拥有网站及 Realm 的权限。', name: '网站名称', nameLanguage: '网站名称的语言', create: '创建网站', creating: '正在创建网站…', created: '网站已准备就绪。', attach: '关联现有的 Realm', failed: '无法确认请求。请保持此页打开并重试。' },
  ja: { title: '独立したサイトを作成', help: '専用の Space にサイトを作成し、既存の Realm を接続します。接続にはサイトと Realm の両方に対する権限が必要です。', name: 'サイト名', nameLanguage: 'サイト名の言語', create: 'サイトを作成', creating: 'サイトを作成中…', created: 'サイトの準備ができました。', attach: '既存の Realm を接続', failed: 'リクエストを確認できませんでした。このページを開いたまま再試行してください。' },
  ko: { title: '독립 사이트 만들기', help: '별도의 Space에 사이트를 만든 다음 기존 Realm을 연결하세요. 연결하려면 사이트와 Realm 양쪽에 대한 권한이 필요합니다.', name: '사이트 이름', nameLanguage: '사이트 이름 언어', create: '사이트 만들기', creating: '사이트를 만드는 중…', created: '사이트가 준비되었습니다.', attach: '기존 Realm 연결', failed: '요청을 확인하지 못했습니다. 이 페이지를 열어 둔 채 다시 시도하세요.' },
  de: { title: 'Eigenständige Website erstellen', help: 'Erstelle eine Website in einem eigenen Space und verknüpfe dann einen bestehenden Realm. Dafür brauchst du Berechtigungen für die Website und den Realm.', name: 'Name der Website', nameLanguage: 'Sprache des Website-Namens', create: 'Website erstellen', creating: 'Website wird erstellt…', created: 'Deine Website ist bereit.', attach: 'Bestehenden Realm verknüpfen', failed: 'Die Anfrage konnte nicht bestätigt werden. Lass diese Seite geöffnet und versuche es erneut.' },
  fr: { title: 'Créer un site indépendant', help: 'Créez un site dans son propre Space, puis associez un Realm existant. Il faut disposer des droits sur le site et sur le Realm.', name: 'Nom du site', nameLanguage: 'Langue du nom du site', create: 'Créer le site', creating: 'Création du site…', created: 'Votre site est prêt.', attach: 'Associer un Realm existant', failed: 'La demande n’a pas pu être confirmée. Gardez cette page ouverte et réessayez.' },
  es: { title: 'Crear un sitio independiente', help: 'Crea un sitio en su propio Space y después vincula un Realm existente. Necesitas autoridad sobre el sitio y el Realm para vincularlos.', name: 'Nombre del sitio', nameLanguage: 'Idioma del nombre del sitio', create: 'Crear sitio', creating: 'Creando el sitio…', created: 'Tu sitio está listo.', attach: 'Vincular un Realm existente', failed: 'No se pudo confirmar la solicitud. Mantén esta página abierta y vuelve a intentarlo.' },
});
