package com.rezics.jena;

import org.apache.jena.graph.Node;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.system.Txn;

/** Empties the dataset a maintenance command serves, including the work-scope
 * proof graph. {@code deleteAny} is the removal jena-text records;
 * {@code clear()} on a wrapper skips that monitor. Raw update and the Graph
 * Store Protocol cannot call this. */
final class DatasetResetPolicy {
    static void reset(DatasetGraph data) {
        if (data.isInTransaction()) throw new IllegalStateException("dataset reset owns its write");
        // The write's commit goes through the halt helper. A thrown TDB2 commit
        // may already hold the writer lock, and this command must not return that store.
        data.begin(ReadWrite.WRITE);
        boolean committed = false;
        try {
            data.deleteAny(Node.ANY, Node.ANY, Node.ANY, Node.ANY);
            CommitHalt.commit(data);
            committed = true;
        } finally {
            // Text-index commit clears its transaction flag and still needs end.
            // A commit that threw already aborted and ended inside the halt helper.
            if (committed || data.isInTransaction()) data.end();
        }
        // The exclusive-writer flag is per-process state on the same store.
        // A graph clear does not drop it, so the next file would inherit it.
        Txn.executeRead(data, () -> {
            if (TemplateIndexService.workScopeNativeStorage(data))
                TemplateIndexService.withdrawWorkScopeWriter(data);
        });
        // The generation this audit requires was just deleted, so qualifying
        // here returns false. A process that proved exclusivity at startup
        // admits again when the fresh graph's audit succeeds.
        SearchDeltaJournal.dropQualification(data);
        SearchDeltaJournal.deferExclusiveAdmission(data);
    }

    private DatasetResetPolicy() {}
}
