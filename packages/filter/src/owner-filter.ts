/** Private fact operands only. The consuming native plan binds viewer-self and admits each stored pin. */
export type OwnerLeaf = {
  readonly owner:
    | { readonly presence: true }
    | {
        readonly state: {
          readonly profileId: string;
          readonly stateSetId: string;
          readonly in: readonly string[];
        };
      }
    | { readonly label: { readonly id: string } }
    | {
        readonly session: {
          readonly profileId: string;
          readonly lifecycle: 'active' | 'completed' | 'abandoned';
        };
      }
    | { readonly holding: { readonly profileId: string; readonly kind?: string; readonly status?: string } };
};
