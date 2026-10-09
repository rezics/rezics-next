package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** A composition change validates the nodes it edits. Focus and current-graph
 * reads stay the same at 100 and 1,000 chapters. */
public class CompositionChangeFocusTest {
    private static final String RV = "https://rezics.com/vocab/", SCHEMA = "https://schema.org/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        CONTROL = uri(CommandPolicy.CONTROL), PRODUCT = uri("urn:rezics:dataset:product"),
        STRUCTURE = id(1), GENERATION = id(2), HEAD = id(4);
    private static final Node LIST = uri("urn:rezics:item-list:" + StatementUpgradePolicy.templateDigest(
        GENERATION.getURI() + "\0" + STRUCTURE.getURI()));
    private static final ProfileRegistry PROFILES = ProfileRegistry.load(Files.isRegularFile(Path.of("profiles/manifest.json"))
        ? Path.of("profiles") : Path.of("../../../generated/model"));
    private static final String DIGEST = "a".repeat(64);
    private static final String EPOCH = "11111111-1111-4111-8111-111111111111";

    @Test public void sixteenInsertsReadTheSameFocusAtEveryScale() {
        Measurement small = measure(10), mid = measure(100), large = measure(1000);
        System.out.println("composition-change-focus " + small + " " + mid + " " + large);
        assertEquals("committed", small.status);
        assertEquals("committed", mid.status);
        assertEquals("committed", large.status);
        assertEquals(mid.focuses, large.focuses);
        assertEquals(mid.focuses, small.focuses);
        assertTrue("focus grew with the structure: " + large.focuses, large.focuses < 250);
        assertEquals(mid.currentQuads, large.currentQuads);
        assertEquals(0, mid.segmentScans);
        assertEquals(0, large.segmentScans);
    }

    /** Same shapes as a full inbound scan. A violation on an edited node is refused.
     * A violation already sitting on an unedited neighbour is not this change's
     * responsibility: the old segment scan would have refused it, and this change commits.
     * Depth is not a shape. The counted placement total is. */
    @Test public void editedViolationsAreRefusedAndUneditedNeighboursAreNotAdopted() {
        assertEquals("invalid", change(opts(32).orderKey("BAD")).status);
        assertEquals("invalid", change(opts(32).memberCount(513)).status);
        assertEquals("invalid", change(opts(32).placementCount(1_048_577)).status);
        Outcome orphan = change(opts(32).listEdge(false));
        assertEquals("invalid", orphan.status);
        assertTrue(String.valueOf(orphan.report), String.valueOf(orphan.report).contains("ItemList membership"));
        assertEquals("guard-unmatched", change(opts(32).head(id(99))).status);
        // Order-key uniqueness and role/depth limits are the composition command's
        // checks. These shapes accept a duplicate key. A parent that does not own
        // the placement's item list is refused by the edited placement's membership
        // check, which reads that parent and list only.
        assertEquals("committed", change(opts(32).orderKey("1")).status);
        Outcome wrongParent = planted(32, data -> {
            Node segment = lastSegment(32);
            data.delete(CURRENT, segment, p("parent"), STRUCTURE);
            data.add(CURRENT, segment, p("parent"), id(100000));
        });
        assertEquals(String.valueOf(wrongParent.report), "invalid", wrongParent.status);
        assertTrue(String.valueOf(wrongParent.report), String.valueOf(wrongParent.report).contains("ItemList membership"));
        wrongParent.data.close();
        Outcome preexisting = planted(32, data -> data.add(CURRENT, id(10000), p("orderKey"), text("BAD")));
        assertEquals("committed", preexisting.status);
        preexisting.data.begin(ReadWrite.READ);
        try {
            Map<String, Object> full = CanonicalPolicy.validate(PROFILES, preexisting.data, id(10000).getURI(), false);
            assertNotNull(full);
            assertEquals("invalid", full.get("status"));
        } finally { preexisting.data.end(); preexisting.data.close(); }
    }

    private static Measurement measure(int population) {
        Outcome outcome = change(opts(population));
        outcome.data.close();
        return new Measurement(population, outcome.status, outcome.focuses, outcome.currentQuads,
            outcome.segmentScans, outcome.validationMs, outcome.updateMs);
    }

