package com.rezics.jena;

import java.util.ArrayList;
import java.util.List;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateDataInsert;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.update.Update;
import org.apache.jena.vocabulary.RDF;

/** Exact-reference replay fence for a sanitized graph generation. */
final class ErasurePolicy {
    private static final Node REVISIONS = NodeFactory.createURI(CommandPolicy.REVISIONS);
    private static final Node ERASED = NodeFactory.createURI("https://rezics.com/vocab/ErasedRevision");

    static String preflight(DatasetGraph data, CommandPolicy.Plan plan) {
        Update update = plan.request().getOperations().getFirst();
        List<Quad> inserts = update instanceof UpdateModify modify ? modify.getInsertQuads()
            : update instanceof UpdateDataInsert insert ? insert.getQuads() : new ArrayList<>();
        for (Quad quad : inserts) {
            if (erased(data, quad.getSubject()) || erased(data, quad.getObject()))
                return "erased exact revision cannot be reactivated";
        }
        return null;
    }

    private static boolean erased(DatasetGraph data, Node node) {
        return node.isURI() && data.contains(REVISIONS, node, RDF.type.asNode(), ERASED);
    }

    private ErasurePolicy() {}
}
