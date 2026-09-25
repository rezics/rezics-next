package com.rezics.jena;

import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Fixed private-source roles and receipt binding inside the command transaction. */
final class SourceProjectionPolicy {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node SOURCE = NodeFactory.createURI(CommandPolicy.SOURCE);
    private static final Node RECEIPTS = NodeFactory.createURI(CommandPolicy.RECEIPTS);
    private static final Set<String> RECORD = Set.of(RDF.type.getURI(), RV + "sourceProvider",
        RV + "sourceNamespace", RV + "sourceExternalId");
    private static final Set<String> OBSERVATION = Set.of(RDF.type.getURI(), RV + "sourceRecord",
        RV + "sourceByteDigest", RV + "sourceRevision", RV + "sourceCoverage",
        RV + "sourceRightsBasis", RV + "sourceRightsNote", RV + "sourceSubmittedAt",
        RV + "sourceFetchedAt");
    private static final Set<String> CONVERSION = Set.of(RDF.type.getURI(), RV + "sourceObservation",
        RV + "sourceKey", RV + "sourceTitle", RV + "sourceDescription",
        RV + "sourceAuthorRefsJson", RV + "sourceSubjectsJson", RV + "sourceByteDigest",
        RV + "sourceMappingRevision");

    static String check(DatasetGraph data, String receipt, CommandPolicy.Plan plan) {
        if (plan.source().isEmpty()) return null;
        Node own = NodeFactory.createURI(receipt);
        Node record = one(data, RECEIPTS, own, "sourceRecord");
        Node observation = one(data, RECEIPTS, own, "sourceObservation");
        Node conversion = one(data, RECEIPTS, own, "sourceConversion");
        Node digest = one(data, RECEIPTS, own, "sourceByteDigest");
        Node mapping = one(data, RECEIPTS, own, "sourceMappingRevision");
        if (!nativeId(record) || !nativeId(observation) || !nativeId(conversion)
            || record.equals(observation) || record.equals(conversion) || observation.equals(conversion)
            || !plan.source().equals(Set.of(record.getURI(), observation.getURI(), conversion.getURI()))
            || !text(digest, "[0-9a-f]{64}") || !text(mapping, "open-library-work-map-v1")
            || !data.contains(RECEIPTS, own, rv("outcome"), rv("Succeeded")))
            return "source projection receipt identity differs";
        if (!data.contains(SOURCE, record, RDF.type.asNode(), rv("SourceRecord"))
            || !data.contains(SOURCE, observation, RDF.type.asNode(), rv("SourceObservation"))
            || !data.contains(SOURCE, conversion, RDF.type.asNode(), rv("SourceConversion"))
            || !record.equals(one(data, SOURCE, observation, "sourceRecord"))
            || !observation.equals(one(data, SOURCE, conversion, "sourceObservation"))
            || !digest.equals(one(data, SOURCE, observation, "sourceByteDigest"))
            || !digest.equals(one(data, SOURCE, conversion, "sourceByteDigest"))
            || !mapping.equals(one(data, SOURCE, conversion, "sourceMappingRevision")))
            return "source projection graph links differ from receipt";
        Node external = one(data, SOURCE, record, "sourceExternalId");
        Node key = one(data, SOURCE, conversion, "sourceKey");
        if (external == null || !external.isLiteral() || key == null || !key.isLiteral()
            || !key.getLiteralLexicalForm().equals("/works/" + external.getLiteralLexicalForm()))
            return "source Work key differs from record identity";
        for (Map.Entry<Node, Set<String>> role : Map.of(record, RECORD,
            observation, OBSERVATION, conversion, CONVERSION).entrySet()) {
            var quads = data.find(SOURCE, role.getKey(), Node.ANY, Node.ANY);
            while (quads.hasNext()) {
                var quad = quads.next();
                if (!quad.getPredicate().isURI()
                    || !role.getValue().contains(quad.getPredicate().getURI()))
                    return "source projection contains an unreviewed predicate";
                if (RDF.type.asNode().equals(quad.getPredicate())
                    && !quad.getObject().equals(role.getKey().equals(record) ? rv("SourceRecord")
                        : role.getKey().equals(observation) ? rv("SourceObservation") : rv("SourceConversion")))
                    return "source projection contains an unreviewed type";
            }
        }
        return null;
    }

    private static Node one(DatasetGraph data, Node graph, Node subject, String property) {
        var values = data.find(graph, subject, rv(property), Node.ANY);
        if (!values.hasNext()) return null;
        Node value = values.next().getObject();
        return values.hasNext() ? null : value;
    }
    private static boolean nativeId(Node node) {
        return node != null && node.isURI()
            && node.getURI().matches("https://rezics\\.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}");
    }
    private static boolean text(Node node, String pattern) {
        return node != null && node.isLiteral() && node.getLiteralLexicalForm().matches(pattern);
    }
    private static Node rv(String local) { return NodeFactory.createURI(RV + local); }
    private SourceProjectionPolicy() {}
}
