package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.apache.jena.vocabulary.RDFS;
import org.junit.Test;

public class ModelMutationPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String ITEM = "urn:probe:item";
    private static final ProfileRegistry PROFILES = ProfileRegistry.load(
        Path.of("src/test/resources/registry-probe"));

    private static Node uri(String value) { return NodeFactory.createURI(value); }

    private static CommandPolicy.Plan plan() {
        return new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT), Set.of(ITEM),
            Set.of(), Set.of(), false, false, true);
    }

    private static DatasetGraph data() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        data.add(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), uri(RV + "RegistryProbe"));
        data.add(uri(CommandPolicy.CURRENT), uri(ITEM), uri(RV + "probeLabel"),
            NodeFactory.createLiteralString("probe"));
        return data;
    }

    private static String report(Map<String, Object> result) {
        assertEquals("invalid", result.get("status"));
        return String.valueOf(result.get("report"));
    }

    @Test public void model15PrestateRouteCannotFallThroughAfterSelectorDeletion() {
        DatasetGraph data = data();
        try {
            Node state = uri(RV + "probeState");
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), state, uri(RV + "Sealed"));
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), uri(RV + "sealedBy"), uri("urn:probe:actor"));
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            data.delete(uri(CommandPolicy.CURRENT), uri(ITEM), state, uri(RV + "Sealed"));
            assertEquals("prestate canonical selector changed: " + ITEM,
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void model16ReverseDependentsHaveAnExplicitBound() {
        DatasetGraph data = data();
        try {
            for (int i = 0; i < 4; i++) addDependent(data, i);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            assertNull(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before));
            for (int i = 4; i < 257; i++) addDependent(data, i);
            assertEquals("reverse dependency footprint exceeds 256",
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void model16UnknownHistoricalParentRejectsAChildTypeChange() {
        DatasetGraph data = data();
        try {
            Node secondary = uri(RV + "RegistryProbeRecord");
            Node parent = uri("urn:probe:historical-parent");
            data.add(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), secondary);
            data.add(uri(CommandPolicy.REVISIONS), parent, RDF.type.asNode(), uri(RV + "RevisionAnchor"));
            data.add(uri(CommandPolicy.REVISIONS), parent, uri(RV + "item"), uri(ITEM));
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(PROFILES, data, plan());
            data.delete(uri(CommandPolicy.CURRENT), uri(ITEM), RDF.type.asNode(), secondary);
            assertEquals("uncanonical reverse revision dependency requires staged lifecycle: " + parent.getURI(),
                report(ModelMutationPolicy.check(PROFILES, data, plan(), "urn:receipt:probe", before)));
        } finally { data.abort(); data.end(); }
    }

    @Test public void stableAgentProfileEditSkipsReverseDependents() {
        ProfileRegistry profiles = ProfileRegistry.load(Path.of("src/test/resources/agent-identity"));
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            String agent = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a1";
            Node node = uri(agent);
            data.add(uri(CommandPolicy.CURRENT), node, RDF.type.asNode(), uri(RV + "Agent"));
            data.add(uri(CommandPolicy.CURRENT), node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            data.add(uri(CommandPolicy.CURRENT), node, RDFS.label.asNode(), NodeFactory.createLiteralString("Old Name"));
            data.add(uri(CommandPolicy.CURRENT), node, uri(RV + "profileHandle"),
                NodeFactory.createLiteralString("agent-00000000-0000-4000-8000-0000000000a1"));
            data.add(uri(CommandPolicy.CURRENT), node, uri(RV + "profileDisclosure"), uri(RV + "Public"));
            for (int i = 0; i < 300; i++) data.add(uri(CommandPolicy.REVISIONS), uri("urn:probe:credit:" + i),
                uri(RV + "author"), node);
            CommandPolicy.Plan plan = new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS),
                Set.of(agent), Set.of(), Set.of(), false, false, true);
            ModelMutationPolicy.Snapshot before = ModelMutationPolicy.capture(profiles, data, plan);
            data.delete(uri(CommandPolicy.CURRENT), node, RDFS.label.asNode(), NodeFactory.createLiteralString("Old Name"));
            data.add(uri(CommandPolicy.CURRENT), node, RDFS.label.asNode(), NodeFactory.createLiteralString("New Name"));
            assertNull(ModelMutationPolicy.check(profiles, data, plan, "urn:rezics:receipt:agent-profile:probe", before));
            data.delete(uri(CommandPolicy.CURRENT), node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            String broken = report(ModelMutationPolicy.check(profiles, data, plan,
                "urn:rezics:receipt:agent-profile:probe", before));
            assertTrue(broken.contains(RV + "agentKind"));
            assertTrue(!broken.contains("reverse dependency footprint"));
        } finally { data.abort(); data.end(); }
    }

    @Test public void addressedAgentProfileUpgradeRequiresItsCasReceiptAndPreservesKind() {
        ProfileRegistry profiles = ProfileRegistry.load(Path.of("src/test/resources/agent-identity"));
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            String agent = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a1";
            String receipt = "urn:rezics:receipt:agent-profile:probe";
            Node node = uri(agent), prior = uri("urn:probe:prior"), revision = uri("urn:probe:next"), own = uri(receipt);
            Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS), receipts = uri(CommandPolicy.RECEIPTS);
            Node model = uri("https://rezics.com/definition/agent-profile-address-v1");
            data.add(current, node, RDF.type.asNode(), uri(RV + "Agent"));
            data.add(current, node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            data.add(current, node, uri(RV + "head"), prior);
            CommandPolicy.Plan plan = new CommandPolicy.Plan(null, Set.of(CommandPolicy.CURRENT),
                Set.of(agent), Set.of(), Set.of(), false, false, true);
            var before = ModelMutationPolicy.capture(profiles, data, plan).current().get(agent);
            data.add(current, node, uri(RV + "publicProfileHead"), revision);
            data.add(current, node, uri(RV + "profileNameFormat"), uri(RV + "PlainNameAddressV1"));
            data.add(current, node, uri(RV + "profileStateFormat"), uri(RV + "AddressedAgentProfileV1"));
            data.add(revisions, revision, uri(RV + "predecessor"), prior);
            data.add(revisions, revision, uri(RV + "component"), node);
            data.add(revisions, revision, uri(RV + "modelRevision"), model);
            data.add(revisions, revision, uri(RV + "shapeRevision"), model);
            data.add(receipts, own, RDF.type.asNode(), uri(RV + "OperationReceipt"));
            data.add(receipts, own, uri(RV + "agent"), node);
            data.add(receipts, own, uri(RV + "profileRevision"), revision);
            data.add(receipts, own, uri(RV + "outcome"), uri(RV + "Succeeded"));
            assertTrue(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, before));
            assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, "urn:probe:unrelated", agent, before));
            for (String field : new String[] { "predecessor", "component", "modelRevision", "shapeRevision" }) {
                Node value = field.equals("predecessor") ? prior : field.equals("component") ? node : model;
                data.delete(revisions, revision, uri(RV + field), value);
                assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, before));
                data.add(revisions, revision, uri(RV + field), value);
            }
            data.delete(current, node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            data.add(current, node, uri(RV + "agentKind"), uri(RV + "ServiceAgent"));
            assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, before));
            data.delete(current, node, uri(RV + "agentKind"), uri(RV + "ServiceAgent"));
            data.add(current, node, uri(RV + "agentKind"), uri(RV + "PersonAgent"));
            var translated = new ModelMutationPolicy.Subject(before.graph(), before.selection(),
                Map.of(RV + "profileNameFormat", Set.of(uri(RV + "LocalizedNameV2"))), before.types(), before.mutationBasis());
            assertFalse(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, translated));
            data.delete(current, node, uri(RV + "profileNameFormat"), uri(RV + "PlainNameAddressV1"));
            data.add(current, node, uri(RV + "profileNameFormat"), uri(RV + "LocalizedNameAddressV1"));
            assertTrue(ModelMutationPolicy.agentAddressProfileUpgrade(data, receipt, agent, translated));
        } finally { data.abort(); data.end(); }
    }

    private static void addDependent(DatasetGraph data, int index) {
        Node record = uri("urn:probe:record:" + index);
        data.add(uri(CommandPolicy.REVISIONS), record, RDF.type.asNode(), uri(RV + "RegistryProbeRecord"));
        data.add(uri(CommandPolicy.REVISIONS), record, uri(RV + "item"), uri(ITEM));
    }
}
