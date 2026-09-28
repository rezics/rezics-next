package com.rezics.jena;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Closed releases are not extended in place, and a virtual release stays virtual.
 * A web snapshot's bytes, once recorded, do not change. */
final class ReleasePolicy {
    private static final Node CURRENT = NodeFactory.createURI(CommandPolicy.CURRENT);
    private static final Node RECEIPTS = NodeFactory.createURI(CommandPolicy.RECEIPTS);
    private static final String RV = "https://rezics.com/vocab/";

    private ReleasePolicy() {}

    record Prior(String kind, String status, int languages, boolean translation, String head,
                 String digest, boolean release, boolean snapshot) {}

    static Map<String, Prior> capture(DatasetGraph data, CommandPolicy.Plan plan) {
        Map<String, Prior> prior = new HashMap<>();
        for (String subject : plan.current()) prior.put(subject, read(data, subject));
        return prior;
    }

    static String check(DatasetGraph data, CommandPolicy.Plan plan, String receipt, Map<String, Prior> before) {
        Node evidence = one(data, RECEIPTS, NodeFactory.createURI(receipt), rv("correctionEvidence"));
        for (String subject : plan.current()) {
            Prior was = before.get(subject);
            Prior now = read(data, subject);
            if (was != null && was.snapshot && (now == null || now.digest == null || !now.digest.equals(was.digest))) {
                return "web snapshot bytes are closed";
            }
            if (now == null || !now.release) continue;
            if (!paired(now.kind, now.status)) return "release kind and status disagree";
            if (was == null || !was.release) continue;
            if (was.kind != null && !was.kind.equals(now.kind)) return "release kind is closed";
            if (was.head != null && was.head.equals(now.head)) {
                if (was.languages != now.languages || was.translation != now.translation || !same(was.status, now.status)) {
                    return "closed release changed without a new revision";
                }
                continue;
            }
            if ("virtual".equals(was.kind)) {
                if (!"virtual".equals(now.status)) return "virtual status cannot become a publication claim";
                if (now.languages < was.languages) return "a virtual release keeps its content languages";
                boolean growthOnly = now.languages >= was.languages && was.translation == now.translation;
                if (!growthOnly && evidence == null) return "a release correction cites evidence";
                continue;
            }
            if (now.translation && !was.translation) return "a later translation is not added to a closed release";
            if (now.languages > was.languages) return "a closed release cannot gain languages";
            boolean structural = now.languages != was.languages || was.translation != now.translation
                || !same(was.status, now.status);
            if (structural && evidence == null) return "a release correction cites evidence";
        }
        return null;
    }

    private static boolean paired(String kind, String status) {
        if (kind == null || status == null) return false;
        boolean virtual = "virtual".equals(kind);
        if (virtual != "virtual".equals(status)) return false;
        return Set.of("formal", "web", "fixed", "virtual").contains(kind)
            && Set.of("official", "unofficial", "virtual", "withdrawn", "cancelled").contains(status);
    }

    private static Prior read(DatasetGraph data, String subject) {
        Node node = NodeFactory.createURI(subject);
        boolean release = data.contains(CURRENT, node, RDF.type.asNode(), rv("Release"));
        boolean snapshot = data.contains(CURRENT, node, RDF.type.asNode(), rv("WebSnapshot"));
        if (!release && !snapshot) return null;
        return new Prior(literal(data, node, "releaseKind"), literal(data, node, "releaseStatus"),
            tokens(literal(data, node, "contentLanguages")), "true".equals(literal(data, node, "isTranslation")),
            iri(data, node, "releaseHead"), literal(data, node, "byteDigest"), release, snapshot);
    }

    private static int tokens(String value) {
        if (value == null || value.isBlank()) return 0;
        return value.trim().split(" ").length;
    }

    private static boolean same(String left, String right) { return left == null ? right == null : left.equals(right); }

    private static String literal(DatasetGraph data, Node subject, String name) {
        Node value = one(data, CURRENT, subject, rv(name));
        return value != null && value.isLiteral() ? value.getLiteralLexicalForm() : null;
    }

    private static String iri(DatasetGraph data, Node subject, String name) {
        Node value = one(data, CURRENT, subject, rv(name));
        return value != null && value.isURI() ? value.getURI() : null;
    }

    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        Set<Node> values = new HashSet<>();
        data.find(graph, subject, predicate, Node.ANY).forEachRemaining(quad -> values.add(quad.getObject()));
        return values.size() == 1 ? values.iterator().next() : null;
    }

    private static Node rv(String name) { return NodeFactory.createURI(RV + name); }
}
