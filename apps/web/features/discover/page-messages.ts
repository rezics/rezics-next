import { insert } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

export const pageMessages = defineMessages({
  en: { freshness: insert('Results as of change {{sequence}}', { sequence: String }),
    stale: 'New and changed works may still be missing. Check again shortly.' },
  'zh-Hant': { freshness: insert('結果更新至變更 {{sequence}}', { sequence: String }),
    stale: '新增或變更的作品可能尚未顯示，請稍後再查看。' },
  'zh-Hans': { freshness: insert('结果更新至变更 {{sequence}}', { sequence: String }),
    stale: '新增或变更的作品可能尚未显示，请稍后再查看。' },
  ja: { freshness: insert('変更 {{sequence}} 時点の結果', { sequence: String }),
    stale: '新規または変更された作品がまだ表示されていない場合があります。しばらくしてから再確認してください。' },
  ko: { freshness: insert('변경 {{sequence}} 기준 결과', { sequence: String }),
    stale: '새로 추가되거나 변경된 작품이 아직 표시되지 않을 수 있습니다. 잠시 후 다시 확인하세요.' },
  de: { freshness: insert('Ergebnisse mit Stand der Änderung {{sequence}}', { sequence: String }),
    stale: 'Neue und geänderte Werke fehlen möglicherweise noch. Schau in Kürze erneut nach.' },
  fr: { freshness: insert('Résultats à jour au changement {{sequence}}', { sequence: String }),
    stale: 'Des œuvres nouvelles ou modifiées peuvent encore manquer. Réessayez dans un instant.' },
  es: { freshness: insert('Resultados actualizados hasta el cambio {{sequence}}', { sequence: String }),
    stale: 'Puede que aún falten obras nuevas o modificadas. Vuelve a consultar en breve.' },
});
