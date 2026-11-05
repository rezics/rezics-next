import { createKernelClient } from '@rezics/client';
import { env } from 'cloudflare:workers';
import layout from 'satori/layout.wasm?module';
import raster from '@resvg/resvg-wasm/index_bg.wasm?module';
import latin from '@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff?inline';
import extended from '@fontsource/source-serif-4/files/source-serif-4-latin-ext-600-normal.woff?inline';
import simplified from '@fontsource/noto-serif-sc/files/noto-serif-sc-chinese-simplified-400-normal.woff?inline';
import traditional from '@fontsource/noto-serif-tc/files/noto-serif-tc-chinese-traditional-400-normal.woff?inline';
import japanese from '@fontsource/noto-serif-jp/files/noto-serif-jp-japanese-400-normal.woff?inline';
import korean from '@fontsource/noto-serif-kr/files/noto-serif-kr-korean-400-normal.woff?inline';
import type { Font } from 'satori/standalone';
import { requestLanguages } from '../kernel/languages';
import { readShareCardPage } from './share-card-page';
import { createShareCardRenderer } from './share-card-renderer';
import { shareCardResponse, type ShareCardPage } from './share-card';

const bundledFonts = new Map<string, Font>();

function font(data: string): Font {
  const cached = bundledFonts.get(data);
  if (cached) return cached;
  const encoded = /^data:[^,]+;base64,(.+)$/.exec(data)?.[1];
  if (!encoded) throw new Error('Bundled share card font unavailable');
  const value: Font = {
    name: 'Share Serif',
    data: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)).buffer,
    weight: 600,
    style: 'normal',
  };
  bundledFonts.set(data, value);
  return value;
}

function fonts(page: ShareCardPage): Font[] {
  const cjk = new Set<string>();
  if (/\p{Script=Han}/u.test(page.title))
    cjk.add(
      page.locale === 'zh-Hant'
        ? traditional
        : page.locale === 'ja'
          ? japanese
          : page.locale === 'ko'
            ? korean
            : simplified,
    );
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(page.title)) cjk.add(japanese);
  if (/\p{Script=Hangul}/u.test(page.title)) cjk.add(korean);
  return [latin, extended, ...cjk].map(font);
}

const render = createShareCardRenderer({ layout, raster, fonts });

export function currentShareCardResponse(request: Request): Promise<Response> {
  return shareCardResponse(request, {
    read: async (target) => {
      const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
      if (!origin) return { kind: 'unavailable' };
      const client = createKernelClient(origin, {
        headers: { 'accept-language': requestLanguages(target.locale).join(', ') },
      });
      return readShareCardPage(client, target);
    },
    render,
  });
}
