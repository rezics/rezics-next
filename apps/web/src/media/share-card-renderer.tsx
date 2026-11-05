import satori, { init, type Font } from 'satori/standalone';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { ShareCardView } from './share-card-view';
import { shareCardSize, type ShareCardPage } from './share-card';

export type ShareCardAssets = {
  layout: WebAssembly.Module;
  raster: WebAssembly.Module;
  fonts: (page: ShareCardPage) => Font[];
};

/** One server-owned renderer per isolate. Only immutable local modules/fonts are retained. */
export function createShareCardRenderer(assets: ShareCardAssets) {
  let ready: Promise<void> | undefined;
  return async (page: ShareCardPage): Promise<Uint8Array<ArrayBuffer>> => {
    ready ??= Promise.all([init(assets.layout), initWasm(assets.raster)]).then(() => undefined);
    await ready;
    const fonts = assets.fonts(page);
    if (
      !fonts.length ||
      fonts.length > 6 ||
      fonts.reduce((size, font) => size + font.data.byteLength, 0) > 16 * 1024 * 1024
    )
      throw new Error('Share card font bound exceeded');
    const svg = await satori(<ShareCardView page={page} />, { ...shareCardSize, fonts, embedFont: true });
    const raster = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'original' } });
    try {
      const image = raster.render();
      try {
        if (image.width !== shareCardSize.width || image.height !== shareCardSize.height)
          throw new Error('Invalid share card dimensions');
        return new Uint8Array(image.asPng());
      } finally {
        image.free();
      }
    } finally {
      raster.free();
    }
  };
}
