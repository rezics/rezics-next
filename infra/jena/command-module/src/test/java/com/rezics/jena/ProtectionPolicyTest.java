package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.junit.Test;
import org.apache.jena.vocabulary.RDF;

public class ProtectionPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String WORK = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    private static final String PROTECTION = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    private static final String RECEIPT = "urn:rezics:receipt:protection-test";

    private static String iri(String value) { return "<" + value + ">"; }
    private static String edit(String action) {
        return "PREFIX rv: <" + RV + "> DELETE { GRAPH " + iri(CommandPolicy.CURRENT) + " { "
            + iri(WORK) + " <http://www.w3.org/2000/01/rdf-schema#label> ?old } } "
            + "INSERT { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK)
            + " <http://www.w3.org/2000/01/rdf-schema#label> \"changed\"@en } "
            + "GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
            + " rv:outcome rv:Succeeded ; rv:action \"" + action + "\" } } "
            + "WHERE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK)
            + " <http://www.w3.org/2000/01/rdf-schema#label> ?old } }";
    }
    private static ProtectionPolicy.Snapshot capture(String mode, String action) {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                NodeFactory.createURI(RV + "protectionHead"), NodeFactory.createURI(PROTECTION));
            data.add(NodeFactory.createURI(CommandPolicy.REVISIONS), NodeFactory.createURI(PROTECTION),
                NodeFactory.createURI(RV + "protectionMode"), NodeFactory.createURI(RV + mode));
            String update = edit(action);
            return ProtectionPolicy.capture(data, CommandPolicy.parse(update, RECEIPT), RECEIPT,
                "digest", update, null, new byte[32]);
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void protectedMutationCannotBorrowAnOrdinaryEditReceipt() {
        assertEquals("protected Work mutation requires a reviewed protection action",
            capture("ReviewRequired", "work.edit").error());
        assertNull(capture("Open", "work.edit"));
    }

    @Test public void reviewedActionRequiresAnExactSignedEffect() {
        assertNotNull(capture("ReviewRequired", "work.correction.review").error());
    }

    @Test public void pollProposalHeadDoesNotEnterWorkProtectionPolicy() {
        for (String type : new String[] { RV + "Poll", "https://schema.org/CreativeWork" }) {
            DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
            data.begin(org.apache.jena.query.ReadWrite.WRITE);
            try {
                data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                    RDF.type.asNode(), NodeFactory.createURI(type));
                String update = "PREFIX rv: <" + RV + "> INSERT { GRAPH " + iri(CommandPolicy.CURRENT)
                    + " { " + iri(WORK) + " rv:proposalHead " + iri(PROTECTION) + " } "
                    + "GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
                    + " rv:outcome rv:Succeeded ; rv:action \"governance.poll.administer\" } } WHERE {}";
                ProtectionPolicy.Snapshot result = ProtectionPolicy.capture(data,
                    CommandPolicy.parse(update, RECEIPT), RECEIPT, "digest", update, null, new byte[32]);
                if (type.equals(RV + "Poll")) assertNull(result);
                else assertEquals("protected Work mutation requires a reviewed protection action", result.error());
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
}
