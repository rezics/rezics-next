import type { WikiMessages } from '../messages.ts';

export default {
  region: 'Position de lecture',
  upTo: 'Jusqu’à :',
  upToEverything: 'Tout est affiché',
  yourProgress: 'votre progression',
  startOfStory: 'début de l’histoire',
  chosen: 'votre choix',
  showEverything: 'Tout afficher',
  sheetTitle: 'Lire jusqu’à',
  sheetBody: 'Les pages montrent seulement ce que l’histoire a révélé jusqu’à la position choisie.',
  progressOption: 'Votre propre progression',
  progressNote: 'Actuellement',
  progressNoneNote: 'Vous n’avez pas encore terminé de chapitre : vous commencez au premier.',
  everythingOption: 'Tout afficher',
  everythingNote: 'Inclut les fiches révélées dans des chapitres que vous n’avez pas lus.',
  moreChapters: 'L’histoire compte plus de chapitres que cette liste. Utilisez Tout afficher pour le reste.',
  unavailable: 'La position de lecture ne peut pas être choisie pour le moment.',
  // Machine-drafted; needs native review.
  numberSeekUnavailable: 'Le saut par numéro n’est pas encore disponible pour cette série. Parcourez la liste ou recherchez par titre.',
  close: 'Fermer',
} satisfies WikiMessages;
