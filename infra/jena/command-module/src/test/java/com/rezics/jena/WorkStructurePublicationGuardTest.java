package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class WorkStructurePublicationGuardTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String WORK = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    private static final String MAIN = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    private static final String STRUCTURE = "https://rezics.com/id/00000000-0000-4000-8000-000000000003";
    private static final String REVISION = "https://rezics.com/id/00000000-0000-4000-8000-000000000004";
    private static final String GENERATION = "https://rezics.com/id/00000000-0000-4000-8000-000000000005";
    private static final String DECISION = "https://rezics.com/id/00000000-0000-4000-8000-000000000006";
    private static final String SOURCE = "urn:rezics:work-source:guard-test";
    private static final String RECEIPT = "urn:rezics:receipt:work-publication-head-test";
    private static final String ADMISSION = "00000000-0000-4000-8000-000000000007";
    private static final String ROOT = "urn:rezics:sha256:" + "a".repeat(64);

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static String nt(String value) { return "<" + value + ">"; }
    private static int count(DatasetGraph data, Node graph, Node subject, Node predicate) {
        int count = 0;
        var rows = data.find(graph, subject, predicate, Node.ANY);
        while (rows.hasNext()) { rows.next(); count++; }
        return count;
    }

    private static DatasetGraph publication() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS);
        Node work = uri(WORK), main = uri(MAIN), structure = uri(STRUCTURE), revision = uri(REVISION);
        Node generation = uri(GENERATION), decision = uri(DECISION), source = uri(SOURCE), root = uri(ROOT);
        data.add(current, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
        data.add(current, work, p("mainVersion"), main);
        data.add(current, main, RDF.type.asNode(), p("MainVersion"));
        data.add(current, main, p("work"), work);
        data.add(current, work, p("workStructurePublicationHead"), decision);
        data.add(current, structure, RDF.type.asNode(), p("Structure"));
        data.add(current, structure, p("structureOf"), main);
        data.add(current, structure, p("structureProfile"), p("RecipeComposition"));
        data.add(current, generation, RDF.type.asNode(), p("StructureGeneration"));
        data.add(current, generation, p("structure"), structure);
        data.add(revisions, decision, RDF.type.asNode(), p("WorkStructurePublicationDecision"));
        data.add(revisions, decision, RDF.type.asNode(), p("RevisionAnchor"));
        data.add(revisions, decision, p("component"), work);
        data.add(revisions, decision, p("publicationOutcome"), p("Published"));
        data.add(revisions, decision, p("publicSource"), source);
        data.add(revisions, decision, p("disclosure"), p("Public"));
        data.add(revisions, decision, p("rightsBasis"), p("OriginalContribution"));
        data.add(revisions, source, RDF.type.asNode(), p("WorkStructurePublicSource"));
        data.add(revisions, source, p("work"), work);
        data.add(revisions, source, p("component"), main);
        data.add(revisions, source, p("structureProfile"), p("RecipeComposition"));
        data.add(revisions, source, p("structure"), structure);
        data.add(revisions, source, p("structureRevision"), revision);
        data.add(revisions, source, p("selectedGeneration"), generation);
        data.add(revisions, source, p("sourceRoot"), root);
        data.add(revisions, revision, RDF.type.asNode(), p("StructureRevision"));
        data.add(revisions, revision, p("component"), structure);
        data.add(revisions, revision, p("generation"), generation);
        data.add(revisions, revision, p("manifest"), root);
        return data;
    }

    @Test public void nativeSourceGuardPinsCurrentWorkMainStructureAndUnerasedManifest() {
        DatasetGraph data = publication();
        data.begin(ReadWrite.READ);
        try {
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(DECISION), RDF.type.asNode(),
                p("WorkStructurePublicationDecision")));
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(DECISION), RDF.type.asNode(),
                p("RevisionAnchor")));
            assertTrue(data.contains(uri(CommandPolicy.REVISIONS), uri(DECISION), p("component"), uri(WORK)));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), RDF.type.asNode(),
                uri("https://schema.org/CreativeWork")));
            assertTrue(data.contains(uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead"),
                uri(DECISION)));
            assertEquals(1, count(data, uri(CommandPolicy.REVISIONS), uri(DECISION), p("component")));
            assertEquals(1, count(data, uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead")));
            assertNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
        } finally { data.end(); data.close(); }

        data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            data.delete(uri(CommandPolicy.REVISIONS), uri(SOURCE), p("work"), uri(WORK));
            data.add(uri(CommandPolicy.REVISIONS), uri(SOURCE), p("work"), uri(MAIN));
            assertEquals("Work structure publication source is missing or has the wrong owner: " + DECISION,
                CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
        } finally { data.abort(); data.end(); data.close(); }

        data = publication();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(uri(CommandPolicy.REVISIONS), uri(REVISION), RDF.type.asNode(), p("ErasedRevision"));
            assertNotNull(CommandService.workStructurePublicationDecisionLinks(data, null, DECISION));
        } finally { data.abort(); data.end(); data.close(); }
    }

    private static String update(String prior, String expected) {
        String priorTemplate = "?prior";
        return "PREFIX rv: <" + RV + "> DELETE { GRAPH " + nt(CommandPolicy.CURRENT) + " { " + nt(WORK)
            + " rv:workStructurePublicationHead " + priorTemplate + " } } INSERT { GRAPH "
            + nt(CommandPolicy.CURRENT) + " { " + nt(WORK) + " rv:workStructurePublicationHead " + nt(DECISION)
            + " } GRAPH " + nt(CommandPolicy.REVISIONS) + " { " + nt(DECISION)
            + " a rv:WorkStructurePublicationDecision, rv:RevisionAnchor ; rv:component " + nt(WORK)
            + " ; rv:publicationOutcome rv:Published"
            + (prior == null ? "" : " ; rv:predecessor " + nt(prior)) + " } GRAPH "
            + nt(CommandPolicy.RECEIPTS) + " { " + nt(RECEIPT)
            + " a rv:OperationReceipt ; rv:outcome rv:Succeeded ; rv:admissionId \"" + ADMISSION
            + "\" ; rv:authorityEpoch \"0\" ; rv:admittedScope \"work:publish:" + WORK
            + "\" ; rv:action \"work.publish\" ; rv:commandFamily \"work-structure-publication-v1\""
            + " ; rv:work " + nt(WORK) + " ; rv:publicationDecision " + nt(DECISION)
            + (expected == null ? "" : " ; rv:expectedHead " + nt(expected)) + " } } WHERE { GRAPH "
            + nt(CommandPolicy.CURRENT) + " { " + nt(WORK) + " a <https://schema.org/CreativeWork> . OPTIONAL { "
            + nt(WORK) + " rv:workStructurePublicationHead ?prior } } }";
    }

    @Test public void publicationHeadCasRejectsAConcurrentOrUnexpectedPredecessor() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(uri(CommandPolicy.CURRENT), uri(WORK), RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
            var plan = CommandPolicy.parse(update(null, null), RECEIPT);
            var snapshot = HeadCasPolicy.capture(data, plan, RECEIPT);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
            assertNull(HeadCasPolicy.check(data, RECEIPT, snapshot));
        } finally { data.abort(); data.end(); data.close(); }

        data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            Node prior = uri("https://rezics.com/id/00000000-0000-4000-8000-000000000008");
            data.add(uri(CommandPolicy.CURRENT), uri(WORK), RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
            data.add(uri(CommandPolicy.CURRENT), uri(WORK), p("workStructurePublicationHead"), prior);
            var plan = CommandPolicy.parse(update(prior.getURI(), null), RECEIPT);
            assertEquals("receipt expected head differs from transaction prestate",
                HeadCasPolicy.capture(data, plan, RECEIPT).error());
        } finally { data.abort(); data.end(); data.close(); }
    }
}
