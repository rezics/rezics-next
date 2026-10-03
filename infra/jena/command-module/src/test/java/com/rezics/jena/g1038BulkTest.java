package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.junit.Test;

public class g1038BulkTest {
    private static Node uri(String name) { return NodeFactory.createURI(name); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), PRODUCT = uri("urn:rezics:dataset:product");
    private static class Counted extends DatasetGraphWrapper {
        int commits = 0, unboundedSequenceReads = 0;
        Counted(DatasetGraph data) { super(data); }
        @Override public void commit() { commits++; super.commit(); }
        @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(Node g, Node s, Node p, Node o) {
            if (uri(CommandPolicy.OUTBOX).equals(g) && Node.ANY.equals(s) && rv("sequence").equals(p) && Node.ANY.equals(o)) unboundedSequenceReads++;
            return super.find(g, s, p, o);
        }
    }
    private static Counted dataset() {
        var data = new Counted(DatasetGraphFactory.createTxnMem());
        data.begin(ReadWrite.WRITE);
        data.add(CONTROL, PRODUCT, rv("dataEpoch"), NodeFactory.createLiteralString("test"));
        data.add(CONTROL, PRODUCT, rv("routingEpoch"), NodeFactory.createLiteralString("0"));
        data.add(CONTROL, PRODUCT, rv("sequence"), NodeFactory.createLiteralByValue(0, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        // Unrelated outbox history must not enter validation's seek.
        for (int i = 1000; i < 2000; i++) data.add(uri(CommandPolicy.OUTBOX), uri("urn:rezics:old:" + i), rv("sequence"),
            NodeFactory.createLiteralByValue(i, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        data.commit(); data.end(); data.commits = 0;
        return data;
    }
    private static String update(String receipt, String extra, String guard, boolean cancel) {
        return """
            PREFIX rv: <https://rezics.com/vocab/>
            DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?n } }
            INSERT {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
              GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt ; rv:requestDigest "digest" ;
                rv:outcome rv:%s ; rv:commandFamily "work-catalogue-import-v1" ; rv:datasetId <urn:rezics:dataset:product> ;
                rv:dataEpoch "test" ; rv:sequence ?next . }
              GRAPH <urn:rezics:graph:outbox> { <%s:batch> a rv:OutboxBatch ; rv:dataEpoch "test" ; rv:sequence ?next ; rv:eventCount 0 . }
              %s
            } WHERE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "test" ; rv:routingEpoch "0" ; rv:sequence ?n }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <%s> ?p ?o } }
              BIND(?n + 1 AS ?next) %s
            }
            """.formatted(receipt, cancel ? "Cancelled" : "Succeeded", receipt, extra, receipt, guard);
    }
    private static CommandService.BulkItem item(int index, String extra, String guard) {
        String receipt = "urn:rezics:receipt:bulk-test:" + index;
        String success = update(receipt, extra, guard, false), cancel = update(receipt, "", "", true);
        return new CommandService.BulkItem(receipt, "digest", success, CommandPolicy.parse(success, receipt), List.of(),
            cancel, CommandPolicy.parse(cancel, receipt));
    }
    @Test public void partialValidationAndStaleItemsShareOneDurableCommitAndReplayWithoutOne() {
        var data = dataset();
        var service = new CommandService(ProfileRegistry.load(java.nio.file.Files.exists(Path.of("/profiles")) ? Path.of("/profiles") : Path.of("profiles")),
            "1".repeat(64).getBytes(), "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
        var commands = List.of(item(1, "", ""), item(2,
            "GRAPH <urn:rezics:graph:current> { <https://rezics.com/id/00000000-0000-0000-0000-000000000002> a rv:Unknown }", ""),
            item(3, "", "FILTER(false)"), item(4, "", ""));
        try (var work = new CommandWork()) {
            var result = service.runBulk(data, commands, System.nanoTime() + 10_000_000_000L);
            assertEquals(1, data.commits);
            assertTrue(work.counters().contains("durable_commits=1"));
            @SuppressWarnings("unchecked") var items = (List<Map<String, Object>>) result.get("items");
            assertEquals(List.of("committed", "invalid", "guard-unmatched", "committed"), items.stream().map(row -> row.get("status")).toList());
        }
        data.begin(ReadWrite.READ);
        assertFalse(data.contains(uri(CommandPolicy.CURRENT), Node.ANY, Node.ANY, Node.ANY));
        assertTrue(data.contains(CONTROL, PRODUCT, rv("sequence"), NodeFactory.createLiteralByValue(4, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger)));
        assertTrue(data.contains(uri(CommandPolicy.RECEIPTS), uri(commands.get(1).receipt()), rv("outcome"), rv("Cancelled")));
        data.end();
        assertEquals(0, data.unboundedSequenceReads);
        try (var work = new CommandWork()) {
            service.runBulk(data, commands, System.nanoTime() + 10_000_000_000L);
            assertEquals(1, data.commits);
            assertTrue(work.counters().contains("durable_commits=0"));
        }
        data.close();
    }
    @Test public void overlayQueriesSeeStagedChangesButParentAndAbortedItemDoNot() {
        var data = dataset(); data.begin(ReadWrite.WRITE);
        var staged = new CommandOverlay(data);
        Node graph = uri(CommandPolicy.CURRENT), subject = uri("urn:rezics:test:subject"), value = NodeFactory.createLiteralString("value");
        staged.add(graph, subject, rv("value"), value);
        assertTrue(staged.contains(graph, subject, rv("value"), value));
        assertFalse(data.contains(graph, subject, rv("value"), value));
        assertTrue(org.apache.jena.query.QueryExecutionFactory.create("ASK { GRAPH <urn:rezics:graph:current> { <urn:rezics:test:subject> <https://rezics.com/vocab/value> \"value\" } }",
            org.apache.jena.query.DatasetFactory.wrap(staged)).execAsk());
        staged.delete(graph, subject, rv("value"), value);
        assertFalse(staged.changed());
        data.abort(); data.end(); data.close();
    }
}
