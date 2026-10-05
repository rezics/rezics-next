import { mediaImageLabels, type MediaImageLabels } from '@rezics/ui/media-image';
import { defineMessages } from '../../i18n/define.ts';

export const mediaMessages = defineMessages<MediaImageLabels & { ratingFailed: string; retryRating: string }>({
  en: { ...mediaImageLabels, ratingFailed: 'The age rating could not be checked. Try again to show this text.', retryRating: 'Try again' },
  'zh-Hant': {
    ratingFailed: '無法確認年齡分級。請重試以顯示這段文字。', retryRating: '重試',
    loading: '正在載入內容偏好…', unavailable: '內容無法顯示', ratingHidden: '依照你的年齡分級偏好，這項內容已隱藏。',
    masked: '已遮罩的圖片', nsfw: 'NSFW 圖片', unknown: '圖片尚未評定 NSFW', reveal: '顯示圖片',
    conceal: '遮罩這張圖片', nsfwLabel: 'NSFW 標記', sfw: '非 NSFW', unassessed: '未評定', ageRating: '年齡分級', general: '一般',
    lock: '鎖定', unlock: '解鎖', locked: '已由平台管理員鎖定', saveFailed: '圖片設定無法儲存，請重試。',
  },
  'zh-Hans': {
    ratingFailed: '无法确认年龄分级。请重试以显示这段文字。', retryRating: '重试',
    loading: '正在加载内容偏好…', unavailable: '内容无法显示', ratingHidden: '根据你的年龄分级偏好，这项内容已隐藏。',
    masked: '已遮罩的图片', nsfw: 'NSFW 图片', unknown: '图片尚未评定 NSFW', reveal: '显示图片',
    conceal: '遮罩这张图片', nsfwLabel: 'NSFW 标记', sfw: '非 NSFW', unassessed: '未评定', ageRating: '年龄分级', general: '一般',
    lock: '锁定', unlock: '解锁', locked: '已由平台管理员锁定', saveFailed: '图片设置无法保存，请重试。',
  },
  ja: {
    ratingFailed: '年齢区分を確認できませんでした。本文を表示するには再試行してください。', retryRating: '再試行',
    loading: 'コンテンツの表示設定を読み込み中…', unavailable: 'コンテンツを表示できません', ratingHidden: '年齢区分の表示設定により、このコンテンツは非表示です。',
    masked: '隠された画像', nsfw: 'NSFW 画像', unknown: 'NSFW 未判定の画像', reveal: '画像を表示',
    conceal: 'この画像を隠す', nsfwLabel: 'NSFW ラベル', sfw: 'NSFW ではない', unassessed: '未判定', ageRating: '年齢区分', general: '全年齢',
    lock: 'ロック', unlock: 'ロック解除', locked: 'プラットフォーム管理者がロックしています', saveFailed: '画像の設定を保存できませんでした。再試行してください。',
  },
  ko: {
    ratingFailed: '연령 등급을 확인할 수 없습니다. 본문을 보려면 다시 시도하세요.', retryRating: '다시 시도',
    loading: '콘텐츠 표시 설정을 불러오는 중…', unavailable: '콘텐츠를 표시할 수 없습니다', ratingHidden: '연령 등급 표시 설정에 따라 이 콘텐츠가 숨겨졌습니다.',
    masked: '가려진 이미지', nsfw: 'NSFW 이미지', unknown: 'NSFW 미평가 이미지', reveal: '이미지 보기',
    conceal: '이 이미지 가리기', nsfwLabel: 'NSFW 표시', sfw: 'NSFW 아님', unassessed: '미평가', ageRating: '연령 등급', general: '전체 이용가',
    lock: '잠금', unlock: '잠금 해제', locked: '플랫폼 관리자가 잠갔습니다', saveFailed: '이미지 설정을 저장할 수 없습니다. 다시 시도하세요.',
  },
  de: {
    ratingFailed: 'Die Altersfreigabe konnte nicht geprüft werden. Versuche es erneut, um den Text anzuzeigen.', retryRating: 'Erneut versuchen',
    loading: 'Inhaltseinstellungen werden geladen…', unavailable: 'Inhalt nicht verfügbar', ratingHidden: 'Dieser Inhalt ist durch deine Altersfreigabe-Einstellungen ausgeblendet.',
    masked: 'Verdecktes Bild', nsfw: 'NSFW-Bild', unknown: 'Bild ohne NSFW-Bewertung', reveal: 'Bild anzeigen',
    conceal: 'Dieses Bild verdecken', nsfwLabel: 'NSFW-Kennzeichnung', sfw: 'Kein NSFW', unassessed: 'Nicht bewertet', ageRating: 'Altersfreigabe', general: 'Allgemein',
    lock: 'Sperren', unlock: 'Entsperren', locked: 'Von der Plattformadministration gesperrt', saveFailed: 'Die Bildeinstellung konnte nicht gespeichert werden. Versuche es erneut.',
  },
  fr: {
    ratingFailed: 'La classification par âge n’a pas pu être vérifiée. Réessayez pour afficher ce texte.', retryRating: 'Réessayer',
    loading: 'Chargement des préférences de contenu…', unavailable: 'Contenu indisponible', ratingHidden: 'Ce contenu est masqué selon vos préférences de classification par âge.',
    masked: 'Image masquée', nsfw: 'Image NSFW', unknown: 'Image sans évaluation NSFW', reveal: 'Afficher l’image',
    conceal: 'Masquer cette image', nsfwLabel: 'Mention NSFW', sfw: 'Non NSFW', unassessed: 'Non évalué', ageRating: 'Classification par âge', general: 'Tout public',
    lock: 'Verrouiller', unlock: 'Déverrouiller', locked: 'Verrouillé par l’administration de la plateforme', saveFailed: 'Le réglage de l’image n’a pas pu être enregistré. Réessayez.',
  },
  es: {
    ratingFailed: 'No se pudo comprobar la clasificación por edad. Vuelve a intentarlo para mostrar este texto.', retryRating: 'Volver a intentar',
    loading: 'Cargando preferencias de contenido…', unavailable: 'Contenido no disponible', ratingHidden: 'Este contenido está oculto según tus preferencias de clasificación por edad.',
    masked: 'Imagen cubierta', nsfw: 'Imagen NSFW', unknown: 'Imagen sin evaluación NSFW', reveal: 'Mostrar imagen',
    conceal: 'Cubrir esta imagen', nsfwLabel: 'Etiqueta NSFW', sfw: 'No NSFW', unassessed: 'Sin evaluar', ageRating: 'Clasificación por edad', general: 'General',
    lock: 'Bloquear', unlock: 'Desbloquear', locked: 'Bloqueado por la administración de la plataforma', saveFailed: 'No se pudo guardar la configuración de la imagen. Inténtalo de nuevo.',
  },
});
