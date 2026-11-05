import { placeholderColors } from '@rezics/ui/cover';
import { shareCardSize, shareCardTitle, type ShareCardPage } from './share-card';

/** The Cover placeholder's id colour, Work title face, generous inset and ruled byline, in a sharing frame. */
export function ShareCardView({ page, fontFamily = 'Share Serif' }: { page: ShareCardPage; fontFamily?: string }) {
  const colors = placeholderColors(page);
  const title = shareCardTitle(page.title);
  const longest = title
    .split(/[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}-]+/u)
    .reduce((length, word) => Math.max(length, Array.from(word).length), 1);
  return (
    <div
      lang={page.locale}
      style={{
        ...shareCardSize,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        overflow: 'hidden',
        backgroundColor: colors.background,
        color: colors.foreground,
        fontFamily,
      }}
    >
      <div style={{ display: 'flex', height: 352, overflow: 'hidden' }}>
        <div style={{ fontSize: Math.min(72, 1056 / longest), lineHeight: 1.2, fontWeight: 600, lineClamp: 4 }}>
          {title}
        </div>
      </div>
      <div style={{ display: 'flex', paddingTop: 24, borderTop: `1px solid ${colors.foreground}66`, fontSize: 28 }}>
        REZICS
      </div>
    </div>
  );
}
