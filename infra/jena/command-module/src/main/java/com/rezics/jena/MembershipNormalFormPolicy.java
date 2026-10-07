package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;

/** Preserve ordered membership from the actual staged mutation, without reading
 * a parent list's adjacency. Metadata fields admit at most 16 values; one command
 * admits at most 128 affected focuses and 128 total inbound rows/empty probes.
 * An overflow requires a bounded owner operation, never truncated validation. */
final class MembershipNormalFormPolicy {
    private static final String RV = "https://rezics.com/vocab/", SCHEMA = "https://schema.org/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node TYPE = RDF.type.asNode(), LIVE = uri(RV + "OccurrencePlacement"),
        REMOVED = uri(RV + "RemovedPlacement"), LIST = uri(SCHEMA + "ItemList"),
        ITEM = uri(SCHEMA + "ListItem"), SEGMENT = uri(RV + "OrderSegment"),
        GENERATION = uri(RV + "StructureGeneration"), STRUCTURE = uri(RV + "Structure");
    private static final Node ELEMENT = uri(SCHEMA + "itemListElement");
    private static final int MAX_DEPENDENTS = 128, MAX_FIELD_VALUES = 16;

    static void invalidate(DatasetGraph data) {
        TemplateIndexService.invalidateMembershipCompletion(data);
    }

    record Result(String error, Set<Node> validatedLists) {}
    static Result check(CommandOverlay delta, ProfileRegistry profiles, long deadlineNano) {
        try {
            Check check=new Check(delta, profiles, deadlineNano); check.run();
            return new Result(null,Set.copyOf(check.validatedLists));
        } catch (IllegalArgumentException invalid) { return new Result(invalid.getMessage(),Set.of()); }
    }

    static Map<String,Object> validateList(DatasetGraph data,ProfileRegistry profiles,String subject,Set<Node> verifiedLists) {
        if(!verifiedLists.contains(uri(subject)) && !TemplateIndexService.membershipCompleted(data))
            return CommandService.invalid("ItemList validation requires completed membership preparation or a bounded verified delta");
        return TemplateIndexService.membershipValidateList(data,uri(subject),null,profiles);
    }

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private record Field(boolean prior, Node graph, Node subject, Node predicate) {}
    private record Edge(Node list, Node member) {}
    private record Inbound(Node predicate, Node object) {}
    private record Reference(Node type, Node predicate) {}
    private static final List<Reference> CLASS_REFERENCES = List.of(
        new Reference(ITEM, uri(RV + "occurrence")), new Reference(ITEM, ELEMENT),
        new Reference(GENERATION, uri(RV + "generation")), new Reference(SEGMENT, uri(RV + "orderSegment")),
        new Reference(uri(RV + "StructureRevision"), uri(RV + "removedBy")),
        new Reference(uri(RV + "Realm"), uri(RV + "selectionRealm")));

    private static final class Check {
        private final CommandOverlay after;
        private final DatasetGraph before;
        private final ProfileRegistry profiles;
        private final long deadline;
        private final Map<Field, Set<Node>> fields = new HashMap<>();
        private final Set<Node> focuses = new LinkedHashSet<>();
        private final ArrayDeque<Node> pending = new ArrayDeque<>();
        private final Set<Edge> edges = new LinkedHashSet<>();
        private final Set<Inbound> scanned = new LinkedHashSet<>();
        private final Set<Node> segments = new LinkedHashSet<>(), generations = new LinkedHashSet<>(),
            structures = new LinkedHashSet<>();
        private int inboundWork;
        private final Set<Node> validatedLists=new LinkedHashSet<>();
        private final boolean completedBefore;

        Check(CommandOverlay after, ProfileRegistry profiles, long deadline) {
            this.after = after; this.before = after.getWrapped(); this.profiles = profiles; this.deadline = deadline;
            this.completedBefore=TemplateIndexService.membershipCompleted(this.before);
        }

