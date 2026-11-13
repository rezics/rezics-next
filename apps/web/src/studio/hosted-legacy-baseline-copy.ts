import type { Locale } from '../paraglide/runtime.js';
import type { BaselineBody } from './hosted-legacy-baseline-contract';

type Copy = {
  heading: string;
  entry: string;
  private: string;
  review: string;
  original: string;
  current: string;
  catalogue: string;
  revision: string;
  publication: string;
  confirm: string;
  continue: string;
  retry: string;
  refresh: string;
  sourceSize: string;
  preparing: string;
  ready: string;
  unknown: string;
  stale: string;
  unavailable: string;
  noPublication: string;
  done: string;
  point: string;
  ended: string;
  readFailed: string;
  next: string;
  steps: Record<BaselineBody['step'], string>;
};

/** Feature copy follows the normal launch Locale union; opaque IDs and native progress remain untranslated. */
export const baselineCopy = {
  en: {
    heading: 'Prepare this Book for point editing',
    entry: 'Prepare a legacy public Book',
    private:
      'Preparation builds a private baseline from the original public version. It does not publish, replace the public version, or include later private draft edits.',
    review: 'Review the public version',
    original: 'Original reviewed version',
    current: 'Version available for a new review',
    catalogue: 'Book',
    revision: 'Private structure revision',
    publication: 'Original public version',
    confirm: 'Use this version for preparation',
    continue: 'Continue preparation',
    retry: 'Retry the same step',
    refresh: 'Read the current owner version',
    sourceSize: 'Placements in the captured source',
    preparing: 'Preparing one bounded step…',
    ready: 'The next step is ready',
    unknown:
      'The last step may have finished. Retry its original request to recover the result. Its version and operation key stay the same.',
    stale:
      'The structure or public version changed. The original reviewed version is kept below. Read the current owner version, then explicitly review it to start a new preparation intent.',
    unavailable: 'Preparation is unavailable. Read the current owner version to review a new intent.',
    noPublication: 'This Book has no public version to prepare. Open point editing for private draft work.',
    done: 'The private baseline is ready. Preparation has not published anything. Point editing rechecks the original public version before publishing a point change.',
    point: 'Open point editing',
    ended: 'This private preparation visit has ended. Reopen the Book to continue.',
    readFailed:
      'The owner version could not be read. The last acknowledged private progress and any unknown step are kept. Retry the read separately.',
    next: 'Next step',
    steps: {
      startBuild: 'Capture the original public source',
      build: 'Build one source page',
      seal: 'Seal source coverage',
      receive: 'Begin private baseline receiving',
      apply: 'Apply one private baseline page',
      complete: 'Verify the private baseline',
    },
  },
  'zh-Hant': {
    heading: '準備這本書的單點編輯',
    entry: '準備舊版公開書籍',
    private: '準備程序會從原始公開版本建立私人基準，不會發布、替換公開版本，也不會納入之後的私人草稿修改。',
    review: '檢視公開版本',
    original: '原先確認的版本',
    current: '可重新確認的版本',
    catalogue: '書籍',
    revision: '私人結構修訂版',
    publication: '原始公開版本',
    confirm: '以此版本進行準備',
    continue: '繼續準備',
    retry: '重試同一步驟',
    refresh: '讀取目前的作者版本',
    sourceSize: '擷取來源中的配置數量',
    preparing: '正在執行一個有界步驟…',
    ready: '可以執行下一步',
    unknown: '上一步可能已完成。請重試原始請求以取得結果，版本與操作金鑰將保持不變。',
    stale: '結構或公開版本已變更。下方保留原先確認的版本。請讀取目前的作者版本，再明確確認，以建立新的準備意圖。',
    unavailable: '目前無法準備。請讀取目前的作者版本，重新確認準備內容。',
    noPublication: '這本書尚無可準備的公開版本。可前往單點編輯處理私人草稿。',
    done: '私人基準已就緒。準備程序並未發布任何內容。單點編輯在發布變更前，仍會重新檢查原始公開版本。',
    point: '開啟單點編輯',
    ended: '此私人準備作業已結束。請重新開啟書籍以繼續。',
    readFailed: '無法讀取作者版本。已確認的私人進度與結果不明的步驟仍會保留。請另行重試讀取。',
    next: '下一步',
    steps: {
      startBuild: '擷取原始公開來源',
      build: '建立一頁來源',
      seal: '封存完整來源',
      receive: '開始接收私人基準',
      apply: '套用一頁私人基準',
      complete: '驗證私人基準',
    },
  },
  'zh-Hans': {
    heading: '准备这本书的单点编辑',
    entry: '准备旧版公开书籍',
    private: '准备过程会从原始公开版本建立私人基准，不会发布、替换公开版本，也不会纳入之后的私人草稿修改。',
    review: '检查公开版本',
    original: '原先确认的版本',
    current: '可重新确认的版本',
    catalogue: '书籍',
    revision: '私人结构修订版',
    publication: '原始公开版本',
    confirm: '使用此版本进行准备',
    continue: '继续准备',
    retry: '重试同一步骤',
    refresh: '读取当前作者版本',
    sourceSize: '所捕获来源中的配置数量',
    preparing: '正在执行一个有界步骤…',
    ready: '可以执行下一步',
    unknown: '上一步可能已完成。请重试原始请求以获取结果，版本与操作密钥将保持不变。',
    stale: '结构或公开版本已变更。下方保留原先确认的版本。请读取当前作者版本，再明确确认，以建立新的准备意图。',
    unavailable: '目前无法准备。请读取当前作者版本，重新确认准备内容。',
    noPublication: '这本书尚无可准备的公开版本。可前往单点编辑处理私人草稿。',
    done: '私人基准已就绪。准备过程并未发布任何内容。单点编辑在发布变更前，仍会重新检查原始公开版本。',
    point: '打开单点编辑',
    ended: '此私人准备会话已结束。请重新打开书籍以继续。',
    readFailed: '无法读取作者版本。已确认的私人进度与结果不明的步骤仍会保留。请单独重试读取。',
    next: '下一步',
    steps: {
      startBuild: '捕获原始公开来源',
      build: '建立一页来源',
      seal: '封存完整来源',
      receive: '开始接收私人基准',
      apply: '应用一页私人基准',
      complete: '验证私人基准',
    },
  },
  ja: {
    heading: 'この本の個別編集を準備',
    entry: '従来の公開版がある本を準備',
    private:
      '元の公開版から非公開の基盤を作成します。公開版の差し替えや公開は行わず、その後の非公開下書きの変更も取り込みません。',
    review: '公開版を確認',
    original: '最初に確認した版',
    current: '新たに確認できる版',
    catalogue: '本',
    revision: '非公開構成のリビジョン',
    publication: '元の公開版',
    confirm: 'この版で準備する',
    continue: '準備を続ける',
    retry: '同じ手順を再試行',
    refresh: '現在の著者用の版を読み込む',
    sourceSize: '取得元に含まれる配置数',
    preparing: '範囲を限定した手順を実行中…',
    ready: '次の手順を実行できます',
    unknown:
      '直前の手順は完了している可能性があります。同じリクエストを再試行して結果を取得してください。版と操作キーは変わりません。',
    stale:
      '構成または公開版が変更されました。最初に確認した版を下に残しています。現在の著者用の版を読み込み、明示的に確認して新しい準備を開始してください。',
    unavailable: '準備できません。現在の著者用の版を読み込み、新しい準備内容を確認してください。',
    noPublication: '準備の対象となる公開版がありません。非公開下書きは個別編集で編集できます。',
    done: '非公開の基盤が整いました。この準備では何も公開していません。個別の変更を公開する前に、元の公開版を再確認します。',
    point: '個別編集を開く',
    ended: 'この非公開の準備セッションは終了しました。本を開き直してください。',
    readFailed:
      '著者用の版を読み込めませんでした。確認済みの非公開の進捗と結果不明の手順は保持しています。読み込みを個別に再試行してください。',
    next: '次の手順',
    steps: {
      startBuild: '元の公開版を取得',
      build: '取得元を1ページ構築',
      seal: '取得元の完全性を確定',
      receive: '非公開の基盤の受信を開始',
      apply: '非公開の基盤を1ページ適用',
      complete: '非公開の基盤を検証',
    },
  },
  ko: {
    heading: '이 책의 개별 편집 준비',
    entry: '기존 공개 책 준비',
    private:
      '원래 공개 버전에서 비공개 기준을 만듭니다. 공개하거나 공개 버전을 교체하지 않으며, 이후의 비공개 초안 변경도 포함하지 않습니다.',
    review: '공개 버전 검토',
    original: '처음 검토한 버전',
    current: '새로 검토할 수 있는 버전',
    catalogue: '책',
    revision: '비공개 구조 리비전',
    publication: '원래 공개 버전',
    confirm: '이 버전으로 준비',
    continue: '준비 계속',
    retry: '같은 단계 다시 시도',
    refresh: '현재 작성자 버전 읽기',
    sourceSize: '캡처한 원본의 배치 수',
    preparing: '범위가 제한된 한 단계를 준비하는 중…',
    ready: '다음 단계를 진행할 수 있습니다',
    unknown:
      '마지막 단계가 완료되었을 수 있습니다. 원래 요청을 다시 시도해 결과를 확인하세요. 버전과 작업 키는 그대로 유지됩니다.',
    stale:
      '구조 또는 공개 버전이 변경되었습니다. 처음 검토한 버전은 아래에 남아 있습니다. 현재 작성자 버전을 읽고 명시적으로 검토하여 새 준비를 시작하세요.',
    unavailable: '준비할 수 없습니다. 현재 작성자 버전을 읽고 새 준비 내용을 검토하세요.',
    noPublication: '준비할 공개 버전이 없습니다. 비공개 초안은 개별 편집에서 작업할 수 있습니다.',
    done: '비공개 기준이 준비되었습니다. 준비 과정에서는 아무것도 공개하지 않았습니다. 개별 변경을 공개하기 전에 원래 공개 버전을 다시 확인합니다.',
    point: '개별 편집 열기',
    ended: '이 비공개 준비 세션이 종료되었습니다. 책을 다시 열어 계속하세요.',
    readFailed:
      '작성자 버전을 읽지 못했습니다. 확인된 비공개 진행 상황과 결과를 모르는 단계는 유지됩니다. 읽기를 별도로 다시 시도하세요.',
    next: '다음 단계',
    steps: {
      startBuild: '원래 공개 원본 캡처',
      build: '원본 한 페이지 구성',
      seal: '원본 전체 범위 확정',
      receive: '비공개 기준 수신 시작',
      apply: '비공개 기준 한 페이지 적용',
      complete: '비공개 기준 검증',
    },
  },
  de: {
    heading: 'Dieses Buch für Einzeländerungen vorbereiten',
    entry: 'Buch mit bisheriger öffentlicher Version vorbereiten',
    private:
      'Die Vorbereitung erstellt eine private Grundlage aus der ursprünglichen öffentlichen Version. Sie veröffentlicht nichts, ersetzt keine öffentliche Version und übernimmt keine späteren privaten Entwurfsänderungen.',
    review: 'Öffentliche Version prüfen',
    original: 'Ursprünglich geprüfte Version',
    current: 'Version für eine neue Prüfung',
    catalogue: 'Buch',
    revision: 'Private Strukturrevision',
    publication: 'Ursprüngliche öffentliche Version',
    confirm: 'Diese Version für die Vorbereitung verwenden',
    continue: 'Vorbereitung fortsetzen',
    retry: 'Denselben Schritt wiederholen',
    refresh: 'Aktuelle Autorenversion lesen',
    sourceSize: 'Platzierungen in der erfassten Quelle',
    preparing: 'Ein begrenzter Schritt wird vorbereitet…',
    ready: 'Der nächste Schritt ist bereit',
    unknown:
      'Der letzte Schritt könnte abgeschlossen sein. Wiederholen Sie die ursprüngliche Anfrage, um das Ergebnis abzurufen. Version und Vorgangsschlüssel bleiben gleich.',
    stale:
      'Die Struktur oder öffentliche Version hat sich geändert. Die ursprünglich geprüfte Version bleibt unten erhalten. Lesen und prüfen Sie die aktuelle Autorenversion ausdrücklich, um eine neue Vorbereitung zu beginnen.',
    unavailable:
      'Die Vorbereitung ist nicht verfügbar. Lesen Sie die aktuelle Autorenversion und prüfen Sie eine neue Vorbereitung.',
    noPublication:
      'Dieses Buch hat keine öffentliche Version zur Vorbereitung. Private Entwürfe können Sie im Editor für Einzeländerungen bearbeiten.',
    done: 'Die private Grundlage ist bereit. Die Vorbereitung hat nichts veröffentlicht. Vor der Veröffentlichung einer Einzeländerung wird die ursprüngliche öffentliche Version erneut geprüft.',
    point: 'Editor für Einzeländerungen öffnen',
    ended: 'Diese private Vorbereitung ist beendet. Öffnen Sie das Buch erneut.',
    readFailed:
      'Die Autorenversion konnte nicht gelesen werden. Bestätigter privater Fortschritt und Schritte mit unbekanntem Ergebnis bleiben erhalten. Wiederholen Sie das Lesen getrennt.',
    next: 'Nächster Schritt',
    steps: {
      startBuild: 'Ursprüngliche öffentliche Quelle erfassen',
      build: 'Eine Quellseite aufbauen',
      seal: 'Vollständige Quellenabdeckung versiegeln',
      receive: 'Empfang der privaten Grundlage beginnen',
      apply: 'Eine Seite der privaten Grundlage anwenden',
      complete: 'Private Grundlage überprüfen',
    },
  },
  fr: {
    heading: 'Préparer ce livre aux modifications ponctuelles',
    entry: 'Préparer un livre public ancien',
    private:
      'La préparation crée une base privée à partir de la version publique d’origine. Elle ne publie rien, ne remplace pas la version publique et n’inclut pas les modifications privées ultérieures.',
    review: 'Examiner la version publique',
    original: 'Version examinée à l’origine',
    current: 'Version disponible pour un nouvel examen',
    catalogue: 'Livre',
    revision: 'Révision de la structure privée',
    publication: 'Version publique d’origine',
    confirm: 'Préparer à partir de cette version',
    continue: 'Continuer la préparation',
    retry: 'Réessayer la même étape',
    refresh: 'Lire la version actuelle de l’auteur',
    sourceSize: 'Emplacements dans la source capturée',
    preparing: 'Préparation d’une étape limitée…',
    ready: 'L’étape suivante est prête',
    unknown:
      'La dernière étape a peut-être abouti. Réessayez la requête d’origine pour récupérer le résultat. La version et la clé d’opération restent identiques.',
    stale:
      'La structure ou la version publique a changé. La version examinée à l’origine reste ci-dessous. Lisez puis examinez explicitement la version actuelle de l’auteur pour commencer une nouvelle préparation.',
    unavailable:
      'La préparation est indisponible. Lisez la version actuelle de l’auteur pour examiner une nouvelle préparation.',
    noPublication:
      'Ce livre n’a aucune version publique à préparer. Ouvrez l’éditeur ponctuel pour travailler sur le brouillon privé.',
    done: 'La base privée est prête. La préparation n’a rien publié. L’éditeur ponctuel revérifie la version publique d’origine avant de publier une modification.',
    point: 'Ouvrir l’éditeur ponctuel',
    ended: 'Cette préparation privée est terminée. Rouvrez le livre pour continuer.',
    readFailed:
      'La version de l’auteur n’a pas pu être lue. La progression privée confirmée et toute étape au résultat inconnu sont conservées. Réessayez la lecture séparément.',
    next: 'Étape suivante',
    steps: {
      startBuild: 'Capturer la source publique d’origine',
      build: 'Construire une page source',
      seal: 'Sceller la couverture de la source',
      receive: 'Commencer la réception de la base privée',
      apply: 'Appliquer une page de la base privée',
      complete: 'Vérifier la base privée',
    },
  },
  es: {
    heading: 'Preparar este libro para cambios puntuales',
    entry: 'Preparar un libro público anterior',
    private:
      'La preparación crea una base privada a partir de la versión pública original. No publica, no sustituye la versión pública ni incluye cambios posteriores del borrador privado.',
    review: 'Revisar la versión pública',
    original: 'Versión revisada originalmente',
    current: 'Versión disponible para una nueva revisión',
    catalogue: 'Libro',
    revision: 'Revisión de la estructura privada',
    publication: 'Versión pública original',
    confirm: 'Preparar a partir de esta versión',
    continue: 'Continuar la preparación',
    retry: 'Reintentar el mismo paso',
    refresh: 'Leer la versión actual del autor',
    sourceSize: 'Ubicaciones en la fuente capturada',
    preparing: 'Preparando un paso limitado…',
    ready: 'El siguiente paso está listo',
    unknown:
      'El último paso puede haber terminado. Repite la solicitud original para recuperar el resultado. La versión y la clave de operación se mantienen.',
    stale:
      'La estructura o la versión pública ha cambiado. La versión revisada originalmente se conserva debajo. Lee y revisa explícitamente la versión actual del autor para iniciar una nueva preparación.',
    unavailable:
      'La preparación no está disponible. Lee la versión actual del autor para revisar una nueva preparación.',
    noPublication:
      'Este libro no tiene una versión pública que preparar. Abre la edición puntual para trabajar en el borrador privado.',
    done: 'La base privada está lista. La preparación no ha publicado nada. La edición puntual vuelve a comprobar la versión pública original antes de publicar un cambio.',
    point: 'Abrir la edición puntual',
    ended: 'Esta sesión de preparación privada ha terminado. Vuelve a abrir el libro para continuar.',
    readFailed:
      'No se ha podido leer la versión del autor. Se conservan el progreso privado confirmado y cualquier paso con resultado desconocido. Reintenta la lectura por separado.',
    next: 'Siguiente paso',
    steps: {
      startBuild: 'Capturar la fuente pública original',
      build: 'Construir una página de la fuente',
      seal: 'Sellar la cobertura de la fuente',
      receive: 'Iniciar la recepción de la base privada',
      apply: 'Aplicar una página de la base privada',
      complete: 'Verificar la base privada',
    },
  },
} satisfies Record<Locale, Copy>;
