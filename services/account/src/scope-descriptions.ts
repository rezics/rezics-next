import type { AccountLocale } from './email.ts';
import { providerScopes } from './oauth-scopes.ts';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const satisfies readonly AccountLocale[];
type Description = Record<AccountLocale, string>;
type Phrase = Record<AccountLocale, string>;

function fill(templates: Phrase, noun: Phrase): Description {
  return Object.fromEntries(locales.map(locale => [locale, templates[locale].replaceAll('{n}', noun[locale])])) as Description;
}

const nouns: Record<string, Phrase> = {
  work: { en: 'works', 'zh-Hans': '作品', 'zh-Hant': '作品', ja: '作品', ko: '작품', de: 'Werke', fr: 'des œuvres', es: 'obras' },
  comment: { en: 'comments', 'zh-Hans': '评论', 'zh-Hant': '評論', ja: 'コメント', ko: '댓글', de: 'Kommentare', fr: 'des commentaires', es: 'comentarios' },
  space: { en: 'spaces', 'zh-Hans': '空间', 'zh-Hant': '空間', ja: '空間', ko: '공간', de: 'Bereiche', fr: 'des espaces', es: 'espacios' },
  realm: { en: 'community submissions', 'zh-Hans': '社区投稿', 'zh-Hant': '社群投稿', ja: 'コミュニティの投稿', ko: '커뮤니티 기고', de: 'Community-Beiträge', fr: 'des contributions de la communauté', es: 'contribuciones de la comunidad' },
  classification: { en: 'classifications', 'zh-Hans': '分类', 'zh-Hant': '分類', ja: '分類', ko: '분류', de: 'Klassifikationen', fr: 'des classifications', es: 'clasificaciones' },
  rating: { en: 'ratings', 'zh-Hans': '评分', 'zh-Hant': '評分', ja: '評価', ko: '평가', de: 'Bewertungen', fr: 'des évaluations', es: 'valoraciones' },
  address: { en: 'addresses', 'zh-Hans': '地址', 'zh-Hant': '地址', ja: 'アドレス', ko: '주소', de: 'Adressen', fr: 'des adresses', es: 'direcciones' },
  access: { en: 'access permissions', 'zh-Hans': '访问权限', 'zh-Hant': '存取權限', ja: 'アクセス権', ko: '접근 권한', de: 'Zugriffsberechtigungen', fr: 'des droits d’accès', es: 'permisos de acceso' },
  source: { en: 'source material', 'zh-Hans': '来源资料', 'zh-Hant': '來源資料', ja: '出典資料', ko: '출처 자료', de: 'Quellen', fr: 'des sources', es: 'fuentes' },
  package: { en: 'packages', 'zh-Hans': '软件包', 'zh-Hant': '軟體套件', ja: 'パッケージ', ko: '패키지', de: 'Pakete', fr: 'des paquets', es: 'paquetes' },
  agent: { en: 'agents', 'zh-Hans': '代理身份', 'zh-Hant': '代理身分', ja: 'エージェント', ko: '에이전트', de: 'Agenten', fr: 'des agents', es: 'agentes' },
  subscription: { en: 'subscriptions', 'zh-Hans': '订阅', 'zh-Hant': '訂閱', ja: 'サブスクリプション', ko: '구독', de: 'Abos', fr: 'des abonnements', es: 'suscripciones' },
  'connected-app': { en: 'connected apps', 'zh-Hans': '关联应用', 'zh-Hant': '連結的應用程式', ja: '連携アプリ', ko: '연결된 앱', de: 'verbundene Apps', fr: 'des applications connectées', es: 'aplicaciones conectadas' },
  context: { en: 'contexts', 'zh-Hans': '语境', 'zh-Hant': '語境', ja: 'コンテキスト', ko: '맥락', de: 'Kontexte', fr: 'des contextes', es: 'contextos' },
  event: { en: 'event observations', 'zh-Hans': '事件观测', 'zh-Hant': '事件觀測', ja: 'イベントの観測', ko: '이벤트 관측', de: 'Ereignisbeobachtungen', fr: 'des observations d’événements', es: 'observaciones de eventos' },
  export: { en: 'exports', 'zh-Hans': '导出', 'zh-Hant': '匯出', ja: 'エクスポート', ko: '내보내기', de: 'Exporte', fr: 'des exportations', es: 'exportaciones' },
  governance: { en: 'community reports and decisions', 'zh-Hans': '社区报告与决定', 'zh-Hant': '社群報告與決定', ja: 'コミュニティの報告と決定', ko: '커뮤니티 보고와 결정', de: 'Community-Meldungen und Entscheidungen', fr: 'des signalements et décisions de la communauté', es: 'informes y decisiones de la comunidad' },
  judgment: { en: 'judgments', 'zh-Hans': '评价', 'zh-Hant': '評價', ja: '評価文', ko: '평가', de: 'Beurteilungen', fr: 'des jugements', es: 'juicios' },
  notification: { en: 'notifications', 'zh-Hans': '通知', 'zh-Hant': '通知', ja: '通知', ko: '알림', de: 'Benachrichtigungen', fr: 'des notifications', es: 'notificaciones' },
  owner: { en: 'storage ownership', 'zh-Hans': '存储归属', 'zh-Hant': '儲存歸屬', ja: 'ストレージの所有', ko: '저장소 소유권', de: 'Speicherbesitz', fr: 'la propriété du stockage', es: 'la propiedad del almacenamiento' },
  content: { en: 'content', 'zh-Hans': '内容', 'zh-Hant': '內容', ja: 'コンテンツ', ko: '콘텐츠', de: 'Inhalte', fr: 'des contenus', es: 'contenidos' },
  rights: { en: 'usage rights', 'zh-Hans': '使用权', 'zh-Hant': '使用權', ja: '利用権', ko: '이용 권리', de: 'Nutzungsrechte', fr: 'des droits d’utilisation', es: 'derechos de uso' },
  statement: { en: 'statements', 'zh-Hans': '陈述', 'zh-Hant': '陳述', ja: 'ステートメント', ko: '진술', de: 'Aussagen', fr: 'des déclarations', es: 'declaraciones' },
  theme: { en: 'executable themes', 'zh-Hans': '可执行主题', 'zh-Hant': '可執行主題', ja: '実行可能なテーマ', ko: '실행 가능한 테마', de: 'ausführbare Themes', fr: 'des thèmes exécutables', es: 'temas ejecutables' },
  claim: { en: 'verification claims', 'zh-Hans': '核验主张', 'zh-Hant': '核驗主張', ja: '検証の主張', ko: '검증 주장', de: 'Verifikationsansprüche', fr: 'des revendications de vérification', es: 'alegaciones de verificación' },
  vote: { en: 'polls and ballots', 'zh-Hans': '投票与选票', 'zh-Hant': '投票與選票', ja: '投票と投票用紙', ko: '투표와 투표용지', de: 'Abstimmungen und Stimmzettel', fr: 'des sondages et bulletins', es: 'encuestas y papeletas' },
  zone: { en: 'zones', 'zh-Hans': '分区', 'zh-Hant': '分區', ja: 'ゾーン', ko: '구역', de: 'Zonen', fr: 'des zones', es: 'zonas' },
  collection: { en: 'collections', 'zh-Hans': '集合', 'zh-Hant': '集合', ja: 'コレクション', ko: '컬렉션', de: 'Sammlungen', fr: 'des collections', es: 'colecciones' },
  semantic: { en: 'semantic relationships', 'zh-Hans': '语义关系', 'zh-Hant': '語意關係', ja: '意味関係', ko: '의미 관계', de: 'semantische Beziehungen', fr: 'des relations sémantiques', es: 'relaciones semánticas' },
};