        void run() {
            Set<Node> changed = new LinkedHashSet<>(), changedTypes = new LinkedHashSet<>();
            for (Set<Quad> mutation : List.of(after.additions(), after.removals())) for (Quad quad : mutation) {
                deadline();
                if (quad.getPredicate().equals(TYPE) && Set.of(CURRENT, REVISIONS).contains(quad.getGraph()))
                    changedTypes.add(quad.getSubject());
                if (!quad.getGraph().equals(CURRENT)) continue;
                Node subject = quad.getSubject(), predicate = quad.getPredicate();
                changed.add(subject);
                if (predicate.equals(ELEMENT)) {
                    edges.add(new Edge(subject, quad.getObject())); focus(subject); focus(quad.getObject());
                }
                if (List.of(TYPE, uri(RV + "generation"), uri(RV + "parent")).contains(predicate)
                    && types(true, subject).contains(LIST))
                    fail("existing ItemList skeleton is immutable");
                if (List.of(TYPE, uri(RV + "segmentKey"), uri(RV + "parent"), uri(RV + "generation")).contains(predicate)
                    && types(true, subject).contains(SEGMENT)) segments.add(subject);
                if (List.of(TYPE, uri(RV + "structure")).contains(predicate)
                    && types(true, subject).contains(GENERATION)) generations.add(subject);
                if (List.of(TYPE, uri(RV + "structureProfile")).contains(predicate)
                    && types(true, subject).contains(STRUCTURE)) structures.add(subject);
            }
            for (Node subject : changed) {
                deadline();
                Set<Node> postTypes=types(false,subject);
                if(postTypes.stream().anyMatch(type->List.of(LIVE,REMOVED,LIST,ITEM,SEGMENT,GENERATION,STRUCTURE).contains(type))
                    && before.contains(Quad.defaultGraphNodeGenerated,subject,Node.ANY,Node.ANY))
                    fail("ordered membership cannot be redirected into default metadata storage");
                if (typedEither(subject, LIVE) || typedEither(subject, REMOVED) || typedEither(subject, LIST)) focus(subject);
            }
            // Only loss of an existing class can break an unchanged dependent.
            // New placements/edges are checked directly from their actual delta;
            // adding a class cannot regress an already-complete representation.
            // The authored shapes use the current/revisions type union.
            for (Node subject : changedTypes) for (Reference reference : CLASS_REFERENCES) {
                deadline();
                if (hasClass(true, subject, reference.type()) && !hasClass(false, subject, reference.type()))
                    inbound(reference.predicate(), subject);
            }
            for (Node structure : structures) {
                deadline();
                inbound(uri(RV + "structure"), structure);
            }
            while (!pending.isEmpty() || !generations.isEmpty() || !segments.isEmpty()) {
                deadline();
                if (!generations.isEmpty()) {
                    Node generation = generations.iterator().next(); generations.remove(generation);
                    inbound(uri(RV + "generation"), generation);
                } else if (!segments.isEmpty()) {
                    Node segment = segments.iterator().next(); segments.remove(segment);
                    inbound(uri(RV + "orderSegment"), segment);
                } else {
                    Node subject = pending.removeFirst();
                    Set<Node> types = types(false, subject);
                    if (types.contains(LIVE) || types.contains(REMOVED)) placement(subject, types.contains(LIVE));
                    if (types.contains(LIST)) validateList(subject,null);
                }
            }
            for (Edge edge : edges) {
                deadline();
                if (after.contains(CURRENT, edge.list(), ELEMENT, edge.member()))
                    validateList(edge.list(),edge.member());
            }
        }

        private void inbound(Node predicate, Node object) {
            deadline();
            if (!scanned.add(new Inbound(predicate, object))) return;
            var rows = after.find(CURRENT, Node.ANY, predicate, object);
            boolean found = false;
            try {
                while (rows.hasNext()) {
                    deadline(); inboundWork(); found = true;
                    Quad quad = rows.next(); Node subject = quad.getSubject();
                    focus(subject);
                    if (predicate.equals(ELEMENT)) edges.add(new Edge(subject, object));
                    if (predicate.equals(uri(RV + "structure")) && types(false, subject).contains(GENERATION))
                        generations.add(subject);
                }
                if (!found) inboundWork();
            } finally { Iter.close(rows); }
        }

        private void inboundWork() {
            if (++inboundWork > MAX_DEPENDENTS) fail("membership dependent read footprint exceeds 128");
            CommandWork.count("membership_dependent_reads", 1);
        }

