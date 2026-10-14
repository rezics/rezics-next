package com.rezics.jena;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateDataInsert;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.update.Update;
import org.apache.jena.vocabulary.RDF;

/** Exact-reference replay fence for a sanitized graph generation. */
final class ErasurePolicy {
    private static final Node REVISIONS = NodeFactory.createURI(CommandPolicy.REVISIONS);
    private static final Node ERASED = NodeFactory.createURI("https://rezics.com/vocab/ErasedRevision");
    private static final Node REVISION = NodeFactory.createURI("https://rezics.com/vocab/revision");
    private static final Node CONTENT_REVISION = NodeFactory.createURI("https://rezics.com/vocab/contentRevision");
    private static final Node ERASURE_EPOCH = NodeFactory.createURI("https://rezics.com/vocab/erasureEpoch");
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final String UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
    static final String PERSON_TARGET = "https://rezics\\.com/id/" + UUID;
    static final String PROVISION_TARGET = PERSON_TARGET + "-agent-revision";
    static final Set<Node> PROFILE_PREDICATES = Set.of(
        uri("http://www.w3.org/2000/01/rdf-schema#label"), uri("https://schema.org/name"),
        uri("https://schema.org/alternateName"), uri("http://www.w3.org/2004/02/skos/core#prefLabel"),
        uri("http://www.w3.org/2004/02/skos/core#altLabel"), rv("profileBio"), rv("profileAvatarSelection"),
        rv("profileHandle"), rv("localizedName"), rv("originalNameLanguage"), rv("profileNameFormat"),
        rv("profileStateFormat"), rv("profileDisclosure"), rv("head"), rv("publicProfileHead"));
    static final Set<Node> INDEX_REFERENCES = Set.of(REVISION, CONTENT_REVISION, rv("resource"),
        rv("nameResource"), rv("nameDirectoryResource"));
    private record PersonMarker(Node person, Node id, Node epoch) {}
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String value) { return uri("https://rezics.com/vocab/" + value); }

    /** Content revision URNs and the revision IRIs reads already honour. `String.matches` is full-string. */
    static final String REVISION_TARGET =
        "(?:urn:rezics:content:revision:|https://rezics\\.com/id/)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

    /**
     * Every command with an erasure-graph receipt is admitted here, before it is applied.
     * The receipt text is not authority: each revision subject may gain only {@code ErasedRevision}
     * and {@code erasureEpoch}. A Person command additionally admits its closed typed tombstone
     * and allowlisted profile deletions; native preflight proves the exact prior owners.
     * @return null when the command is that marker, otherwise the refusal
     */
    static String admitsMarker(CommandPolicy.Plan plan, String receipt) {
        if (receipt == null || !receipt.startsWith("urn:rezics:receipt:erasure-graph:"))
            return "not an erasure marker";
        if (plan == null || plan.request() == null) return "erasure command is not a marker";
        return plan.current().isEmpty() ? markerFootprint(plan, receipt) : personTemplate(plan, receipt);
    }

    static String preflight(DatasetGraph data, CommandPolicy.Plan plan, String receipt) {
        if (ErasureRestorePolicy.applies(receipt)) return "held erasure requires its authenticated restore path";
        if (receipt.startsWith("urn:rezics:receipt:erasure-graph:")) {
            String marker = admitsMarker(plan, receipt);
            if (marker != null) return marker;
            if (!plan.current().isEmpty()) return personPreflight(data, plan, receipt);
            // An id IRI shares the resource space with Works, Agents and Realms.
            // A marker is admitted only when that subject is already a revision.
            // Content URNs stay bare tombstones: they have no revisions-graph type.
            for (String subject : plan.revisions()) {
                if (subject.startsWith("urn:rezics:content:revision:")) continue;
                if (!priorRevision(data, subject)) return "erasure target is not a revision";
            }
        }
        Update update = plan.request().getOperations().getFirst();
        List<Quad> inserts = update instanceof UpdateModify modify ? modify.getInsertQuads()
            : update instanceof UpdateDataInsert insert ? insert.getQuads() : new ArrayList<>();
        boolean dynamicReference = false;
        for (Quad quad : inserts) {
            if (quad.getSubject().isURI() && data.contains(CURRENT, quad.getSubject(), RDF.type.asNode(), rv("AgentTombstone")))
                return "erased Person profile cannot be reactivated";
            if (profileIndexReference(quad)) {
                if (quad.getObject().isVariable()) dynamicReference = true;
                if (quad.getObject().isURI() && data.contains(CURRENT, quad.getObject(), RDF.type.asNode(), rv("AgentTombstone")))
                    return "erased Person cannot regain indexed profile content";
            }
            if (erased(data, quad.getSubject()) || (erased(data, quad.getObject())
                && !retainedHomePredecessor(data, inserts, quad)))
                return "erased exact revision cannot be reactivated";
        }
        if (dynamicReference && data.contains(CURRENT, Node.ANY, RDF.type.asNode(), rv("AgentTombstone"))) {
            var staged = new CommandOverlay(data);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(staged));
            for (Quad quad : staged.additions()) if (profileIndexReference(quad) && quad.getObject().isURI()
                && data.contains(CURRENT, quad.getObject(), RDF.type.asNode(), rv("AgentTombstone")))
                return "erased Person cannot regain indexed profile content";
        }
        return null;
    }

    private static boolean profileIndexReference(Quad quad) {
        return Set.of(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PRIVATE_SEARCH)).contains(quad.getGraph())
            && (quad.getPredicate().isVariable() || INDEX_REFERENCES.contains(quad.getPredicate())
                || rv("prefixAuthor").equals(quad.getPredicate()));
    }

    /** A fresh home cut retains its predecessor's identity without restoring
     * that cut's bytes. Even after compaction the owner's retained head proves
     * which tombstone it replaces; no other reference to erased data is allowed. */
    private static boolean retainedHomePredecessor(DatasetGraph data, List<Quad> inserts, Quad quad) {
        Node revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
        Node current = NodeFactory.createURI(CommandPolicy.CURRENT);
        Node predecessor = NodeFactory.createURI("https://rezics.com/vocab/predecessor");
        Node component = NodeFactory.createURI("https://rezics.com/vocab/component");
        Node homeHead = NodeFactory.createURI("https://rezics.com/vocab/homeDocumentHead");
        Node homeType = NodeFactory.createURI("https://rezics.com/vocab/ZoneHomeRevision");
        if (!quad.getGraph().equals(revisions) || !quad.getPredicate().equals(predecessor)
            || !inserts.contains(new Quad(revisions, quad.getSubject(), RDF.type.asNode(), homeType))) return false;
        for (Quad candidate : inserts) {
            if (candidate.getGraph().equals(revisions) && candidate.getSubject().equals(quad.getSubject())
                && candidate.getPredicate().equals(component)
                && data.contains(current, candidate.getObject(), homeHead, quad.getObject())) return true;
        }
        return false;
    }

    private static String markerFootprint(CommandPolicy.Plan plan, String receipt) {
        Update update = plan.request().getOperations().getFirst();
        List<Quad> inserts = update instanceof UpdateModify modify ? modify.getInsertQuads()
            : update instanceof UpdateDataInsert insert ? insert.getQuads() : new ArrayList<>();
        if (!receipt.matches("urn:rezics:receipt:erasure-graph:[0-9a-f]{64}")
            || !plan.current().isEmpty() || !plan.source().isEmpty()
            || plan.revisions().isEmpty()
            || !plan.graphs().equals(Set.of(CommandPolicy.CONTROL, CommandPolicy.REVISIONS,
                CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX, CommandPolicy.PUBLIC_SEARCH,
                CommandPolicy.PRIVATE_SEARCH))
            || plan.revisions().stream().anyMatch(subject -> !subject.matches(REVISION_TARGET)))
            return "erasure graph footprint differs";
        for (Quad quad : inserts) {
            String graph = quad.getGraph().getURI();
            if (graph.equals(CommandPolicy.PUBLIC_SEARCH) || graph.equals(CommandPolicy.PRIVATE_SEARCH))
                return "erasure cannot insert indexed content";
            if (graph.equals(CommandPolicy.REVISIONS)
                && !(quad.getPredicate().equals(RDF.type.asNode()) && quad.getObject().equals(ERASED)
                    || quad.getPredicate().equals(ERASURE_EPOCH) && quad.getObject().isLiteral()))
                return "erasure may insert only an exact tombstone";
        }
        for (String subject : plan.revisions()) {
            boolean type = false, epoch = false;
            for (Quad quad : inserts) {
                if (!quad.getGraph().getURI().equals(CommandPolicy.REVISIONS) || !quad.getSubject().isURI()
                    || !quad.getSubject().getURI().equals(subject)) continue;
                if (quad.getPredicate().equals(RDF.type.asNode()) && quad.getObject().equals(ERASED)) type = true;
                if (quad.getPredicate().equals(ERASURE_EPOCH) && quad.getObject().isLiteral()) epoch = true;
            }
            if (!type || !epoch) return "erasure may insert only an exact tombstone";
        }
        if (update instanceof UpdateModify modify) for (Quad quad : modify.getDeleteQuads()) {
            if (Set.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS, CommandPolicy.SOURCE)
                .contains(quad.getGraph().getURI())) return "erasure cannot remove owner history";
        }
        return null;
    }

    static boolean priorRevision(DatasetGraph data, String subject) {
        Node node = NodeFactory.createURI(subject);
        for (String name : RevisionClasses.PRIOR)
            if (data.contains(REVISIONS, node, RDF.type.asNode(),
                NodeFactory.createURI("https://rezics.com/vocab/" + name))) return true;
        return false;
    }

    private static boolean erased(DatasetGraph data, Node node) {
        return node.isURI() && data.contains(REVISIONS, node, RDF.type.asNode(), ERASED);
    }

    /** A tombstone cannot commit while a public or private unit still names its exact revision. */
    static String check(DatasetGraph data, CommandPolicy.Plan plan) {
        if (!plan.current().isEmpty() && plan.request().getOperations().getFirst() instanceof UpdateModify modify
            && personMarker(plan) != null
            && modify.getInsertQuads().stream().anyMatch(q -> CURRENT.equals(q.getGraph())
                && RDF.type.asNode().equals(q.getPredicate()) && rv("AgentTombstone").equals(q.getObject()))) {
            PersonMarker marker = personMarker(plan);
            if (marker == null || !personTombstone(data, marker.person(), marker.id(), marker.epoch()))
                return "Person tombstone footprint differs";
            if (personIndexedReference(data, marker.person()) || data.contains(uri(CommandPolicy.PUBLIC_SEARCH), Node.ANY, rv("prefixAuthor"), marker.person())) return "erased Person still has an indexed unit";
            for (String subject : plan.revisions()) {
                if (profileFacts(data, REVISIONS, uri(subject))) return "erased Person revision still has profile facts";
                if (personIndexedReference(data, uri(subject))) return "erased Person revision still has an indexed unit";
            }
        }
        for (String subject : plan.revisions()) {
            Node target = NodeFactory.createURI(subject);
            if (!data.contains(REVISIONS, target, RDF.type.asNode(), ERASED)) continue;
            if (indexedReference(data, target))
                return "erased exact revision still has an indexed unit";
        }
        return null;
    }

    static boolean indexedReference(DatasetGraph data, Node target) {
        for (String graph : List.of(CommandPolicy.PUBLIC_SEARCH, CommandPolicy.PRIVATE_SEARCH))
            for (Node predicate : List.of(REVISION, CONTENT_REVISION))
                if (data.contains(NodeFactory.createURI(graph), Node.ANY, predicate, target)) return true;
        return false;
    }

    /** Access owns the retained Account proof and holds its locks through dispatch.
     * Native admission owns only the exact Person mutation, never an SQL authority decision. */
    private static String personTemplate(CommandPolicy.Plan plan, String receipt) {
        if (!receipt.matches("urn:rezics:receipt:erasure-graph:[0-9a-f]{64}")
            || plan.current().size() != 1 || plan.revisions().isEmpty() || plan.revisions().size() > 64
            || !plan.source().isEmpty() || plan.bootstrap() || plan.rebuild()
            || !plan.graphs().containsAll(Set.of(CommandPolicy.CONTROL, CommandPolicy.CURRENT,
                CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX))
            || !Set.of(CommandPolicy.CONTROL, CommandPolicy.CURRENT, CommandPolicy.REVISIONS,
                CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX, CommandPolicy.PUBLIC_SEARCH,
                CommandPolicy.PRIVATE_SEARCH).containsAll(plan.graphs())
            || !(plan.request().getOperations().getFirst() instanceof UpdateModify))
            return "Person erasure graph footprint differs";
        PersonMarker marker = personMarker(plan);
        if (marker == null || !marker.person().getURI().matches(PERSON_TARGET)
            || !marker.id().isLiteral() || !marker.id().getLiteralLexicalForm().matches(UUID)
            || !"http://www.w3.org/2001/XMLSchema#string".equals(marker.id().getLiteralDatatypeURI())
            || !positiveEpoch(marker.epoch()) || !receipt.equals(receipt(marker.id().getLiteralLexicalForm())))
            return "Person erasure identity differs";
        var modify = (UpdateModify) plan.request().getOperations().getFirst();
        List<Quad> inserts = modify.getInsertQuads();
        Set<Quad> expected = Set.of(new Quad(CURRENT, marker.person(), RDF.type.asNode(), rv("AgentTombstone")),
            new Quad(CURRENT, marker.person(), rv("agentKind"), rv("PersonAgent")),
            new Quad(CURRENT, marker.person(), rv("erasureId"), marker.id()),
            new Quad(CURRENT, marker.person(), ERASURE_EPOCH, marker.epoch()));
        if (!new HashSet<>(inserts.stream().filter(q -> CURRENT.equals(q.getGraph())).toList()).equals(expected)
            || inserts.stream().filter(q -> CURRENT.equals(q.getGraph())).count() != 4)
            return "Person erasure inserts only the typed tombstone";
        Node own = uri(receipt);
        for (Node predicate : List.of(rv("erasureId"), ERASURE_EPOCH)) {
            Node value = predicate.equals(ERASURE_EPOCH) ? marker.epoch() : marker.id();
            var fields = inserts.stream().filter(q -> uri(CommandPolicy.RECEIPTS).equals(q.getGraph())
                && own.equals(q.getSubject()) && predicate.equals(q.getPredicate())).toList();
            if (fields.size() != 1 || !fields.getFirst().getObject().equals(value))
                return "Person erasure receipt identity differs";
        }
        for (String subject : plan.revisions()) {
            if (!(subject.matches(PERSON_TARGET) || subject.matches(PROVISION_TARGET)))
                return "Person profile revision identity differs";
            Set<Quad> revision = Set.of(new Quad(REVISIONS, uri(subject), RDF.type.asNode(), ERASED),
                new Quad(REVISIONS, uri(subject), ERASURE_EPOCH, marker.epoch()));
            var found = inserts.stream().filter(q -> REVISIONS.equals(q.getGraph()) && uri(subject).equals(q.getSubject())).toList();
            if (found.size() != 2 || !new HashSet<>(found).equals(revision))
                return "Person erasure inserts only exact revision tombstones";
        }
        if (inserts.stream().anyMatch(q -> Set.of(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PRIVATE_SEARCH)).contains(q.getGraph())))
            return "Person erasure cannot insert indexed content";
        int units = 0;
        for (Quad quad : modify.getDeleteQuads()) {
            if (CURRENT.equals(quad.getGraph())) {
                if (!quad.getSubject().equals(marker.person()) || !(quad.getPredicate().isVariable()
                    || PROFILE_PREDICATES.contains(quad.getPredicate())
                    || quad.getPredicate().equals(RDF.type.asNode()) && quad.getObject().equals(rv("Agent"))))
                    return "Person erasure current deletion differs";
            } else if (REVISIONS.equals(quad.getGraph())) {
                if (!quad.getSubject().isURI() || !plan.revisions().contains(quad.getSubject().getURI())
                    || !(quad.getPredicate().isVariable() || historicalProfilePredicate(quad.getPredicate())))
                    return "Person erasure cannot remove owner history";
            } else if (Set.of(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PRIVATE_SEARCH)).contains(quad.getGraph())) {
                if (!(quad.getSubject().isURI() || quad.getSubject().isVariable())
                    || !(quad.getPredicate().isVariable() && quad.getObject().isVariable()
                        || quad.getPredicate().equals(rv("prefixAuthor")) && quad.getObject().equals(marker.person()))
                    || ++units > 64)
                    return "Person erasure deletes only exact search units";
            } else if (!quad.getGraph().equals(uri(CommandPolicy.CONTROL))
                || !quad.getSubject().equals(uri("urn:rezics:dataset:product")) || !quad.getPredicate().equals(rv("sequence")))
                return "Person erasure deletion graph differs";
        }
        return null;
    }

    private static PersonMarker personMarker(CommandPolicy.Plan plan) {
        if (plan.current().size() != 1 || !(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        Node person = uri(plan.current().iterator().next()), id = null, epoch = null;
        for (Quad quad : modify.getInsertQuads()) if (CURRENT.equals(quad.getGraph()) && person.equals(quad.getSubject())) {
            if (quad.getPredicate().equals(rv("erasureId"))) { if (id != null) return null; id = quad.getObject(); }
            if (quad.getPredicate().equals(ERASURE_EPOCH)) { if (epoch != null) return null; epoch = quad.getObject(); }
        }
        return id == null || epoch == null ? null : new PersonMarker(person, id, epoch);
    }

    static boolean positiveEpoch(Node value) {
        return value != null && value.isLiteral() && "http://www.w3.org/2001/XMLSchema#integer".equals(value.getLiteralDatatypeURI())
            && value.getLiteralLexicalForm().matches("[1-9][0-9]{0,18}")
            && new BigInteger(value.getLiteralLexicalForm()).compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0;
    }

    private static String receipt(String id) {
        try { return "urn:rezics:receipt:erasure-graph:" + HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }

    static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var found = data.find(graph, subject, predicate, Node.ANY);
        try { if (!found.hasNext()) return null; Node value = found.next().getObject(); return found.hasNext() ? null : value; }
        finally { Iter.close(found); }
    }

    /** A suffix alone is never authority; the anchor's exact model and operation prove its meaning. */
    static boolean personRevision(DatasetGraph data, Node revision, Node person) {
        if (!revision.isURI() || !person.equals(one(data, REVISIONS, revision, rv("component")))
            || !data.contains(REVISIONS, revision, RDF.type.asNode(), rv("RevisionAnchor"))) return false;
        Node model = one(data, REVISIONS, revision, rv("modelRevision"));
        Node operation = one(data, REVISIONS, revision, rv("operation"));
        if (revision.getURI().matches(PROVISION_TARGET)) {
            String id = revision.getURI().substring("https://rezics.com/id/".length(), revision.getURI().length() - "-agent-revision".length());
            Node manifest = one(data, REVISIONS, revision, rv("manifest"));
            if (!rvModel("agent-provision-v1").equals(model) || !uri("urn:rezics:operation:agent-provision:" + id).equals(operation)
                || manifest == null || !manifest.isURI() || !manifest.getURI().matches("urn:rezics:sha256:[0-9a-f]{64}")) return false;
        } else if (!revision.getURI().matches(PERSON_TARGET)
            || !data.contains(REVISIONS, revision, RDF.type.asNode(), rv("AgentPublicProfileRevision"))
            || model == null || !Set.of(rvModel("agent-profile-address-v1"), rvModel("agent-profile-v1"), rvModel("agent-profile-v2")).contains(model)
            || operation == null || !operation.isURI() || !operation.getURI().matches("urn:rezics:operation:agent-profile:(?:" + UUID + "|[0-9a-f]{64})")) return false;
        Set<Node> allowedTypes = revision.getURI().matches(PROVISION_TARGET)
            ? Set.of(rv("RevisionAnchor"), ERASED)
            : Set.of(rv("RevisionAnchor"), rv("AgentPublicProfileRevision"), ERASED);
        var types = data.find(REVISIONS, revision, RDF.type.asNode(), Node.ANY);
        try { while (types.hasNext()) if (!allowedTypes.contains(types.next().getObject())) return false; }
        finally { Iter.close(types); }
        return true;
    }
    private static Node rvModel(String value) { return uri("https://rezics.com/definition/" + value); }
    static boolean historicalProfilePredicate(Node predicate) {
        return PROFILE_PREDICATES.contains(predicate) && !Set.of(rv("head"), rv("publicProfileHead")).contains(predicate);
    }
    private static boolean profileFacts(DatasetGraph data, Node graph, Node subject) {
        for (Node predicate : PROFILE_PREDICATES) if (data.contains(graph, subject, predicate, Node.ANY)) return true;
        return false;
    }
    static boolean personTombstone(DatasetGraph data, Node person, Node id, Node epoch) {
        if (!person.isURI() || !person.getURI().matches(PERSON_TARGET) || id == null || !id.isLiteral()
            || !id.getLiteralLexicalForm().matches(UUID) || !positiveEpoch(epoch)) return false;
        Set<Quad> expected = Set.of(new Quad(CURRENT, person, RDF.type.asNode(), rv("AgentTombstone")),
            new Quad(CURRENT, person, rv("agentKind"), rv("PersonAgent")),
            new Quad(CURRENT, person, rv("erasureId"), id), new Quad(CURRENT, person, ERASURE_EPOCH, epoch));
        return stored(data, CURRENT, person).equals(expected);
    }
    static boolean personTombstone(DatasetGraph data, CommandPolicy.Plan plan, String receipt, String name) {
        if (plan.current().size() != 1 || !plan.current().contains(name) || personTemplate(plan, receipt) != null) return false;
        PersonMarker marker = personMarker(plan);
        return personTombstone(data, marker.person(), marker.id(), marker.epoch());
    }

    private static Set<Quad> stored(DatasetGraph data, Node graph, Node subject) {
        Set<Quad> result = new HashSet<>(); var found = data.find(graph, subject, Node.ANY, Node.ANY);
        try { while (found.hasNext()) { if (result.size() >= 16_384) throw new IllegalArgumentException("Person footprint exceeds quad bound"); result.add(found.next()); } }
        finally { Iter.close(found); }
        return result;
    }
    static boolean personIndexedReference(DatasetGraph data, Node target) {
        for (String graph : List.of(CommandPolicy.PUBLIC_SEARCH, CommandPolicy.PRIVATE_SEARCH))
            for (Node predicate : INDEX_REFERENCES) if (data.contains(uri(graph), Node.ANY, predicate, target)) return true;
        return false;
    }

    private static boolean directPersonDocument(DatasetGraph data, Node graph, Node subject, Set<Node> targets) {
        boolean own = false;
        for (Node predicate : INDEX_REFERENCES) {
            var values = data.find(graph, subject, predicate, Node.ANY);
            try { while (values.hasNext()) {
                if (!targets.contains(values.next().getObject())) return false;
                own = true;
            } } finally { Iter.close(values); }
        }
        return own;
    }

    /** Shared prefixes retain every coauthor and Work fact; only an unshared
     * credit prefix may disappear as a complete directory entry. */
    static boolean authorPrefixRemoval(DatasetGraph data, Quad quad, Node person) {
        return authorPrefixRemoval(data, quad, Set.of(person));
    }
    static boolean authorPrefixRemoval(DatasetGraph data, Quad quad, Set<Node> persons) {
        if (!uri(CommandPolicy.PUBLIC_SEARCH).equals(quad.getGraph())
            || persons.stream().noneMatch(person -> data.contains(quad.getGraph(), quad.getSubject(), rv("prefixAuthor"), person))) return false;
        if (quad.getPredicate().equals(rv("prefixAuthor"))) return persons.contains(quad.getObject());
        if (!quad.getSubject().isURI() || !quad.getSubject().getURI().startsWith(PublicNameProjection.PREFIX_DIRECTORY)) return false;
        Node field = one(data, quad.getGraph(), quad.getSubject(), rv("prefixField"));
        if (field != null && !NodeFactory.createLiteralString("credit").equals(field)) return false;
        for (Node reference : INDEX_REFERENCES)
            if (data.contains(quad.getGraph(), quad.getSubject(), reference, Node.ANY)) return false;
        var authors = data.find(quad.getGraph(), quad.getSubject(), rv("prefixAuthor"), Node.ANY);
        try { while (authors.hasNext()) if (!persons.contains(authors.next().getObject())) return false; }
        finally { Iter.close(authors); }
        return true;
    }

    private static String personPreflight(DatasetGraph data, CommandPolicy.Plan plan, String receipt) {
        PersonMarker marker = personMarker(plan);
        Node person = marker.person();
        if (!rv("PersonAgent").equals(one(data, CURRENT, person, rv("agentKind")))
            || !rv("Agent").equals(one(data, CURRENT, person, RDF.type.asNode()))
            || data.contains(CURRENT, person, rv("protectionHead"), Node.ANY)) return "Person erasure kind or hold differs";
        for (Quad quad : stored(data, CURRENT, person)) if (!Set.of(RDF.type.asNode(), rv("agentKind")).contains(quad.getPredicate())
            && !PROFILE_PREDICATES.contains(quad.getPredicate())) return "Person current footprint is unsupported";
        Node head = one(data, CURRENT, person, rv("head"));
        if (head == null || !head.isURI() || !plan.revisions().contains(head.getURI())) return "Person head is outside the sealed closure";
        Set<String> owned = new HashSet<>(); var revisions = data.find(REVISIONS, Node.ANY, rv("component"), person);
        try { while (revisions.hasNext()) {
            Node revision = revisions.next().getSubject();
            if (!personRevision(data, revision, person) || !owned.add(revision.getURI()) || owned.size() > 64)
                return "Person revision kind, owner or provisioning anchor differs";
            if (data.contains(REVISIONS, revision, RDF.type.asNode(), ERASED)
                || data.contains(REVISIONS, revision, ERASURE_EPOCH, Node.ANY)) return "Person revision erasure epoch is stale";
        } } finally { Iter.close(revisions); }
        if (!owned.equals(plan.revisions())) return "Person revisions differ from the sealed closure";
        Set<Node> targets = new HashSet<>(); targets.add(person); owned.forEach(value -> targets.add(uri(value)));
        var modify = (UpdateModify) plan.request().getOperations().getFirst();
        for (Quad quad : modify.getDeleteQuads()) if (Set.of(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PRIVATE_SEARCH)).contains(quad.getGraph())) {
            // Author-prefix removals are proved from their actual staged quads below.
            if (quad.getSubject().isVariable() || data.contains(uri(CommandPolicy.PUBLIC_SEARCH), quad.getSubject(), rv("prefixAuthor"), person)) continue;
            boolean own = false;
            for (Node predicate : INDEX_REFERENCES) {
                var values = data.find(quad.getGraph(), quad.getSubject(), predicate, Node.ANY);
                try { while (values.hasNext()) {
                    if (!targets.contains(values.next().getObject())) return "Person indexed unit has a foreign owner";
                    own = true;
                } } finally { Iter.close(values); }
            }
            if (!own) return "Person indexed unit is outside the sealed closure";
        }
        // Use the same bounded savepoint as the command writer. A variable predicate
        // cannot hide a metadata deletion behind an apparently narrow template.
        var staged = new CommandOverlay(data);
        UpdateAction.execute(plan.request(), DatasetFactory.wrap(staged));
        for (Quad quad : staged.removals()) {
            if (CURRENT.equals(quad.getGraph()) && !(PROFILE_PREDICATES.contains(quad.getPredicate())
                || quad.getPredicate().equals(RDF.type.asNode()) && quad.getObject().equals(rv("Agent"))))
                return "Person erasure deleted a retained current fact";
            if (REVISIONS.equals(quad.getGraph()) && !historicalProfilePredicate(quad.getPredicate()))
                return "Person erasure deleted retained revision metadata";
            if (Set.of(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PRIVATE_SEARCH)).contains(quad.getGraph())
                && !directPersonDocument(data, quad.getGraph(), quad.getSubject(), targets)
                && !authorPrefixRemoval(data, quad, person))
                return "Person erasure deleted retained search data";
        }
        if (!personTombstone(staged, person, marker.id(), marker.epoch())) return "Person erasure guard did not match its exact tombstone";
        String checked = check(staged, plan);
        return checked;
    }

    private ErasurePolicy() {}
}
