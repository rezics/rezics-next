/** A bounded receiving representation, never proof that the named job committed.
 * The scheduler selects these fields from a committed job. A locator or encoded result
 * does not replace the command transaction or its durable checkpoint.
 */
export type CatalogueMechanicalInput = Readonly<{
  format: 'catalogue-mechanical-input/1';
  root: string;
  episode: string;
  position: string;
  deadline: number;
}> &
  (
    | Readonly<{ phase: 'step'; buildTransactionId: string }>
    | Readonly<{ phase: 'activation-step'; activationId: string }>
  );
export type CatalogueMechanicalResult =
  | Readonly<{ phase: 'step'; progress: import('./definition-catalogue-publication.ts').CatalogueBuildStatus }>
  | Readonly<{
      phase: 'activation-step';
      progress: import('./definition-catalogue-lifecycle.ts').CatalogueActivationProgress;
    }>;
