package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
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
        DEPENDENT = p("alsoEnjoyedCurrentOwner"), DEPENDENCY = p("alsoEnjoyedCurrentSource"),
        SLOT_WORK = p("alsoEnjoyedSlotWork"), WORK_SLOT = p("alsoEnjoyedCurrentSlot"),
        ELIGIBLE = p("alsoEnjoyedEligible"), PUBLIC = NodeFactory.createLiteralByValue(true,
            org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean),
        PREPARATION = uri(PREFIX + "preparation"), FORM = NodeFactory.createLiteralString("current-edges-v1");
    static final int PAGE = 64;
    static final int MAX_VISITS = 3 * (PAGE + 1) * 32 * 16;
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static void budget(long deadline) { TemplateIndexService.workScopeBudget(deadline); }
    /** Count actual indexed probes, iterator consumption (including lookahead)
     * and mutation calls. Counts are owner work, not distinct persisted tuples. */
    private static DatasetGraph writer(DatasetGraph data) {
        return data instanceof WriterGraph ? data : new WriterGraph(data);
    }
    private static final class WriterGraph extends DatasetGraphWrapper {
        WriterGraph(DatasetGraph data) { super(data); }
        @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
            CommandWork.count("also_enjoyed_writer_probes", 1);
            var rows = super.find(g, s, p, o);
            return new org.apache.jena.atlas.iterator.IteratorCloseable<Quad>() {
                private Quad next;
                public boolean hasNext() {
                    if (next == null && rows.hasNext()) {
                        next = rows.next(); CommandWork.count("also_enjoyed_writer_rows", 1);
                    }
                    return next != null;
                }
                public Quad next() {
                    if (!hasNext()) throw new NoSuchElementException();
                    Quad value = next; next = null; return value;
                }
                public void close() { Iter.close(rows); }
            };
        }
        @Override public boolean contains(Node g, Node s, Node p, Node o) {
            var rows = find(g, s, p, o);
            try { return rows.hasNext(); } finally { Iter.close(rows); }
        }
        @Override public void add(Node g, Node s, Node p, Node o) {
            CommandWork.count("also_enjoyed_writer_adds", 1); super.add(g, s, p, o);
        }
        @Override public void delete(Node g, Node s, Node p, Node o) {
            CommandWork.count("also_enjoyed_writer_deletes", 1); super.delete(g, s, p, o);
        }
        @Override public void deleteAny(Node g, Node s, Node p, Node o) {
            var rows = find(g, s, p, o); List<Quad> removed = new ArrayList<>();
            try { while (rows.hasNext()) removed.add(rows.next()); } finally { Iter.close(rows); }
            for (Quad quad : removed) delete(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
        }
    }
    /** Use the bounded net primary delta, not validation or search-copy
     * neighbours. In particular a slot edit does not change its Work owner. */
    static Set<Node> changedSubjects(Set<Quad> additions, Set<Quad> removals) {
        Set<Node> result = new LinkedHashSet<>();
        for (var quads : List.of(additions, removals)) for (Quad quad : quads)
            if (quad.getGraph().equals(CURRENT) || quad.getGraph().equals(REVISIONS)) result.add(quad.getSubject());
        return result;
    }
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
    private static void dependency(Set<Node> desired, Node resource) {
        if (resource != null && resource.isURI()) desired.add(resource);
    }
    /** The reverse inventory belongs to this current owner snapshot. Removing
     * a source also removes its forward trigger in this same transaction.
     * Legacy alsoEnjoyedWork edges are superseded, never read as a fallback. */
    private static void dependencies(DatasetGraph data, Node owner, Set<Node> desired, long deadline) {
        Set<Node> prior = new LinkedHashSet<>();
        var rows = data.find(STATE, owner, DEPENDENCY, Node.ANY);
        try { while (rows.hasNext()) { budget(deadline); prior.add(rows.next().getObject()); } }
        finally { Iter.close(rows); }
        for (Node source : prior) if (!desired.contains(source)) {
            data.delete(STATE, owner, DEPENDENCY, source); data.delete(STATE, source, DEPENDENT, owner);
        }
        for (Node source : desired) if (!prior.contains(source)) {
            data.add(STATE, owner, DEPENDENCY, source); data.add(STATE, source, DEPENDENT, owner);
        }
    }
    private static boolean workOwner(DatasetGraph data, Node owner) {
        return data.contains(CURRENT, owner, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))
            || data.contains(STATE, owner, ELIGIBLE, Node.ANY);
    }
    static void refresh(DatasetGraph data, Set<Node> resources, long deadline) {
        data = writer(data);
        Set<Node> owners = new LinkedHashSet<>();
        for (Node resource : resources) {
            budget(deadline);
            // A current or previously indexed slot owns only its own leaf.
            if (data.contains(CURRENT, resource, RDF.type.asNode(), p("RealmPublicationSlot"))
                || data.contains(STATE, resource, SLOT_WORK, Node.ANY)
                || data.contains(STATE, resource, ENTRY, Node.ANY)
                    && !workOwner(data, resource)) {
                owners.add(resource); continue;
            }
            if (workOwner(data, resource)) owners.add(resource);
            for (String property : List.of("work", "resource", "component")) {
                Node work = linkedWork(data, resource, p(property));
                if (PublicNameProjection.productResource(work)
                    && data.contains(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))) owners.add(work);
            }
            var linked = data.find(STATE, resource, DEPENDENT, Node.ANY);
            try { while (linked.hasNext()) { budget(deadline); owners.add(linked.next().getObject()); } }
            finally { Iter.close(linked); }
        }
        // Rebind current slot adjacency before any Work fan-out, then refresh
        // the changed Works and finally the explicit slots. Compound writes do
        // not depend on primary-quad order or an old Work's cached eligibility.
        Set<Node> slots = new LinkedHashSet<>();
        for (Node owner : owners) if (!workOwner(data, owner)) {
            slots.add(owner); linkSlot(data, owner, data.contains(CURRENT, owner, RDF.type.asNode(), p("RealmPublicationSlot"))
                ? one(data, CURRENT, owner, p("work")) : null);
        }
        for (Node owner : owners) if (!slots.contains(owner)) refreshWork(data, owner, deadline);
        for (Node slot : slots) refreshSlot(data, slot, deadline);
    }
    static void refreshWork(DatasetGraph data, Node work, long deadline) {
        data = writer(data); CommandWork.count("also_enjoyed_writer_works", 1);
        budget(deadline);
        Set<String> desired = new HashSet<>();
        Set<Node> sources = new LinkedHashSet<>();
        Node main = one(data, CURRENT, work, p("mainVersion"));
        dependency(sources, main);
        for (Node owner : main == null ? List.of(work) : List.of(work, main))
            for (String property : List.of("head", "semanticHead", "conceptHead", "collectionHead", "zoneHead"))
                dependency(sources, one(data, CURRENT, owner, p(property)));
        boolean eligible = PublicNameProjection.candidateWork(data, work);
        // Work-level Content erasure is an authority fence, not a stale page.
        // This inventory is inspected only by the writer, never by the reader.
        var variants = data.find(CURRENT, Node.ANY, p("resource"), work);
        try { while (variants.hasNext()) {
            budget(deadline); Node variant = variants.next().getSubject(); dependency(sources, variant);
            Node publication = one(data, CURRENT, variant, p("contentPublicationHead"));
            Node revision = publication == null ? null : one(data, REVISIONS, publication, p("contentRevision"));
            dependency(sources, publication); dependency(sources, revision);
            if (revision != null && data.contains(REVISIONS, revision, RDF.type.asNode(), p("ErasedRevision"))) eligible = false;
        } } finally { Iter.close(variants); }
        Set<String> languages = new HashSet<>(); languages.add("");
        if (main != null) for (Node selection : values(data, CURRENT, main, p("selectionHead"), 64)) {
            budget(deadline);
            dependency(sources, selection);
            Node language = one(data, REVISIONS, selection, p("language"));
            if (language != null && language.isLiteral()) languages.add(language.getLiteralLexicalForm());
            for (String property : List.of("contribution", "selectedDraft", "publicationDecision"))
                dependency(sources, one(data, REVISIONS, selection, p(property)));
            Node contribution = one(data, REVISIONS, selection, p("contribution"));
            if (contribution != null) for (String property : List.of("head", "semanticHead", "conceptHead", "collectionHead", "zoneHead"))
                dependency(sources, one(data, CURRENT, contribution, p(property)));
        }
        Node structureDecision = one(data, CURRENT, work, p("workStructurePublicationHead"));
        if (structureDecision != null) {
            dependency(sources, structureDecision);
            Node source = one(data, REVISIONS, structureDecision, p("publicSource"));
            dependency(sources, source);
            if (source != null) for (String property : List.of("structure", "structureRevision", "selectedGeneration"))
                dependency(sources, one(data, REVISIONS, source, p(property)));
        }
        if (eligible) for (Node type : values(data, CURRENT, work, RDF.type.asNode(), 16)) {
            if (!type.isURI() || type.getURI().equals("https://schema.org/CreativeWork")) continue;
            for (String language : languages) desired.add(root("type", type.getURI(), language) + key(work));
        }
        // This Work-owned proof includes every current Content erasure. Slot
        // edits consume it in one point probe instead of rescanning variants.
        Node eligibility = NodeFactory.createLiteralByValue(eligible, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean);
        if (!eligibility.equals(one(data, STATE, work, ELIGIBLE))) {
            data.deleteAny(STATE, work, ELIGIBLE, Node.ANY); data.add(STATE, work, ELIGIBLE, eligibility);
        }
        dependencies(data, work, sources, deadline);
        replace(data, work, work, desired, deadline);
        // Only a changed Work's own Realm slots fan out, in the writer. The
        // native page never catches up, folds logs or enumerates these slots.
        var slots = data.find(STATE, work, WORK_SLOT, Node.ANY);
        List<Node> currentSlots = new ArrayList<>();
        try { while (slots.hasNext()) {
            budget(deadline); currentSlots.add(slots.next().getObject());
        } } finally { Iter.close(slots); }
        for (Node slot : currentSlots) refreshSlot(data, slot, eligible, deadline);
    }
    /** Current adjacency, including private slots, is pruned atomically by its
     * slot writer. Work writes never enumerate Contributions or removed slots. */
    private static void linkSlot(DatasetGraph data, Node slot, Node work) {
        Node prior = one(data, STATE, slot, SLOT_WORK);
        if (Objects.equals(prior, work)) return;
        if (prior != null) { data.delete(STATE, slot, SLOT_WORK, prior); data.delete(STATE, prior, WORK_SLOT, slot); }
        if (work != null) { data.add(STATE, slot, SLOT_WORK, work); data.add(STATE, work, WORK_SLOT, slot); }
    }
    static void refreshSlot(DatasetGraph data, Node slot, long deadline) {
        data = writer(data);
        Node work = one(data, CURRENT, slot, p("work"));
        refreshSlot(data, slot, work != null && data.contains(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))
            && data.contains(STATE, work, ELIGIBLE, PUBLIC), deadline);
    }
    private static void refreshSlot(DatasetGraph data, Node slot, boolean publicWork, long deadline) {
        CommandWork.count("also_enjoyed_writer_slots", 1);
        budget(deadline);
        boolean current = data.contains(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"));
        Node work = current ? one(data, CURRENT, slot, p("work")) : null,
            realm = current ? one(data, CURRENT, slot, p("realm")) : null;
        Node selection = current ? one(data, CURRENT, slot, p("selectionHead")) : null;
        linkSlot(data, slot, work);
        Set<String> desired = new HashSet<>();
        Set<Node> sources = new LinkedHashSet<>(); dependency(sources, selection);
        if (publicWork && PublicNameProjection.productResource(work) && PublicNameProjection.productResource(realm) && selection != null
            && data.contains(REVISIONS, selection, RDF.type.asNode(), p("PublicationSelection"))
            && data.contains(REVISIONS, selection, p("work"), work)) {
            Node decision = one(data, REVISIONS, selection, p("publicationDecision"));
            dependency(sources, decision);
            if (decision != null && data.contains(REVISIONS, decision, p("disclosure"), p("Public")))
                desired.add(root("realm", realm.getURI(), "") + key(work));
        }
        dependencies(data, slot, sources, deadline);
        replace(data, slot, work, desired, deadline);
    }
    static boolean prepared(DatasetGraph data) {
        Node epoch = one(data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("dataEpoch"));
        return epoch != null && epoch.equals(one(data, STATE, PREPARATION, p("alsoEnjoyedEpoch")))
            && FORM.equals(one(data, STATE, PREPARATION, p("alsoEnjoyedForm")))
            && !data.contains(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("restoreHold"), NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
    }
    /** The existing cold Work-scope preparer advances one physical type page.
     * Old schema upgrades cannot be warmed or rebuilt by an HTTP reader. */
    static boolean prepare(DatasetGraph data, long deadline) {
        data = writer(data);
        if (prepared(data)) return true;
        Node epoch = one(data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("dataEpoch"));
        if (epoch == null) throw new IllegalStateException("candidate epoch is unavailable");
        if (!epoch.equals(one(data, STATE, PREPARATION, p("alsoEnjoyedBuildEpoch")))
            || !FORM.equals(one(data, STATE, PREPARATION, p("alsoEnjoyedBuildForm")))) {
            data.deleteAny(STATE, PREPARATION, Node.ANY, Node.ANY);
            data.add(STATE, PREPARATION, p("alsoEnjoyedBuildEpoch"), epoch);
            data.add(STATE, PREPARATION, p("alsoEnjoyedBuildForm"), FORM);
            data.add(STATE, PREPARATION, p("alsoEnjoyedBuildPhase"), NodeFactory.createLiteralString("slots"));
        }
        Node after = one(data, STATE, PREPARATION, p("alsoEnjoyedAfter"));
        boolean slots = NodeFactory.createLiteralString("slots").equals(one(data, STATE, PREPARATION, p("alsoEnjoyedBuildPhase")));
        var page = TemplateIndexService.ownerTypePage(data, slots ? RV + "RealmPublicationSlot" : "https://schema.org/CreativeWork",
            after == null ? "" : after.getLiteralLexicalForm(), deadline);
        for (Node owner : page.owners()) {
            if (slots) {
                CommandWork.count("also_enjoyed_source_rows_visited", 1);
                // Cold qualification fences readers until all Work proofs are
                // rebuilt. Remove old leaves while registering current slots.
                refreshSlot(data, owner, false, deadline);
            }
            else refreshWork(data, owner, deadline);
        }
        data.deleteAny(STATE, PREPARATION, p("alsoEnjoyedAfter"), Node.ANY);
        if (page.more()) data.add(STATE, PREPARATION, p("alsoEnjoyedAfter"), NodeFactory.createLiteralString(page.after()));
        else if (slots) {
            data.deleteAny(STATE, PREPARATION, p("alsoEnjoyedBuildPhase"), Node.ANY);
            data.add(STATE, PREPARATION, p("alsoEnjoyedBuildPhase"), NodeFactory.createLiteralString("works"));
            // An empty fresh dataset can qualify in this turn; populated cuts
            // keep the Work pass in the existing next maintenance turn.
            if (!data.contains(CURRENT, Node.ANY, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))) {
                data.add(STATE, PREPARATION, p("alsoEnjoyedEpoch"), epoch); data.add(STATE, PREPARATION, p("alsoEnjoyedForm"), FORM);
                return true;
            }
            return false;
        }
        else {
            data.add(STATE, PREPARATION, p("alsoEnjoyedEpoch"), epoch);
            data.add(STATE, PREPARATION, p("alsoEnjoyedForm"), FORM);
        }
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
        QueryWorkService.beginRead(data);
        try { return page(data, ProfileRegistry.required(request, "source"), types,
            request.get("language").isNull() ? null : request.get("language").getAsString().value(),
            request.get("realm").isNull() ? null : request.get("realm").getAsString().value(),
            Integer.parseInt(request.get("limit").toString())); }
        finally { QueryWorkService.endRead(data); }
    }
    private AlsoEnjoyedCandidates() {}
}
