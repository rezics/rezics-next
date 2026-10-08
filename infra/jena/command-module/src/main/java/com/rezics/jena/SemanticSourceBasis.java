package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.changes.TextQuadAction;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.store.DatasetGraphTDB;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.vocabulary.RDF;

/** Native source identity only. No key, adoption inventory or promotion authority.
 * Manifest references must still resolve through the immutable owner: in particular
 * projection absence is never evidence that the retained payload lacks a value.
 * Proof stays closed until startup qualification AND every native writer hook are composed. */
final class SemanticSourceBasis {
    static final int MAX_QUADS = 16_384, MAX_RESOURCES = 64, MAX_TERM_BYTES = 32_768;
    static final int MAX_PROOF_BYTES = 262_144, MAX_EFFECT_BYTES = 4_194_304;
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        CONTROL = uri(CommandPolicy.CONTROL), STATE = PublicNameProjection.REPAIR,
        CHECKPOINT = uri("urn:rezics:projection:semantic-source-basis"),
        PRODUCT = uri("urn:rezics:dataset:product"), RESOURCE = uri("http://www.w3.org/2000/01/rdf-schema#Resource"),
        PROFILE = uri("https://rezics.com/definition/semantic-resource-v1"),
        INITIAL = uri("urn:rezics:semantic-source:initial");
    private static final String PROCESS = UUID.randomUUID().toString();
    private static final Map<DatasetGraphTDB, String> STORES = new WeakHashMap<>();
    private static final Set<Node> CURRENT_FIELDS = Set.of(p("semanticHead"), p("protectionHead"), p("mergedInto"));
    private static final Set<Node> ANCHOR_FIELDS = Set.of(RDF.type.asNode(), p("component"), p("manifest"),
        p("lifecycle"), p("operation"), p("modelGeneration"), p("modelRevision"), p("shapeRevision"),
        p("datasetId"), p("dataEpoch"), p("sequence"));
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    static final class Cancelled extends IllegalStateException {
        Cancelled() { super("semantic source work cancelled or expired"); }
    }
    static void check(long deadline) {
        if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) throw new Cancelled();
    }
    private static boolean nativeId(Node value) {
        return value != null && value.isURI() && value.getURI().length() == 58
            && value.getURI().matches("https://rezics\\.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}");
    }
    private static DatasetGraphTDB storage(DatasetGraph data) {
        DatasetGraph base = data;
        while (base instanceof DatasetGraphWrapper wrapper && TDBInternal.getDatasetGraphTDB(base) == null)
            base = wrapper.getWrapped();
        return TDBInternal.requireStorage(base);
    }
    private static String store(DatasetGraph data) {
        synchronized (STORES) { return PROCESS + ":" + STORES.computeIfAbsent(storage(data), ignored -> UUID.randomUUID().toString()); }
    }
    private static void writer(DatasetGraph data) {
        if (!data.isInTransaction() || data.transactionMode() != ReadWrite.WRITE)
            throw new IllegalStateException("semantic source effects require the native writer");
    }
    /** Count UTF-8 before allocation/formatting, including datatype and language. */
    private static final class Budget {
        final int limit;
        int bytes;
        Budget(int limit) { this.limit = limit; }
        void part(String value, long deadline) {
            if (value.length() > MAX_TERM_BYTES) throw new IllegalStateException("semantic source term exceeds byte bound");
            int size = 0;
            for (int i = 0; i < value.length(); i++) {
                check(deadline);
                char c = value.charAt(i);
                if (Character.isHighSurrogate(c)) {
                    if (++i == value.length() || !Character.isLowSurrogate(value.charAt(i)))
                        throw new IllegalStateException("semantic source term has invalid Unicode");
                    size += 4;
                } else if (Character.isLowSurrogate(c)) throw new IllegalStateException("semantic source term has invalid Unicode");
                else size += c < 128 ? 1 : c < 2048 ? 2 : 3;
                if (size > MAX_TERM_BYTES || bytes + size > limit)
                    throw new IllegalStateException("semantic source cumulative byte bound exceeded");
            }
            bytes += size;
        }
        void node(Node value, long deadline) {
            if (value == null) return;
            if (value.isURI()) part(value.getURI(), deadline);
            else if (value.isLiteral()) {
                part(value.getLiteralLexicalForm(), deadline);
                if (value.getLiteralDatatypeURI() != null) part(value.getLiteralDatatypeURI(), deadline);
                part(value.getLiteralLanguage(), deadline);
            } else throw new IllegalStateException("semantic source term is not a scalar or IRI");
        }
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate, Budget budget, long deadline) {
        check(deadline);
        CommandWork.count("semantic_source_point_probes", 1);
        var rows = data.find(graph, subject, predicate, Node.ANY);
        try {
            Node value = rows.hasNext() ? rows.next().getObject() : null;
            CommandWork.count("semantic_source_point_rows", value == null ? 0 : 1);
            check(deadline);
            if (rows.hasNext()) {
                rows.next(); CommandWork.count("semantic_source_point_rows", 1);
                throw new IllegalStateException("semantic source field is ambiguous");
            }
            check(deadline);
            budget.node(value, deadline);
            return value;
        } finally { Iter.close(rows); }
    }
    private static boolean has(DatasetGraph data, Node graph, Node subject, Node predicate, Node object, long deadline) {
        check(deadline); CommandWork.count("semantic_source_point_probes", 1);
        boolean found = data.contains(graph, subject, predicate, object);
        if (found) CommandWork.count("semantic_source_point_rows", 1);
        check(deadline); return found;
    }
    private static Node required(Node value, String message) {
        if (value == null) throw new IllegalStateException("semantic source " + message + " is unavailable");
        return value;
    }
    private static boolean string(Node value) {
        return value != null && value.isLiteral() && value.getLiteralLanguage().isEmpty()
            && XSDDatatype.XSDstring.getURI().equals(value.getLiteralDatatypeURI());
    }
    private static boolean anchorTypes(DatasetGraph data, Node head, Budget budget, long deadline) {
        check(deadline); CommandWork.count("semantic_source_point_probes", 1);
        var rows = data.find(REVISIONS, head, RDF.type.asNode(), Node.ANY);
        Set<Node> expected = new LinkedHashSet<>(Set.of(p("SemanticRevision"), p("RevisionAnchor")));
        try {
            for (int i = 0; i < 2; i++) {
                check(deadline);
                if (!rows.hasNext()) return false;
                Node type = rows.next().getObject(); CommandWork.count("semantic_source_point_rows", 1);
                budget.node(type, deadline);
                if (!expected.remove(type)) return false;
            }
            check(deadline); return !rows.hasNext();
        } finally { Iter.close(rows); }
    }
    private record Qualification(Node epoch, Node routing, Node nonce, String store) {}
    private static Qualification qualification(DatasetGraph data, Budget budget, long deadline) {
        Node epoch = required(one(data, CONTROL, PRODUCT, p("dataEpoch"), budget, deadline), "data epoch");
        Node routing = required(one(data, CONTROL, PRODUCT, p("routingEpoch"), budget, deadline), "routing epoch");
        if (!string(epoch) || !string(routing)
            || one(data, CONTROL, PRODUCT, p("restoreHold"), budget, deadline) != null)
            throw new IllegalStateException("semantic source lineage is unavailable or held");
        Node savedEpoch = one(data, STATE, CHECKPOINT, p("semanticSourceEpoch"), budget, deadline);
        Node savedRouting = one(data, STATE, CHECKPOINT, p("semanticSourceRouting"), budget, deadline);
        Node savedStore = one(data, STATE, CHECKPOINT, p("semanticSourceStore"), budget, deadline);
        Node nonce = one(data, STATE, CHECKPOINT, p("semanticSourceQualification"), budget, deadline);
        String physical = store(data);
        if (!epoch.equals(savedEpoch) || !routing.equals(savedRouting) || !text(physical).equals(savedStore)
            || nonce == null || !nonce.isURI()) throw new IllegalStateException("semantic source writer is unqualified");
        return new Qualification(epoch, routing, nonce, physical);
    }
    private static void state(DatasetGraph data, Node subject, String field, Node next, long deadline) {
        Node old = one(data, STATE, subject, p(field), new Budget(MAX_PROOF_BYTES), deadline);
        check(deadline);
        if (old != null) data.delete(STATE, subject, p(field), old);
        if (next != null) data.add(STATE, subject, p(field), next);
    }
    /** Closed startup seam, before traffic, after other owner initialization.
     * This requires exclusive observed writers, not payload/adoption completeness.
     * No caller inventory or empty-completion flag is accepted. */
    static void qualifyAtStartup(DatasetGraph data, long deadline) {
        writer(data); check(deadline);
        Budget budget = new Budget(MAX_PROOF_BYTES);
        Node epoch = required(one(data, CONTROL, PRODUCT, p("dataEpoch"), budget, deadline), "data epoch");
        Node routing = required(one(data, CONTROL, PRODUCT, p("routingEpoch"), budget, deadline), "routing epoch");
        if (!string(epoch) || !string(routing) || one(data, CONTROL, PRODUCT, p("restoreHold"), budget, deadline) != null)
            throw new IllegalStateException("semantic source startup requires active lineage");
        state(data, CHECKPOINT, "semanticSourceEpoch", epoch, deadline);
        state(data, CHECKPOINT, "semanticSourceRouting", routing, deadline);
        state(data, CHECKPOINT, "semanticSourceStore", text(store(data)), deadline);
        state(data, CHECKPOINT, "semanticSourceQualification", uri("urn:rezics:semantic-source:" + UUID.randomUUID()), deadline);
        check(deadline);
    }
    /** Append at the existing raw-maintenance boundary, after all requested
     * updates in the same transaction, including imported/forged qualification.
     * Unobserved out-of-band writers are outside the exclusive-writer premise. */
    static String rawInvalidationUpdate() {
        return "DELETE WHERE { GRAPH <" + STATE.getURI() + "> { <" + CHECKPOINT.getURI()
            + "> <" + p("semanticSourceQualification").getURI() + "> ?sourceQualification } }";
    }
    static void invalidate(DatasetGraph data) {
        writer(data);
        data.deleteAny(STATE, CHECKPOINT, p("semanticSourceQualification"), Node.ANY);
    }
    record Proof(Node resource, Node predicate, Node revision, Node manifest, Node modelGeneration,
        Node sourceEpoch, Node sourceSequence, Node generation, Node dataEpoch, Node routingEpoch,
        String store, String token, boolean projectionHasScalar) {}
    /** A bounded reference proof. The owner must verify manifest/payload bytes and
     * projection agreement before treating either scalar presence or absence as data. */
    static Proof proof(DatasetGraph data, Node resource, Node predicate, long deadline) {
        if (!nativeId(resource) || predicate == null || !predicate.isURI() || predicate.getURI().startsWith(RV)
            || RDF.type.asNode().equals(predicate)) throw new IllegalArgumentException("semantic scalar source identity is invalid");
        Budget budget = new Budget(MAX_PROOF_BYTES); budget.node(resource, deadline); budget.node(predicate, deadline);
        Qualification qualified = qualification(data, budget, deadline);
        if (!has(data, CURRENT, resource, RDF.type.asNode(), RESOURCE, deadline)
            || one(data, CURRENT, resource, p("protectionHead"), budget, deadline) != null
            || one(data, CURRENT, resource, p("mergedInto"), budget, deadline) != null)
            throw new IllegalStateException("semantic source Resource is unavailable");
        Node head = required(one(data, CURRENT, resource, p("semanticHead"), budget, deadline), "head");
        if (!nativeId(head) || !anchorTypes(data, head, budget, deadline)
            || !resource.equals(one(data, REVISIONS, head, p("component"), budget, deadline))
            || !p("Active").equals(one(data, REVISIONS, head, p("lifecycle"), budget, deadline)))
            throw new IllegalStateException("semantic source anchor is unavailable");
        Node manifest = required(one(data, REVISIONS, head, p("manifest"), budget, deadline), "manifest");
        Node model = required(one(data, REVISIONS, head, p("modelGeneration"), budget, deadline), "model generation");
        Node operation = required(one(data, REVISIONS, head, p("operation"), budget, deadline), "operation");
        Node epoch = required(one(data, REVISIONS, head, p("dataEpoch"), budget, deadline), "revision epoch");
        Node sequence = required(one(data, REVISIONS, head, p("sequence"), budget, deadline), "revision sequence");
        if (!manifest.isURI() || !manifest.getURI().matches("urn:rezics:sha256:[0-9a-f]{64}") || !model.isURI()
            || !model.getURI().matches("urn:rezics:model-generation:[0-9a-f]{64}") || !nativeId(operation)
            || !string(epoch) || !sequence.isLiteral() || !sequence.getLiteralLanguage().isEmpty()
            || !XSDDatatype.XSDinteger.getURI().equals(sequence.getLiteralDatatypeURI())
            || !sequence.getLiteralLexicalForm().matches("[1-9][0-9]{0,1023}")
            || !PRODUCT.equals(one(data, REVISIONS, head, p("datasetId"), budget, deadline)))
            throw new IllegalStateException("semantic source anchor custody references differ");
        for (String field : java.util.List.of("modelRevision", "shapeRevision")) {
            Node value = one(data, REVISIONS, head, p(field), budget, deadline);
            if (value != null && !PROFILE.equals(value)) throw new IllegalStateException("semantic source anchor profile differs");
        }
        Node scalar = one(data, CURRENT, resource, predicate, budget, deadline);
        if (scalar != null && !scalar.isLiteral()) throw new IllegalStateException("semantic source value is not a direct scalar");
        Node generation = one(data, STATE, resource, p("semanticSourceEffect"), budget, deadline);
        if (generation == null) generation = INITIAL;
        if (!generation.isURI()) throw new IllegalStateException("semantic source generation differs");
        budget.node(generation, deadline);
        check(deadline);
        // Never hash a TDB numeric lexical into an authored key. These are bounded
        // custody identities and a mutation generation; values remain owner bytes.
        String identity = String.join("\0", resource.getURI(), predicate.getURI(), head.getURI(), manifest.getURI(),
            model.getURI(), epoch.getLiteralLexicalForm(), sequence.getLiteralLexicalForm(), generation.getURI(),
            qualified.epoch().getLiteralLexicalForm(), qualified.routing().getLiteralLexicalForm(), qualified.store(), qualified.nonce().getURI());
        try {
            String token = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8)));
            check(deadline);
            return new Proof(resource, predicate, head, manifest, model, epoch, sequence, generation,
                qualified.epoch(), qualified.routing(), qualified.store(), token, scalar != null);
        } catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private static boolean relevant(Quad quad) {
        if (uncertainty(quad)) return true;
        if (!nativeId(quad.getSubject())) return false;
        if (REVISIONS.equals(quad.getGraph())) return ANCHOR_FIELDS.contains(quad.getPredicate());
        return CURRENT.equals(quad.getGraph()) && (RDF.type.asNode().equals(quad.getPredicate())
            || CURRENT_FIELDS.contains(quad.getPredicate()) || quad.getPredicate().isURI() && !quad.getPredicate().getURI().startsWith(RV));
    }
    private static boolean uncertainty(Quad quad) {
        return CONTROL.equals(quad.getGraph()) && PRODUCT.equals(quad.getSubject())
            && (p("dataEpoch").equals(quad.getPredicate()) || p("routingEpoch").equals(quad.getPredicate())
                || p("restoreHold").equals(quad.getPredicate()));
    }
    private static Set<Node> owners(DatasetGraph data, Quad quad, long deadline) {
        if (uncertainty(quad)) return Set.of();
        if (CURRENT.equals(quad.getGraph())) {
            Node subject = quad.getSubject();
            return has(data, CURRENT, subject, RDF.type.asNode(), RESOURCE, deadline)
                || has(data, CURRENT, subject, p("semanticHead"), Node.ANY, deadline) ? Set.of(subject) : Set.of();
        }
        Node component = one(data, REVISIONS, quad.getSubject(), p("component"), new Budget(MAX_PROOF_BYTES), deadline);
        return nativeId(component) && has(data, CURRENT, component, p("semanticHead"), quad.getSubject(), deadline)
            ? Set.of(component) : Set.of();
    }
    /** Receives the existing Journal monitor's actual callbacks. No extra journal
     * or observer engine; net changes are flushed once at the physical commit. */
    static final class Capture {
        private final DatasetGraph data;
        private final Map<Quad, Boolean> before = new LinkedHashMap<>();
        private final Map<Quad, Set<Node>> oldOwners = new LinkedHashMap<>();
        private final Budget bytes = new Budget(MAX_EFFECT_BYTES);
        private boolean finished;
        private long deadline = Long.MAX_VALUE;
        Capture(DatasetGraph data) { this.data = data; }
        void deadline(long value) { deadline = Math.min(deadline, value); check(deadline); }
        void change(TextQuadAction action, Quad quad) {
            if (action != TextQuadAction.ADD && action != TextQuadAction.DELETE
                || !uncertainty(quad) && ((!CURRENT.equals(quad.getGraph()) && !REVISIONS.equals(quad.getGraph()))
                    || !nativeId(quad.getSubject()))) return;
            check(deadline);
            new Budget(MAX_PROOF_BYTES).node(quad.getPredicate(), deadline);
            if (!relevant(quad)) return;
            Budget candidate = new Budget(MAX_EFFECT_BYTES);
            // Validate before any Quad/Node map or set can hash an unbounded value.
            for (Node node : java.util.List.of(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject())) candidate.node(node, deadline);
            if (finished) throw new IllegalStateException("semantic source mutation after final effects");
            if (before.containsKey(quad)) return;
            if (before.size() == MAX_QUADS) throw new IllegalArgumentException("semantic source effects exceed native quad bound");
            if (bytes.bytes + candidate.bytes > bytes.limit) throw new IllegalStateException("semantic source cumulative byte bound exceeded");
            bytes.bytes += candidate.bytes;
            before.put(quad, action == TextQuadAction.DELETE);
            // Journal callbacks follow mutation. Reverse only the exact first
            // quad to recover old ownership; never enumerate reverse owners.
            DatasetGraph previous = new DatasetGraphWrapper(data) {
                @Override public java.util.Iterator<Quad> find(Node g, Node s, Node p, Node o) {
                    var original = super.find(g, s, p, o);
                    if (action == TextQuadAction.ADD) return Iter.filter(original, value -> !value.equals(quad));
                    boolean matches = (g == Node.ANY || g.equals(quad.getGraph())) && (s == Node.ANY || s.equals(quad.getSubject()))
                        && (p == Node.ANY || p.equals(quad.getPredicate())) && (o == Node.ANY || o.equals(quad.getObject()));
                    return matches ? Iter.concat(original, java.util.List.of(quad).iterator()) : original;
                }
                @Override public boolean contains(Node g, Node s, Node p, Node o) {
                    var rows = find(g, s, p, o);
                    try { return rows.hasNext(); } finally { Iter.close(rows); }
                }
            };
            oldOwners.put(quad, owners(previous, quad, deadline));
        }
        void finish(long bound) {
            deadline(bound); writer(data);
            if (finished) return;
            Set<Node> changed = new LinkedHashSet<>();
            boolean uncertain = false;
            for (var entry : before.entrySet()) {
                check(deadline);
                Quad quad = entry.getKey();
                if (entry.getValue() == has(data, quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject(), deadline)) continue;
                uncertain |= uncertainty(quad);
                changed.addAll(oldOwners.get(quad)); changed.addAll(owners(data, quad, deadline));
                CommandWork.count("semantic_source_effect_quads", 1);
                if (changed.size() > MAX_RESOURCES) throw new IllegalArgumentException("semantic source effects exceed 64 Resources");
            }
            // Lineage/restore changes are uncertainty fences, never ordinary
            // commit stamps. Releasing a hold cannot revive an old qualification.
            if (uncertain) invalidate(data);
            for (Node resource : changed) {
                check(deadline);
                state(data, resource, "semanticSourceEffect", uri("urn:rezics:semantic-source:effect:" + UUID.randomUUID()), deadline);
                CommandWork.count("semantic_source_resources_changed", 1);
            }
            check(deadline); finished = true;
        }
    }
    /** Fixed retained-anchor references only. EOF says nothing about occurrence
     * adoption, owner object completeness or accepted scalar absence. This closed
     * maintenance seam requires externally stopped writers throughout the held cut.
     * Its physical snapshot checkpoint is never maintained by ordinary commits. */
    static final class Catalogue {
        static final int MAX_TUPLES = 64, MAX_PROBES = 64, MAX_BYTES = 131_072;
        private static final Node SUBJECT = uri("urn:rezics:projection:retained-anchor-catalogue"),
            FIELD = p("retainedCatalogueCheckpoint"), COMPOSITION = uri("https://rezics.com/definition/structure-composition-v1");
        record Ticket(String attempt, String cursor) {}
        record Reference(Node graph, Node anchor, Node kind, Node structure, Node manifest,
            Node structureRevision, Node generation, Node count, Node coverage, Node unavailableCount,
            Node dataEpoch, Node sequence) {}
        record Page(Ticket next, java.util.List<Reference> references, boolean catalogueEof,
            int namedTuples, int defaultTuples, int probes, int rows, int bytes) {}
        private record Cut(String epoch, String routing, String sequence, String marker, String store) {}
        private static final class Work {
            final Budget bytes = new Budget(MAX_BYTES);
            final long deadline;
            int probes, rows, named, defaults;
            Work(long deadline) { this.deadline = Math.min(deadline, System.nanoTime() + 10_000_000_000L); check(this.deadline); }
            void tuple(boolean alias) {
                check(deadline);
                if (named + defaults + rows == MAX_TUPLES) throw new IllegalStateException("retained catalogue physical tuple bound exceeded");
                if (alias) defaults++; else named++;
                CommandWork.count("semantic_catalogue_prefix_tuples", 1);
            }
            boolean membership(DatasetGraph data, Node graph, Node subject, Node kind) {
                check(deadline);
                if (named + defaults + rows >= MAX_TUPLES || ++probes > MAX_PROBES)
                    throw new IllegalStateException("retained catalogue tuple/probe bound exceeded");
                CommandWork.count("semantic_catalogue_point_probes", 1);
                boolean found = data.contains(graph, subject, RDF.type.asNode(), kind);
                if (found) { rows++; CommandWork.count("semantic_catalogue_point_rows", 1); }
                check(deadline); return found;
            }
            Node scalar(DatasetGraph data, Node graph, Node subject, Node predicate) {
                check(deadline);
                if (++probes > MAX_PROBES) throw new IllegalStateException("retained catalogue point probe bound exceeded");
                CommandWork.count("semantic_catalogue_point_probes", 1);
                var values = data.find(graph, subject, predicate, Node.ANY);
                try {
                    Node value = null;
                    for (int n = 0; n < 2 && values.hasNext(); n++) {
                        if (named + defaults + rows == MAX_TUPLES) throw new IllegalStateException("retained catalogue physical tuple bound exceeded");
                        value = values.next().getObject(); rows++;
                        CommandWork.count("semantic_catalogue_point_rows", 1); check(deadline);
                        bytes.node(value, deadline);
                        if (n == 1) throw new IllegalStateException("retained catalogue field is ambiguous");
                    }
                    return value;
                } finally { Iter.close(values); }
            }
        }
        static String rawInvalidationUpdate() {
            return "DELETE WHERE { GRAPH <" + STATE.getURI() + "> { <" + SUBJECT.getURI()
                + "> <" + FIELD.getURI() + "> ?retainedCheckpoint } }";
        }
        private static Cut cut(DatasetGraph data, Work work) {
            Node epoch = work.scalar(data, CONTROL, PRODUCT, p("dataEpoch")),
                routing = work.scalar(data, CONTROL, PRODUCT, p("routingEpoch")),
                sequence = work.scalar(data, CONTROL, PRODUCT, p("sequence")),
                hold = work.scalar(data, CONTROL, PRODUCT, p("restoreHold")),
                marker = work.scalar(data, CONTROL, PRODUCT, p("restoreCutover"));
            if (!SemanticSourceBasis.string(epoch) || !SemanticSourceBasis.string(routing) || epoch.getLiteralLexicalForm().isEmpty()
                || routing.getLiteralLexicalForm().isEmpty() || !number(sequence, false)
                || !NodeFactory.createLiteralByValue(true, XSDDatatype.XSDboolean).equals(hold)
                || marker == null || !marker.isURI()) throw new IllegalStateException("retained catalogue requires an exact held owner cut");
            return new Cut(epoch.getLiteralLexicalForm(), routing.getLiteralLexicalForm(), sequence.getLiteralLexicalForm(), marker.getURI(), store(data));
        }
        private static boolean number(Node value, boolean count) {
            if (value == null || !value.isLiteral() || !value.getLiteralLanguage().isEmpty()
                || !XSDDatatype.XSDinteger.getURI().equals(value.getLiteralDatatypeURI())) return false;
            String lexical = value.getLiteralLexicalForm();
            return lexical.matches(count ? "(0|[1-9][0-9]{0,6})" : "(0|[1-9][0-9]{0,1023})")
                && (!count || new java.math.BigInteger(lexical).compareTo(java.math.BigInteger.valueOf(1_048_576)) <= 0);
        }
        private static void nativeRef(Node value) {
            if (!nativeId(value)) throw new IllegalStateException("retained catalogue native identity is unavailable");
        }
        private static void manifestRef(Node value) {
            if (value == null || !value.isURI() || !value.getURI().matches("urn:rezics:sha256:[0-9a-f]{64}"))
                throw new IllegalStateException("retained catalogue manifest reference is unavailable");
        }
        private static Reference reference(DatasetGraph data, Node graph, Node anchor, Node kind, Work work) {
            nativeRef(anchor); work.bytes.node(anchor, work.deadline);
            boolean seal = kind.equals(p("StructureSeal"));
            Node structure = work.scalar(data, graph, anchor, p(seal ? "structure" : "component")); nativeRef(structure);
            Node manifest = work.scalar(data, graph, anchor, p("manifest")); manifestRef(manifest);
            Node epoch = work.scalar(data, graph, anchor, p("dataEpoch")), sequence = work.scalar(data, graph, anchor, p("sequence"));
            if (!SemanticSourceBasis.string(epoch) || epoch.getLiteralLexicalForm().isEmpty() || !number(sequence, false)
                || !PRODUCT.equals(work.scalar(data, graph, anchor, p("datasetId")))
                || !COMPOSITION.equals(work.scalar(data, graph, anchor, p("modelRevision")))
                || !COMPOSITION.equals(work.scalar(data, graph, anchor, p("shapeRevision"))))
                throw new IllegalStateException("retained catalogue anchor custody differs");
            Node operation = work.scalar(data, graph, anchor, p(seal ? "sealedBy" : "operation")); nativeRef(operation);
            Node revision = null, generation = null, count = null, coverage = null, unavailable = null;
            if (seal) {
                revision = work.scalar(data, graph, anchor, p("structureRevision")); nativeRef(revision);
                coverage = work.scalar(data, graph, anchor, p("sealCoverage"));
                unavailable = work.scalar(data, graph, anchor, p("unavailableCount"));
                if ((!p("Complete").equals(coverage) && !p("Partial").equals(coverage)) || !number(unavailable, true)
                    || p("Complete").equals(coverage) && !"0".equals(unavailable.getLiteralLexicalForm()))
                    throw new IllegalStateException("retained catalogue seal pins are unavailable");
                // Never repair a split alias using fields from another graph.
                Node linkedType = work.scalar(data, graph, revision, p("component"));
                if (!structure.equals(linkedType)) throw new IllegalStateException("retained catalogue seal revision differs");
                manifestRef(work.scalar(data, graph, revision, p("manifest")));
                if (!work.membership(data, graph, revision, p("StructureRevision")))
                    throw new IllegalStateException("retained catalogue seal revision is unavailable");
            } else {
                generation = work.scalar(data, graph, anchor, p("generation")); nativeRef(generation);
                count = work.scalar(data, graph, anchor, p("placementCount"));
                Node structureOperation = work.scalar(data, graph, anchor, p("structureOperation"));
                if (structureOperation == null || !structureOperation.isURI())
                    throw new IllegalStateException("retained catalogue revision operation is unavailable");
                if (!number(count, true) || !work.membership(data, graph, anchor, p("RevisionAnchor")))
                    throw new IllegalStateException("retained catalogue revision count/type is unavailable");
                Node predecessor = work.scalar(data, graph, anchor, p("predecessor"));
                if (predecessor != null) nativeRef(predecessor);
            }
            check(work.deadline);
            if (work.named + work.defaults + work.rows > MAX_TUPLES || work.probes > MAX_PROBES)
                throw new IllegalStateException("retained catalogue tuple/probe bound exceeded");
            return new Reference(graph, anchor, kind, structure, manifest, revision, generation, count, coverage, unavailable, epoch, sequence);
        }
        private static String string(org.apache.jena.atlas.json.JsonObject object, String key) {
            var value = object.get(key);
            if (value == null || !value.isString()) throw new IllegalStateException("retained catalogue checkpoint field is unavailable");
            return value.getAsString().value();
        }
        private static String value(Node node) { return node == null ? "" : node.isURI() ? node.getURI() : node.getLiteralLexicalForm(); }
        private static Map<String, Object> row(Reference reference) {
            return Map.ofEntries(Map.entry("graph", value(reference.graph())), Map.entry("anchor", value(reference.anchor())),
                Map.entry("kind", value(reference.kind())), Map.entry("structure", value(reference.structure())), Map.entry("manifest", value(reference.manifest())),
                Map.entry("revision", value(reference.structureRevision())), Map.entry("generation", value(reference.generation())), Map.entry("count", value(reference.count())),
                Map.entry("coverage", value(reference.coverage())), Map.entry("unavailable", value(reference.unavailableCount())),
                Map.entry("epoch", value(reference.dataEpoch())), Map.entry("sequence", value(reference.sequence())));
        }
        private static Node iriOrNull(String value) { return value.isEmpty() ? null : uri(value); }
        private static Node integerOrNull(String value) { return value.isEmpty() ? null : NodeFactory.createLiteralDT(value, XSDDatatype.XSDinteger); }
        private static Map<String, Object> page(Page page) {
            return Map.of("references", page.references().stream().map(Catalogue::row).toList(), "named", page.namedTuples(),
                "defaults", page.defaultTuples(), "probes", page.probes(), "rows", page.rows(), "bytes", page.bytes());
        }
        private static Page replay(org.apache.jena.atlas.json.JsonObject state) {
            var saved = state.get("result").getAsObject(); var references = new java.util.ArrayList<Reference>();
            for (var item : saved.get("references").getAsArray()) {
                var row = item.getAsObject();
                references.add(new Reference(uri(string(row,"graph")), uri(string(row,"anchor")), uri(string(row,"kind")), uri(string(row,"structure")),
                    uri(string(row,"manifest")), iriOrNull(string(row,"revision")), iriOrNull(string(row,"generation")), integerOrNull(string(row,"count")),
                    iriOrNull(string(row,"coverage")), integerOrNull(string(row,"unavailable")), text(string(row,"epoch")), integerOrNull(string(row,"sequence"))));
            }
            return new Page(new Ticket(string(state,"attempt"), string(state,"cursor")), java.util.List.copyOf(references),
                state.get("phase").getAsNumber().value().intValue() == 4, saved.get("named").getAsNumber().value().intValue(),
                saved.get("defaults").getAsNumber().value().intValue(), saved.get("probes").getAsNumber().value().intValue(),
                saved.get("rows").getAsNumber().value().intValue(), saved.get("bytes").getAsNumber().value().intValue());
        }
        private static Map<String, Object> checkpoint(Cut cut, long version, Ticket next, String previous, int phase, String after, Page result) {
            Map<String, Object> state = new LinkedHashMap<>();
            state.put("epoch", cut.epoch()); state.put("routing", cut.routing()); state.put("sequence", cut.sequence());
            state.put("marker", cut.marker()); state.put("store", cut.store()); state.put("version", Long.toString(version));
            state.put("attempt", next.attempt()); state.put("cursor", next.cursor()); state.put("previous", previous);
            state.put("phase", phase); state.put("after", after); state.put("result", result == null ? Map.of() : page(result));
            return state;
        }
        private static void persist(DatasetGraph data, Node old, Map<String, Object> state, Work work) {
            // Bound even worst-case JSON escaping BEFORE formatting. This walks
            // only the fixed native checkpoint (one cached reference), never data.
            var pending = new java.util.ArrayDeque<Object>(); pending.add(state);
            long escaped = 4096; int fields = 0; // fixed punctuation/indentation allowance
            while (!pending.isEmpty()) {
                check(work.deadline);
                if (++fields > 256) throw new IllegalStateException("retained catalogue checkpoint shape exceeded");
                Object field = pending.removeFirst();
                if (field instanceof Map<?, ?> map) { pending.addAll(map.keySet()); pending.addAll(map.values()); }
                else if (field instanceof java.util.List<?> list) pending.addAll(list);
                else if (field instanceof String value) escaped += 6L * value.length();
                else if (field instanceof Number) escaped += 32;
                else throw new IllegalStateException("retained catalogue checkpoint field is invalid");
                if (escaped > MAX_TERM_BYTES) throw new IllegalStateException("retained catalogue checkpoint byte bound exceeded");
            }
            String encoded = CommandService.jsonObject(state).toString();
            new Budget(MAX_PROOF_BYTES).part(encoded, work.deadline);
            check(work.deadline);
            if (old != null) data.delete(STATE, SUBJECT, FIELD, old);
            data.add(STATE, SUBJECT, FIELD, text(encoded));
            check(work.deadline);
        }
        private static void cleanup(DatasetGraph data, boolean committed) {
            // TDB cleanup writes through NIO: preserve cancellation safely.
            boolean interrupted = Thread.interrupted();
            try { try { if (!committed) data.abort(); } finally { data.end(); } }
            finally { if (interrupted) Thread.currentThread().interrupt(); }
        }
        static Ticket begin(DatasetGraph data, long deadline) {
            synchronized (data) {
                if (data.isInTransaction()) throw new IllegalStateException("retained catalogue owns its maintenance transaction");
                Work work = new Work(deadline); data.begin(ReadWrite.WRITE); boolean committed = false;
                try {
                    Cut cut = cut(data, work); Node old = work.scalar(data, STATE, SUBJECT, FIELD);
                    Ticket next = new Ticket(UUID.randomUUID().toString(), UUID.randomUUID().toString());
                    long version = storage(data).getTxnSystem().getThreadTransaction().getDataVersion();
                    persist(data, old, checkpoint(cut, Math.addExact(version, 1), next, "", 0, "", null), work);
                    check(work.deadline); CommitHalt.commit(data); committed = true; return next;
                } finally { cleanup(data, committed); }
            }
        }
        static Page turn(DatasetGraph data, Ticket expected, long deadline) {
            synchronized (data) {
                if (data.isInTransaction()) throw new IllegalStateException("retained catalogue owns its maintenance transaction");
                Work work = new Work(deadline);
                if (expected == null || expected.attempt() == null || expected.cursor() == null)
                    throw new IllegalArgumentException("retained catalogue ticket is unavailable");
                work.bytes.part(expected.attempt(), work.deadline); work.bytes.part(expected.cursor(), work.deadline);
                UUID.fromString(expected.attempt()); UUID.fromString(expected.cursor());
                data.begin(ReadWrite.WRITE); boolean committed = false;
                try {
                    Node old = work.scalar(data, STATE, SUBJECT, FIELD);
                    if (!SemanticSourceBasis.string(old)) throw new IllegalStateException("retained catalogue is unqualified");
                    var state = org.apache.jena.atlas.json.JSON.parse(old.getLiteralLexicalForm());
                    long version = storage(data).getTxnSystem().getThreadTransaction().getDataVersion();
                    if (!string(state,"version").equals(Long.toString(version)) || !string(state,"store").equals(store(data))
                        || !expected.attempt().equals(string(state,"attempt"))) throw new IllegalStateException("retained catalogue cut/attempt moved");
                    Cut cut = cut(data, work);
                    if (!cut.epoch().equals(string(state,"epoch")) || !cut.routing().equals(string(state,"routing"))
                        || !cut.sequence().equals(string(state,"sequence")) || !cut.marker().equals(string(state,"marker")))
                        throw new IllegalStateException("retained catalogue held cut moved");
                    int phase = state.get("phase").getAsNumber().value().intValue();
                    if (phase < 0 || phase > 4) throw new IllegalStateException("retained catalogue phase is invalid");
                    if (expected.cursor().equals(string(state,"previous"))
                        || phase == 4 && expected.cursor().equals(string(state,"cursor"))) return replay(state);
                    if (!expected.cursor().equals(string(state,"cursor"))) throw new IllegalStateException("retained catalogue cursor moved");
                    String after = string(state,"after"); var references = new java.util.ArrayList<Reference>();
                    var tdb = storage(data);
                    // One reference reserves room for exact scalar custody probes
                    // within the TOTAL 64-tuple budget, including the checkpoint.
                    while (phase < 4 && references.isEmpty()) {
                        check(work.deadline); boolean alias = phase >= 2;
                        Node graph = alias ? Quad.defaultGraphNodeGenerated : REVISIONS;
                        Node kind = p(phase % 2 == 0 ? "StructureRevision" : "StructureSeal");
                        var index = (org.apache.jena.tdb2.store.tupletable.TupleIndexRecord) TDBInternal.findIndex(tdb, alias ? "POS" : "GPOS").baseTupleIndex();
                        var factory = new org.apache.jena.dboe.base.record.RecordFactory(alias ? 24 : 32, 0);
                        var start = factory.createKeyOnly(); var end = factory.createKeyOnly();
                        Node[] prefix = alias ? new Node[]{RDF.type.asNode(), kind} : new Node[]{REVISIONS, RDF.type.asNode(), kind};
                        boolean missing = false;
                        for (int n = 0; n < prefix.length; n++) {
                            var id = TDBInternal.getNodeId(tdb, prefix[n]);
                            if (org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) { missing = true; break; }
                            org.apache.jena.tdb2.store.NodeIdFactory.set(id, start.getKey(), n * 8);
                            org.apache.jena.tdb2.store.NodeIdFactory.set(id, end.getKey(), n * 8);
                        }
                        if (missing) { phase++; after = ""; continue; }
                        org.apache.jena.tdb2.store.NodeIdFactory.setNext(TDBInternal.getNodeId(tdb, kind), end.getKey(), (prefix.length - 1) * 8);
                        byte[] previous = after.isEmpty() ? null : HexFormat.of().parseHex(after);
                        if (previous != null) {
                            if (previous.length != start.getKey().length || !java.util.Arrays.equals(java.util.Arrays.copyOf(previous, prefix.length * 8),
                                java.util.Arrays.copyOf(start.getKey(), prefix.length * 8))) throw new IllegalStateException("retained catalogue checkpoint prefix differs");
                            System.arraycopy(previous, 0, start.getKey(), 0, previous.length);
                        }
                        var tuples = index.getRangeIndex().iterator(start, end);
                        boolean ended = false;
                        try {
                            while (references.isEmpty()) {
                                check(work.deadline);
                                if (work.named + work.defaults + work.rows >= MAX_TUPLES) break;
                                if (!tuples.hasNext()) { ended = true; break; }
                                var tuple = tuples.next(); work.tuple(alias);
                                if (previous != null && java.util.Arrays.equals(previous, tuple.getKey())) continue;
                                Node anchor = (alias ? tdb.getTripleTable() : tdb.getQuadTable()).getNodeTupleTable().getNodeTable()
                                    .getNodeForNodeId(org.apache.jena.tdb2.store.NodeIdFactory.get(tuple.getKey(), prefix.length * 8));
                                work.bytes.node(anchor, work.deadline);
                                references.add(reference(data, graph, anchor, kind, work));
                                after = HexFormat.of().formatHex(tuple.getKey());
                            }
                        } finally { Iter.close(tuples); }
                        if (ended) { phase++; after = ""; } else break;
                    }
                    Ticket next = new Ticket(expected.attempt(), UUID.randomUUID().toString());
                    Page result = new Page(next, java.util.List.copyOf(references), phase == 4, work.named, work.defaults, work.probes, work.rows, work.bytes.bytes);
                    persist(data, old, checkpoint(cut, Math.addExact(version, 1), next, expected.cursor(), phase, after, result), work);
                    check(work.deadline); CommitHalt.commit(data); committed = true; return result;
                } finally { cleanup(data, committed); }
            }
        }
    }
    private SemanticSourceBasis() {}
}
