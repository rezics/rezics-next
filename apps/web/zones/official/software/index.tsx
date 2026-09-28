import { defineZonePackage } from '@rezics/zone-sdk';
import css from './software.css?raw';
import { SoftwareCard, SoftwareHero, SoftwareLists, SoftwareShelf } from './slots.tsx';

/** App directory cards lead to project-maintained download instructions. */
export default defineZonePackage({ slug: 'software', css,
  slots: { hero: SoftwareHero, workCard: SoftwareCard,
    modules: { shelf: SoftwareShelf, 'editorial-list': SoftwareLists } } });
