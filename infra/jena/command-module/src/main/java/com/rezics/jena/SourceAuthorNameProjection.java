package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonNull;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonString;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** A bounded native copy of factual source names. Each publication carries its
 * exact current credit witnesses; matching never enumerates source records or
 * a Work's unrelated owner population. SQL remains the source name authority.
 * Lookup scopes reuse normalizedPrefixText: NFC, Unicode lowercase and Main's
 * whitespace normalization, preserving diacritics. Names never form order keys:
 * credit tier + fixed lowercase Main/unit UUID hex equals Main localeCompare. */
final class SourceAuthorNameProjection {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String PREFIX = PublicNameProjection.PREFIX + "source-author:";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        REPAIR = PublicNameProjection.REPAIR;
    private static final int MAX_NAMES = 192, MAX_CREDITS = 128;
    private static final java.util.regex.Pattern CONTROL = java.util.regex.Pattern.compile("[\\x00-\\x1f\\x7f]");
    static final class ConflictException extends RuntimeException {
        ConflictException(String message) { super(message); }
    }
    private record Name(String sourceKey, String displayName, String language) {}
    private record Input(String target, String sourceKey, List<Node> credits, List<Name> names,
                         String position, String idempotencyKey, String encodedNames) {}
    private record Owner(Node work, Node main) {}
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node one(DatasetGraph data, Node graph, Node subject, String predicate) {
        return one(data, graph, subject, p(predicate));
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var rows = data.find(graph, subject, predicate, Node.ANY);
        try {
            if (!rows.hasNext()) return null;
            Node value = rows.next().getObject();
            return rows.hasNext() ? null : value;
        } finally { Iter.close(rows); }
    }
    private static String string(JsonObject value, String key) {
        if (!value.hasKey(key) || !value.get(key).isString()) throw new IllegalArgumentException("source name field is invalid: " + key);
        return value.get(key).getAsString().value();
    }
    private static String literal(Node value) {
        if (value == null || !value.isLiteral()) throw new IllegalStateException("source name projection state is incomplete");
        return value.getLiteralLexicalForm();
    }
    private static void fields(JsonObject value, Set<String> keys) {
        if (!value.keys().equals(keys)) throw new IllegalArgumentException("source name fields are not admitted");
    }
    private static String sourceKey(String value) {
        if (!value.matches("/authors/OL[1-9][0-9]{0,11}A")) throw new IllegalArgumentException("source author key is invalid");
        return value;
    }
    private static Input input(JsonObject request) {
        fields(request, Set.of("target", "sourceKey", "credits", "names", "sourcePosition", "idempotencyKey"));
        String target = string(request, "target"), sourceKey = sourceKey(string(request, "sourceKey")),
            position = string(request, "sourcePosition"), key = string(request, "idempotencyKey");
        if (!PublicNameProjection.productResource(uri(target)) || !position.matches("0|[1-9][0-9]{0,63}")
            || key.isEmpty() || key.length() > 128 || CONTROL.matcher(key).find())
            throw new IllegalArgumentException("source publication identity is invalid");
        if (!request.get("credits").isArray() || !request.get("names").isArray())
            throw new IllegalArgumentException("source publication arrays are invalid");
        JsonArray creditValues = request.get("credits").getAsArray(), nameValues = request.get("names").getAsArray();
        if (creditValues.size() > MAX_CREDITS || nameValues.size() > MAX_NAMES)
            throw new IllegalArgumentException("source publication exceeds its bound");
        Set<Node> uniqueCredits = new LinkedHashSet<>();
        for (var value : creditValues) {
            if (!value.isString()) throw new IllegalArgumentException("source credit identity is invalid");
            Node credit = uri(value.getAsString().value());
            if (!PublicNameProjection.productResource(credit) || !uniqueCredits.add(credit))
                throw new IllegalArgumentException("source credit identities are invalid or repeated");
        }
        List<Node> credits = uniqueCredits.stream().sorted(Comparator.comparing(Node::getURI)).toList();
        Set<Name> uniqueNames = new LinkedHashSet<>();
        for (var value : nameValues) {
            if (!value.isObject()) throw new IllegalArgumentException("source name is invalid");
            JsonObject row = value.getAsObject();
            fields(row, Set.of("sourceKey", "displayName", "language"));
            String nameKey = string(row, "sourceKey"), displayName = string(row, "displayName"), language = null;
            if (!row.get("language").isNull()) {
                if (!row.get("language").isString()) throw new IllegalArgumentException("source name language is invalid");
                language = row.get("language").getAsString().value().toLowerCase(java.util.Locale.ROOT);
                if (!language.matches("[a-z]{2,3}(?:-[a-z0-9]{1,8})*"))
                    throw new IllegalArgumentException("source name language is invalid");
            }
            if (!sourceKey.equals(nameKey) || displayName.length() > 200
                || PublicNameProjection.normalizedPrefixText(displayName).isEmpty()
                || CONTROL.matcher(displayName).find())
                throw new IllegalArgumentException("source name value is invalid");
            if (!uniqueNames.add(new Name(sourceKey, displayName, language)))
                throw new IllegalArgumentException("source names are repeated");
        }
        List<Name> names = uniqueNames.stream().sorted(Comparator.comparing(Name::sourceKey)
            .thenComparing(name -> name.language() == null ? "" : name.language()).thenComparing(Name::displayName)).toList();
        if (!names.isEmpty() && credits.isEmpty()) throw new IllegalArgumentException("source names need current credit witnesses");
        return new Input(target, sourceKey, credits, names, position, key, encode(names).toString());
    }
    private static JsonArray encode(List<Name> names) {
        var result = new JsonArray();
        for (Name name : names) {
            var row = new JsonObject(); row.put("sourceKey", name.sourceKey()); row.put("displayName", name.displayName());
            row.put("language", name.language() == null ? JsonNull.instance : new JsonString(name.language())); result.add(row);
        }
        return result;
    }
    private static Owner owner(DatasetGraph data, String target) {
        Node resource = uri(target), work;
        if (data.contains(CURRENT, resource, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))) work = resource;
        else if (data.contains(CURRENT, resource, RDF.type.asNode(), p("MainVersion"))) work = one(data, CURRENT, resource, "work");
        else throw new ConflictException("source publication target is no longer current");
        if (!PublicNameProjection.productResource(work)
            || !data.contains(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork")))
            throw new ConflictException("source publication Work is unavailable");
        Node main;
        var mains = data.find(CURRENT, work, p("mainVersion"), Node.ANY);
        try {
            main = mains.hasNext() ? mains.next().getObject() : null;
            if (mains.hasNext()) throw new ConflictException("source publication Main is ambiguous");
        } finally { Iter.close(mains); }
        // Source facts belong to the Work before its first selected Main too.
        if (main == null && resource.equals(work)) return new Owner(work, null);
        if (!PublicNameProjection.productResource(main) || !data.contains(CURRENT, main, RDF.type.asNode(), p("MainVersion"))
            || !work.equals(one(data, CURRENT, main, "work")) || !resource.equals(work) && !resource.equals(main))
            throw new ConflictException("source publication Main changed");
        return new Owner(work, main);
    }
    private static boolean creditValid(DatasetGraph data, Node work, String key, Node credit) {
        if (data.contains(CURRENT, credit, p("retiredBy"), Node.ANY)
            || !data.contains(CURRENT, credit, RDF.type.asNode(), p("AuthorCredit"))
            || !work.equals(one(data, CURRENT, credit, "work")) || !text(key).equals(one(data, CURRENT, credit, "externalKey"))) return false;
        Node revision = one(data, CURRENT, credit, "creditRevision");
        if (revision == null || !revision.isURI() || !data.contains(REVISIONS, revision, RDF.type.asNode(), p("AuthorCreditRevision"))
            || !credit.equals(one(data, REVISIONS, revision, "component")) || !work.equals(one(data, REVISIONS, revision, "work"))
            || !text(key).equals(one(data, REVISIONS, revision, "externalKey"))
            || data.contains(REVISIONS, revision, RDF.type.asNode(), p("ErasedRevision"))) return false;
        for (String predicate : List.of("externalProvider", "externalNamespace")) {
            Node expected = text(predicate.equals("externalProvider") ? "open-library" : "author");
            if (!expected.equals(one(data, CURRENT, credit, predicate)) || !expected.equals(one(data, REVISIONS, revision, predicate))) return false;
        }
        Node role = uri("https://schema.org/roleName");
        return text("author").equals(one(data, CURRENT, credit, role)) && text("author").equals(one(data, REVISIONS, revision, role))
            && !data.contains(CURRENT, credit, p("agent"), Node.ANY)
            && !data.contains(CURRENT, credit, uri("https://schema.org/author"), Node.ANY)
            && !data.contains(REVISIONS, revision, p("agent"), Node.ANY)
            && !data.contains(REVISIONS, revision, uri("https://schema.org/author"), Node.ANY);
    }
    private static String digest(String value) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static Node snapshot(Node work, String key) { return uri(PREFIX + "snapshot:" + digest(work.getURI() + "\n" + key)); }
    private static void set(DatasetGraph data, Node subject, String predicate, Node value) {
        data.deleteAny(REPAIR, subject, p(predicate), Node.ANY);
        if (value != null) data.add(REPAIR, subject, p(predicate), value);
    }
    private static JsonArray storedNames(DatasetGraph data, Node snapshot) {
        String encoded = literal(one(data, REPAIR, snapshot, "sourceAuthorNames"));
        if (encoded.length() > 192 * 1_000) throw new IllegalStateException("source name projection payload exceeds its bound");
        var values = JSON.parseAny(encoded);
        if (!values.isArray() || values.getAsArray().size() > MAX_NAMES) throw new IllegalStateException("source name projection is invalid");
        return values.getAsArray();
    }
    private static List<Node> snapshots(DatasetGraph data, Node work, long deadline) {
        var values = new ArrayList<Node>();
        var rows = data.find(REPAIR, work, p("sourceAuthorSnapshot"), Node.ANY);
        try { while (rows.hasNext()) {
            TemplateIndexService.workScopeBudget(deadline);
            if (values.size() == MAX_NAMES) throw new IllegalStateException("source name snapshot inventory exceeds its bound");
            values.add(rows.next().getObject());
        } } finally { Iter.close(rows); }
        return values;
    }
    /** Only exact retained credit subjects are inspected. Pruning removes the
     * active directory link, while position and receipts retain replay order. */
    private static boolean liveSnapshot(DatasetGraph data, Node work, Node snapshot, String key, long deadline) {
        var credits = data.find(REPAIR, snapshot, p("sourceAuthorCredit"), Node.ANY); boolean current = false;
        try { for (int visited = 0; credits.hasNext(); visited++) {
            TemplateIndexService.workScopeBudget(deadline);
            if (visited == MAX_CREDITS) throw new IllegalStateException("source credit inventory exceeds its bound");
            if (creditValid(data, work, key, credits.next().getObject())) current = true;
        } } finally { Iter.close(credits); }
        if (!current) data.delete(REPAIR, work, p("sourceAuthorSnapshot"), snapshot);
        return current;
    }
    static JsonObject publish(DatasetGraph data, JsonObject request, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        long examinedBefore = CommandWork.currentCount("source_author_name_entries_visited");
        Input input = input(request); Owner owner = owner(data, input.target());
        Node snapshot = snapshot(owner.work(), input.sourceKey()), receipt = uri(PREFIX + "receipt:" + digest(owner.work().getURI() + "\n" + input.idempotencyKey()));
        var canonical = new JsonObject(); canonical.put("target", input.target()); canonical.put("work", owner.work().getURI());
        canonical.put("sourceKey", input.sourceKey()); canonical.put("sourcePosition", input.position()); canonical.put("names", JSON.parseAny(input.encodedNames()));
        var credits = new JsonArray(); for (Node credit : input.credits()) credits.add(credit.getURI()); canonical.put("credits", credits);
        String hash = digest(canonical.toString());
        Node priorDigest = one(data, REPAIR, receipt, "sourceAuthorDigest");
        if (priorDigest != null) {
            if (!hash.equals(literal(priorDigest))) throw new ConflictException("source publication idempotency key changed payload");
            var response = JSON.parse(literal(one(data, REPAIR, receipt, "sourceAuthorResult")));
            response.put("replayed", true); response.put("examined", 0); return response;
        }
        Node previous = one(data, REPAIR, snapshot, "sourceAuthorPosition");
        if (previous != null) {
            int order = new BigInteger(input.position()).compareTo(new BigInteger(literal(previous)));
            if (order < 0) throw new ConflictException("source author publication position moved backwards");
            if (order == 0 && !input.encodedNames().equals(literal(one(data, REPAIR, snapshot, "sourceAuthorNames"))))
                throw new ConflictException("source author position has conflicting names");
        }
        for (Node credit : input.credits()) {
            TemplateIndexService.workScopeBudget(deadline);
            if (!creditValid(data, owner.work(), input.sourceKey(), credit)) throw new ConflictException("source author credit is no longer current");
        }
        Set<Node> retainedCredits = new LinkedHashSet<>(input.credits());
        var priorCredits = data.find(REPAIR, snapshot, p("sourceAuthorCredit"), Node.ANY);
        try { for (int visited = 0; priorCredits.hasNext(); visited++) {
            TemplateIndexService.workScopeBudget(deadline);
            if (visited == MAX_CREDITS) throw new IllegalStateException("source credit inventory exceeds its bound");
            Node credit = priorCredits.next().getObject();
            if (creditValid(data, owner.work(), input.sourceKey(), credit)) retainedCredits.add(credit);
        } } finally { Iter.close(priorCredits); }
        if (retainedCredits.size() > MAX_CREDITS) throw new ConflictException("source credit witnesses exceed their bound");
        int count = input.names().size();
        for (Node existing : snapshots(data, owner.work(), deadline)) if (!existing.equals(snapshot)) {
            TemplateIndexService.workScopeBudget(deadline);
            String existingKey = literal(one(data, REPAIR, existing, "sourceAuthorKey"));
            if (!liveSnapshot(data, owner.work(), existing, existingKey, deadline)) continue;
            int existingNames = storedNames(data, existing).size();
            CommandWork.count("source_author_name_entries_visited", existingNames); count += existingNames;
        }
        if (count > MAX_NAMES) throw new ConflictException("source names exceed the Work publication bound");
        CommandWork.count("source_author_name_entries_visited", input.names().size());
        set(data, snapshot, "sourceAuthorKey", text(input.sourceKey())); set(data, snapshot, "sourceAuthorMain", owner.main());
        set(data, snapshot, "sourceAuthorNames", text(input.encodedNames())); set(data, snapshot, "sourceAuthorPosition", text(input.position()));
        data.deleteAny(REPAIR, snapshot, p("sourceAuthorCredit"), Node.ANY);
        for (Node credit : retainedCredits) {
            TemplateIndexService.workScopeBudget(deadline); data.add(REPAIR, snapshot, p("sourceAuthorCredit"), credit);
            PublicNameProjection.prefixDependency(data, credit, owner.work());
        }
        if (input.names().isEmpty()) data.deleteAny(REPAIR, owner.work(), p("sourceAuthorSnapshot"), snapshot);
        else data.add(REPAIR, owner.work(), p("sourceAuthorSnapshot"), snapshot);
        PublicNameProjection.refreshPrefixSource(data, owner.work(), deadline);
        var response = new JsonObject(); response.put("target", input.target()); response.put("work", owner.work().getURI());
        response.put("mainVersion", owner.main() == null ? JsonNull.instance : new JsonString(owner.main().getURI())); response.put("sourceKey", input.sourceKey()); response.put("sourcePosition", input.position());
        response.put("names", input.names().size()); response.put("examined", CommandWork.currentCount("source_author_name_entries_visited") - examinedBefore); response.put("replayed", false);
        set(data, receipt, "sourceAuthorDigest", text(hash)); set(data, receipt, "sourceAuthorResult", text(response.toString()));
        return response;
    }
    /** Writer recipe: at most 192 factual names, with fixed-subject credit evidence.
     * Facts follow their Work when its Main changes; retired credit witnesses
     * contribute no prefix terms. */
    static Set<Node> names(DatasetGraph data, Node work, long deadline) {
        Set<Node> result = new LinkedHashSet<>(); int count = 0;
        for (Node snapshot : snapshots(data, work, deadline)) {
            TemplateIndexService.workScopeBudget(deadline);
            JsonArray names = storedNames(data, snapshot); count += names.size();
            CommandWork.count("source_author_name_entries_visited", names.size());
            if (count > MAX_NAMES) throw new IllegalStateException("source name inventory exceeds its bound");
            String key = literal(one(data, REPAIR, snapshot, "sourceAuthorKey"));
            if (!liveSnapshot(data, work, snapshot, key, deadline)) continue;
            for (var value : names) {
                TemplateIndexService.workScopeBudget(deadline);
                var name = value.getAsObject(); String displayName = name.get("displayName").getAsString().value();
                result.add(name.get("language").isNull() ? text(displayName)
                    : NodeFactory.createLiteralLang(displayName, name.get("language").getAsString().value()));
            }
        }
        return result;
    }
}
