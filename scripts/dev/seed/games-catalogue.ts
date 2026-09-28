/** Public store descriptions checked against the linked publisher listings in September 2026.
 * Dates and review totals deliberately stay unknown when the seed has no current snapshot. */
export interface SeedGame {
  id: string; title: string; pitch: string; source: string;
  status: 'released' | 'upcoming'; tags: readonly string[];
  platforms: readonly string[]; languages: readonly string[]; mods: boolean;
}

export const gamesCatalogue: readonly SeedGame[] = [
  { id: 'game-stardew', title: 'Stardew Valley', pitch: 'Build a farm and settle into a small town.',
    source: 'https://store.steampowered.com/app/413150/Stardew_Valley/', status: 'released',
    tags: ['Farming', 'Life sim'], platforms: ['Windows'], languages: ['English'], mods: true },
  { id: 'game-hollow-knight', title: 'Hollow Knight', pitch: 'Explore a ruined kingdom beneath the surface.',
    source: 'https://store.steampowered.com/app/367520/Hollow_Knight/', status: 'released',
    tags: ['Metroidvania', 'Exploration'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-celeste', title: 'Celeste', pitch: 'Climb a mountain one demanding screen at a time.',
    source: 'https://store.steampowered.com/app/504230/Celeste/', status: 'released',
    tags: ['Platformer', 'Precision'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-hades', title: 'Hades', pitch: 'Fight your way out of the underworld as Zagreus.',
    source: 'https://store.steampowered.com/app/1145360/Hades/', status: 'released',
    tags: ['Roguelike', 'Action'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-hades-2', title: 'Hades II', pitch: 'Take on the Titan of Time as Melinoë.',
    source: 'https://store.steampowered.com/app/1145350/Hades_II/', status: 'released',
    tags: ['Roguelike', 'Action'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-terraria', title: 'Terraria', pitch: 'Dig, build and fight through a world you can reshape.',
    source: 'https://store.steampowered.com/app/105600/Terraria/', status: 'released',
    tags: ['Sandbox', 'Crafting'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-slay-spire', title: 'Slay the Spire', pitch: 'Build a deck as you climb a changing tower.',
    source: 'https://store.steampowered.com/app/646570/Slay_the_Spire/', status: 'released',
    tags: ['Deckbuilding', 'Roguelike'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-outer-wilds', title: 'Outer Wilds', pitch: 'Investigate a solar system caught in a time loop.',
    source: 'https://store.steampowered.com/app/753640/Outer_Wilds/', status: 'released',
    tags: ['Exploration', 'Mystery'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-minecraft', title: 'Minecraft', pitch: 'Build and explore a world made of blocks.',
    source: 'https://www.minecraft.net/en-us/about-minecraft', status: 'released',
    tags: ['Sandbox', 'Building'], platforms: ['Windows'], languages: ['English'], mods: true },
  { id: 'game-baldurs-gate-3', title: 'Baldur’s Gate 3', pitch: 'Travel through the Forgotten Realms with a party shaped by your choices.',
    source: 'https://store.steampowered.com/app/1086940/Baldurs_Gate_3/', status: 'released',
    tags: ['Role-playing', 'Choices'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-witchbrook', title: 'Witchbrook', pitch: 'Study magic and make a life in the seaside town of Mossport.',
    source: 'https://store.steampowered.com/app/1846700/Witchbrook/', status: 'upcoming',
    tags: ['Life sim', 'Magic'], platforms: ['Windows'], languages: ['English'], mods: false },
  { id: 'game-light-no-fire', title: 'Light No Fire', pitch: 'Explore and build together on a large fantasy planet.',
    source: 'https://store.steampowered.com/app/2719590/Light_No_Fire/', status: 'upcoming',
    tags: ['Exploration', 'Survival'], platforms: ['Windows'], languages: ['English'], mods: false },
];
