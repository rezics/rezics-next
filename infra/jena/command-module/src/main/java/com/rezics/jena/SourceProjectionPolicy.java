package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
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
        RV + "sourceMappingRevision", RV + "sourceStatement");
    private static final Set<String> MAPPED_CONVERSION = Set.of(RDF.type.getURI(), RV + "sourceObservation",
        RV + "sourceByteDigest", RV + "sourceMappingRevision", RV + "sourceMappedValuesJson");
    private static final Set<String> STATEMENT = Set.of(RDF.type.getURI(),
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#object",
        "http://www.w3.org/ns/prov#wasDerivedFrom", RV + "sourceObservation",
        RV + "sourceByteDigest", RV + "sourceMappingRevision", RV + "sourceField",
        RV + "fieldDisposition", RV + "dispositionReason");
    private static final Node RDF_SUBJECT = NodeFactory.createURI(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject");
    private static final Node RDF_PREDICATE = NodeFactory.createURI(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate");
    private static final Node RDF_OBJECT = NodeFactory.createURI(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#object");
    private static final Node PROV_DERIVED = NodeFactory.createURI(
        "http://www.w3.org/ns/prov#wasDerivedFrom");

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
            || !plan.source().containsAll(Set.of(record.getURI(), observation.getURI(), conversion.getURI()))
            || !text(digest, "[0-9a-f]{64}") || !text(mapping, "[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}")
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
        Node mapped = one(data, SOURCE, conversion, "sourceMappedValuesJson");
        Set<Node> statements = new LinkedHashSet<>();
        if (mapped != null) {
            if (!mapped.isLiteral() || mapped.getLiteralLexicalForm().length() > 131072
                || !plan.source().equals(Set.of(record.getURI(), observation.getURI(), conversion.getURI()))
                || sourceTitle(data, conversion) == null)
                return "mapped source projection footprint or title differs";
        } else {
            Node external = one(data, SOURCE, record, "sourceExternalId");
            Node key = one(data, SOURCE, conversion, "sourceKey");
            if (external == null || !external.isLiteral() || key == null || !key.isLiteral()
                || !key.getLiteralLexicalForm().equals("/works/" + external.getLiteralLexicalForm()))
                return "source Work key differs from record identity";
            var links = data.find(SOURCE, conversion, rv("sourceStatement"), Node.ANY);
            while (links.hasNext()) {
                Node statement = links.next().getObject();
                if (!statement.isURI() || !statement.getURI().matches(
                    "urn:rezics:source-statement:[0-9a-f]{64}") || !statements.add(statement))
                    return "source statement link is invalid";
            }
            Node title = one(data, SOURCE, conversion, "sourceTitle");
            Node description = one(data, SOURCE, conversion, "sourceDescription");
            if (statements.size() != (description == null ? 1 : 2)
                || !plan.source().equals(union(Set.of(record.getURI(), observation.getURI(), conversion.getURI()),
                    statements.stream().map(Node::getURI).collect(java.util.stream.Collectors.toSet()))))
                return "source statement footprint differs";
            boolean titleSeen = false;
            boolean descriptionSeen = false;
            for (Node statement : statements) {
                Node predicate = one(data, SOURCE, statement, RDF_PREDICATE);
                Node object = one(data, SOURCE, statement, RDF_OBJECT);
                Node sourceField = one(data, SOURCE, statement, "sourceField");
                boolean isTitle = rv("sourceTitle").equals(predicate) && title != null && title.equals(object)
                    && text(sourceField, "title");
                boolean isDescription = rv("sourceDescription").equals(predicate) && description != null
                    && description.equals(object) && text(sourceField, "description");
                String field = isTitle ? "title" : isDescription ? "description" : "";
                String expectedStatement = "urn:rezics:source-statement:" + hash(
                    conversion.getURI() + "\0" + field + "\0" + digest.getLiteralLexicalForm());
                if ((!isTitle && !isDescription) || !data.contains(SOURCE, statement, RDF.type.asNode(),
                        rdf("Statement"))
                    || !expectedStatement.equals(statement.getURI())
                    || !conversion.equals(one(data, SOURCE, statement, RDF_SUBJECT))
                    || !observation.equals(one(data, SOURCE, statement, "sourceObservation"))
                    || !observation.equals(one(data, SOURCE, statement, PROV_DERIVED))
                    || !digest.equals(one(data, SOURCE, statement, "sourceByteDigest"))
                    || !mapping.equals(one(data, SOURCE, statement, "sourceMappingRevision"))
                    || !text(one(data, SOURCE, statement, "fieldDisposition"), "structured-source-only")
                    || !text(one(data, SOURCE, statement, "dispositionReason"),
                        "Source evidence requires separate explicit acceptance before native use."))
                    return "source statement differs from retained evidence";
                titleSeen |= isTitle;
                descriptionSeen |= isDescription;
            }
            if (!titleSeen || (description != null && !descriptionSeen))
                return "source statement fields are incomplete";
        }
        for (Map.Entry<Node, Set<String>> role : Map.of(record, RECORD,
            observation, OBSERVATION, conversion, mapped == null ? CONVERSION : MAPPED_CONVERSION).entrySet()) {
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
        for (Node statement : statements) {
            var quads = data.find(SOURCE, statement, Node.ANY, Node.ANY);
            while (quads.hasNext()) {
                var quad = quads.next();
                if (!quad.getPredicate().isURI() || !STATEMENT.contains(quad.getPredicate().getURI()))
                    return "source statement contains an unreviewed predicate";
            }
        }
        return null;
    }

    /** Native owners consume the adapter's private mapped values; legacy receipts keep their exact representation. */
    static String sourceTitle(DatasetGraph data, Node conversion) {
        Node legacy = one(data, SOURCE, conversion, "sourceTitle");
        if (legacy != null) return legacy.isLiteral() ? legacy.getLiteralLexicalForm() : null;
        JsonObject mapped = mappedValues(data, conversion);
        try { return mapped == null ? null : ProfileRegistry.required(mapped.get("title").getAsObject(), "value"); }
        catch (RuntimeException invalid) { return null; }
    }

    static String sourceField(DatasetGraph data, Node conversion, String slot) {
        Node legacy = one(data, SOURCE, conversion, "sourceDescription");
        if (legacy != null && slot.equals("work-editorial-field-v1#synopsis"))
            return legacy.isLiteral() ? legacy.getLiteralLexicalForm() : null;
        JsonObject mapped = mappedValues(data, conversion);
        if (mapped == null) return null;
        try {
            var fields = mapped.get("fields").getAsArray();
            if (fields.size() > 128) return null;
            String value = null;
            for (var item : fields) {
                JsonObject field = item.getAsObject();
                if (slot.equals(ProfileRegistry.required(field, "slot"))) {
                    if (value != null) return null;
                    value = ProfileRegistry.required(field, "value");
                }
            }
            return value;
        } catch (RuntimeException invalid) { return null; }
    }

    private static JsonObject mappedValues(DatasetGraph data, Node conversion) {
        Node mapped = one(data, SOURCE, conversion, "sourceMappedValuesJson");
        if (mapped == null || !mapped.isLiteral() || mapped.getLiteralLexicalForm().length() > 131072) return null;
        try { return JSON.parse(mapped.getLiteralLexicalForm()); }
        catch (RuntimeException invalid) { return null; }
    }

    private static Set<String> union(Set<String> base, Set<String> additional) {
        Set<String> values = new LinkedHashSet<>(base);
        values.addAll(additional);
        return values;
    }

    private static Node one(DatasetGraph data, Node graph, Node subject, String property) {
        return one(data, graph, subject, rv(property));
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var values = data.find(graph, subject, predicate, Node.ANY);
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
    private static Node rdf(String local) {
        return NodeFactory.createURI("http://www.w3.org/1999/02/22-rdf-syntax-ns#" + local);
    }
    private static String hash(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
    private SourceProjectionPolicy() {}
}
