import UniqueID from '@tiptap/extension-unique-id';
import { Plugin } from '@tiptap/pm/state';
import { identityPreservingBatch } from './editor-compact-transaction.ts';

/** A whole-batch proof; UniqueID's per-transaction filter can otherwise hide a structural sibling. */
export const IdentityUniqueID = UniqueID.extend({
  addProseMirrorPlugins() {
    const plugins: Plugin[] = this.parent?.() ?? [];
    return plugins.map((plugin) => {
      const append = plugin.spec.appendTransaction;
      if (!append) return plugin;
      return new Plugin({
        ...plugin.spec,
        appendTransaction(transactions, oldState, newState) {
          if (identityPreservingBatch(transactions)) return null;
          return append.call(this, transactions, oldState, newState);
        },
      });
    });
  },
});
