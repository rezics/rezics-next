import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { admitShowcaseImage } from '../../../services/main/src/modules/media/showcase-contract.ts';
import { checkZonePresentation } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { gamesCatalogue } from './games-catalogue.ts';
import { officialPresentation } from './official-plan.ts';
import { demoClassics } from '../../../tests/fixtures/sources/open-library.ts';
import { realms } from './plan.ts';
import { softwareCatalogue } from './software-catalogue.ts';
import { focal, logoSvg, renderArt, sizes, wholeImage } from './showcase-art.ts';
import { retainedSlides, showcaseSlides, showcaseUnarted, showcaseWorks, showcaseZone } from './showcase-plan.ts';

const known = new Set([...demoClassics.map(work => work.id), ...gamesCatalogue.map(game => game.id),
  ...softwareCatalogue.map(app => app.id)]);
const id = (name: string) => `https://rezics.com/id/${name.padEnd(8, '0').slice(0, 8)}-0000-7000-8000-000000000001`;
const workOf = (name: string) => id(name.replace(/[^a-f0-9]/g, 'a'));

describe('Showcase seed plan', () => {
  test('names Works of a book, a game and a piece of software, and one without art', () => {
    expect(showcaseWorks.map(work => work.kind).sort()).toEqual(['book', 'game', 'software']);
    for (const work of showcaseWorks) expect(known.has(work.id)).toBe(true);
    expect(known.has(showcaseUnarted[0])).toBe(true);
    expect(showcaseWorks.map(work => work.id)).not.toContain(showcaseUnarted[0]);
  });

  test('covers landscape and portrait backgrounds, logos in two languages and tones, one cutout and one trailer', () => {
    const keys = showcaseWorks.flatMap(work => work.slots);
    expect(keys.some(key => key.role === 'background-landscape')).toBe(true);
    expect(keys.some(key => key.role === 'background-portrait')).toBe(true);
    const logos = keys.flatMap(key => key.role === 'logo' ? [key] : []);
    expect(new Set(logos.map(key => key.language))).toEqual(new Set(['en', 'ja']));
    expect(new Set(logos.map(key => key.tone))).toEqual(new Set(['light', 'dark']));
    expect(keys.filter(key => key.role === 'cutout')).toHaveLength(1);
    expect(showcaseWorks.filter(work => work.trailer)).toHaveLength(1);
    // A slot is selected once: Main keeps one selection per role, and per language and tone for logos.
    for (const work of showcaseWorks) {
      const slots = work.slots.map(key => key.role === 'logo' ? `logo:${key.language}:${key.tone}` : key.role);
      expect(new Set(slots).size).toBe(slots.length);
    }
  });

  test('renders art Main admits: exact ratios and minimum sizes, with alpha on logos and cutouts', async () => {
    const work = showcaseWorks.find(item => item.slots.some(key => key.role === 'cutout'))!;
    for (const key of [...work.slots, ...showcaseWorks[0]!.slots]) {
      const bytes = await renderArt(work, key);
      const metadata = await sharp(bytes).metadata();
      expect({ width: metadata.width, height: metadata.height }).toEqual(sizes[key.role]);
      const area = key.role === 'background-landscape' || key.role === 'background-portrait' ? focal[key.role] : null;
      expect(admitShowcaseImage({ role: key.role, crop: wholeImage, focalArea: area },
        { width: metadata.width!, height: metadata.height!, hasAlpha: metadata.hasAlpha })).toEqual(sizes[key.role]);
      if (key.role === 'logo' || key.role === 'cutout') expect(metadata.hasAlpha).toBe(true);
    }
  });

  test('a logo names its own Work, sized to fit its plate', () => {
    const svg = '<svg><text x="300" font-size="70" letter-spacing="4">ASTRAL TIDE</text></svg>';
    expect(logoSvg(svg, 'Hades', 'en')).toContain('>Hades</text>');
    expect(logoSvg(svg, 'Pride and Prejudice', 'en')).toMatch(/font-size="4\d"/);
    expect(logoSvg(svg, 'Krita', 'en')).toContain('font-size="70"');
  });
});

describe('Showcase Zone slides', () => {
  const slides = showcaseSlides(workOf);

  test('are v2 slides the Zone layout accepts: work, link and scheduled', () => {
    const realm = realms.find(item => item.id === showcaseZone)!;
    const presentation = officialPresentation(showcaseZone, realm.preset, undefined, slides);
    expect(checkZonePresentation(presentation, [])).toBe(presentation);
    // The Zone's stage shows five slides at most.
    expect(slides.length).toBeLessThanOrEqual(5);
    expect(slides.some(slide => 'href' in slide)).toBe(true);
    expect(slides.filter(slide => 'work' in slide).length).toBeGreaterThanOrEqual(3);
    expect(slides.filter(slide => slide.startsAt && slide.endsAt)).toHaveLength(1);
  });

  test('mix the seeded Works and leave out a Work that does not exist yet', () => {
    expect(slides.filter(slide => 'work' in slide)).toHaveLength(4);
    const partial = showcaseSlides(name => name === 'pride' ? workOf(name) : undefined);
    expect(partial.map(slide => slide.id)).toEqual(['book-club', 'autumn-contest']);
  });

  test('are kept when the realms step replays the layout', () => {
    const realm = realms.find(item => item.id === showcaseZone)!;
    const written = officialPresentation(showcaseZone, realm.preset, undefined, slides);
    expect(retainedSlides(written)).toEqual(slides);
    expect(officialPresentation(showcaseZone, realm.preset, undefined, retainedSlides(written))).toEqual(written);
    expect(retainedSlides(undefined)).toEqual([]);
    expect(retainedSlides({ slides: 'none' })).toEqual([]);
  });
});
