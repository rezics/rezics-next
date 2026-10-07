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
            .filter(quad -> PUBLIC.equals(quad.getGraph())).allMatch(PublicNameProjection::nameMaintenanceQuad);
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var found = data.find(graph, subject, predicate, Node.ANY);
        try {
            if (!found.hasNext()) return null;
            Node value = found.next().getObject();
            return found.hasNext() ? null : value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(found); }
    }
    static final int BODY_NAME_LIMIT = 64;
    private static final List<Node> AUTHORED = List.of(uri("http://www.w3.org/2000/01/rdf-schema#label"),
        uri("https://schema.org/name"), uri("https://schema.org/alternateName"));
    /** A body MatchUnit carries a bounded cache, not the Work name inventory.
     * Sample fixed owner/predicate prefixes, then sort only that bounded union.
     * PublicNameProjection separately preserves every legal authored name. */
    static Set<Node> expected(DatasetGraph data, Node work) { return expected(data, work, null); }
    private static Set<Node> expected(DatasetGraph data, Node work, org.apache.jena.atlas.json.JsonObject override) {
        if (work == null || !work.isURI()) throw new IllegalArgumentException("name Work owner is invalid");
        Set<Node> names = new HashSet<>(), primary = new HashSet<>();
        for (Node predicate : AUTHORED) {
            if (predicate.equals(AUTHORED.getFirst()) && override != null && override.hasKey("replacementTitle")) {
                var title = override.get("replacementTitle").getAsObject();
                Node replacement = NodeFactory.createLiteralLang(title.get("value").getAsString().value(), title.get("language").getAsString().value());
                names.add(replacement); primary.add(replacement);
                continue;
            }
            var rows = data.find(CURRENT, work, predicate, Node.ANY);
            try { for (int count = 0; count < BODY_NAME_LIMIT && rows.hasNext(); count++) {
                Node value = rows.next().getObject();
                names.add(value);
                if (predicate.equals(AUTHORED.getFirst())) primary.add(value);
                CommandWork.count("catalogue_name_values_visited", 1);
            } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        }
        org.apache.jena.atlas.json.JsonObject header = null;
        if (override != null && override.hasKey("header")) {
            if (!override.get("header").isNull()) header = override.get("header").getAsObject();
        } else {
            Node metadata = one(data, CURRENT, work, rv("descriptiveMetadataHead"));
            if (metadata != null && !data.contains(REVISIONS, metadata,
                org.apache.jena.vocabulary.RDF.type.asNode(), rv("ErasedRevision"))) {
                Node payload = one(data, REVISIONS, metadata, rv("metadataState"));
                if (payload == null || !payload.isLiteral() || payload.getLiteralLexicalForm().length() > 65536)
                    throw new IllegalArgumentException("name metadata is incomplete or exceeds its owner bound");
                CommandWork.count("catalogue_name_payload_characters", payload.getLiteralLexicalForm().length());
                header = JSON.parse(payload.getLiteralLexicalForm());
            }
        }
        if (header != null) {
            String encoded = header.toString();
            if (encoded.length() > 4 * 65536 || !header.hasKey("kind") || !"header".equals(header.get("kind").getAsString().value()))
                throw new IllegalArgumentException("name metadata is not a bounded header");
            if (header.hasKey("originalTitle") && !header.get("originalTitle").isNull()) {
                var original = header.get("originalTitle").getAsObject();
                names.add(NodeFactory.createLiteralLang(original.get("value").getAsString().value(), original.get("language").getAsString().value()));
            }
            if (header.hasKey("localized")) for (var entry : header.get("localized").getAsArray()) {
                var locale = entry.getAsObject();
                if (locale.hasKey("title") && !locale.get("title").isNull()) names.add(NodeFactory.createLiteralLang(
                    locale.get("title").getAsString().value(), locale.get("language").getAsString().value()));
            }
        }
        if (names.stream().anyMatch(name -> !name.isLiteral() || name.getLiteralLexicalForm().isEmpty()
            || name.getLiteralLexicalForm().length() > 500)) throw new IllegalArgumentException("name recipe exceeds its value bound");
        var order = java.util.Comparator.comparing(Node::getLiteralLexicalForm)
            .thenComparing(Node::getLiteralLanguage).thenComparing(org.apache.jena.riot.out.NodeFmtLib::strNT);
        // Keep the current controlled title in the body cache. Selection adds
        // that same title, so its required witness cannot create a 65th value.
        Set<Node> result = primary.stream().sorted(order).limit(BODY_NAME_LIMIT)
            .collect(java.util.stream.Collectors.toCollection(java.util.LinkedHashSet::new));
        names.stream().filter(name -> !result.contains(name)).sorted(order).limit(BODY_NAME_LIMIT - result.size()).forEach(result::add);
        return result;
    }
    /** Shared read/proposal recipe: native validation recomputes this same
     * bounded owner sample after the mutation. No client-side population sort. */
    static org.apache.jena.atlas.json.JsonObject recipe(DatasetGraph data, org.apache.jena.atlas.json.JsonObject request) {
        if (!request.hasKey("work")) throw new IllegalArgumentException("name recipe needs one Work owner");
        var names = expected(data, uri(request.get("work").getAsString().value()),
            request.hasKey("override") ? request.get("override").getAsObject() : null);
        var values = new org.apache.jena.atlas.json.JsonArray();
        for (Node name : names) values.add(org.apache.jena.riot.out.NodeFmtLib.strNT(name));
        var result = new org.apache.jena.atlas.json.JsonObject(); result.put("names", values);
        return result;
    }
    static String check(DatasetGraph data, String receipt, List<SearchDeltaJournal.Change> changes) {
        if (changes.size() > SearchDeltaJournal.MAX_UNITS) return "name refresh exceeds its unit delta bound";
        Node receiptWork = one(data, RECEIPTS, uri(receipt), rv("work"));
        if (receiptWork == null && data.contains(RECEIPTS, uri(receipt), rv("work"), Node.ANY))
            return "name refresh receipt Work owner is ambiguous";
        for (var change : changes) {
            if (!change.before() || !change.after()) return "name refresh changed MatchUnit membership";
            Node unit = uri(change.unit()), work = one(data, PUBLIC, unit, rv("work"));
            if (work == null || !work.isURI() || receiptWork != null && !receiptWork.equals(work))
                return "name refresh differs from Work owner";
            Set<Node> actual = new HashSet<>();
            var titles = data.find(PUBLIC, unit, rv("publicTitle"), Node.ANY);
            try { for (int count = 0; titles.hasNext(); count++) {
                if (count == BODY_NAME_LIMIT) return "catalogue body name cache exceeds its bound";
                actual.add(titles.next().getObject());
                CommandWork.count("catalogue_name_copies_visited", 1);
            } } finally { org.apache.jena.atlas.iterator.Iter.close(titles); }
            try {
                if (!actual.equals(expected(data, work))) return "catalogue names differ from exact current owner recipe";
            } catch (IllegalArgumentException malformed) { return "catalogue name owner recipe is invalid"; }
        }
        return null;
    }
}
