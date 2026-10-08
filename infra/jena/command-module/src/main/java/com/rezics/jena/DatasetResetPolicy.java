package com.rezics.jena;

import org.apache.jena.graph.Node;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.system.Txn;

/** Empties the dataset a maintenance command serves, including the work-scope
 * proof graph. {@code deleteAny} is the removal jena-text records;
 * {@code clear()} on a wrapper skips that monitor. Raw update and the Graph
 * Store Protocol cannot call this. */
final class DatasetResetPolicy {
    static void reset(DatasetGraph data) {
        if (data.isInTransaction()) throw new IllegalStateException("dataset reset owns its write");
        Txn.executeWrite(data, () -> data.deleteAny(Node.ANY, Node.ANY, Node.ANY, Node.ANY));
        // The exclusive-writer flag is per-process state on the same store.
        // A graph clear does not drop it, so the next file would inherit it.
        Txn.executeRead(data, () -> {
            if (TemplateIndexService.workScopeNativeStorage(data))
                TemplateIndexService.withdrawWorkScopeWriter(data);
        });
    }

    private DatasetResetPolicy() {}
}
