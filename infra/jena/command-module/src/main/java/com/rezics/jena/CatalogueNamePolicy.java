package com.rezics.jena;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.modify.request.UpdateModify;

/** Names-only refreshes keep the body's existing receipt identity. Validate
 * their exact current owner recipe rather than accepting a new body claim. */
final class CatalogueNamePolicy {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static final Node PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH), CURRENT = uri(CommandPolicy.CURRENT),
        REVISIONS = uri(CommandPolicy.REVISIONS), RECEIPTS = uri(CommandPolicy.RECEIPTS);
    static boolean namesOnly(CommandPolicy.Plan plan) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return false;
        return java.util.stream.Stream.concat(modify.getInsertQuads().stream(), modify.getDeleteQuads().stream())
            .filter(quad -> PUBLIC.equals(quad.getGraph())).allMatch(quad -> rv("publicTitle").equals(quad.getPredicate()));
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var found = data.find(graph, subject, predicate, Node.ANY);
        try {
            if (!found.hasNext()) return null;
            Node value = found.next().getObject();
            return found.hasNext() ? null : value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(found); }
    }
    static Set<Node> expected(DatasetGraph data, Node work) {
        Set<Node> names = new HashSet<>();
        for (Node predicate : List.of(uri("http://www.w3.org/2000/01/rdf-schema#label"),
            uri("https://schema.org/name"), uri("https://schema.org/alternateName"))) {
            var rows = data.find(CURRENT, work, predicate, Node.ANY);
            try { while (rows.hasNext()) names.add(rows.next().getObject()); }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        }
        Node metadata = one(data, CURRENT, work, rv("descriptiveMetadataHead"));
        if (metadata != null && !data.contains(REVISIONS, metadata,
            org.apache.jena.vocabulary.RDF.type.asNode(), rv("ErasedRevision"))) {
            Node payload = one(data, REVISIONS, metadata, rv("metadataState"));
            if (payload == null || !payload.isLiteral()) throw new IllegalArgumentException("name metadata is incomplete");
            var header = JSON.parse(payload.getLiteralLexicalForm());
            if (!"header".equals(header.get("kind").getAsString().value()))
                throw new IllegalArgumentException("name metadata is not a header");
            if (!header.get("originalTitle").isNull()) {
                var original = header.get("originalTitle").getAsObject();
                names.add(NodeFactory.createLiteralLang(original.get("value").getAsString().value(),
                    original.get("language").getAsString().value()));
            }
            for (var entry : header.get("localized").getAsArray()) {
                var locale = entry.getAsObject();
                if (!locale.get("title").isNull()) names.add(NodeFactory.createLiteralLang(
                    locale.get("title").getAsString().value(), locale.get("language").getAsString().value()));
            }
        }
        if (names.size() > 64 || names.stream().anyMatch(name -> !name.isLiteral()
            || name.getLiteralLexicalForm().isEmpty() || name.getLiteralLexicalForm().length() > 500))
            throw new IllegalArgumentException("name recipe exceeds its bound");
        return names;
    }
    static String check(DatasetGraph data, String receipt, List<SearchDeltaJournal.Change> changes) {
        Node receiptWork = one(data, RECEIPTS, uri(receipt), rv("work"));
        for (var change : changes) {
            if (!change.before() || !change.after()) return "name refresh changed MatchUnit membership";
            Node unit = uri(change.unit()), work = one(data, PUBLIC, unit, rv("work"));
            if (work == null || !work.isURI() || receiptWork != null && !receiptWork.equals(work))
                return "name refresh differs from Work owner";
            Set<Node> actual = new HashSet<>();
            var titles = data.find(PUBLIC, unit, rv("publicTitle"), Node.ANY);
            try { while (titles.hasNext()) actual.add(titles.next().getObject()); }
            finally { org.apache.jena.atlas.iterator.Iter.close(titles); }
            if (!actual.equals(expected(data, work))) return "catalogue names differ from exact current owner recipe";
        }
        return null;
    }
}
