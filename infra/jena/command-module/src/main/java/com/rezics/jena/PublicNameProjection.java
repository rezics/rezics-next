package com.rezics.jena;

import java.util.LinkedHashSet;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;

/** Current public names, committed with their owner mutation. These title-only
 * units share the existing publicTitle field; they are not Work body units. */
final class PublicNameProjection {
    static final String PREFIX = "urn:rezics:search:name:";
    static final String DIRECTORY = "urn:rezics:search:directory:";
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node POLICY = uri(PREFIX + "policy-state");
    static final Node REPAIR = uri("urn:rezics:projection:public-name-repair");
    static final int REPAIR_BATCH_SIZE = 64;
    private static final Node IN_SCHEME = uri("http://www.w3.org/2004/02/skos/core#inScheme");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    static boolean nameMaintenanceQuad(Quad quad) {
        if (quad.getPredicate().equals(p("publicTitle"))) return true;
        return (quad.getSubject().isURI() && quad.getSubject().getURI().matches(PREFIX + "visibility:[0-9a-f-]{36}")
            || quad.getSubject().isVariable() && quad.getSubject().getName().equals("marker"))
            && Set.of(p("nameVisibility"), p("nameVersion"), p("nameListing"), p("listingVersion")).contains(quad.getPredicate());
    }
    private static boolean has(DatasetGraph data, Node subject, String predicate, Node object) {
        return data.contains(CURRENT, subject, p(predicate), object);
    }
    private static Node one(DatasetGraph data, Node subject, String predicate) {
        var rows = data.find(CURRENT, subject, p(predicate), Node.ANY);
        try { return rows.hasNext() ? rows.next().getObject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static boolean type(DatasetGraph data, Node subject, String value) {
        return data.contains(CURRENT, subject, RDF.type.asNode(), uri(value));
    }
    static boolean listedPublic(DatasetGraph data, Node resource, boolean requireDisclosure) {
        Node disclosure = one(data, resource, "disclosure"), listing = one(data, resource, "listing");
        return (disclosure == null ? !requireDisclosure : disclosure.equals(p("Public")))
            && (listing == null || listing.equals(NodeFactory.createLiteralString("listed")));
    }
    private static boolean publicRealm(DatasetGraph data, Node realm) {
        Node space = one(data, realm, "space");
        return has(data, realm, "realmState", p("Active")) && space != null
            && listedPublic(data, space, true) && listedPublic(data, realm, false)
            && !withdrawn(data, realm) && !withdrawn(data, space);
    }
    private static boolean withdrawn(DatasetGraph data, Node resource) {
        for (String predicate : Set.of("head", "semanticHead", "conceptHead", "collectionHead", "zoneHead")) {
            Node head = one(data, resource, predicate);
            if (head != null && data.contains(uri(CommandPolicy.REVISIONS), head, RDF.type.asNode(), p("ErasedRevision"))) return true;
        }
        return has(data, resource, "protectionHead", Node.ANY) || has(data, resource, "mergedInto", Node.ANY);
    }
    private static String kind(DatasetGraph data, Node resource) {
        if (withdrawn(data, resource)) return null;
        if (type(data, resource, "http://www.w3.org/2004/02/skos/core#Concept")) {
            Node realm = one(data, resource, "conceptRealm"), scheme = null;
            var rows = data.find(CURRENT, resource, uri("http://www.w3.org/2004/02/skos/core#inScheme"), Node.ANY);
            try { if (rows.hasNext()) scheme = rows.next().getObject(); }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            return has(data, resource, "conceptState", p("Active"))
                && (realm == null || publicRealm(data, realm))
                && (scheme == null || !has(data, scheme, "schemeState", p("Retired")) && !withdrawn(data, scheme)) ? "concept" : null;
        }
        if (type(data, resource, RV + "Realm")) return publicRealm(data, resource) ? "realm" : null;
        if (type(data, resource, RV + "Agent")) {
            Node marker = uri(PREFIX + "visibility:" + resource.getURI().substring("https://rezics.com/id/".length()));
            // An upgraded legacy dataset has unknown Access policies until its
            // resumable policy pass. New bootstrap datasets start reconciled.
            if ((!data.contains(PUBLIC, marker, p("nameVersion"), Node.ANY)
                || !data.contains(PUBLIC, marker, p("listingVersion"), Node.ANY))
                && !data.contains(PUBLIC, POLICY, p("complete"), NodeFactory.createLiteralByValue(true,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean))) return null;
            return has(data, resource, "head", Node.ANY)
            && !type(data, resource, RV + "AgentTombstone")
            && listedPublic(data, resource, false)
            && !has(data, resource, "profileDisclosure", p("Private"))
            && !data.contains(PUBLIC, uri(PREFIX + "visibility:" + resource.getURI().substring("https://rezics.com/id/".length())),
                p("nameListing"), NodeFactory.createLiteralString("unlisted"))
            && !data.contains(PUBLIC, uri(PREFIX + "visibility:" + resource.getURI().substring("https://rezics.com/id/".length())),
                p("nameVisibility"), NodeFactory.createLiteralString("private")) ? "agent" : null;
        }
        if (type(data, resource, "https://schema.org/CreativeWork")) {
            Node main = one(data, resource, "mainVersion");
            boolean published = false;
            var units = data.find(PUBLIC, Node.ANY, p("work"), resource);
            try { while (units.hasNext()) {
                var facts = FilteredGraphTextIndex.describeUnit(data, units.next().getSubject().getURI());
                if (facts != null && facts.context().equals(facts.main()) && facts.main().equals(main)
                    && has(data, main, "selectionHead", facts.selection())) published = true;
            } } finally { org.apache.jena.atlas.iterator.Iter.close(units); }
            return published || has(data, resource, "catalogueVisible", NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)) ? "work" : null;
        }
        if (!listedPublic(data, resource, true)) return null;
        if (type(data, resource, RV + "Zone")) {
            Node space = one(data, resource, "space"), realm = space == null ? null : one(data, space, "realmCapability");
            return has(data, resource, "zoneState", p("Active")) && realm != null && listedPublic(data, space, true) && publicRealm(data, realm) ? "site" : null;
        }
        if (type(data, resource, RV + "Collection")) return has(data, resource, "collectionState", p("Active")) ? "collection" : null;
        if (type(data, resource, RV + "Space")) return one(data, resource, "realmCapability") == null
            && one(data, resource, "zoneCapability") == null ? "space" : null;
        return null;
    }
    static void refresh(DatasetGraph data, CommandPolicy.Plan plan, String receipt, java.util.List<CommandService.Validation> validations, java.util.List<SearchDeltaJournal.Change> changes) {
        if (plan.bootstrap() || data.contains(uri(CommandPolicy.RECEIPTS), uri(receipt), p("namePoliciesComplete"),
            NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)))
            data.add(PUBLIC, POLICY, p("complete"), NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
        Set<Node> resources = new LinkedHashSet<>();
        for (String value : plan.current()) if (value.startsWith("https://rezics.com/id/")) resources.add(uri(value));
        for (var change : changes) {
            if (change.work() != null) resources.add(change.work());
            var units = data.find(PUBLIC, uri(change.unit()), p("work"), Node.ANY);
            try { if (units.hasNext()) resources.add(units.next().getObject()); }
            finally { org.apache.jena.atlas.iterator.Iter.close(units); }
        }
        for (var validation : validations) if (validation.graphs().contains(CommandPolicy.CURRENT))
            for (String value : validation.focus()) if (value.startsWith("https://rezics.com/id/")) resources.add(uri(value));
        if (receipt.startsWith("urn:rezics:receipt:catalogue-search-index:")) {
            var names = data.find(uri(CommandPolicy.RECEIPTS), uri(receipt), p("nameResource"), Node.ANY);
            try { while (names.hasNext()) {
                Node resource = names.next().getObject();
                if (!resource.isURI() || !resource.getURI().startsWith("https://rezics.com/id/"))
                    throw new IllegalArgumentException("name backfill resource is invalid");
                resources.add(resource);
                if (resources.size()>64) throw new IllegalArgumentException("name backfill exceeds candidate bound");
            } } finally { org.apache.jena.atlas.iterator.Iter.close(names); }
        }
        // Only forward, single-valued owner links belong to the writing
        // neighbourhood. Population fan-out is represented by durable cursors.
        Set<Node> changed = new LinkedHashSet<>(resources);
        for (Node subject : Set.copyOf(resources)) {
            for (String predicate : Set.of("work", "space", "realmCapability", "zoneCapability")) {
                Node neighbour = one(data, subject, predicate);
                if (neighbour != null) resources.add(neighbour);
            }
        }
        for (Node resource : changed) if (plan.current().contains(resource.getURI())
            || receipt.startsWith("urn:rezics:receipt:catalogue-search-index:")) invalidate(data, resource, uri(receipt));
        for (Node resource : resources) project(data, resource,
            plan.current().contains(resource.getURI()) || changes.stream().anyMatch(change ->
                resource.equals(change.work()) || data.contains(PUBLIC, uri(change.unit()), p("work"), resource))
            || receipt.startsWith("urn:rezics:receipt:catalogue-search-index:"));
        // The existing names-maintenance entry point advances one bounded batch
        // after the parent write has committed. Receipt replay cannot advance it.
        if (receipt.startsWith("urn:rezics:receipt:catalogue-search-index:")) repairBatch(data, receipt);
    }
    static void refresh(DatasetGraph data, Node resource) {
        invalidate(data, resource, uri(PREFIX + "generation:" + java.util.UUID.randomUUID()));
        project(data, resource, true);
    }

    private static Node state(DatasetGraph data, Node subject, String predicate) {
        var rows = data.find(REPAIR, subject, p(predicate), Node.ANY);
        try { return rows.hasNext() ? rows.next().getObject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static void state(DatasetGraph data, Node subject, String predicate, Node value) {
        Node old = state(data, subject, predicate);
        if (java.util.Objects.equals(old, value)) return;
        if (old != null) data.delete(REPAIR, subject, p(predicate), old);
        if (value != null) data.add(REPAIR, subject, p(predicate), value);
    }
    /** Each projected dependent adds at most four constant-time adjacency
     * links. Links are immutable so a cursor survives moves, deletion and new
     * inserts without a sorted population scan or an offset replay. Historical
     * links may cause a redundant refresh, never a stale visibility decision.
     * Existing datasets acquire these links through the names backfill. */
    private static void dependencies(DatasetGraph data, Node resource) {
        Set<Node> parents = new LinkedHashSet<>();
        for (Node predicate : java.util.List.of(p("space"), p("conceptRealm"), IN_SCHEME)) {
            var rows = data.find(CURRENT, resource, predicate, Node.ANY);
            try { if (rows.hasNext()) parents.add(rows.next().getObject()); }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        }
        // Site admission also depends on its Space's Realm. Keeping this
        // fixed forward link lets a Realm withdrawal tidy Sites as well as
        // Concepts, without walking all Spaces or capabilities.
        if (type(data, resource, RV + "Zone")) {
            Node space = one(data, resource, "space");
            Node realm = space == null ? null : one(data, space, "realmCapability");
            if (realm != null) parents.add(realm);
        }
        for (Node parent : parents) {
            if (!parent.isURI()) continue;
            Node member = uri(PREFIX + "dependent:" + java.util.UUID.nameUUIDFromBytes(
                (parent.getURI() + "\n" + resource.getURI()).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            if (state(data, member, "dependentResource") != null) continue;
            state(data, member, "dependentResource", resource);
            state(data, member, "dependentNext", state(data, parent, "dependentHead"));
            state(data, parent, "dependentHead", member);
        }
    }
    /** O(1) per changed parent, independent of its dependent population. The
     * generation also fences copied names when a public parent is renamed. */
    private static void invalidate(DatasetGraph data, Node parent, Node generation) {
        if (generation.equals(state(data, parent, "nameGeneration"))) return;
        state(data, parent, "nameGeneration", generation);
        Node head = state(data, parent, "dependentHead");
        if (head == null) return;
        state(data, parent, "repairCursor", head);
    }
    /** One indexed pending-parent probe; never sort or enumerate the pending
     * inventory. Each writer stores its own cursor without a global queue head
     * or tail that would serialize unrelated parent partitions. */
    private static Node pendingParent(DatasetGraph data) {
        var rows = data.find(REPAIR, Node.ANY, p("repairCursor"), Node.ANY);
        try { return rows.hasNext() ? rows.next().getSubject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    /** Called in the maintenance command's write transaction: projection,
     * checkpoint and replay marker commit or roll back together. Jena permits
     * one writer, so a newer invalidation atomically resets a pending cursor.
     * https://jena.apache.org/documentation/tdb/tdb_transactions.html
     * Cost: <=64 dependent steps, each with constant indexed probes;
     * individual authored-name/Work-unit recipe costs remain unchanged. */
    static int repairBatch(DatasetGraph data, String receipt) {
        Node replay = uri(receipt);
        if (state(data, replay, "repairApplied") != null) return 0;
        int processed = 0;
        for (int step = 0; step < REPAIR_BATCH_SIZE; step++) {
            Node parent = pendingParent(data);
            if (parent == null) break;
            Node cursor = state(data, parent, "repairCursor");
            if (cursor != null) {
                Node resource = state(data, cursor, "dependentResource");
                Node next = state(data, cursor, "dependentNext");
                if (resource == null) throw new IllegalStateException("name repair cursor has no dependent");
                // Cascades (Space -> Realm -> Concept) are separate pending work,
                // never a recursive dependent walk in either transaction.
                invalidate(data, resource, replay);
                project(data, resource, false);
                state(data, parent, "repairCursor", next);
                processed++;
            }
        }
        state(data, replay, "repairApplied", replay);
        return processed;
    }
    /** Check live parent policy before admitting any stored name candidate.
     * A fence does not require repair to run: Concept -> Realm -> Space is a
     * fixed path; retired Schemes and protected name sources also deny reads. */
    static boolean visible(DatasetGraph data, Node resource) {
        // Work names have no parent policy dependency and are synchronously
        // maintained by their own mutation. Do not turn this bounded candidate
        // gate into a walk of all of a Work's publication units.
        String kind = type(data, resource, "https://schema.org/CreativeWork")
            ? (withdrawn(data, resource) ? null : "work") : kind(data, resource);
        if (kind == null) return false;
        Node source = Set.of("realm", "site").contains(kind) ? one(data, resource, "space") : resource;
        if (source == null || has(data, source, "protectionHead", Node.ANY)) return false;
        Node unit = uri(PREFIX + kind + ":" + resource.getURI().substring("https://rezics.com/id/".length()));
        if (!data.contains(PUBLIC, unit, p("resource"), resource)) return false;
        return !Set.of("realm", "site").contains(kind) || java.util.Objects.equals(
            state(data, source, "nameGeneration"), projectedGeneration(data, unit));
    }
    private static Node projectedGeneration(DatasetGraph data, Node unit) {
        var rows = data.find(PUBLIC, unit, p("nameSourceGeneration"), Node.ANY);
        try { return rows.hasNext() ? rows.next().getObject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    static boolean visibleUnit(DatasetGraph data, String id) {
        var rows = data.find(PUBLIC, uri(id), p("resource"), Node.ANY);
        Node resource;
        try { resource = rows.hasNext() ? rows.next().getObject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        return resource != null && resource.isURI() && visible(data, resource);
    }
    private static void project(DatasetGraph data, Node resource, boolean changed) {
        dependencies(data, resource);
        Set<Quad> prior = new LinkedHashSet<>(), desired = new LinkedHashSet<>();
        String suffix = resource.getURI().substring("https://rezics.com/id/".length());
        Node oldCreated = null, oldUpdated = null;
        var directories = data.find(PUBLIC, Node.ANY, p("nameDirectoryResource"), resource);
        Set<Node> oldDirectories = new LinkedHashSet<>();
        try { while (directories.hasNext()) oldDirectories.add(directories.next().getSubject()); }
        finally { org.apache.jena.atlas.iterator.Iter.close(directories); }
        for (Node directory : oldDirectories) collect(data, directory, prior);
        for (String value : Set.of("concept", "realm", "site", "agent", "collection", "space", "work"))
        {
            Node oldUnit = uri(PREFIX + value + ":" + suffix);
            var created = data.find(PUBLIC, oldUnit, p("createdOrder"), Node.ANY);
            try { if (created.hasNext()) oldCreated = created.next().getObject(); }
            finally { org.apache.jena.atlas.iterator.Iter.close(created); }
            var updated = data.find(PUBLIC, oldUnit, p("updatedOrder"), Node.ANY);
            try { if (updated.hasNext()) oldUpdated = updated.next().getObject(); }
            finally { org.apache.jena.atlas.iterator.Iter.close(updated); }
            collect(data, oldUnit, prior);
        }
        String kind = kind(data, resource);
        if (kind == null) { apply(data, prior, desired); return; }
        Node source = Set.of("realm", "site").contains(kind) ? one(data, resource, "space") : resource;
        if (source == null || has(data, source, "protectionHead", Node.ANY)) {
            apply(data, prior, desired); return;
        }
        Node unit = uri(PREFIX + kind + ":" + suffix);
        java.util.NavigableSet<Node> names = new java.util.TreeSet<>(java.util.Comparator.comparing(
            org.apache.jena.riot.out.NodeFmtLib::strNT));
        for (String predicate : Set.of("http://www.w3.org/2000/01/rdf-schema#label", "https://schema.org/name",
            "https://schema.org/alternateName", RV + "localizedName", "http://www.w3.org/2004/02/skos/core#prefLabel",
            "http://www.w3.org/2004/02/skos/core#altLabel")) {
            var rows = data.find(CURRENT, source, uri(predicate), Node.ANY);
            try { while (rows.hasNext()) {
                Node name = rows.next().getObject();
                if (name.isLiteral()) names.add(name);
                if (names.size() > 64) names.pollLast();
            } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        }
        if (kind.equals("work")) {
            var units = data.find(PUBLIC, Node.ANY, p("work"), resource);
            try { while (units.hasNext()) {
                var titles = data.find(PUBLIC, units.next().getSubject(), p("publicTitle"), Node.ANY);
                try { while (titles.hasNext()) {
                    names.add(titles.next().getObject());
                    if (names.size() > 64) names.pollLast();
                } }
                finally { org.apache.jena.atlas.iterator.Iter.close(titles); }
            } } finally { org.apache.jena.atlas.iterator.Iter.close(units); }
        }
        for (Node name : names) desired.add(new Quad(PUBLIC, unit, p("publicTitle"), name));
        if (!names.isEmpty()) {
            desired.add(new Quad(PUBLIC, unit, RDF.type.asNode(), p("PublicNameMatchUnit")));
            desired.add(new Quad(PUBLIC, unit, p("resource"), resource));
            if (Set.of("realm", "site").contains(kind)) {
                Node generation = state(data, source, "nameGeneration");
                if (generation != null) desired.add(new Quad(PUBLIC, unit, p("nameSourceGeneration"), generation));
            }
            desired.add(new Quad(PUBLIC, unit, p("disclosure"), p("Public")));
            var sequences = data.find(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("sequence"), Node.ANY);
            try { if (sequences.hasNext()) {
                String sequence = sequences.next().getObject().getLiteralLexicalForm();
                Node rank = NodeFactory.createLiteralByValue(new java.math.BigInteger("32000000000000000000000000000000")
                    .add(new java.math.BigInteger(sequence)), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger);
                Node updatedRank = !changed && oldUpdated != null ? oldUpdated : rank;
                desired.add(new Quad(PUBLIC, unit, p("updatedOrder"), updatedRank));
                desired.add(new Quad(PUBLIC, unit, p("createdOrder"), oldCreated == null ? rank : oldCreated));
                directory(desired, resource, kind, "newest", oldCreated == null ? rank : oldCreated);
                directory(desired, resource, kind, "updated", updatedRank);
            } } finally { org.apache.jena.atlas.iterator.Iter.close(sequences); }
        }
        apply(data, prior, desired);
    }
    private static void collect(DatasetGraph data, Node subject, Set<Quad> result) {
        var quads = data.find(PUBLIC, subject, Node.ANY, Node.ANY);
        try { while (quads.hasNext()) result.add(quads.next()); }
        finally { org.apache.jena.atlas.iterator.Iter.close(quads); }
    }
    /** Preserve unchanged name documents and directory entries. In particular,
     * validating a Work during classification does not rewrite its names. */
    private static void apply(DatasetGraph data, Set<Quad> prior, Set<Quad> desired) {
        for (Quad quad : prior) if (!desired.contains(quad)) data.delete(quad);
        for (Quad quad : desired) if (!prior.contains(quad)) data.add(quad);
    }
    /** Ordered projection keys use the existing indexed entity field. Lucene's
     * term dictionary can seek by kind/order without sorting name documents. */
    private static void directory(Set<Quad> desired, Node resource, String kind, String order, Node rank) {
        java.math.BigInteger value = new java.math.BigInteger(rank.getLiteralLexicalForm());
        String reverse = String.format(java.util.Locale.ROOT, "%040d", java.math.BigInteger.TEN.pow(40)
            .subtract(java.math.BigInteger.ONE).subtract(value));
        Node unit = uri(DIRECTORY + kind + ":" + order + ":" + reverse + ":" + resource.getURI().substring("https://rezics.com/id/".length()));
        desired.add(new Quad(PUBLIC, unit, p("nameDirectoryResource"), resource));
        desired.add(new Quad(PUBLIC, unit, p("nameDirectoryOrder"), rank));
        desired.add(new Quad(PUBLIC, unit, p("publicTitle"), NodeFactory.createLiteralString("rezicspublicdirectory")));
    }
}
