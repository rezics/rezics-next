export type SelectedEditorLive = { readonly id: number; live: () => boolean; retire: () => void };

/**
 * Every mounted selected-synopsis editor attempt has a unique identity. Replacing the visit,
 * including A/B/A, retires the earlier payload so a late result cannot restore it.
 */
export function selectedEditorAttempt() {
  let generation = 0;
  return {
    start(): SelectedEditorLive {
      const id = ++generation;
      return {
        id,
        live: () => generation === id,
        retire() {
          if (generation === id) generation += 1;
        },
      };
    },
    replace(): SelectedEditorLive {
      return this.start();
    },
  };
}
