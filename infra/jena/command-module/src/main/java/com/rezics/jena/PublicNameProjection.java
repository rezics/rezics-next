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
    static boolean publicRealm(DatasetGraph data, Node realm) {
        if (!productResource(realm)) return false;
        Node space = one(data, realm, "space");
        return productResource(space) && has(data, realm, "realmState", p("Active")) && space != null
            && listedPublic(data, space, true) && listedPublic(data, realm, false)
            && !withdrawn(data, realm) && !withdrawn(data, space);
    }
    static boolean withdrawn(DatasetGraph data, Node resource) {
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
            if (publishedSelection(data, work, main, selection, main)) return true;
        } } finally { org.apache.jena.atlas.iterator.Iter.close(heads); }
        return false;
    }
    /** Exact selected publication authority, independently of another live
     * language keeping the Work name visible. Uses only owned revision probes. */
    static boolean publishedSelection(DatasetGraph data, Node work, Node main, Node selection, Node context) {
        if (withdrawn(data, main) || !type(data, main, RV + "MainVersion") || !has(data, main, "work", work)) return false;
        Node contribution = revisionValue(data, selection, "contribution");
        Node decision = revisionValue(data, selection, "publicationDecision");
        Node draft = revisionValue(data, selection, "selectedDraft");
        return contribution != null && decision != null && draft != null && !withdrawn(data, contribution)
                && data.contains(REVISIONS, selection, RDF.type.asNode(), p("PublicationSelection"))
                && data.contains(REVISIONS, selection, p("work"), work)
                && data.contains(REVISIONS, selection, p("mainVersion"), main)
                && data.contains(REVISIONS, selection, p("context"), context)
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
                && !data.contains(REVISIONS, draft, RDF.type.asNode(), p("ErasedRevision"));
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
    // Native prerequisites only. These hooks do not publish candidates or
    // change name queries. The command owner must admit their closed turns.
    private static final Node WORK_SCOPE = uri(PREFIX + "work-scope-directory");
    static String workScopeRepairGraph() { return REPAIR.getURI(); }
    static String workScopeUncertaintyUpdate() {
        return "DELETE WHERE { GRAPH <" + REPAIR.getURI() + "> { <" + WORK_SCOPE.getURI()
            + "> <" + p("scopePhase").getURI() + "> ?scopePhase } }; DELETE WHERE { GRAPH <"
            + REPAIR.getURI() + "> { <" + WORK_SCOPE.getURI() + "> <" + p("scopeQualification").getURI() + "> ?scopeProof } }";
    }
    /** Exclusive startup and controlled maintenance are the trust boundary;
     * ordinary commits never stamp a dataset-wide correctness position. */
    static void workScopeExclusiveStartup(DatasetGraph data) {
        scopeWrite(data);
        invalidateWorkScopeQualification(data);
        TemplateIndexService.admitWorkScopeWriter(data);
    }
    static void invalidateWorkScopeQualification(DatasetGraph data) {
        scopeWrite(data);
        scopeState(data, WORK_SCOPE, "scopePhase", null);
        scopeState(data, WORK_SCOPE, "scopeQualification", null);
    }
    private static Node scopeState(DatasetGraph data, Node subject, String predicate) {
        CommandWork.count("work_name_scope_point_probes", 1);
        var rows = data.find(REPAIR, subject, p(predicate), Node.ANY);
        try {
            Node value = rows.hasNext() ? rows.next().getObject() : null;
            CommandWork.count("work_name_scope_point_rows", value == null ? 0 : 1);
            if (rows.hasNext()) throw new IllegalStateException("Work name scope state is ambiguous");
            return value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static void scopeState(DatasetGraph data, Node subject, String predicate, Node value) {
        Node old = scopeState(data, subject, predicate);
        if (java.util.Objects.equals(old, value)) return;
        if (old != null) data.delete(REPAIR, subject, p(predicate), old);
        if (value != null) data.add(REPAIR, subject, p(predicate), value);
    }
    private static Node scopeOne(DatasetGraph data, Node graph, Node subject, String predicate) {
        CommandWork.count("work_name_scope_point_probes", 1);
        var rows = data.find(graph, subject, p(predicate), Node.ANY);
        try {
            Node value = rows.hasNext() ? rows.next().getObject() : null;
            CommandWork.count("work_name_scope_point_rows", value == null ? 0 : 1);
            if (rows.hasNext()) throw new IllegalStateException("Work name source owner is ambiguous");
            return value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static void scopeWrite(DatasetGraph data) {
        if (!data.isInTransaction() || data.transactionMode() != org.apache.jena.query.ReadWrite.WRITE)
            throw new IllegalStateException("Work name scope turn requires the native writer");
    }
    private static Node scopeEpoch(DatasetGraph data) {
        Node epoch = scopeOne(data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), "dataEpoch");
        if (epoch == null || !epoch.isLiteral()) throw new IllegalStateException("Work name scope epoch is unavailable");
        return epoch;
    }
    private static Node scopeRouting(DatasetGraph data) {
        Node routing = scopeOne(data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), "routingEpoch");
        if (routing == null || !routing.isLiteral()) throw new IllegalStateException("Work name scope routing epoch is unavailable");
        return routing;
    }
    private static boolean scopeCheckpointCurrent(DatasetGraph data) {
        if (!TemplateIndexService.workScopeWriterAdmitted(data)) return false;
        Node phase = scopeState(data, WORK_SCOPE, "scopePhase");
        return (NodeFactory.createLiteralString("owners").equals(phase) || NodeFactory.createLiteralString("complete").equals(phase))
            && scopeEpoch(data).equals(scopeState(data, WORK_SCOPE, "scopeEpoch"))
            && scopeRouting(data).equals(scopeState(data, WORK_SCOPE, "scopeRouting"))
            && NodeFactory.createLiteralString(TemplateIndexService.workScopeStore(data)).equals(scopeState(data, WORK_SCOPE, "scopeStore"));
    }
    private static Node scopeQualification(DatasetGraph data) {
        if (data.contains(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("restoreHold"),
            NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)))
            throw new IllegalStateException("Work name scope is held for restore");
        if (!scopeCheckpointCurrent(data) || !NodeFactory.createLiteralString("complete").equals(scopeState(data, WORK_SCOPE, "scopePhase")))
            throw new IllegalStateException("Work adoption directory is unqualified; bounded native preparation is required");
        Node proof = scopeState(data, WORK_SCOPE, "scopeQualification");
        if (proof == null || !proof.isURI()) throw new IllegalStateException("Work adoption directory qualification is missing");
        return proof;
    }
    record WorkNameBasis(String source, String adoption, String qualification,
                         String dataEpoch, String routingEpoch, String store) {}
    /** Captures current native facts; it certifies no recipe, copied names or index readiness. */
    static WorkNameBasis captureWorkNameBasis(DatasetGraph data, Node work, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        String source = nameSourceToken(data, work, deadline).getURI();
        WorkNameBasis result = new WorkNameBasis(source, TemplateIndexService.workAdoptionBasis(data, work),
            scopeQualification(data).getURI(), scopeEpoch(data).getLiteralLexicalForm(),
            scopeRouting(data).getLiteralLexicalForm(), TemplateIndexService.workScopeStore(data));
        TemplateIndexService.workScopeBudget(deadline); return result;
    }
    /** Only explicit maintenance scans a population, using the existing native
     * GPOS seek. Controlled raw uncertainty or a new store restarts this proof. */
    static int prepareWorkScopeDirectory(DatasetGraph data) {
        return prepareWorkScopeDirectory(data, Long.MAX_VALUE);
    }
    static int prepareWorkScopeDirectory(DatasetGraph data, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        scopeWrite(data);
        if (!TemplateIndexService.workScopeWriterAdmitted(data))
            throw new IllegalStateException("Work name scope requires exclusive native writer admission");
        if (!scopeCheckpointCurrent(data)) {
            scopeState(data, WORK_SCOPE, "scopeEpoch", scopeEpoch(data));
            scopeState(data, WORK_SCOPE, "scopeRouting", scopeRouting(data));
            scopeState(data, WORK_SCOPE, "scopeStore", NodeFactory.createLiteralString(TemplateIndexService.workScopeStore(data)));
            scopeState(data, WORK_SCOPE, "scopeQualification", uri(PREFIX + "scope-proof:" + java.util.UUID.randomUUID()));
            scopeState(data, WORK_SCOPE, "scopePhase", NodeFactory.createLiteralString("owners"));
            scopeState(data, WORK_SCOPE, "scopeAfter", null);
        }
        if (NodeFactory.createLiteralString("complete").equals(scopeState(data, WORK_SCOPE, "scopePhase"))) {
            TemplateIndexService.workScopeBudget(deadline);
            TemplateIndexService.workScopeBudget(deadline); return 0;
        }
        Node after = scopeState(data, WORK_SCOPE, "scopeAfter");
        var page = TemplateIndexService.realmOwnerPage(data, after == null ? "" : after.getLiteralLexicalForm(), deadline);
        for (Node slot : page.owners()) workSlotLink(data, slot, deadline);
        TemplateIndexService.workScopeBudget(deadline);
        scopeState(data, WORK_SCOPE, "scopeAfter", page.more() ? NodeFactory.createLiteralString(page.after()) : null);
        if (!page.more()) scopeState(data, WORK_SCOPE, "scopePhase", NodeFactory.createLiteralString("complete"));
        TemplateIndexService.workScopeBudget(deadline); return page.owners().size();
    }
    /** Reads the phase the preparer just committed. It does not choose or change that phase. */
    static String workScopeDirectoryPhase(DatasetGraph data) {
        scopeWrite(data);
        Node phase = scopeState(data, WORK_SCOPE, "scopePhase");
        if (phase == null) return "absent";
        if (!phase.isLiteral()) throw new IllegalStateException("Work name scope phase is unavailable");
        return phase.getLiteralLexicalForm();
    }
    record ScopeOwner(Node slot, Node work, Node main, Node realm, Node head) {}
    private static ScopeOwner scopeOwner(DatasetGraph data, Node slot) {
        if (!data.contains(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"))) return null;
        if (CanonicalPolicy.realmSlotOwnerFailure(data, slot) != null) throw new IllegalStateException("Work scope contains an uncertain Realm owner");
        return new ScopeOwner(slot, scopeOne(data, CURRENT, slot, "work"), scopeOne(data, CURRENT, slot, "mainVersion"),
            scopeOne(data, CURRENT, slot, "realm"), scopeOne(data, CURRENT, slot, "selectionHead"));
    }
    /** Immutable, descending ordinals detect corrupt/cyclic links and count
     * historical removals in the same physical 64-step budget. */
    static void workSlotLink(DatasetGraph data, Node slot) {
        workSlotLink(data, slot, Long.MAX_VALUE);
    }
    static void workSlotLink(DatasetGraph data, Node slot, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        ScopeOwner owner = scopeOwner(data, slot);
        if (owner == null) { TemplateIndexService.workScopeBudget(deadline); return; }
        Node work = owner.work();
        if (!productResource(work)) throw new IllegalStateException("Work scope owner is not a product Work");
        Node link = uri(PREFIX + "work-slot:" + java.util.UUID.nameUUIDFromBytes((work + "\n" + slot).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        Node prior = scopeState(data, link, "scopeWork");
        if (prior != null) {
            if (!work.equals(prior) || !slot.equals(scopeState(data, link, "scopeSlot"))) throw new IllegalStateException("Work scope link identity differs");
            TemplateIndexService.workScopeBudget(deadline);
            return;
        }
        Node count = scopeState(data, work, "scopeLinkCount");
        java.math.BigInteger ordinal = count == null ? java.math.BigInteger.ONE : new java.math.BigInteger(count.getLiteralLexicalForm()).add(java.math.BigInteger.ONE);
        scopeState(data, link, "scopeWork", work); scopeState(data, link, "scopeSlot", slot);
        scopeState(data, link, "scopeOrdinal", NodeFactory.createLiteralString(ordinal.toString()));
        scopeState(data, link, "scopeNext", scopeState(data, work, "scopeLinkHead"));
        scopeState(data, work, "scopeLinkHead", link); scopeState(data, work, "scopeLinkCount", NodeFactory.createLiteralString(ordinal.toString()));
        TemplateIndexService.workScopeBudget(deadline);
    }
    /** Fixed source-owner paths; raw headers without these backlinks cannot
     * acquire a completion certificate by guessing who depends on them. */
    static Node nameSourceToken(DatasetGraph data, Node work) {
        return nameSourceToken(data, work, Long.MAX_VALUE);
    }
    static Node nameSourceToken(DatasetGraph data, Node work, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        Node qualification = scopeQualification(data);
        if (!productResource(work) || !data.contains(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork")))
            throw new IllegalStateException("Work name source is unavailable");
        Node header = scopeOne(data, CURRENT, work, "descriptiveMetadataHead");
        if (header != null) {
            Node component = scopeOne(data, REVISIONS, header, "component");
            if (!header.isURI() || component == null || !component.isURI()
                || !data.contains(REVISIONS, header, RDF.type.asNode(), p("WorkMetadataRevision"))
                || !data.contains(CURRENT, component, RDF.type.asNode(), p("WorkMetadataComponent"))
                || !work.equals(scopeOne(data, CURRENT, component, "work"))
                || !header.equals(scopeOne(data, CURRENT, component, "metadataHead"))
                || !NodeFactory.createLiteralString("header").equals(scopeOne(data, CURRENT, component, "metadataKind")))
                throw new IllegalStateException("Work header source ownership is unqualified");
            if (!data.contains(REVISIONS, header, RDF.type.asNode(), p("ErasedRevision"))) {
                Node payload = scopeOne(data, REVISIONS, header, "metadataState");
                if (payload == null || !payload.isLiteral() || payload.getLiteralLexicalForm().length() > 65536)
                    throw new IllegalStateException("Work header source payload is unqualified");
                CommandWork.count("work_name_scope_header_characters", payload.getLiteralLexicalForm().length());
                CommandWork.count("work_name_scope_header_utf8_bytes",
                    payload.getLiteralLexicalForm().getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
                try {
                    var headerState = org.apache.jena.atlas.json.JSON.parse(payload.getLiteralLexicalForm());
                    if (!headerState.hasKey("kind") || !"header".equals(headerState.get("kind").getAsString().value()))
                        throw new IllegalStateException("Work header source kind differs");
                } catch (java.util.concurrent.CancellationException cancelled) { throw cancelled;
                } catch (RuntimeException malformed) { throw new IllegalStateException("Work header source payload is unqualified", malformed); }
                TemplateIndexService.workScopeBudget(deadline);
            }
        }
        Node token = scopeState(data, work, "scopeNameSource");
        String key = work + "|" + qualification + "|" + token;
        Node result = uri(PREFIX + "work-source:" + java.util.UUID.nameUUIDFromBytes(key.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        TemplateIndexService.workScopeBudget(deadline); return result;
    }
    static boolean nameSourceQuad(org.apache.jena.sparql.core.Quad quad) {
        return CURRENT.equals(quad.getGraph()) && (NAME_PREDICATES.contains(quad.getPredicate())
            || java.util.List.of(p("descriptiveMetadataHead"), p("metadataHead"), p("metadataKind"), p("work")).contains(quad.getPredicate())
            || RDF.type.asNode().equals(quad.getPredicate()) && Set.of(uri("https://schema.org/CreativeWork"), p("WorkMetadataComponent")).contains(quad.getObject()))
            || REVISIONS.equals(quad.getGraph()) && (java.util.List.of(p("metadataState"), p("component")).contains(quad.getPredicate())
                || RDF.type.asNode().equals(quad.getPredicate()) && Set.of(p("ErasedRevision"), p("WorkMetadataRevision")).contains(quad.getObject()));
    }
    static Set<Node> nameSourceOwners(DatasetGraph data, org.apache.jena.sparql.core.Quad quad) {
        Set<Node> owners = new LinkedHashSet<>(); Node subject = quad.getSubject();
        if (CURRENT.equals(quad.getGraph())) {
            if (NAME_PREDICATES.contains(quad.getPredicate()) || p("descriptiveMetadataHead").equals(quad.getPredicate())
                || RDF.type.asNode().equals(quad.getPredicate()) && uri("https://schema.org/CreativeWork").equals(quad.getObject())) {
                if (productResource(subject) && data.contains(CURRENT, subject, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))) owners.add(subject);
            } else if (NodeFactory.createLiteralString("header").equals(scopeOne(data, CURRENT, subject, "metadataKind"))) {
                Node work = scopeOne(data, CURRENT, subject, "work");
                if (productResource(work)) {
                    Node head = scopeOne(data, CURRENT, work, "descriptiveMetadataHead");
                    if (head != null && subject.equals(scopeOne(data, REVISIONS, head, "component"))) owners.add(work);
                }
            }
        } else {
            Node component = scopeOne(data, REVISIONS, subject, "component");
            if (component != null) {
                if (data.contains(CURRENT, component, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))
                    && subject.equals(scopeOne(data, CURRENT, component, "head"))) owners.add(component);
                Node work = scopeOne(data, CURRENT, component, "work");
                if (productResource(work) && subject.equals(scopeOne(data, CURRENT, work, "descriptiveMetadataHead"))) owners.add(work);
            }
        }
        return owners;
    }
    static void actualWorkScopeEffects(DatasetGraph data, java.util.Map<Node,TemplateIndexService.Entity> before,
        Set<Node> sources, boolean reset, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        TemplateIndexService.actualRealmEffects(data, before, deadline);
        for (Node work : sources) {
            TemplateIndexService.workScopeBudget(deadline);
            scopeState(data, work, "scopeNameSource", uri(PREFIX + "source-effect:" + java.util.UUID.randomUUID()));
            CommandWork.count("work_name_sources_changed", 1);
        }
        TemplateIndexService.workScopeBudget(deadline);
        if (reset) invalidateWorkScopeQualification(data);
        TemplateIndexService.workScopeBudget(deadline);
    }
    static void beginWorkScope(DatasetGraph data, Node work, Node pass) {
        beginWorkScope(data, work, pass, Long.MAX_VALUE);
    }
    static void beginWorkScope(DatasetGraph data, Node work, Node pass, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        scopeWrite(data); Node source = nameSourceToken(data, work, deadline);
        TemplateIndexService.workScopeBudget(deadline);
        Node existing = scopeState(data, pass, "scopeWork");
        if (existing != null) {
            if (!existing.equals(work)) throw new IllegalStateException("Work scope pass identity differs");
            TemplateIndexService.workScopeBudget(deadline); return;
        }
        scopeState(data, pass, "scopeWork", work); scopeState(data, pass, "scopeSource", source);
        scopeState(data, pass, "scopeBasis", NodeFactory.createLiteralString(TemplateIndexService.workAdoptionBasis(data, work)));
        scopeState(data, pass, "scopeProof", scopeQualification(data));
        scopeState(data, pass, "scopeCursor", scopeState(data, work, "scopeLinkHead"));
        Node count = scopeState(data, work, "scopeLinkCount");
        scopeState(data, pass, "scopeRemaining", count == null ? NodeFactory.createLiteralString("0") : count);
        TemplateIndexService.workScopeBudget(deadline);
    }
    private static void checkWorkScope(DatasetGraph data, Node pass, long deadline) {
        Node work = scopeState(data, pass, "scopeWork");
        if (work == null || !scopeQualification(data).equals(scopeState(data, pass, "scopeProof"))
            || !nameSourceToken(data, work, deadline).equals(scopeState(data, pass, "scopeSource"))
            || !NodeFactory.createLiteralString(TemplateIndexService.workAdoptionBasis(data, work)).equals(scopeState(data, pass, "scopeBasis")))
            throw new IllegalStateException("Work name scope basis moved or is unqualified");
    }
    static boolean workScopeComplete(DatasetGraph data, Node pass) {
        return workScopeComplete(data, pass, Long.MAX_VALUE);
    }
    static boolean workScopeComplete(DatasetGraph data, Node pass, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        try {
            checkWorkScope(data, pass, deadline);
            boolean complete = scopeState(data, pass, "scopeCursor") == null && NodeFactory.createLiteralString("0").equals(scopeState(data, pass, "scopeRemaining"));
            TemplateIndexService.workScopeBudget(deadline); return complete;
        } catch (java.util.concurrent.CancellationException cancelled) { throw cancelled;
        } catch (IllegalStateException | IllegalArgumentException unavailable) { TemplateIndexService.workScopeBudget(deadline); return false; }
    }
    record ScopeTurn(java.util.List<ScopeOwner> owners, int visited, boolean complete, boolean replayed) {}
    static ScopeTurn advanceWorkScope(DatasetGraph data, Node pass, Node receipt) {
        return advanceWorkScope(data, pass, receipt, Long.MAX_VALUE);
    }
    static ScopeTurn advanceWorkScope(DatasetGraph data, Node pass, Node receipt, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        scopeWrite(data); checkWorkScope(data, pass, deadline);
        TemplateIndexService.workScopeBudget(deadline);
        Node replay = scopeState(data, receipt, "scopePass");
        if (replay != null) {
            if (!pass.equals(replay)) throw new IllegalStateException("Work scope step receipt differs");
            return new ScopeTurn(java.util.List.of(), 0, workScopeComplete(data, pass, deadline), true);
        }
        Node work = scopeState(data, pass, "scopeWork"), cursor = scopeState(data, pass, "scopeCursor");
        java.math.BigInteger remaining = new java.math.BigInteger(scopeState(data, pass, "scopeRemaining").getLiteralLexicalForm());
        java.util.List<ScopeOwner> owners = new java.util.ArrayList<>(); int visited = 0;
        while (cursor != null && visited < REPAIR_BATCH_SIZE) {
            TemplateIndexService.workScopeBudget(deadline);
            visited++; CommandWork.count("work_name_scope_links_visited", 1);
            Node slot = scopeState(data, cursor, "scopeSlot"), next = scopeState(data, cursor, "scopeNext");
            if (!work.equals(scopeState(data, cursor, "scopeWork")) || slot == null || !slot.isURI()
                || !NodeFactory.createLiteralString(remaining.toString()).equals(scopeState(data, cursor, "scopeOrdinal"))
                || remaining.signum() <= 0 || (next == null) != remaining.equals(java.math.BigInteger.ONE))
                throw new IllegalStateException("Work scope link chain is unqualified");
            ScopeOwner owner = scopeOwner(data, slot);
            if (owner != null && work.equals(owner.work())) owners.add(owner);
            remaining = remaining.subtract(java.math.BigInteger.ONE); cursor = next;
        }
        TemplateIndexService.workScopeBudget(deadline);
        if (cursor == null && remaining.signum() != 0) throw new IllegalStateException("Work scope EOF is incomplete");
        scopeState(data, pass, "scopeCursor", cursor); scopeState(data, pass, "scopeRemaining", NodeFactory.createLiteralString(remaining.toString()));
        scopeState(data, receipt, "scopePass", pass);
        return new ScopeTurn(java.util.List.copyOf(owners), visited, workScopeComplete(data, pass, deadline), false);
    }
    // Private CURRENT-source materialization only. This predicate is deliberately
    // absent from the text entity map; a snapshot is never an indexed generation.
    static final Node WORK_NAME_RECIPE_LITERAL = p("workNameRecipeLiteral");
    record RecipeTurn(int sourceValues, int lookahead, int copies, int additions, boolean complete, boolean replayed) {}

    private static void checkWorkRecipeMapping(DatasetGraph data) {
        DatasetGraph current = data;
        while (true) {
            if (current instanceof org.apache.jena.query.text.DatasetGraphText text) {
                if (text.getTextIndex().getDocDef().getField(WORK_NAME_RECIPE_LITERAL) != null)
                    throw new IllegalStateException("private Work recipe predicate must not be text-mapped");
                return;
            }
            if (!(current instanceof org.apache.jena.sparql.core.DatasetGraphWrapper wrapper)) return;
            current = wrapper.getWrapped();
        }
    }

    static Node beginWorkNameRecipe(DatasetGraph data, Node work, Node receipt, long deadline) {
        scopeWrite(data); TemplateIndexService.workScopeBudget(deadline);
        checkWorkRecipeMapping(data);
        if (receipt == null || !receipt.isURI() || scopeState(data, receipt, "recipeTurn") != null)
            throw new IllegalStateException("Work recipe begin receipt differs");
        Node previous = scopeState(data, receipt, "recipeBegin");
        if (previous != null) {
            if (!work.equals(scopeState(data, previous, "scopeWork")))
                throw new IllegalStateException("Work recipe receipt targets another Work");
            checkWorkNameRecipe(data, previous, deadline); return previous;
        }
        Node snapshot = uri(PREFIX + "work-recipe:" + java.util.UUID.randomUUID());
        beginWorkScope(data, work, snapshot, deadline);
        scopeState(data, snapshot, "recipeEpoch", scopeEpoch(data));
        scopeState(data, snapshot, "recipeRouting", scopeRouting(data));
        scopeState(data, snapshot, "recipeStore", NodeFactory.createLiteralString(TemplateIndexService.workScopeStore(data)));
        scopeState(data, snapshot, "recipePhase", NodeFactory.createLiteralString("0"));
        scopeState(data, receipt, "recipeBegin", snapshot);
        TemplateIndexService.workScopeBudget(deadline); return snapshot;
    }
    private static int checkWorkNameRecipe(DatasetGraph data, Node snapshot, long deadline) {
        checkWorkRecipeMapping(data);
        checkWorkScope(data, snapshot, deadline);
        if (!scopeEpoch(data).equals(scopeState(data, snapshot, "recipeEpoch"))
            || !scopeRouting(data).equals(scopeState(data, snapshot, "recipeRouting"))
            || !NodeFactory.createLiteralString(TemplateIndexService.workScopeStore(data)).equals(scopeState(data, snapshot, "recipeStore")))
            throw new IllegalStateException("Work recipe instance changed");
        Node phase = scopeState(data, snapshot, "recipePhase");
        if (phase == null || !phase.isLiteral()) throw new IllegalStateException("Work recipe progress is missing");
        int value = Integer.parseInt(phase.getLiteralLexicalForm());
        if (value < 0 || value > 7 || value == 7 && scopeState(data, snapshot, "recipeAfter") != null)
            throw new IllegalStateException("Work recipe progress is invalid");
        TemplateIndexService.workScopeBudget(deadline); return value;
    }
    static boolean workNameRecipeComplete(DatasetGraph data, Node snapshot, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        try { return checkWorkNameRecipe(data, snapshot, deadline) == 7; }
        catch (java.util.concurrent.CancellationException cancelled) { throw cancelled;
        } catch (IllegalStateException | IllegalArgumentException unavailable) { return false; }
    }
    // Preparation limits, not primary-data constraints. Reuse the bounded
    // header encoding and native response budgets. Count the pinned NT encoding
    // directly on existing strings: never format or allocate a UTF-8 copy.
    static final int WORK_RECIPE_TERM_BYTES = 4 * 65536;
    static final int WORK_RECIPE_TURN_BYTES = TemplateQueryService.MAX_BYTES;
    private static long recipeEncodedBytes(String text, int mode, long bytes, long limit, long deadline) {
        for (int index = 0; index < text.length(); index++) {
            if ((index & 255) == 0) TemplateIndexService.workScopeBudget(deadline);
            char value = text.charAt(index);
            CommandWork.count("work_name_recipe_lexical_units", 1);
            if (mode == 3) { // NodeFormatterNT blank-label encoding (_:B prefix).
                bytes += value == 'X' ? 2 : value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
                    || value >= '0' && value <= '9' ? 1 : value < 256 ? 3 : 6;
            } else if (mode == 1 && (value == '\\' || value == '\"' || value == '\t'
                || value == '\n' || value == '\r' || value == '\f')) bytes += 2;
            else if (mode == 2 && (value < 20 || value == ' ' || value == '\"' || value == '<' || value == '>'
                || value == '\\' || value == '^' || value == '`' || value == '{' || value == '|' || value == '}' || value == 127)) bytes += 6;
            else if (Character.isHighSurrogate(value) && index + 1 < text.length() && Character.isLowSurrogate(text.charAt(index + 1))) {
                bytes += 4; index++; CommandWork.count("work_name_recipe_lexical_units", 1);
            } else if (mode == 1 && (value == '\uFFFD' || Character.isSurrogate(value))) bytes += 6;
            else if (Character.isSurrogate(value)) bytes++; // UTF-8 encoder's '?' replacement outside literals.
            else bytes += value < 128 ? 1 : value < 2048 ? 2 : 3;
            if (bytes > limit)
                throw new IllegalStateException("Work recipe scalar byte bound exceeded");
        }
        return bytes;
    }
    private static long recipeBytes(Node value, long allowance, long deadline) {
        TemplateIndexService.workScopeBudget(deadline);
        if (value == null) return 0;
        String lexical, suffix = ""; int mode; long punctuation;
        if (value.isURI()) { lexical = value.getURI(); mode = 2; punctuation = 2; }
        else if (value.isBlank()) { lexical = value.getBlankNodeLabel(); mode = 3; punctuation = 3; }
        else if (value.isLiteral()) {
            lexical = value.getLiteralLexicalForm(); mode = 1; punctuation = 2;
            String language = value.getLiteralLanguage();
            var direction = value.getLiteralBaseDirection();
            if (direction != null) {
                suffix = language; punctuation += 3 + direction.direction().length();
            } else if (!language.isEmpty()) { suffix = language; punctuation++; }
            else if (value.getLiteralDatatype() != null
                && !value.getLiteralDatatype().equals(org.apache.jena.datatypes.xsd.XSDDatatype.XSDstring)) {
                suffix = value.getLiteralDatatypeURI(); punctuation += 4;
            }
        } else throw new IllegalStateException("Work recipe term encoding is unavailable");
        // Every encoded UTF-16 unit costs at least one byte. Reject huge fields
        // in O(1), before scanning, escaping or constructing any output buffer.
        long minimum = punctuation + (long) lexical.length() + suffix.length();
        long limit = Math.min(WORK_RECIPE_TERM_BYTES, allowance);
        if (minimum > limit)
            throw new IllegalStateException("Work recipe scalar byte bound exceeded");
        long bytes = recipeEncodedBytes(lexical, mode, punctuation, limit, deadline);
        if (!suffix.isEmpty()) bytes = recipeEncodedBytes(suffix,
            value.getLiteralBaseDirection() != null || !value.getLiteralLanguage().isEmpty() ? 0 : 2, bytes, limit, deadline);
        TemplateIndexService.workScopeBudget(deadline); return bytes;
    }
    /** Parse the bounded current payload, but construct/visit only this page's
     * titles. Null title entries count; direct array indexing avoids prefix replay. */
    private static NamePage workRecipeHeaderPage(DatasetGraph data, Node work, int offset, int limit, long deadline) {
        Node head = scopeOne(data, CURRENT, work, "descriptiveMetadataHead");
        if (head == null || data.contains(REVISIONS, head, RDF.type.asNode(), p("ErasedRevision")))
            return new NamePage(java.util.List.of(), false);
        Node payload = scopeOne(data, REVISIONS, head, "metadataState");
        if (payload == null || !payload.isLiteral() || payload.getLiteralLexicalForm().length() > 65536)
            throw new IllegalStateException("Work recipe header payload is unavailable");
        String text = payload.getLiteralLexicalForm();
        CommandWork.count("work_name_recipe_header_characters", text.length());
        CommandWork.count("work_name_recipe_header_utf8_bytes", text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        var json = org.apache.jena.atlas.json.JSON.parse(text);
        var localized = json.hasKey("localized") ? json.get("localized").getAsArray() : new org.apache.jena.atlas.json.JsonArray();
        int total = 1 + localized.size();
        if (offset < 0 || offset > total) throw new IllegalStateException("Work recipe header cursor is invalid");
        java.util.List<Node> values = new java.util.ArrayList<>();
        for (int index = offset; index < total && values.size() <= limit; index++) {
            TemplateIndexService.workScopeBudget(deadline);
            var item = index == 0 ? json.hasKey("originalTitle") ? json.get("originalTitle") : null : localized.get(index - 1);
            Node name = null;
            if (item != null && !item.isNull()) {
                var title = item.getAsObject();
                if (index == 0) name = NodeFactory.createLiteralLang(title.get("value").getAsString().value(), title.get("language").getAsString().value());
                else if (title.hasKey("title") && !title.get("title").isNull())
                    name = NodeFactory.createLiteralLang(title.get("title").getAsString().value(), title.get("language").getAsString().value());
            }
            values.add(name);
        }
        boolean more = values.size() > limit;
        Node lookahead = more ? values.removeLast() : null;
        TemplateIndexService.workScopeBudget(deadline); return new NamePage(values, more, lookahead);
    }
    static RecipeTurn advanceWorkNameRecipe(DatasetGraph data, Node snapshot, Node receipt, long deadline) {
        scopeWrite(data); TemplateIndexService.workScopeBudget(deadline);
        int phase = checkWorkNameRecipe(data, snapshot, deadline);
        if (receipt == null || !receipt.isURI() || scopeState(data, receipt, "recipeBegin") != null)
            throw new IllegalStateException("Work recipe turn receipt differs");
        Node replay = scopeState(data, receipt, "recipeTurn");
        if (replay != null) {
            if (!snapshot.equals(replay)) throw new IllegalStateException("Work recipe step targets another snapshot");
            Node eof = scopeState(data, receipt, "recipeEOF");
            if (eof == null) throw new IllegalStateException("Work recipe step result is missing");
            TemplateIndexService.workScopeBudget(deadline);
            return new RecipeTurn(0, 0, 0, 0, NodeFactory.createLiteralString("true").equals(eof), true);
        }
        Node work = scopeState(data, snapshot, "scopeWork");
        int sourceValues = 0, lookahead = 0, copies = 0, additions = 0;
        long admittedBytes = 0;
        while (phase < 7 && sourceValues + lookahead + copies <= NAME_BATCH_SIZE - 3) {
            TemplateIndexService.workScopeBudget(deadline);
            int limit = (NAME_BATCH_SIZE - sourceValues - lookahead - copies - 1) / 2;
            Node after = scopeState(data, snapshot, "recipeAfter");
            int offset = phase == 6 && after != null ? Integer.parseInt(after.getLiteralLexicalForm()) : 0;
            NamePage page = phase < 6 ? nameRange(data, work, NAME_PREDICATES.get(phase), after, limit)
                : workRecipeHeaderPage(data, work, offset, limit, deadline);
            sourceValues += page.values().size(); lookahead += page.more() ? 1 : 0;
            CommandWork.count("work_name_recipe_source_values", page.values().size());
            CommandWork.count("work_name_recipe_lookahead", page.more() ? 1 : 0);
            long lookaheadBound = recipeBytes(page.lookahead(), WORK_RECIPE_TURN_BYTES - admittedBytes, deadline);
            if (lookaheadBound > WORK_RECIPE_TERM_BYTES || lookaheadBound > WORK_RECIPE_TURN_BYTES - admittedBytes)
                throw new IllegalStateException("Work recipe lookahead byte bound exceeded");
            admittedBytes += lookaheadBound;
            CommandWork.count("work_name_recipe_admitted_bytes", lookaheadBound);
            CommandWork.count("work_name_recipe_source_utf8_bytes", lookaheadBound);
            for (Node value : page.values()) {
                TemplateIndexService.workScopeBudget(deadline);
                int weight = value != null && value.isLiteral() ? 2 : 1;
                long bound = recipeBytes(value, (WORK_RECIPE_TURN_BYTES - admittedBytes) / weight, deadline);
                long charge = bound * weight;
                if (bound > WORK_RECIPE_TERM_BYTES || charge > WORK_RECIPE_TURN_BYTES - admittedBytes)
                    throw new IllegalStateException("Work recipe turn byte bound exceeded");
                admittedBytes += charge;
                CommandWork.count("work_name_recipe_admitted_bytes", charge);
                long bytes = bound;
                CommandWork.count("work_name_recipe_source_utf8_bytes", bytes);
                if (value != null && value.isLiteral()) {
                    copies++; CommandWork.count("work_name_recipe_copy_attempts", 1);
                    CommandWork.count("work_name_recipe_copy_utf8_bytes", bytes);
                    // Duplicate terms remain source work without a second stored literal.
                    CommandWork.count("work_name_recipe_literal_probes", 1);
                    boolean present = data.contains(REPAIR, snapshot, WORK_NAME_RECIPE_LITERAL, value);
                    CommandWork.count("work_name_recipe_literal_rows", present ? 1 : 0);
                    if (!present) {
                        data.add(REPAIR, snapshot, WORK_NAME_RECIPE_LITERAL, value);
                        additions++; CommandWork.count("work_name_recipe_additions", 1);
                    }
                }
            }
            if (phase == 6) scopeState(data, snapshot, "recipeAfter", NodeFactory.createLiteralString(Integer.toString(offset + page.values().size())));
            else if (!page.values().isEmpty()) scopeState(data, snapshot, "recipeAfter", page.values().getLast());
            if (page.more()) break;
            phase++; scopeState(data, snapshot, "recipeAfter", null);
        }
        scopeState(data, snapshot, "recipePhase", NodeFactory.createLiteralString(Integer.toString(phase)));
        checkWorkNameRecipe(data, snapshot, deadline);
        scopeState(data, receipt, "recipeTurn", snapshot);
        scopeState(data, receipt, "recipeEOF", NodeFactory.createLiteralString(Boolean.toString(phase == 7)));
        TemplateIndexService.workScopeBudget(deadline);
        return new RecipeTurn(sourceValues, lookahead, copies, additions, phase == 7, false);
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
    private record NamePage(java.util.List<Node> values, boolean more, Node lookahead) {
        private NamePage(java.util.List<Node> values, boolean more) { this(values, more, null); }
    }
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
        Node lookahead = more ? values.removeLast() : null;
        return new NamePage(values, more, lookahead);
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
        Node lookahead = more ? values.removeLast() : null;
        return new NamePage(values, more, lookahead);
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