const actions: Record<string, Phrase> = {
  create: { en: 'Create {n}', 'zh-Hans': '创建{n}', 'zh-Hant': '建立{n}', ja: '{n}を作成する', ko: '{n} 만들기', de: '{n} erstellen', fr: 'Créer {n}', es: 'Crear {n}' },
  edit: { en: 'Edit {n}', 'zh-Hans': '编辑{n}', 'zh-Hant': '編輯{n}', ja: '{n}を編集する', ko: '{n} 수정', de: '{n} bearbeiten', fr: 'Modifier {n}', es: 'Editar {n}' },
  read: { en: 'Read {n}', 'zh-Hans': '读取{n}', 'zh-Hant': '讀取{n}', ja: '{n}を読み取る', ko: '{n} 읽기', de: '{n} lesen', fr: 'Lire {n}', es: 'Leer {n}' },
  adopt: { en: 'Adopt {n}', 'zh-Hans': '采纳{n}', 'zh-Hant': '採納{n}', ja: '{n}を採用する', ko: '{n} 채택', de: '{n} übernehmen', fr: 'Adopter {n}', es: 'Adoptar {n}' },
  reject: { en: 'Reject {n}', 'zh-Hans': '拒绝{n}', 'zh-Hant': '拒絕{n}', ja: '{n}を却下する', ko: '{n} 거절', de: '{n} ablehnen', fr: 'Refuser {n}', es: 'Rechazar {n}' },
  classify: { en: 'Classify {n}', 'zh-Hans': '分类{n}', 'zh-Hant': '分類{n}', ja: '{n}を分類する', ko: '{n} 분류', de: '{n} klassifizieren', fr: 'Classer {n}', es: 'Clasificar {n}' },
  define: { en: 'Define {n}', 'zh-Hans': '定义{n}', 'zh-Hant': '定義{n}', ja: '{n}を定義する', ko: '{n} 정의', de: '{n} definieren', fr: 'Définir {n}', es: 'Definir {n}' },
  decide: { en: 'Make decisions about {n}', 'zh-Hans': '决定{n}', 'zh-Hant': '決定{n}', ja: '{n}について決定する', ko: '{n} 결정', de: 'Über {n} entscheiden', fr: 'Décider de {n}', es: 'Decidir sobre {n}' },
  configure: { en: 'Configure {n}', 'zh-Hans': '配置{n}', 'zh-Hant': '設定{n}', ja: '{n}を設定する', ko: '{n} 구성', de: '{n} konfigurieren', fr: 'Configurer {n}', es: 'Configurar {n}' },
  submit: { en: 'Submit {n}', 'zh-Hans': '提交{n}', 'zh-Hant': '提交{n}', ja: '{n}を提出する', ko: '{n} 제출', de: '{n} einreichen', fr: 'Soumettre {n}', es: 'Enviar {n}' },
  claim: { en: 'Claim {n}', 'zh-Hans': '认领{n}', 'zh-Hant': '認領{n}', ja: '{n}の所有を主張する', ko: '{n} 소유 주장', de: '{n} beanspruchen', fr: 'Revendiquer {n}', es: 'Reclamar {n}' },
  manage: { en: 'Manage {n}', 'zh-Hans': '管理{n}', 'zh-Hant': '管理{n}', ja: '{n}を管理する', ko: '{n} 관리', de: '{n} verwalten', fr: 'Gérer {n}', es: 'Gestionar {n}' },
  'membership-consent': { en: 'Consent to membership through {n}', 'zh-Hans': '同意成员资格相关的{n}', 'zh-Hant': '同意與成員資格相關的{n}', ja: '{n}を通じてメンバーシップに同意する', ko: '{n}을 통한 멤버십 동의', de: 'Mitgliedschaft über {n} zustimmen', fr: 'Consentir à l’adhésion via {n}', es: 'Aceptar la membresía a través de {n}' },
  approve: { en: 'Approve {n}', 'zh-Hans': '批准{n}', 'zh-Hant': '核准{n}', ja: '{n}を承認する', ko: '{n} 승인', de: '{n} genehmigen', fr: 'Approuver {n}', es: 'Aprobar {n}' },
  grant: { en: 'Grant {n}', 'zh-Hans': '授予{n}', 'zh-Hant': '授予{n}', ja: '{n}を付与する', ko: '{n} 부여', de: '{n} gewähren', fr: 'Accorder {n}', es: 'Conceder {n}' },
  represent: { en: 'Act with represented {n}', 'zh-Hans': '代表使用{n}', 'zh-Hant': '代表使用{n}', ja: '委任された{n}で行動する', ko: '위임된 {n}으로 행동', de: 'Mit vertretenen {n} handeln', fr: 'Agir avec {n} représentés', es: 'Actuar con {n} representados' },
  'representation-manage': { en: 'Manage representation for {n}', 'zh-Hans': '管理委托相关的{n}', 'zh-Hant': '管理委託相關的{n}', ja: '{n}の委任を管理する', ko: '{n} 위임 관리', de: 'Vertretung für {n} verwalten', fr: 'Gérer la représentation pour {n}', es: 'Gestionar la representación de {n}' },
  role: { en: 'Manage roles for {n}', 'zh-Hans': '管理角色相关的{n}', 'zh-Hant': '管理角色相關的{n}', ja: '{n}の役割を管理する', ko: '{n} 역할 관리', de: 'Rollen für {n} verwalten', fr: 'Gérer les rôles pour {n}', es: 'Gestionar roles de {n}' },
  intake: { en: 'Register {n}', 'zh-Hans': '登记{n}', 'zh-Hant': '登記{n}', ja: '{n}を登録する', ko: '{n} 등록', de: '{n} registrieren', fr: 'Enregistrer {n}', es: 'Registrar {n}' },
  acquire: { en: 'Acquire {n}', 'zh-Hans': '获取{n}', 'zh-Hant': '取得{n}', ja: '{n}を取得する', ko: '{n} 가져오기', de: '{n} beziehen', fr: 'Acquérir {n}', es: 'Adquirir {n}' },
  convert: { en: 'Convert {n}', 'zh-Hans': '转换{n}', 'zh-Hant': '轉換{n}', ja: '{n}を変換する', ko: '{n} 변환', de: '{n} umwandeln', fr: 'Convertir {n}', es: 'Convertir {n}' },
  propose: { en: 'Propose {n}', 'zh-Hans': '提议{n}', 'zh-Hant': '提議{n}', ja: '{n}を提案する', ko: '{n} 제안', de: '{n} vorschlagen', fr: 'Proposer {n}', es: 'Proponer {n}' },
  correspond: { en: 'Link {n}', 'zh-Hans': '关联{n}', 'zh-Hant': '關聯{n}', ja: '{n}を関連付ける', ko: '{n} 연결', de: '{n} verknüpfen', fr: 'Relier {n}', es: 'Vincular {n}' },
  capture: { en: 'Capture {n}', 'zh-Hans': '记录{n}', 'zh-Hant': '記錄{n}', ja: '{n}を記録する', ko: '{n} 기록', de: '{n} erfassen', fr: 'Capturer {n}', es: 'Capturar {n}' },
  resolve: { en: 'Resolve dependencies for {n}', 'zh-Hans': '解析依赖相关的{n}', 'zh-Hant': '解析相依相關的{n}', ja: '{n}の依存関係を解決する', ko: '{n} 의존성 해결', de: 'Abhängigkeiten für {n} auflösen', fr: 'Résoudre les dépendances de {n}', es: 'Resolver dependencias de {n}' },
  verify: { en: 'Verify {n}', 'zh-Hans': '验证{n}', 'zh-Hant': '驗證{n}', ja: '{n}を検証する', ko: '{n} 검증', de: '{n} prüfen', fr: 'Vérifier {n}', es: 'Verificar {n}' },
  observe: { en: 'Observe {n}', 'zh-Hans': '观测{n}', 'zh-Hant': '觀測{n}', ja: '{n}を観測する', ko: '{n} 관측', de: '{n} beobachten', fr: 'Observer {n}', es: 'Observar {n}' },
  consent: { en: 'Grant consent to {n}', 'zh-Hans': '授权{n}', 'zh-Hant': '授權{n}', ja: '{n}に同意を与える', ko: '{n}에 동의 부여', de: '{n} zustimmen', fr: 'Autoriser {n}', es: 'Dar consentimiento a {n}' },
  invoke: { en: 'Run {n}', 'zh-Hans': '运行{n}', 'zh-Hant': '執行{n}', ja: '{n}を実行する', ko: '{n} 실행', de: '{n} ausführen', fr: 'Exécuter {n}', es: 'Ejecutar {n}' },
  write: { en: 'Write {n}', 'zh-Hans': '编写{n}', 'zh-Hant': '撰寫{n}', ja: '{n}を書く', ko: '{n} 작성', de: '{n} schreiben', fr: 'Rédiger {n}', es: 'Escribir {n}' },
  select: { en: 'Select {n}', 'zh-Hans': '选择{n}', 'zh-Hant': '選擇{n}', ja: '{n}を選ぶ', ko: '{n} 선택', de: '{n} auswählen', fr: 'Choisir {n}', es: 'Elegir {n}' },
  report: { en: 'Submit {n}', 'zh-Hans': '提交{n}', 'zh-Hant': '提交{n}', ja: '{n}を報告する', ko: '{n} 신고', de: '{n} melden', fr: 'Signaler {n}', es: 'Informar {n}' },
  operate: { en: 'Operate {n}', 'zh-Hans': '操作{n}', 'zh-Hant': '操作{n}', ja: '{n}を操作する', ko: '{n} 운영', de: '{n} betreiben', fr: 'Exploiter {n}', es: 'Operar {n}' },
  install: { en: 'Install {n}', 'zh-Hans': '安装{n}', 'zh-Hant': '安裝{n}', ja: '{n}をインストールする', ko: '{n} 설치', de: '{n} installieren', fr: 'Installer {n}', es: 'Instalar {n}' },
  revoke: { en: 'Revoke {n}', 'zh-Hans': '撤销{n}', 'zh-Hant': '撤銷{n}', ja: '{n}を取り消す', ko: '{n} 취소', de: '{n} widerrufen', fr: 'Révoquer {n}', es: 'Revocar {n}' },
  'recommendation-set': { en: 'Set recommendations for {n}', 'zh-Hans': '设置推荐相关的{n}', 'zh-Hant': '設定推薦相關的{n}', ja: '{n}のおすすめを設定する', ko: '{n} 추천 설정', de: 'Empfehlungen für {n} festlegen', fr: 'Définir des recommandations pour {n}', es: 'Definir recomendaciones de {n}' },
  protect: { en: 'Protect {n}', 'zh-Hans': '保护{n}', 'zh-Hant': '保護{n}', ja: '{n}を保護する', ko: '{n} 보호', de: '{n} schützen', fr: 'Protéger {n}', es: 'Proteger {n}' },
  correct: { en: 'Correct {n}', 'zh-Hans': '更正{n}', 'zh-Hant': '更正{n}', ja: '{n}を訂正する', ko: '{n} 정정', de: '{n} korrigieren', fr: 'Corriger {n}', es: 'Corregir {n}' },
  review: { en: 'Review {n}', 'zh-Hans': '审查{n}', 'zh-Hant': '審查{n}', ja: '{n}を審査する', ko: '{n} 심사', de: '{n} prüfen', fr: 'Examiner {n}', es: 'Revisar {n}' },
  assess: { en: 'Assess {n}', 'zh-Hans': '评估{n}', 'zh-Hant': '評估{n}', ja: '{n}を評価する', ko: '{n} 평가', de: '{n} bewerten', fr: 'Évaluer {n}', es: 'Evaluar {n}' },
  offer: { en: 'Offer {n}', 'zh-Hans': '提供{n}', 'zh-Hant': '提供{n}', ja: '{n}を提供する', ko: '{n} 제공', de: '{n} anbieten', fr: 'Proposer {n}', es: 'Ofrecer {n}' },
  evidence: { en: 'Attach evidence to {n}', 'zh-Hans': '为以下内容提供证据：{n}', 'zh-Hant': '為以下內容提供證據：{n}', ja: '{n}に証拠を添える', ko: '{n}에 증거 첨부', de: 'Belege an {n} anfügen', fr: 'Joindre des preuves à {n}', es: 'Adjuntar pruebas a {n}' },
  challenge: { en: 'Challenge {n}', 'zh-Hans': '质疑{n}', 'zh-Hant': '質疑{n}', ja: '{n}に異議を唱える', ko: '{n}에 이의를 제기', de: '{n} anfechten', fr: 'Contester {n}', es: 'Impugnar {n}' },
  lineage: { en: 'Trace the lineage of {n}', 'zh-Hans': '追踪来源：{n}', 'zh-Hant': '追蹤來源：{n}', ja: '{n}の来歴をたどる', ko: '{n} 계보 추적', de: 'Die Herkunft von {n} nachverfolgen', fr: 'Retracer l’origine de {n}', es: 'Rastrear el origen de {n}' },
  reliability: { en: 'Assess the reliability of {n}', 'zh-Hans': '评估可信度：{n}', 'zh-Hant': '評估可信度：{n}', ja: '{n}の信頼性を評価する', ko: '{n} 신뢰도 평가', de: 'Die Zuverlässigkeit von {n} bewerten', fr: 'Évaluer la fiabilité de {n}', es: 'Evaluar la fiabilidad de {n}' },
  cast: { en: 'Cast {n}', 'zh-Hans': '提交{n}', 'zh-Hant': '投出{n}', ja: '{n}を投じる', ko: '{n} 제출', de: '{n} abgeben', fr: 'Déposer {n}', es: 'Emitir {n}' },
  invalidate: { en: 'Invalidate {n}', 'zh-Hans': '作废{n}', 'zh-Hant': '作廢{n}', ja: '{n}を無効にする', ko: '{n} 무효화', de: '{n} für ungültig erklären', fr: 'Invalider {n}', es: 'Invalidar {n}' },
};

