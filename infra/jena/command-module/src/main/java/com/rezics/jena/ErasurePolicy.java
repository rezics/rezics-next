package com.rezics.jena;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
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
    private static final Node REVISION = NodeFactory.createURI("https://rezics.com/vocab/revision");
    private static final Node CONTENT_REVISION = NodeFactory.createURI("https://rezics.com/vocab/contentRevision");
    private static final Node ERASURE_EPOCH = NodeFactory.createURI("https://rezics.com/vocab/erasureEpoch");

    /** Content revision URNs and the revision IRIs reads already honour. `String.matches` is full-string. */
    static final String REVISION_TARGET =
        "(?:urn:rezics:content:revision:|https://rezics\\.com/id/)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

    /**
     * Every command with an erasure-graph receipt is admitted here, before it is applied.
     * The receipt text is not authority: each revision subject may gain only {@code ErasedRevision}
     * and {@code erasureEpoch}. A deleted quad, a changed quad, or a quad on any other subject is refused.
     * @return null when the command is that marker, otherwise the refusal
     */
    static String admitsMarker(CommandPolicy.Plan plan, String receipt) {
        if (receipt == null || !receipt.startsWith("urn:rezics:receipt:erasure-graph:"))
            return "not an erasure marker";
        if (plan == null || plan.request() == null) return "erasure command is not a marker";
        return markerFootprint(plan, receipt);
    }

    static String preflight(DatasetGraph data, CommandPolicy.Plan plan, String receipt) {
        if (ErasureRestorePolicy.applies(receipt)) return "held erasure requires its authenticated restore path";
        if (receipt.startsWith("urn:rezics:receipt:erasure-graph:")) {
            String marker = admitsMarker(plan, receipt);
            if (marker != null) return marker;
        }
        Update update = plan.request().getOperations().getFirst();
        List<Quad> inserts = update instanceof UpdateModify modify ? modify.getInsertQuads()
            : update instanceof UpdateDataInsert insert ? insert.getQuads() : new ArrayList<>();
        for (Quad quad : inserts) {
            if (erased(data, quad.getSubject()) || erased(data, quad.getObject()))
                return "erased exact revision cannot be reactivated";
        }
        return null;
    }

    private static String markerFootprint(CommandPolicy.Plan plan, String receipt) {
        Update update = plan.request().getOperations().getFirst();
        List<Quad> inserts = update instanceof UpdateModify modify ? modify.getInsertQuads()
            : update instanceof UpdateDataInsert insert ? insert.getQuads() : new ArrayList<>();
        if (!receipt.matches("urn:rezics:receipt:erasure-graph:[0-9a-f]{64}")
            || !plan.current().isEmpty() || !plan.source().isEmpty()
            || plan.revisions().isEmpty()
            || !plan.graphs().equals(Set.of(CommandPolicy.CONTROL, CommandPolicy.REVISIONS,
                CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX, CommandPolicy.PUBLIC_SEARCH,
                CommandPolicy.PRIVATE_SEARCH))
            || plan.revisions().stream().anyMatch(subject -> !subject.matches(REVISION_TARGET)))
            return "erasure graph footprint differs";
        for (Quad quad : inserts) {
            String graph = quad.getGraph().getURI();
            if (graph.equals(CommandPolicy.PUBLIC_SEARCH) || graph.equals(CommandPolicy.PRIVATE_SEARCH))
                return "erasure cannot insert indexed content";
            if (graph.equals(CommandPolicy.REVISIONS)
                && !(quad.getPredicate().equals(RDF.type.asNode()) && quad.getObject().equals(ERASED)
                    || quad.getPredicate().equals(ERASURE_EPOCH) && quad.getObject().isLiteral()))
                return "erasure may insert only an exact tombstone";
        }
        for (String subject : plan.revisions()) {
            boolean type = false, epoch = false;
            for (Quad quad : inserts) {
                if (!quad.getGraph().getURI().equals(CommandPolicy.REVISIONS) || !quad.getSubject().isURI()
                    || !quad.getSubject().getURI().equals(subject)) continue;
                if (quad.getPredicate().equals(RDF.type.asNode()) && quad.getObject().equals(ERASED)) type = true;
                if (quad.getPredicate().equals(ERASURE_EPOCH) && quad.getObject().isLiteral()) epoch = true;
            }
            if (!type || !epoch) return "erasure may insert only an exact tombstone";
        }
        if (update instanceof UpdateModify modify) for (Quad quad : modify.getDeleteQuads()) {
            if (Set.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS, CommandPolicy.SOURCE)
                .contains(quad.getGraph().getURI())) return "erasure cannot remove owner history";
        }
        return null;
    }

    private static boolean erased(DatasetGraph data, Node node) {
        return node.isURI() && data.contains(REVISIONS, node, RDF.type.asNode(), ERASED);
    }

    /** A tombstone cannot commit while a public or private unit still names its exact revision. */
    static String check(DatasetGraph data, CommandPolicy.Plan plan) {
        for (String subject : plan.revisions()) {
            Node target = NodeFactory.createURI(subject);
            if (!data.contains(REVISIONS, target, RDF.type.asNode(), ERASED)) continue;
            if (indexedReference(data, target))
                return "erased exact revision still has an indexed unit";
        }
        return null;
    }

    static boolean indexedReference(DatasetGraph data, Node target) {
        for (String graph : List.of(CommandPolicy.PUBLIC_SEARCH, CommandPolicy.PRIVATE_SEARCH))
            for (Node predicate : List.of(REVISION, CONTENT_REVISION))
                if (data.contains(NodeFactory.createURI(graph), Node.ANY, predicate, target)) return true;
        return false;
    }

    private ErasurePolicy() {}
}