        private void focus(Node subject) {
            if (!subject.isURI()) fail("membership reference must be an IRI");
            if (focuses.add(subject)) {
                if (focuses.size() > MAX_DEPENDENTS) fail("membership dependent closure exceeds 128");
                pending.addLast(subject);
                CommandWork.count("membership_preservation_focuses", 1);
            }
        }

        private void placement(Node subject, boolean live) {
            if (!values(false, CURRENT, subject, uri(RV + "target")).isEmpty())
                fail("legacy rv:target is outside ordered membership normal form");
            if (live) {
                iri(one(subject, SCHEMA + "item"));
                Node generation = iri(one(subject, RV + "generation")), segment = iri(one(subject, RV + "orderSegment"));
                Node parent = iri(one(segment, RV + "parent"));
                String segmentKey = text(one(segment, RV + "segmentKey")), orderKey = text(one(subject, RV + "orderKey"));
                Node position = one(subject, SCHEMA + "position");
                if (!NodeFactory.createLiteralString(segmentKey + "-" + orderKey).equals(position))
                    fail("membership position differs from parent-local order keys");
                if (values(false, CURRENT, subject, uri(RV + "removedBy")).isEmpty()) {
                    Node list = uri("urn:rezics:item-list:" + hash(generation.getURI() + "\0" + parent.getURI()));
                    if (!after.contains(CURRENT, list, ELEMENT, subject)
                        || !generation.equals(one(list, RV + "generation")) || !parent.equals(one(list, RV + "parent")))
                        fail("active placement lacks its deterministic ItemList membership");
                    validateList(list,subject);
                }
            }
            validate(TemplateIndexService.membershipValidatePlacement(after, subject, profiles));
            deadline();
        }

        private void validateList(Node list, Node member) {
            if(!validatedLists.contains(list) && !completedBefore) {
                // One prestate witness, never a parent population walk. A raw
                // or legacy populated list needs the exhaustive preparer first.
                // Staged net deletions do not filter this prestate iterator.
                var prior=before.find(CURRENT,list,ELEMENT,Node.ANY);
                try {
                    inboundWork();
                    if(prior.hasNext()) fail("populated ItemList requires completed membership preparation");
                } finally { Iter.close(prior); }
            }
            validate(TemplateIndexService.membershipValidateList(after,list,member,profiles));
            validatedLists.add(list);
        }

        private Set<Node> types(boolean prior, Node subject) { return values(prior, CURRENT, subject, TYPE); }
        private boolean typedEither(Node subject, Node type) { return types(true, subject).contains(type) || types(false, subject).contains(type); }
        private boolean hasClass(boolean prior, Node subject, Node type) {
            return types(prior, subject).contains(type) || values(prior, REVISIONS, subject, TYPE).contains(type);
        }
        private Set<Node> values(boolean prior, Node graph, Node subject, Node predicate) {
            deadline();
            Field field = new Field(prior, graph, subject, predicate);
            Set<Node> cached = fields.get(field);
            if (cached != null) return cached;
            var rows = (prior ? before : after).find(graph, subject, predicate, Node.ANY);
            Set<Node> values = new LinkedHashSet<>();
            try {
                while (rows.hasNext()) {
                    deadline();
                    if (values.size() == MAX_FIELD_VALUES) fail("membership metadata field exceeds 16 values");
                    values.add(rows.next().getObject());
                    CommandWork.count("membership_preservation_metadata", 1);
                }
            } finally { Iter.close(rows); }
            Set<Node> result = Set.copyOf(values); fields.put(field, result); return result;
        }
        private Node one(Node subject, String predicate) {
            Set<Node> values = values(false, CURRENT, subject, uri(predicate));
            if (values.size() != 1) fail("ambiguous or missing membership field: " + predicate);
            return values.iterator().next();
        }
        private Node iri(Node value) { if (!value.isURI()) fail("membership reference must be an IRI"); return value; }
        private String text(Node value) { if (!value.isLiteral()) fail("membership key must be a literal"); return value.getLiteralLexicalForm(); }
        private void validate(Map<String, Object> report) { if (report != null) fail("membership normal-form validation rejected: " + report.get("report")); }
        private void deadline() {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                fail("membership normal-form validation exceeded its deadline");
        }
        private void fail(String message) { throw new IllegalArgumentException(message); }
    }

    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private MembershipNormalFormPolicy() {}
}
