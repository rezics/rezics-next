package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Physical candidate pages for the existing also-enjoyed owner. Each partition
 * is a pruned 32-nibble UUID trie in the existing private projection graph.
 * Writers maintain public membership, including removals, in their own commit.
 * The reader sorts only each node's <=16 children, never a Work population. */
final class AlsoEnjoyedCandidates {
    static final String PREFIX = "urn:rezics:also-enjoyed:candidates:";
    private static final String RV = TemplateIndexService.RV;
    private static final Node STATE = PublicNameProjection.REPAIR,
        CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        CHILD = p("alsoEnjoyedChild"), MEMBER = p("alsoEnjoyedMember"),
        OWNER = p("alsoEnjoyedOwner"), ENTRY = p("alsoEnjoyedEntry"),
        DEPENDENT = p("alsoEnjoyedWork"), PREPARATION = uri(PREFIX + "preparation");
    static final int PAGE = 64;
    static final int MAX_VISITS = 3 * (PAGE + 1) * 32 * 16;
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static void budget(long deadline) { TemplateIndexService.workScopeBudget(deadline); }
    private static Node one(DatasetGraph data, Node graph, Node owner, Node predicate) {
        var rows = data.find(graph, owner, predicate, Node.ANY);
        try {
            Node value = rows.hasNext() ? rows.next().getObject() : null;
            if (rows.hasNext()) throw new IllegalStateException("also-enjoyed owner is ambiguous");
            return value;
        } finally { Iter.close(rows); }
    }
    private static List<Node> values(DatasetGraph data, Node graph, Node owner, Node predicate, int bound) {
        List<Node> result = new ArrayList<>();
        var rows = data.find(graph, owner, predicate, Node.ANY);
        try { while (rows.hasNext()) {
            if (result.size() == bound) throw new IllegalStateException("also-enjoyed owned field exceeds its bound");
            result.add(rows.next().getObject());
        } } finally { Iter.close(rows); }
        return result;
    }
    // Foreign owners may have multivalued relations. Only an unambiguous
    // direct Work link is a discovery hint; our recorded dependencies remain
    // authoritative and owned publication fields still use strict probes.
    private static Node linkedWork(DatasetGraph data, Node resource, Node predicate) {
        var rows = data.find(CURRENT, resource, predicate, Node.ANY);
        try {
            Node value = rows.hasNext() ? rows.next().getObject() : null;
            return rows.hasNext() ? null : value;
        } finally { Iter.close(rows); }
    }
    private static String root(String family, String anchor, String language) {
        String partition = family + "\n" + anchor + "\n" + language;
        return PREFIX + UUID.nameUUIDFromBytes(partition.getBytes(StandardCharsets.UTF_8)) + ":";
    }
    private static String key(Node work) {
        if (!PublicNameProjection.productResource(work)) throw new IllegalArgumentException("invalid candidate Work");
        return work.getURI().substring("https://rezics.com/id/".length()).replace("-", "");
    }
    private static void replace(DatasetGraph data, Node owner, Node work, Set<String> desired, long deadline) {
        Set<String> prior = new HashSet<>();
        for (Node entry : values(data, STATE, owner, ENTRY, 256)) prior.add(entry.getURI());
        for (String leaf : prior) if (!desired.contains(leaf)) {
            budget(deadline);
            Node entry = uri(leaf);
            data.delete(STATE, owner, ENTRY, entry); data.delete(STATE, entry, OWNER, owner);
            if (!data.contains(STATE, entry, OWNER, Node.ANY)) {
                data.deleteAny(STATE, entry, MEMBER, Node.ANY);
                int start = leaf.lastIndexOf(':') + 1;
                for (int length = 32; length > 0; length--) {
                    Node child = uri(leaf.substring(0, start + length)), parent = uri(leaf.substring(0, start + length - 1));
                    if (data.contains(STATE, child, CHILD, Node.ANY) || data.contains(STATE, child, OWNER, Node.ANY)) break;
                    data.delete(STATE, parent, CHILD, child);
                }
            }
        }
        for (String leaf : desired) if (!prior.contains(leaf)) {
            budget(deadline);
            int start = leaf.lastIndexOf(':') + 1;
            for (int length = 1; length <= 32; length++)
                data.add(STATE, uri(leaf.substring(0, start + length - 1)), CHILD, uri(leaf.substring(0, start + length)));
            data.add(STATE, uri(leaf), MEMBER, work); data.add(STATE, uri(leaf), OWNER, owner);
            data.add(STATE, owner, ENTRY, uri(leaf));
        }
    }
    private static void dependency(DatasetGraph data, Node resource, Node work) {
        if (PublicNameProjection.productResource(resource)) data.add(STATE, resource, DEPENDENT, work);
    }
    static void refresh(DatasetGraph data, Set<Node> resources, long deadline) {
        Set<Node> works = new LinkedHashSet<>();
        for (Node resource : resources) {
            budget(deadline);
            if (data.contains(CURRENT, resource, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))) works.add(resource);
            for (String property : List.of("work", "resource", "component")) {
                Node work = linkedWork(data, resource, p(property));
                if (PublicNameProjection.productResource(work)
                    && data.contains(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))) works.add(work);
            }
            var linked = data.find(STATE, resource, DEPENDENT, Node.ANY);
            try { while (linked.hasNext()) { budget(deadline); works.add(linked.next().getObject()); } }
            finally { Iter.close(linked); }
            if (data.contains(CURRENT, resource, RDF.type.asNode(), p("RealmPublicationSlot"))
                || data.contains(STATE, resource, ENTRY, Node.ANY)
                    && !data.contains(CURRENT, resource, RDF.type.asNode(), uri("https://schema.org/CreativeWork")))
                refreshSlot(data, resource, deadline);
        }
        for (Node work : works) refreshWork(data, work, deadline);
    }
    static void refreshWork(DatasetGraph data, Node work, long deadline) {
        budget(deadline);
        Set<String> desired = new HashSet<>();
        Node main = one(data, CURRENT, work, p("mainVersion"));
        dependency(data, main, work);
        boolean eligible = PublicNameProjection.candidateWork(data, work);
        // Work-level Content erasure is an authority fence, not a stale page.
        // This inventory is inspected only by the writer, never by the reader.
        var variants = data.find(CURRENT, Node.ANY, p("resource"), work);
        try { while (variants.hasNext()) {
            budget(deadline); Node variant = variants.next().getSubject(); dependency(data, variant, work);
            Node publication = one(data, CURRENT, variant, p("contentPublicationHead"));
            Node revision = publication == null ? null : one(data, REVISIONS, publication, p("contentRevision"));
            dependency(data, revision, work);
            if (revision != null && data.contains(REVISIONS, revision, RDF.type.asNode(), p("ErasedRevision"))) eligible = false;
        } } finally { Iter.close(variants); }
        Set<String> languages = new HashSet<>(); languages.add("");
        if (main != null) for (Node selection : values(data, CURRENT, main, p("selectionHead"), 64)) {
            budget(deadline);
            Node language = one(data, REVISIONS, selection, p("language"));
            if (language != null && language.isLiteral()) languages.add(language.getLiteralLexicalForm());
            for (String property : List.of("contribution", "selectedDraft", "publicationDecision"))
                dependency(data, one(data, REVISIONS, selection, p(property)), work);
        }
        Node structureDecision = one(data, CURRENT, work, p("workStructurePublicationHead"));
        if (structureDecision != null) {
            dependency(data, structureDecision, work);
            Node source = one(data, REVISIONS, structureDecision, p("publicSource"));
            dependency(data, source, work);
            if (source != null) for (String property : List.of("structure", "structureRevision", "selectedGeneration"))
                dependency(data, one(data, REVISIONS, source, p(property)), work);
        }
        if (eligible) for (Node type : values(data, CURRENT, work, RDF.type.asNode(), 16)) {
            if (!type.isURI() || type.getURI().equals("https://schema.org/CreativeWork")) continue;
            for (String language : languages) desired.add(root("type", type.getURI(), language) + key(work));
        }
        replace(data, work, work, desired, deadline);
        // Only a changed Work's own Realm slots fan out, in the writer. The
        // native page never catches up, folds logs or enumerates these slots.
        var slots = data.find(CURRENT, Node.ANY, p("work"), work);
        try { while (slots.hasNext()) {
            budget(deadline); Node slot = slots.next().getSubject();
            if (data.contains(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"))) refreshSlot(data, slot, eligible, deadline);
        } } finally { Iter.close(slots); }
    }
    static void refreshSlot(DatasetGraph data, Node slot, long deadline) {
        Node work = one(data, CURRENT, slot, p("work"));
        refreshSlot(data, slot, work != null && PublicNameProjection.candidateWork(data, work), deadline);
    }
    private static void refreshSlot(DatasetGraph data, Node slot, boolean publicWork, long deadline) {
        budget(deadline);
        Node work = one(data, CURRENT, slot, p("work")), realm = one(data, CURRENT, slot, p("realm"));
        Node selection = one(data, CURRENT, slot, p("selectionHead"));
        Set<String> desired = new HashSet<>();
        if (publicWork && PublicNameProjection.productResource(work) && PublicNameProjection.productResource(realm) && selection != null
            && data.contains(REVISIONS, selection, RDF.type.asNode(), p("PublicationSelection"))
            && data.contains(REVISIONS, selection, p("work"), work)) {
            Node decision = one(data, REVISIONS, selection, p("publicationDecision"));
            if (decision != null && data.contains(REVISIONS, decision, p("disclosure"), p("Public")))
                desired.add(root("realm", realm.getURI(), "") + key(work));
        }
        if (work != null) dependency(data, slot, work);
        replace(data, slot, work, desired, deadline);
    }
    static boolean prepared(DatasetGraph data) {
        Node epoch = one(data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("dataEpoch"));
        return epoch != null && epoch.equals(one(data, STATE, PREPARATION, p("alsoEnjoyedEpoch")))
            && !data.contains(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("restoreHold"), NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
    }
    /** The existing cold Work-scope preparer advances one physical type page.
     * Old schema upgrades cannot be warmed or rebuilt by an HTTP reader. */
    static boolean prepare(DatasetGraph data, long deadline) {
        if (prepared(data)) return true;
        Node epoch = one(data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("dataEpoch"));
        if (epoch == null) throw new IllegalStateException("candidate epoch is unavailable");
        if (!epoch.equals(one(data, STATE, PREPARATION, p("alsoEnjoyedBuildEpoch")))) {
            data.deleteAny(STATE, PREPARATION, Node.ANY, Node.ANY);
            data.add(STATE, PREPARATION, p("alsoEnjoyedBuildEpoch"), epoch);
        }
        Node after = one(data, STATE, PREPARATION, p("alsoEnjoyedAfter"));
        var page = TemplateIndexService.ownerTypePage(data, "https://schema.org/CreativeWork",
            after == null ? "" : after.getLiteralLexicalForm(), deadline);
        for (Node work : page.owners()) refreshWork(data, work, deadline);
        data.deleteAny(STATE, PREPARATION, p("alsoEnjoyedAfter"), Node.ANY);
        if (page.more()) data.add(STATE, PREPARATION, p("alsoEnjoyedAfter"), NodeFactory.createLiteralString(page.after()));
        else data.add(STATE, PREPARATION, p("alsoEnjoyedEpoch"), epoch);
        return !page.more();
    }
    private static final class Visits {
        int rows;
        void row() {
            if (++rows > MAX_VISITS) throw new IllegalStateException("candidate trie visit bound exceeded");
            CommandWork.count("also_enjoyed_candidate_rows_visited", 1);
        }
    }
    static Map<String,Object> page(DatasetGraph data, String source, List<String> types, String language, String realm, int limit) {
        if (!PublicNameProjection.productResource(uri(source)) || limit < 1 || limit > PAGE
            || types.size() > 3 || realm == null && types.isEmpty() || realm != null && !types.isEmpty()
            || new HashSet<>(types).size() != types.size()
            || types.stream().anyMatch(type -> !type.startsWith("https://") || type.length() > 256)
            || language != null && (language.isEmpty() || language.length() > 64 || language.codePoints().anyMatch(value -> value < 32))
            || realm != null && !PublicNameProjection.productResource(uri(realm)))
            throw new IllegalArgumentException("invalid also-enjoyed candidate page");
        if (!prepared(data)) throw new IllegalStateException("also-enjoyed candidate directory is unprepared");
        long deadline = System.nanoTime() + 1_500_000_000L;
        Visits visits = new Visits(); TreeSet<String> works = new TreeSet<>();
        List<String> roots = realm != null ? List.of(root("realm", realm, ""))
            : types.stream().map(type -> root("type", type, language == null ? "" : language)).toList();
        for (String partition : roots) {
            List<String> selected = new ArrayList<>();
            walk(data, partition, partition, source, limit, selected, visits, deadline);
            works.addAll(selected);
        }
        return Map.of("works", works.stream().limit(limit).toList(), "examined", visits.rows);
    }
    private static void walk(DatasetGraph data, String root, String prefix, String source, int limit,
                             List<String> selected, Visits visits, long deadline) {
        budget(deadline);
        if (selected.size() == limit) return;
        if (prefix.length() - root.length() == 32) {
            Node work = one(data, STATE, uri(prefix), MEMBER); visits.row();
            if (work == null || !PublicNameProjection.productResource(work) || !prefix.equals(root + key(work)))
                throw new IllegalStateException("candidate trie leaf is damaged");
            if (!work.getURI().equals(source)) selected.add(work.getURI());
            return;
        }
        List<String> children = new ArrayList<>();
        var rows = data.find(STATE, uri(prefix), CHILD, Node.ANY);
        try { while (rows.hasNext()) {
            visits.row(); Node child = rows.next().getObject();
            if (!child.isURI() || children.size() == 16 || !child.getURI().matches(java.util.regex.Pattern.quote(prefix) + "[0-9a-f]"))
                throw new IllegalStateException("candidate trie branch is damaged");
            children.add(child.getURI());
        } } finally { Iter.close(rows); }
        Collections.sort(children);
        for (String child : children) { walk(data, root, child, source, limit, selected, visits, deadline);
            if (selected.size() == limit) break; }
    }
    static Map<String,Object> read(DatasetGraph data, JsonObject request) {
        if (!request.keys().equals(Set.of("source", "types", "language", "realm", "limit"))
            || !request.get("types").isArray() || !request.get("limit").isNumber()
            || !request.get("limit").toString().matches("[1-9]|[1-5][0-9]|6[0-4]")
            || !(request.get("language").isNull() || request.get("language").isString())
            || !(request.get("realm").isNull() || request.get("realm").isString()))
            throw new IllegalArgumentException("invalid candidate envelope");
        List<String> types = new ArrayList<>();
        for (var type : request.get("types").getAsArray()) types.add(type.getAsString().value());
        data.begin(ReadWrite.READ);
        try { return page(data, ProfileRegistry.required(request, "source"), types,
            request.get("language").isNull() ? null : request.get("language").getAsString().value(),
            request.get("realm").isNull() ? null : request.get("realm").getAsString().value(),
            Integer.parseInt(request.get("limit").toString())); }
        finally { data.end(); }
    }
    private AlsoEnjoyedCandidates() {}
}
