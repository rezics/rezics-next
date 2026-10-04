import { defineCases } from './types.ts';

export const cases = defineCases('docs/operations/trust-and-safety.md', [
  {
    id: 'SAFETY01',
    scenario: 'Public reporting without an account and with a suspended Account bearer',
    requiredResult:
      'Intake and private correspondence remain reachable without restoring posting authority.',
  },
  {
    id: 'SAFETY02',
    scenario: 'A valid NCII request covers an original and known identical copies',
    requiredResult:
      'Receipt fixes the 48-hour deadline; originals, uses and later identical uploads are withheld within it.',
  },
  {
    id: 'SAFETY03',
    scenario: 'NCII deadline elapses without a completed response',
    requiredResult:
      'A durable deadline alert reaches a responder independently of optional notifications.',
  },
  {
    id: 'SAFETY04',
    scenario: 'NSFW image classifier is unavailable',
    requiredResult:
      'Presentation evidence remains unknown, manual labeling is available and no governance hold is created; uploads are delivered with viewer presentation preferences, retaining attributable, replay-safe evidence and corrections.',
  },
  {
    id: 'SAFETY05',
    scenario: 'An affected party appeals an enforcement decision',
    requiredResult:
      'Staff answer the retained appeal with reasons and attributable, replay-safe effects.',
  },
  {
    id: 'SAFETY06',
    scenario: 'An uploader requests deletion under a preservation hold',
    requiredResult: 'Deletion cannot destroy held bytes; postponement retains the hold and reason.',
  },
  {
    id: 'SAFETY07',
    scenario: 'Optional notifications are disabled during safety enforcement',
    requiredResult:
      'Safety correspondence still reaches the affected party through a mandatory email channel.',
  },
  {
    id: 'SAFETY08',
    scenario: 'Primary responder is absent',
    requiredResult:
      'The configured backup receives an alert without needing to poll or claim the case first.',
  },
]);