const fixed: Record<string, Description> = {
  openid: { en: 'Identify your REZICS account', 'zh-Hans': '识别你的 REZICS 账号', 'zh-Hant': '識別你的 REZICS 帳戶', ja: 'REZICS アカウントを識別する', ko: '내 REZICS 계정을 식별', de: 'Ihr REZICS-Konto erkennen', fr: 'Identifier votre compte REZICS', es: 'Identificar tu cuenta de REZICS' },
  profile: { en: 'Read your name and profile image', 'zh-Hans': '读取你的姓名和头像', 'zh-Hant': '讀取你的姓名和頭像', ja: '名前とプロフィール画像を読み取る', ko: '이름과 프로필 사진 읽기', de: 'Ihren Namen und Ihr Profilbild lesen', fr: 'Lire votre nom et votre image de profil', es: 'Leer tu nombre y tu imagen de perfil' },
  email: { en: 'Read your email address and verification status', 'zh-Hans': '读取你的邮箱地址与验证状态', 'zh-Hant': '讀取你的電子郵件地址與驗證狀態', ja: 'メールアドレスと確認状態を読み取る', ko: '이메일 주소와 인증 상태 읽기', de: 'Ihre E-Mail-Adresse und den Bestätigungsstatus lesen', fr: 'Lire votre adresse e-mail et son état de confirmation', es: 'Leer tu correo y si está verificado' },
  offline_access: { en: 'Keep access while you are signed out, until you revoke it', 'zh-Hans': '在你退出登录后继续访问，直到你撤销授权', 'zh-Hant': '在你登出後繼續存取，直到你撤銷授權', ja: 'ログアウト後も、取り消すまでアクセスを維持する', ko: '로그아웃한 뒤에도 취소할 때까지 액세스 유지', de: 'Zugriff behalten, nachdem Sie sich abgemeldet haben, bis Sie ihn widerrufen', fr: 'Conserver l’accès après la déconnexion, jusqu’à ce que vous le révoquiez', es: 'Mantener el acceso después de cerrar sesión, hasta que lo revoques' },
  'realm:profile': { en: 'Publish the public profile of communities you manage', 'zh-Hans': '发布你管理的社区的公开资料', 'zh-Hant': '發布你管理的社群的公開資料', ja: '管理しているコミュニティの公開プロフィールを公開する', ko: '내가 관리하는 커뮤니티의 공개 프로필 게시', de: 'Das öffentliche Profil der Communities veröffentlichen, die Sie verwalten', fr: 'Publier le profil public des communautés que vous gérez', es: 'Publicar el perfil público de las comunidades que administras' },
  'realm:public-role': { en: 'Show or hide your public moderator role in communities', 'zh-Hans': '公开或隐藏你在社区中的版主身份', 'zh-Hant': '公開或隱藏你在社群中的版主身分', ja: 'コミュニティでの公開モデレーター表示を切り替える', ko: '커뮤니티의 공개 운영자 역할 표시 또는 숨기기', de: 'Ihre öffentliche Moderatorenrolle in Communities zeigen oder verbergen', fr: 'Afficher ou masquer votre rôle public de modération dans les communautés', es: 'Mostrar u ocultar tu rol público de moderación en las comunidades' },
  'follow:read': { en: 'See the communities, works and people you follow', 'zh-Hans': '查看你关注的社区、作品和用户', 'zh-Hant': '查看你關注的社群、作品和使用者', ja: 'フォローしているコミュニティ、作品、人を見る', ko: '내가 팔로우하는 커뮤니티, 작품, 사람 보기', de: 'Die Communities, Werke und Personen sehen, denen Sie folgen', fr: 'Voir les communautés, les œuvres et les personnes que vous suivez', es: 'Ver las comunidades, obras y personas que sigues' },
  'follow:write': { en: 'Follow or unfollow communities, works and people for you', 'zh-Hans': '为你关注或取消关注社区、作品和用户', 'zh-Hant': '為你關注或取消關注社群、作品和使用者', ja: 'コミュニティ、作品、人をフォローまたは解除する', ko: '커뮤니티, 작품, 사람을 팔로우하거나 해제', de: 'Communities, Werke und Personen für Sie folgen oder entfolgen', fr: 'Suivre ou ne plus suivre des communautés, des œuvres et des personnes pour vous', es: 'Seguir o dejar de seguir comunidades, obras y personas por ti' },
  'feed:vote': { en: 'Cast, change or remove your votes on feed activity', 'zh-Hans': '为你提交、更改或撤回动态投票', 'zh-Hant': '為你送出、更改或撤回動態投票', ja: 'フィードの投票を入れる、変える、取り消す', ko: '피드 활동에 투표하거나 바꾸거나 취소', de: 'Stimmen zur Feed-Aktivität abgeben, ändern oder zurücknehmen', fr: 'Donner, modifier ou retirer vos votes sur l’activité du fil', es: 'Emitir, cambiar o retirar tus votos en la actividad del feed' },
};

/** No silent untranslated fallback: a new scope must define what the person
 * is authorizing. Descriptions explain capability; Access still admits each operation. */
export function describeScope(scope: string): { scope: string; description: Description } {
  const exact = fixed[scope];
  if (exact) return { scope, description: exact };
  const [owner, action] = scope.split(':');
  const noun = nouns[owner!];
  const verb = actions[action!];
  if (!noun || !verb) throw new Error(`Missing consent description: ${scope}`);
  return { scope, description: fill(verb, noun) };
}

export const scopeDescriptions = Object.freeze(providerScopes.map(describeScope));