    private static Outcome planted(int population, java.util.function.Consumer<DatasetGraph> plant) {
        DatasetGraph raw = fixture(population);
        drain(raw);
        raw.begin(ReadWrite.WRITE);
        try { plant.accept(raw); raw.commit(); }
        finally { raw.end(); }
        return execute(raw, opts(population));
    }

    private static Outcome change(Options options) {
        DatasetGraph raw = fixture(options.population);
        try { drain(raw); return execute(raw, options); }
        finally { raw.close(); }
    }

    private static Outcome execute(DatasetGraph raw, Options options) {
        Counting counted = new Counting(raw, lastSegment(options.population));
        Map<String, Object> result;
        String counters, timing;
        try (CommandWork work = new CommandWork()) {
            result = command(counted, options);
            counters = work.counters();
            timing = work.serverTiming();
        }
        return new Outcome(raw, String.valueOf(result.get("status")), result.get("report"),
            counter(counters, "validation_focuses"), counted.currentQuads, counted.segmentScans,
            phase(timing, "validation"), phase(timing, "update"));
    }

    private static Map<String, Object> command(DatasetGraph data, Options options) {
        int population = options.population;
        Node segment = lastSegment(population);
        int beforeCount = lastSegmentCount(population);
        String segmentKey = Integer.toString((population - 1) / 32 + 1, 36);
        int nextCount = options.memberCount == null ? beforeCount + 16 : options.memberCount;
        int nextPlacements = options.placementCount == null ? population + 16 : options.placementCount;
        Node head = options.head == null ? HEAD : options.head;
        StringBuilder inserts = new StringBuilder();
        List<CommandService.Validation> checks = new ArrayList<>();
        checks.add(shape("structure", STRUCTURE));
        checks.add(shape("generation", GENERATION));
        checks.add(shape("item-list", LIST));
        checks.add(shape("segment", segment));
        Node nextHead = id(80_000 + population);
        checks.add(shape("revision", nextHead));
        for (int i = 0; i < 16; i++) {
            Node placement = id(90_000 + i), occurrence = id(400_000 + i);
            String orderKey = options.orderKey == null ? Integer.toString(40 + i, 36) : options.orderKey;
            inserts.append('<').append(placement.getURI()).append("> a rv:OccurrencePlacement, schema:ListItem ; rv:generation <")
                .append(GENERATION.getURI()).append("> ; rv:occurrence <").append(occurrence.getURI())
                .append("> ; rv:occurrenceRole rv:ChapterRole ; rv:orderSegment <").append(segment.getURI())
                .append("> ; rv:orderKey \"").append(orderKey)
                .append("\" ; schema:item <").append(id(200_000).getURI())
                .append("> ; schema:position \"").append(segmentKey).append('-').append(orderKey).append("\" . ");
            inserts.append('<').append(occurrence.getURI()).append("> a schema:ListItem ; rv:structure <")
                .append(STRUCTURE.getURI()).append("> ; rv:introducedBy <").append(nextHead.getURI()).append("> . ");
            if (options.listEdge) inserts.append('<').append(LIST.getURI()).append("> schema:itemListElement <")
                .append(placement.getURI()).append("> . ");
            checks.add(shape("placement", placement));
            checks.add(shape("occurrence", occurrence));
        }
        inserts.append('<').append(STRUCTURE.getURI()).append("> rv:structureHead <").append(nextHead.getURI()).append("> . ");
        inserts.append('<').append(GENERATION.getURI()).append("> rv:placementCount ").append(nextPlacements).append(" . ");
        inserts.append('<').append(segment.getURI()).append("> rv:memberCount ").append(nextCount).append(" . ");
        String revision = """
            <%s> a rv:StructureRevision, rv:RevisionAnchor ; rv:component <%s> ; rv:predecessor <%s> ;
              rv:operation <%s> ; rv:structureOperation rv:OccurrenceInsert ; rv:generation <%s> ;
              rv:manifest <urn:rezics:sha256:%s> ; rv:placementCount %d ;
              rv:modelRevision <https://rezics.com/definition/structure-composition-v1> ;
              rv:shapeRevision <https://rezics.com/definition/structure-composition-v1> ;
              rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "%s" ; rv:sequence ?next .
            """.formatted(nextHead.getURI(), STRUCTURE.getURI(), HEAD.getURI(), id(7).getURI(),
            GENERATION.getURI(), "c".repeat(64), nextPlacements, EPOCH);
        String deletes = """
            <%s> rv:structureHead <%s> . <%s> rv:placementCount %d . <%s> rv:memberCount %d .
            """.formatted(STRUCTURE.getURI(), HEAD.getURI(), GENERATION.getURI(), population, segment.getURI(), beforeCount);
        String receipt = "urn:rezics:receipt:composition-focus:" + UUID.randomUUID();
        String update = """
            PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
            DELETE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?n }
              GRAPH <urn:rezics:graph:current> { %s }
            }
            INSERT {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
              GRAPH <urn:rezics:graph:current> { %s }
              GRAPH <urn:rezics:graph:revisions> { %s }
              GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
                rv:requestDigest "%s" ; rv:action "composition.change" ; rv:datasetId <urn:rezics:dataset:product> ;
                rv:dataEpoch "epoch" ; rv:sequence ?next ; rv:expectedHead <%s> ;
                rv:operation <%s> ; rv:structure <%s> ; rv:structureRevision <%s> . }
              GRAPH <urn:rezics:graph:outbox> { <%s:batch> a rv:OutboxBatch ; rv:dataEpoch "epoch" ; rv:sequence ?next ;
                rv:eventCount 1 ; rv:event <%s:event> . <%s:event> a rv:StructureCommandEvent ; rv:ordinal 0 ;
                rv:action "composition.change" ; rv:receipt <%s> . }
            } WHERE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "epoch" ; rv:routingEpoch "routing" ; rv:sequence ?n }
              GRAPH <urn:rezics:graph:current> { <%s> rv:structureHead <%s> ; rv:selectedGeneration <%s> . <%s> rv:placementCount %d . }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <%s> ?p ?o } }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:revisions> { <%s> ?rp ?ro } }
              BIND(?n + 1 AS ?next)
            }
            """.formatted(deletes, inserts, revision, receipt, DIGEST, HEAD.getURI(), id(7).getURI(),
            STRUCTURE.getURI(), nextHead.getURI(), receipt, receipt, receipt, receipt,
            STRUCTURE.getURI(), head.getURI(), GENERATION.getURI(), GENERATION.getURI(), population, receipt, nextHead.getURI());
        return new CommandService(PROFILES, "1".repeat(64).getBytes(), "2".repeat(64).getBytes(), "3".repeat(64).getBytes())
            .runCommand(data, receipt, DIGEST, update, checks, System.nanoTime() + 60_000_000_000L);
    }

