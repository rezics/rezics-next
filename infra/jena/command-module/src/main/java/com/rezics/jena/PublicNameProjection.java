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
            && !has(data, realm, "protectionHead", Node.ANY);
    }
    private static String kind(DatasetGraph data, Node resource) {
        for (String predicate : Set.of("head", "semanticHead", "conceptHead", "collectionHead", "zoneHead")) {
            Node head = one(data, resource, predicate);
            if (head != null && data.contains(uri(CommandPolicy.REVISIONS), head, RDF.type.asNode(), p("ErasedRevision"))) return null;
        }
        if (has(data, resource, "protectionHead", Node.ANY) || has(data, resource, "mergedInto", Node.ANY)) return null;
        if (type(data, resource, "http://www.w3.org/2004/02/skos/core#Concept")) {
            Node realm = one(data, resource, "conceptRealm"), scheme = null;
            var rows = data.find(CURRENT, resource, uri("http://www.w3.org/2004/02/skos/core#inScheme"), Node.ANY);
            try { if (rows.hasNext()) scheme = rows.next().getObject(); }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            return has(data, resource, "conceptState", p("Active"))
                && (realm == null || publicRealm(data, realm))
                && (scheme == null || !has(data, scheme, "schemeState", p("Retired"))) ? "concept" : null;
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
        // Visibility and lifecycle transitions remove dependent public names in
        // the same transaction. Object-index walks stream the owning inventory.
        for (Node subject : Set.copyOf(resources)) {
            for (String predicate : Set.of("space", "conceptRealm")) {
                if (predicate.equals("conceptRealm") && publicRealm(data, subject)) continue;
                var dependents = data.find(CURRENT, Node.ANY, p(predicate), subject);
                try { while (dependents.hasNext()) resources.add(dependents.next().getSubject()); }
                finally { org.apache.jena.atlas.iterator.Iter.close(dependents); }
            }
            Node work = one(data, subject, "work");
            if (work != null) resources.add(work);
            Node space = one(data, subject, "space");
            if (space != null) resources.add(space);
            for (String capability : Set.of("realmCapability", "zoneCapability")) {
                Node component = one(data, subject, capability);
                if (component != null) resources.add(component);
            }
            if (!has(data, subject, "schemeState", p("Retired"))) continue;
            var concepts = data.find(CURRENT, Node.ANY, uri("http://www.w3.org/2004/02/skos/core#inScheme"), subject);
            try { while (concepts.hasNext()) resources.add(concepts.next().getSubject()); }
            finally { org.apache.jena.atlas.iterator.Iter.close(concepts); }
        }
        for (Node resource : resources) refresh(data, resource);
    }
    static void refresh(DatasetGraph data, Node resource) {
        String suffix = resource.getURI().substring("https://rezics.com/id/".length());
        Node oldCreated = null;
        var directories = data.find(PUBLIC, Node.ANY, p("nameDirectoryResource"), resource);
        Set<Node> oldDirectories = new LinkedHashSet<>();
        try { while (directories.hasNext()) oldDirectories.add(directories.next().getSubject()); }
        finally { org.apache.jena.atlas.iterator.Iter.close(directories); }
        for (Node directory : oldDirectories) data.deleteAny(PUBLIC, directory, Node.ANY, Node.ANY);
        for (String value : Set.of("concept", "realm", "site", "agent", "collection", "space", "work"))
        {
            Node oldUnit = uri(PREFIX + value + ":" + suffix);
            var created = data.find(PUBLIC, oldUnit, p("createdOrder"), Node.ANY);
            try { if (created.hasNext()) oldCreated = created.next().getObject(); }
            finally { org.apache.jena.atlas.iterator.Iter.close(created); }
            data.deleteAny(PUBLIC, oldUnit, Node.ANY, Node.ANY);
        }
        String kind = kind(data, resource);
        if (kind == null) return;
        Node source = Set.of("realm", "site").contains(kind) ? one(data, resource, "space") : resource;
        if (source == null || has(data, source, "protectionHead", Node.ANY)) return;
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
        for (Node name : names) data.add(new Quad(PUBLIC, unit, p("publicTitle"), name));
        if (!names.isEmpty()) {
            data.add(new Quad(PUBLIC, unit, RDF.type.asNode(), p("PublicNameMatchUnit")));
            data.add(new Quad(PUBLIC, unit, p("resource"), resource));
            data.add(new Quad(PUBLIC, unit, p("disclosure"), p("Public")));
            var sequences = data.find(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("sequence"), Node.ANY);
            try { if (sequences.hasNext()) {
                String sequence = sequences.next().getObject().getLiteralLexicalForm();
                Node rank = NodeFactory.createLiteralByValue(new java.math.BigInteger("32000000000000000000000000000000")
                    .add(new java.math.BigInteger(sequence)), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger);
                data.add(new Quad(PUBLIC, unit, p("updatedOrder"), rank));
                data.add(new Quad(PUBLIC, unit, p("createdOrder"), oldCreated == null ? rank : oldCreated));
                directory(data, resource, kind, "newest", oldCreated == null ? rank : oldCreated);
                directory(data, resource, kind, "updated", rank);
            } } finally { org.apache.jena.atlas.iterator.Iter.close(sequences); }
        }
    }
    /** Ordered projection keys use the existing indexed entity field. Lucene's
     * term dictionary can seek by kind/order without sorting name documents. */
    private static void directory(DatasetGraph data, Node resource, String kind, String order, Node rank) {
        java.math.BigInteger value = new java.math.BigInteger(rank.getLiteralLexicalForm());
        String reverse = String.format(java.util.Locale.ROOT, "%040d", java.math.BigInteger.TEN.pow(40)
            .subtract(java.math.BigInteger.ONE).subtract(value));
        Node unit = uri(DIRECTORY + kind + ":" + order + ":" + reverse + ":" + resource.getURI().substring("https://rezics.com/id/".length()));
        data.add(new Quad(PUBLIC, unit, p("nameDirectoryResource"), resource));
        data.add(new Quad(PUBLIC, unit, p("nameDirectoryOrder"), rank));
        data.add(new Quad(PUBLIC, unit, p("publicTitle"), NodeFactory.createLiteralString("rezicspublicdirectory")));
    }
}
