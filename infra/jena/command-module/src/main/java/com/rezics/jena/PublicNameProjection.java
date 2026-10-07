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
    private static final String PRODUCT = "https://rezics.com/id/";
    private static final String UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final java.util.regex.Pattern PRODUCT_IRI = java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(PRODUCT) + UUID);
    static boolean productResource(Node resource) {
        return resource != null && resource.isURI() && PRODUCT_IRI.matcher(resource.getURI()).matches();
    }
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node POLICY = uri(PREFIX + "policy-state");
    static final Node REPAIR = uri("urn:rezics:projection:public-name-repair");
    static final int REPAIR_BATCH_SIZE = 64;
    static final int NAME_BATCH_SIZE = 64;
    private static final java.util.List<String> NAME_KINDS = java.util.List.of("concept", "realm", "site", "agent", "collection", "space", "work");
    private static final java.util.List<Node> NAME_PREDICATES = java.util.List.of(
        uri("http://www.w3.org/2000/01/rdf-schema#label"), uri("https://schema.org/name"),
        uri("https://schema.org/alternateName"), p("localizedName"),
        uri("http://www.w3.org/2004/02/skos/core#prefLabel"), uri("http://www.w3.org/2004/02/skos/core#altLabel"));
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node IN_SCHEME = uri("http://www.w3.org/2004/02/skos/core#inScheme");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    static boolean nameMaintenanceQuad(Quad quad) {
        if (quad.getPredicate().equals(p("publicTitle"))) return true;
        return (quad.getSubject().isURI() && quad.getSubject().getURI().matches(PREFIX + "visibility:" + UUID)
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
        if (!productResource(realm)) return false;
        Node space = one(data, realm, "space");
        return productResource(space) && has(data, realm, "realmState", p("Active")) && space != null
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
        if (!productResource(resource) || withdrawn(data, resource)) return null;
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
            return has(data, resource, "catalogueVisible", NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)) || publishedWork(data, resource) ? "work" : null;
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
    private static Node revisionValue(DatasetGraph data, Node subject, String predicate) {
        var rows = data.find(REVISIONS, subject, p(predicate), Node.ANY);
        try { return rows.hasNext() ? rows.next().getObject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    /** The same owner proof used by publishedWork in Main: current Main heads,
     * current Contribution decision and an unerased selected draft. HeadCasPolicy
     * admits at most 64 language heads. Search units (including chapters) are
     * derived copies and neither establish nor withdraw publication authority. */
    private static boolean publishedWork(DatasetGraph data, Node work) {
        Node main = one(data, work, "mainVersion");
        if (main == null || withdrawn(data, main) || !type(data, main, RV + "MainVersion")
            || !has(data, main, "work", work)) return false;
        var heads = data.find(CURRENT, main, p("selectionHead"), Node.ANY);
        try { for (int count = 0; heads.hasNext(); count++) {
            if (count == 64) throw new IllegalArgumentException("Main language heads exceed their admitted bound");
            Node selection = heads.next().getObject();
            CommandWork.count("public_name_heads_visited", 1);
            Node contribution = revisionValue(data, selection, "contribution");
            Node decision = revisionValue(data, selection, "publicationDecision");
            Node draft = revisionValue(data, selection, "selectedDraft");
            if (contribution != null && decision != null && draft != null && !withdrawn(data, contribution)
                && data.contains(REVISIONS, selection, RDF.type.asNode(), p("PublicationSelection"))
                && data.contains(REVISIONS, selection, p("work"), work)
                && data.contains(REVISIONS, selection, p("mainVersion"), main)
                && data.contains(REVISIONS, selection, p("context"), main)
                && has(data, contribution, "work", work)
                && has(data, contribution, "publicationHead", decision)
                && data.contains(REVISIONS, decision, RDF.type.asNode(), p("PublicationDecision"))
                && data.contains(REVISIONS, decision, p("component"), contribution)
                && data.contains(REVISIONS, decision, p("work"), work)
                && data.contains(REVISIONS, decision, p("contribution"), contribution)
                && data.contains(REVISIONS, decision, p("selectedDraft"), draft)
                && data.contains(REVISIONS, decision, p("disclosure"), p("Public"))
                && data.contains(REVISIONS, draft, RDF.type.asNode(), p("RevisionAnchor"))
                && data.contains(REVISIONS, draft, p("component"), contribution)
                && !data.contains(REVISIONS, draft, RDF.type.asNode(), p("ErasedRevision"))) return true;
        } } finally { org.apache.jena.atlas.iterator.Iter.close(heads); }
        return false;
    }
    static void refresh(DatasetGraph data, CommandPolicy.Plan plan, String receipt, java.util.List<CommandService.Validation> validations, java.util.List<SearchDeltaJournal.Change> changes) {
        if (plan.bootstrap() || data.contains(uri(CommandPolicy.RECEIPTS), uri(receipt), p("namePoliciesComplete"),
            NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)))
            data.add(PUBLIC, POLICY, p("complete"), NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
        Set<Node> resources = new LinkedHashSet<>();
        for (String value : plan.current()) if (productResource(uri(value))) resources.add(uri(value));
        for (var change : changes) {
            if (productResource(change.work())) resources.add(change.work());
            var units = data.find(PUBLIC, uri(change.unit()), p("work"), Node.ANY);
            try { if (units.hasNext()) {
                Node work = units.next().getObject();
                if (productResource(work)) resources.add(work);
            } }
            finally { org.apache.jena.atlas.iterator.Iter.close(units); }
        }
        for (var validation : validations) if (validation.graphs().contains(CommandPolicy.CURRENT))
            for (String value : validation.focus()) if (productResource(uri(value))) resources.add(uri(value));
        if (receipt.startsWith("urn:rezics:receipt:catalogue-search-index:")) {
            var names = data.find(uri(CommandPolicy.RECEIPTS), uri(receipt), p("nameResource"), Node.ANY);
            try { while (names.hasNext()) {
                Node resource = names.next().getObject();
                if (!productResource(resource))
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
                if (productResource(neighbour)) resources.add(neighbour);
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
        if (receipt.startsWith("urn:rezics:receipt:catalogue-search-index:")) {
            repairBatch(data, receipt);
            repairNameLabels(data, receipt);
        }
    }
    static void refresh(DatasetGraph data, Node resource) {
        if (!productResource(resource)) return;
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
                if (productResource(resource)) {
                    invalidate(data, resource, replay);
                    project(data, resource, false);
                }
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
        if (!productResource(resource)) return false;
        // Work qualification now follows bounded owner heads as well, so a
        // live publication withdrawal is denied without waiting for label repair.
        String kind = kind(data, resource);
        if (kind == null || state(data, resource, "labelCopyPhase") != null) return false;
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
        if (!productResource(resource)) return false;
        String kind = kind(data, resource);
        return kind != null && id.equals(nameUnit(resource, kind).getURI()) && visible(data, resource);
    }
    static Node nameUnit(Node resource, String kind) {
        return uri(PREFIX + kind + ":" + resource.getURI().substring("https://rezics.com/id/".length()));
    }
    private record NamePage(java.util.List<Node> values, boolean more) {}
    /** A bounded probe used by the synchronous path and by destructive cleanup.
     * The extra value distinguishes a complete recipe from a repair batch; it
     * is never dropped as a product limit. Count every visited value, including
     * nonliteral or duplicate values, rather than only retained names. */
    private static NamePage namePage(DatasetGraph data, Node graph, Node subject, Node predicate, int limit) {
        var rows = data.find(graph, subject, predicate, Node.ANY);
        java.util.List<Node> values = new java.util.ArrayList<>();
        try { while (rows.hasNext() && values.size() <= limit) {
            values.add(rows.next().getObject());
            CommandWork.count("public_name_labels_visited", 1);
        } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        boolean more = values.size() > limit;
        if (more) values.removeLast();
        return new NamePage(values, more);
    }
    /** Resume on TDB's existing GSPO B+tree. No OFFSET, sort or prefix replay.
     * Persist the RDF term, not a NodeId, and resolve the current node table in
     * each transaction. Reads bypass wrappers, writes always pass through them
     * so the text monitor and command accounting observe every actual change.
     * https://github.com/apache/jena/blob/jena-6.2.0/jena-tdb2/src/main/java/org/apache/jena/tdb2/store/tupletable/TupleIndexRecord.java */
    private static NamePage nameRange(DatasetGraph data, Node source, Node predicate, Node after, int limit) {
        if (after == null) return namePage(data, CURRENT, source, predicate, limit);
        DatasetGraph base = org.apache.jena.sparql.core.DatasetGraphWrapper.unwrap(data);
        var tdb = org.apache.jena.tdb2.sys.TDBInternal.requireStorage(base);
        var table = tdb.getQuadTable().getNodeTupleTable();
        var nodes = table.getNodeTable();
        var index = (org.apache.jena.tdb2.store.tupletable.TupleIndexRecord)
            table.getTupleTable().selectIndex("GSPO").baseTupleIndex();
        var factory = index.getRangeIndex().getRecordFactory();
        var low = factory.createKeyOnly();
        var high = factory.createKeyOnly();
        Node[] prefix = { CURRENT, source, predicate };
        for (int i = 0; i < prefix.length; i++) {
            var id = nodes.getNodeIdForNode(prefix[i]);
            if (org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) return new NamePage(java.util.List.of(), false);
            org.apache.jena.tdb2.store.NodeIdFactory.set(id, low.getKey(), i * 8);
            org.apache.jena.tdb2.store.NodeIdFactory.set(id, high.getKey(), i * 8);
        }
        org.apache.jena.tdb2.store.NodeIdFactory.setNext(nodes.getNodeIdForNode(predicate), high.getKey(), 16);
        var cursor = nodes.getNodeIdForNode(after);
        if (org.apache.jena.tdb2.store.NodeId.isDoesNotExist(cursor))
            throw new IllegalStateException("name cursor term is missing from its node table");
        org.apache.jena.tdb2.store.NodeIdFactory.setNext(cursor, low.getKey(), 24);
        var rows = index.getRangeIndex().iterator(low, high);
        java.util.List<Node> values = new java.util.ArrayList<>();
        try { while (rows.hasNext() && values.size() <= limit) {
            var record = rows.next();
            values.add(nodes.getNodeForNodeId(org.apache.jena.tdb2.store.NodeIdFactory.get(record.getKey(), 24)));
            CommandWork.count("public_name_labels_visited", 1);
        } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        boolean more = values.size() > limit;
        if (more) values.removeLast();
        return new NamePage(values, more);
    }
    /** These authored payload bounds are enforced by the existing revision
     * shapes (65536 metadata characters; 8000 Collection-name characters).
     * Cardinality remains unrestricted within that payload: all titles count
     * towards a resumable page, without a second language/name limit. */
    private static java.util.List<Node> payloadNames(DatasetGraph data, Node resource, String kind) {
        java.util.List<Node> names = new java.util.ArrayList<>();
        Node head = one(data, resource, kind.equals("work") ? "descriptiveMetadataHead" : "collectionNameHead");
        if (!Set.of("work", "collection").contains(kind) || head == null
            || data.contains(REVISIONS, head, RDF.type.asNode(), p("ErasedRevision"))) return names;
        Node payload = revisionValue(data, head, kind.equals("work") ? "metadataState" : "profilePayload");
        int limit = kind.equals("work") ? 65536 : 8000;
        if (payload == null || !payload.isLiteral() || payload.getLiteralLexicalForm().length() > limit)
            throw new IllegalArgumentException("name owner payload exceeds its admitted bound");
        CommandWork.count("public_name_payload_characters", payload.getLiteralLexicalForm().length());
        var value = org.apache.jena.atlas.json.JSON.parse(payload.getLiteralLexicalForm());
        if (kind.equals("work")) {
            if (!value.hasKey("kind") || !"header".equals(value.get("kind").getAsString().value())) return names;
            if (value.hasKey("originalTitle") && !value.get("originalTitle").isNull()) {
                var title = value.get("originalTitle").getAsObject();
                names.add(NodeFactory.createLiteralLang(title.get("value").getAsString().value(), title.get("language").getAsString().value()));
            }
            if (value.hasKey("localized")) for (var entry : value.get("localized").getAsArray()) {
                var locale = entry.getAsObject();
                if (locale.hasKey("title") && !locale.get("title").isNull()) names.add(NodeFactory.createLiteralLang(
                    locale.get("title").getAsString().value(), locale.get("language").getAsString().value()));
            }
        } else {
            var labels = value.get("labels").getAsObject();
            for (String language : labels.keys()) names.add(NodeFactory.createLiteralLang(labels.get(language).getAsString().value(), language));
        }
        return names;
    }
    private static Node storageGeneration(DatasetGraph data) {
        var tdb = org.apache.jena.tdb2.sys.TDBInternal.getDatasetGraphTDB(
            org.apache.jena.sparql.core.DatasetGraphWrapper.unwrap(data));
        if (tdb != null && tdb.getLocation().isMem()) {
            var symbol = org.apache.jena.sparql.util.Symbol.create(PREFIX + "memory-store");
            Node token = tdb.getContext().get(symbol);
            if (token == null) {
                token = uri(PREFIX + "store:" + java.util.UUID.randomUUID());
                tdb.getContext().set(symbol, token);
            }
            return token;
        }
        String location = tdb == null ? "non-tdb" : tdb.getLocation().toString();
        return uri(PREFIX + "store:" + java.util.UUID.nameUUIDFromBytes(location.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
    private static Node recipeGeneration(DatasetGraph data, Node resource, Node source, String kind) {
        StringBuilder key = new StringBuilder(String.valueOf(kind));
        var epochs = data.find(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("dataEpoch"), Node.ANY);
        try { if (epochs.hasNext()) key.append('|').append(epochs.next().getObject()); }
        finally { org.apache.jena.atlas.iterator.Iter.close(epochs); }
        for (Node owner : java.util.List.of(resource, source == null ? resource : source)) {
            key.append('|').append(owner).append('|').append(state(data, owner, "nameGeneration"));
            for (String predicate : java.util.List.of("descriptiveMetadataHead", "collectionNameHead")) {
                Node head = one(data, owner, predicate);
                key.append('|').append(head).append('|').append(head != null
                    && data.contains(REVISIONS, head, RDF.type.asNode(), p("ErasedRevision")));
            }
        }
        return uri(PREFIX + "recipe:" + java.util.UUID.nameUUIDFromBytes(key.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
    private static Set<Quad> metadata(DatasetGraph data, Node resource) {
        Set<Quad> prior = new LinkedHashSet<>();
        for (String kind : NAME_KINDS) {
            Node unit = nameUnit(resource, kind);
            for (Node predicate : java.util.List.of(RDF.type.asNode(), p("resource"), p("disclosure"), p("nameSourceGeneration"),
                p("createdOrder"), p("updatedOrder"))) {
                var rows = data.find(PUBLIC, unit, predicate, Node.ANY);
                try { if (rows.hasNext()) prior.add(rows.next()); }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            }
        }
        var directories = data.find(PUBLIC, Node.ANY, p("nameDirectoryResource"), resource);
        try { for (int count = 0; directories.hasNext(); count++) {
            if (count == 2) throw new IllegalStateException("name directory exceeds its two maintained orders");
            Node directory = directories.next().getSubject();
            for (String predicate : java.util.List.of("nameDirectoryResource", "nameDirectoryOrder", "publicTitle")) {
                var rows = data.find(PUBLIC, directory, p(predicate), Node.ANY);
                try { if (rows.hasNext()) prior.add(rows.next()); }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            }
        } } finally { org.apache.jena.atlas.iterator.Iter.close(directories); }
        return prior;
    }
    private static Set<Quad> desiredMetadata(DatasetGraph data, Node resource, Node source, String kind, Set<Quad> prior,
                                            boolean changed, boolean named) {
        Set<Quad> desired = new LinkedHashSet<>();
        if (kind == null || !named) return desired;
        Node unit = nameUnit(resource, kind), created = null, updated = null;
        for (Quad quad : prior) {
            if (quad.getPredicate().equals(p("createdOrder"))) created = quad.getObject();
            if (quad.getPredicate().equals(p("updatedOrder"))) updated = quad.getObject();
        }
        desired.add(new Quad(PUBLIC, unit, RDF.type.asNode(), p("PublicNameMatchUnit")));
        desired.add(new Quad(PUBLIC, unit, p("resource"), resource));
        desired.add(new Quad(PUBLIC, unit, p("disclosure"), p("Public")));
        if (Set.of("realm", "site").contains(kind)) {
            Node generation = state(data, source, "nameGeneration");
            if (generation != null) desired.add(new Quad(PUBLIC, unit, p("nameSourceGeneration"), generation));
        }
        Node sequence = null;
        var rows = data.find(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("sequence"), Node.ANY);
        try { if (rows.hasNext()) sequence = rows.next().getObject(); }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        if (sequence != null) {
            Node rank = NodeFactory.createLiteralByValue(new java.math.BigInteger("32000000000000000000000000000000")
                .add(new java.math.BigInteger(sequence.getLiteralLexicalForm())), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger);
            Node updatedRank = !changed && updated != null ? updated : rank;
            desired.add(new Quad(PUBLIC, unit, p("createdOrder"), created == null ? rank : created));
            desired.add(new Quad(PUBLIC, unit, p("updatedOrder"), updatedRank));
            directory(desired, resource, kind, "newest", created == null ? rank : created);
            directory(desired, resource, kind, "updated", updatedRank);
        }
        return desired;
    }
    /** Per resource: <=65 authored values + <=65 prior titles, fixed metadata
     * probes and bounded owner payloads. Large recipes are hidden until bounded
     * clear/copy turns complete, so a 64-value turn never becomes a product cap. */
    private static void project(DatasetGraph data, Node resource, boolean changed) {
        if (!productResource(resource)) return;
        dependencies(data, resource);
        String kind = kind(data, resource);
        Node source = kind != null && Set.of("realm", "site").contains(kind) ? one(data, resource, "space") : resource;
        if (!productResource(source) || withdrawn(data, source)) kind = null;
        Node generation = recipeGeneration(data, resource, source, kind);
        if (generation.equals(state(data, resource, "labelCopyGeneration"))
            || state(data, resource, "labelCopyPhase") == null
                && generation.equals(state(data, resource, "labelBuiltGeneration"))) return;
        Set<Quad> prior = metadata(data, resource);
        Set<Node> names = new LinkedHashSet<>();
        int visited = 0;
        boolean more = false;
        if (kind != null) {
            for (Node predicate : NAME_PREDICATES) {
                var page = namePage(data, CURRENT, source, predicate, NAME_BATCH_SIZE - visited);
                visited += page.values().size();
                for (Node value : page.values()) if (value.isLiteral()) names.add(value);
                if (page.more()) { more = true; break; }
            }
            if (!more) for (Node value : payloadNames(data, resource, kind)) {
                CommandWork.count("public_name_labels_visited", 1);
                if (++visited > NAME_BATCH_SIZE) { more = true; break; }
                names.add(value);
            }
        }
        Set<Quad> titles = new LinkedHashSet<>();
        for (String oldKind : NAME_KINDS) {
            var page = namePage(data, PUBLIC, nameUnit(resource, oldKind), p("publicTitle"), NAME_BATCH_SIZE - titles.size());
            for (Node value : page.values()) titles.add(new Quad(PUBLIC, nameUnit(resource, oldKind), p("publicTitle"), value));
            if (page.more()) { more = true; break; }
        }
        if (more) {
            state(data, resource, "labelCopyGeneration", generation);
            state(data, resource, "labelCopyPhase", NodeFactory.createLiteralString("-7"));
            // Retain this per-resource step after completion. A withdrawal and
            // restoration may return to the same recipe generation; reusing a
            // former (generation, phase, step) would replay a completed receipt.
            Node oldStep = state(data, resource, "labelCopyStep");
            java.math.BigInteger step = oldStep == null ? java.math.BigInteger.ZERO
                : new java.math.BigInteger(oldStep.getLiteralLexicalForm()).add(java.math.BigInteger.ONE);
            state(data, resource, "labelCopyStep", NodeFactory.createLiteralString(step.toString()));
            state(data, resource, "labelCopyStore", storageGeneration(data));
            state(data, resource, "labelCopyAfter", null);
            // Remove admission metadata at once; stored titles can be cleaned
            // later without disclosing stale, partial or withdrawn names.
            Set<Quad> ranks = desiredMetadata(data, resource, source, kind, prior, changed, true).stream()
                .filter(quad -> Set.of(p("createdOrder"), p("updatedOrder")).contains(quad.getPredicate()))
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
            apply(data, prior, ranks);
            return;
        }
        Set<Quad> desired = desiredMetadata(data, resource, source, kind, prior, changed, !names.isEmpty());
        if (kind != null) for (Node name : names) desired.add(new Quad(PUBLIC, nameUnit(resource, kind), p("publicTitle"), name));
        prior.addAll(titles);
        apply(data, prior, desired);
        if (state(data, resource, "labelBuiltGeneration") != null)
            state(data, resource, "labelBuiltGeneration", generation);
        state(data, resource, "labelCopyGeneration", null);
        state(data, resource, "labelCopyPhase", null);
        state(data, resource, "labelCopyAfter", null);
        state(data, resource, "labelCopyStore", null);
    }
    /** The existing names-maintenance receipt advances one resource's recipe,
     * visiting <=64 values plus one lookahead per fixed recipe predicate. Both
     * the indexed RDF cursor and replay marker commit with the copied titles. */
    static int repairNameLabels(DatasetGraph data, String receipt) {
        Node replay = uri(receipt);
        if (state(data, replay, "labelRepairApplied") != null) return 0;
        var pending = data.find(REPAIR, Node.ANY, p("labelCopyPhase"), Node.ANY);
        Node resource;
        try { resource = pending.hasNext() ? pending.next().getSubject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(pending); }
        state(data, replay, "labelRepairApplied", replay);
        if (resource == null) return 0;
        if (!productResource(resource)) {
            for (String predicate : java.util.List.of("labelCopyPhase", "labelCopyAfter", "labelCopyGeneration", "labelCopyStore")) state(data, resource, predicate, null);
            return 0;
        }
        String kind = kind(data, resource);
        Node source = kind != null && Set.of("realm", "site").contains(kind) ? one(data, resource, "space") : resource;
        if (!productResource(source) || withdrawn(data, source)) kind = null;
        Node generation = recipeGeneration(data, resource, source, kind);
        if (!generation.equals(state(data, resource, "labelCopyGeneration"))) { project(data, resource, false); return 0; }
        Node store = storageGeneration(data);
        if (!store.equals(state(data, resource, "labelCopyStore"))) {
            // Compaction copies quads into a new node table (CopyDSG), changing
            // its physical order. Reset the bounded recipe instead of seeking
            // with a cursor from the old order; reopening the same store resumes.
            // https://github.com/apache/jena/blob/jena-6.2.0/jena-tdb2/src/main/java/org/apache/jena/tdb2/sys/CopyDSG.java
            state(data, resource, "labelCopyStore", store);
            state(data, resource, "labelCopyPhase", NodeFactory.createLiteralString("-7"));
            state(data, resource, "labelCopyAfter", null);
            java.math.BigInteger step = new java.math.BigInteger(state(data, resource, "labelCopyStep").getLiteralLexicalForm());
            state(data, resource, "labelCopyStep", NodeFactory.createLiteralString(step.add(java.math.BigInteger.ONE).toString()));
            return 0;
        }
        int phase = Integer.parseInt(state(data, resource, "labelCopyPhase").getLiteralLexicalForm());
        int processed = 0;
        while (processed < NAME_BATCH_SIZE && phase < 7) {
            Node after = state(data, resource, "labelCopyAfter");
            NamePage page;
            if (phase < 0) page = namePage(data, PUBLIC, nameUnit(resource, NAME_KINDS.get(phase + 7)), p("publicTitle"), NAME_BATCH_SIZE - processed);
            else if (kind == null) { phase = 7; break; }
            else if (phase < 6) page = nameRange(data, source, NAME_PREDICATES.get(phase), after, NAME_BATCH_SIZE - processed);
            else {
                var payload = payloadNames(data, resource, kind);
                int offset = after == null ? 0 : Integer.parseInt(after.getLiteralLexicalForm());
                int end = Math.min(payload.size(), offset + NAME_BATCH_SIZE - processed);
                page = new NamePage(payload.subList(offset, end), end < payload.size());
                CommandWork.count("public_name_labels_visited", page.values().size());
                state(data, resource, "labelCopyAfter", NodeFactory.createLiteralString(Integer.toString(end)));
            }
            for (Node name : page.values()) {
                if (phase < 0) data.delete(PUBLIC, nameUnit(resource, NAME_KINDS.get(phase + 7)), p("publicTitle"), name);
                else if (name.isLiteral()) data.add(PUBLIC, nameUnit(resource, kind), p("publicTitle"), name);
            }
            processed += page.values().size();
            if (phase >= 0 && phase < 6 && !page.values().isEmpty()) state(data, resource, "labelCopyAfter", page.values().getLast());
            if (page.more()) break;
            phase++;
            state(data, resource, "labelCopyAfter", null);
        }
        state(data, resource, "labelCopyPhase", NodeFactory.createLiteralString(Integer.toString(phase)));
        java.math.BigInteger step = new java.math.BigInteger(state(data, resource, "labelCopyStep").getLiteralLexicalForm());
        state(data, resource, "labelCopyStep", NodeFactory.createLiteralString(step.add(java.math.BigInteger.ONE).toString()));
        if (phase == 7) {
            Set<Quad> prior = metadata(data, resource);
            boolean named = kind != null && data.contains(PUBLIC, nameUnit(resource, kind), p("publicTitle"), Node.ANY);
            apply(data, prior, desiredMetadata(data, resource, source, kind, prior, false, named));
            state(data, resource, "labelBuiltGeneration", generation);
            for (String predicate : java.util.List.of("labelCopyPhase", "labelCopyAfter", "labelCopyGeneration", "labelCopyStore")) state(data, resource, predicate, null);
        }
        return processed;
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