    private static CommandService.Validation shape(String name, Node focus) {
        return new CommandService.Validation("structure-composition-v1", PROFILES.get("structure-composition-v1"),
            "https://rezics.com/definition/structure-composition-v1/" + name + "-shape",
            List.of(focus.getURI()), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of());
    }

    private static DatasetGraph fixture(int population) {
        DatasetGraph data = TDB2Factory.createDataset().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(CONTROL, PRODUCT, p("dataEpoch"), text("epoch"));
            data.add(CONTROL, PRODUCT, p("routingEpoch"), text("routing"));
            data.add(CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(7, XSDDatatype.XSDinteger));
            data.add(CURRENT, STRUCTURE, RDF.type.asNode(), p("Structure"));
            data.add(CURRENT, STRUCTURE, p("structureOf"), id(9));
            data.add(CURRENT, STRUCTURE, p("structureProfile"), p("BookComposition"));
            data.add(CURRENT, STRUCTURE, p("structureHead"), HEAD);
            data.add(CURRENT, STRUCTURE, p("selectedGeneration"), GENERATION);
            data.add(CURRENT, GENERATION, RDF.type.asNode(), p("StructureGeneration"));
            data.add(CURRENT, GENERATION, p("structure"), STRUCTURE);
            data.add(CURRENT, GENERATION, p("generationState"), p("Active"));
            data.add(CURRENT, GENERATION, p("stagedBy"), id(8));
            data.add(CURRENT, GENERATION, p("placementCount"), NodeFactory.createLiteralByValue(population, XSDDatatype.XSDinteger));
            int segments = (population + 31) / 32;
            for (int segmentIndex = 0; segmentIndex < segments; segmentIndex++) {
                int count = Math.min(32, population - segmentIndex * 32);
                Node segment = id(3000 + segmentIndex);
                data.add(CURRENT, segment, RDF.type.asNode(), p("OrderSegment"));
                data.add(CURRENT, segment, p("generation"), GENERATION);
                data.add(CURRENT, segment, p("parent"), STRUCTURE);
                data.add(CURRENT, segment, p("segmentKey"), text(Integer.toString(segmentIndex + 1, 36)));
                data.add(CURRENT, segment, p("memberCount"), NodeFactory.createLiteralByValue(count, XSDDatatype.XSDinteger));
            }
            data.add(REVISIONS, HEAD, RDF.type.asNode(), p("StructureRevision"));
            data.add(REVISIONS, HEAD, RDF.type.asNode(), p("RevisionAnchor"));
            data.add(REVISIONS, HEAD, p("component"), STRUCTURE);
            data.add(REVISIONS, HEAD, p("operation"), id(6));
            data.add(REVISIONS, HEAD, p("structureOperation"), p("StructureCreate"));
            data.add(REVISIONS, HEAD, p("generation"), GENERATION);
            data.add(REVISIONS, HEAD, p("manifest"), uri("urn:rezics:sha256:" + "b".repeat(64)));
            data.add(REVISIONS, HEAD, p("placementCount"), NodeFactory.createLiteralByValue(population, XSDDatatype.XSDinteger));
            data.add(REVISIONS, HEAD, p("modelRevision"), uri("https://rezics.com/definition/structure-composition-v1"));
            data.add(REVISIONS, HEAD, p("shapeRevision"), uri("https://rezics.com/definition/structure-composition-v1"));
            data.add(REVISIONS, HEAD, p("datasetId"), PRODUCT);
            data.add(REVISIONS, HEAD, p("dataEpoch"), text(EPOCH));
            data.add(REVISIONS, HEAD, p("sequence"), NodeFactory.createLiteralByValue(7, XSDDatatype.XSDinteger));
            for (int i = 0; i < population; i++) {
                Node placement = id(10_000 + i), occurrence = id(100_000 + i), target = id(200_000 + i);
                Node segment = id(3000 + i / 32);
                String segmentKey = Integer.toString(i / 32 + 1, 36);
                String orderKey = Integer.toString(i % 32 + 1, 36);
                data.add(CURRENT, occurrence, RDF.type.asNode(), s("ListItem"));
                data.add(CURRENT, occurrence, p("structure"), STRUCTURE);
                data.add(CURRENT, occurrence, p("introducedBy"), HEAD);
                data.add(CURRENT, placement, RDF.type.asNode(), p("OccurrencePlacement"));
                data.add(CURRENT, placement, RDF.type.asNode(), s("ListItem"));
                data.add(CURRENT, placement, p("generation"), GENERATION);
                data.add(CURRENT, placement, p("occurrence"), occurrence);
                data.add(CURRENT, placement, p("occurrenceRole"), p("ChapterRole"));
                data.add(CURRENT, placement, p("orderSegment"), segment);
                data.add(CURRENT, placement, p("orderKey"), text(orderKey));
                data.add(CURRENT, placement, s("item"), target);
                data.add(CURRENT, placement, s("position"), text(segmentKey + "-" + orderKey));
                data.add(CURRENT, LIST, RDF.type.asNode(), s("ItemList"));
                data.add(CURRENT, LIST, p("generation"), GENERATION);
                data.add(CURRENT, LIST, p("parent"), STRUCTURE);
                data.add(CURRENT, LIST, s("itemListElement"), placement);
            }
            data.commit();
        } finally { data.end(); }
        return data;
    }

    private static void drain(DatasetGraph data) {
        for (int turn = 0; turn < 80; turn++) {
            JsonObject request = new JsonObject();
            request.put("operation", "membership-prepare");
            request.put("dataEpoch", "epoch");
            request.put("routingEpoch", "routing");
            request.put("requestId", UUID.randomUUID().toString());
            request.put("deadline", System.currentTimeMillis() + 60_000);
            Map<String, Object> result = TemplateIndexService.membershipPrepare(data, request, PROFILES);
            if (!"committed".equals(result.get("status"))) throw new IllegalStateException(String.valueOf(result));
            if (Boolean.TRUE.equals(result.get("complete"))) return;
        }
        throw new IllegalStateException("membership preparation did not finish");
    }

    private static int lastSegmentCount(int population) {
        int remainder = population % 32;
        return remainder == 0 ? 32 : remainder;
    }
    private static Node lastSegment(int population) { return id(3000 + (population - 1) / 32); }
    private static long counter(String counters, String name) {
        var match = java.util.regex.Pattern.compile("(?:^|,)" + name + "=(\\d+)(?:,|$)").matcher(counters);
        if (!match.find()) throw new AssertionError(counters);
        return Long.parseLong(match.group(1));
    }
    private static double phase(String timing, String name) {
        var match = java.util.regex.Pattern.compile("(?:^|,)\\s*" + name + ";dur=(\\d+(?:\\.\\d+)?)").matcher(timing);
        return match.find() ? Double.parseDouble(match.group(1)) : 0;
    }
    private static Options opts(int population) { return new Options(population); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static Node s(String value) { return uri(SCHEMA + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node id(int value) { return uri("https://rezics.com/id/00000000-0000-4000-8000-%012d".formatted(value)); }

    private static final class Options {
        final int population;
        String orderKey;
        boolean listEdge = true;
        Integer memberCount, placementCount;
        Node head;
        Options(int population) { this.population = population; }
        Options orderKey(String value) { orderKey = value; return this; }
        Options listEdge(boolean value) { listEdge = value; return this; }
        Options memberCount(int value) { memberCount = value; return this; }
        Options placementCount(int value) { placementCount = value; return this; }
        Options head(Node value) { head = value; return this; }
    }
    private record Measurement(int population, String status, long focuses, long currentQuads, long segmentScans,
                               double validationMs, double updateMs) {
        @Override public String toString() {
            return "n=" + population + " status=" + status + " focuses=" + focuses + " quads=" + currentQuads
                + " segmentScans=" + segmentScans + " validationMs=" + validationMs + " updateMs=" + updateMs;
        }
    }
    private static final class Outcome {
        final DatasetGraph data;
        final String status;
        final Object report;
        final long focuses, currentQuads, segmentScans;
        final double validationMs, updateMs;
        Outcome(DatasetGraph data, String status, Object report, long focuses, long currentQuads, long segmentScans,
                double validationMs, double updateMs) {
            this.data = data; this.status = status; this.report = report; this.focuses = focuses;
            this.currentQuads = currentQuads; this.segmentScans = segmentScans;
            this.validationMs = validationMs; this.updateMs = updateMs;
        }
    }
    private static final class Counting extends DatasetGraphWrapper {
        final Node segment;
        long currentQuads, segmentScans;
        Counting(DatasetGraph data, Node segment) { super(data); this.segment = segment; }
        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            boolean scan = subject == null || subject.equals(Node.ANY) || subject.isVariable();
            if (CURRENT.equals(graph) && scan && segment.equals(object)) segmentScans++;
            Iterator<Quad> rows = super.find(graph, subject, predicate, object);
            return new org.apache.jena.util.iterator.NiceIterator<>() {
                @Override public boolean hasNext() { return rows.hasNext(); }
                @Override public Quad next() {
                    Quad quad = rows.next();
                    if (CURRENT.equals(quad.getGraph())) currentQuads++;
                    return quad;
                }
                @Override public void close() { Iter.close(rows); }
            };
        }
        @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
            Iterator<Quad> rows = find(graph, subject, predicate, object);
            try { return rows.hasNext(); } finally { Iter.close(rows); }
        }
        @Override public boolean contains(Quad quad) { return contains(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject()); }
        @Override public Iterator<Quad> find(Quad quad) { return find(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject()); }
        @Override public Iterator<Quad> findNG(Node graph, Node subject, Node predicate, Node object) {
            return Iter.filter(find(graph, subject, predicate, object), quad -> !quad.isDefaultGraph());
        }
        @Override public org.apache.jena.graph.Graph getGraph(Node graph) { return org.apache.jena.sparql.core.GraphView.createNamedGraph(this, graph); }
        @Override public org.apache.jena.graph.Graph getDefaultGraph() { return org.apache.jena.sparql.core.GraphView.createDefaultGraph(this); }
        @Override public org.apache.jena.graph.Graph getUnionGraph() { return org.apache.jena.sparql.core.GraphView.createUnionGraph(this); }
    }
}
