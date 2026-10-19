package com.rezics.jena;

import static org.junit.Assert.*;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFParser;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Exercises the installed registry and production admission helpers, without a server. */
public class CreditBindingPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String SCHEMA = "https://schema.org/";
    private static final String CREDIT = id(2), REVISION = id(5), WORK = id(1), HEAD = id(3), ACTOR = id(4), AGENT = id(6);
    private static final String RECEIPT = "urn:rezics:receipt:work-edit:00000000-0000-4000-8000-000000000005";
    private static final List<String> GRAPHS = List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS,
        CommandPolicy.RECEIPTS, CommandPolicy.CONTROL);
    private static String id(int n) { return "https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012x", n); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node integer(int value) { return NodeFactory.createLiteralByValue(value,
        org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    private static ProfileRegistry registry() {
        return ProfileRegistry.load(Files.isDirectory(Path.of("profiles")) ? Path.of("profiles") : Path.of("../../../generated/model"));
    }

    private static final class Fixture implements AutoCloseable {
        final ProfileRegistry profiles = registry();
        final DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        final String profile, definition;
        final Map<String, String> binding = new LinkedHashMap<>();
        Fixture(boolean agent, boolean successor) {
            data.begin(ReadWrite.WRITE);
            profile = (agent ? "native-agent-credit" : "work-author-credit") + (successor ? "-v2" : "-v1");
            definition = "https://rezics.com/definition/" + profile;
            put(CommandPolicy.CURRENT, WORK, RDF.type.getURI(), uri(SCHEMA + "CreativeWork"));
            put(CommandPolicy.CURRENT, AGENT, RDF.type.getURI(), uri(RV + "Agent"));
            put(CommandPolicy.CURRENT, WORK, RV + "head", uri(HEAD));
            put(CommandPolicy.REVISIONS, HEAD, RDF.type.getURI(), uri(RV + "RevisionAnchor"));
            put(CommandPolicy.REVISIONS, HEAD, RV + "component", uri(WORK));
            for (String subject : List.of(CREDIT, REVISION)) {
                String graph = subject.equals(CREDIT) ? CommandPolicy.CURRENT : CommandPolicy.REVISIONS;
                put(graph, subject, RDF.type.getURI(), uri(RV + (agent ? "NativeAgentCredit" : "AuthorCredit")
                    + (subject.equals(REVISION) ? "Revision" : "")));
                put(graph, subject, RV + "work", uri(WORK));
                put(graph, subject, SCHEMA + "roleName", text(successor ? "performer" : "author"));
                if (agent) put(graph, subject, RV + "agent", uri(AGENT));
                else {
                    put(graph, subject, RV + "externalProvider", text("vndb"));
                    put(graph, subject, RV + "externalNamespace", text("staff"));
                    put(graph, subject, RV + "externalKey", text("s17"));
                    put(graph, subject, SCHEMA + "position", integer(2));
                    put(graph, subject, RV + "editControl", uri(RV + "HumanConfirmed"));
                    put(graph, subject, RV + "rightsStatus", uri(RV + "Undetermined"));
                }
            }
            data.add(uri(CommandPolicy.REVISIONS), uri(REVISION), RDF.type.asNode(), uri(RV + "RevisionAnchor"));
            put(CommandPolicy.CURRENT, CREDIT, RV + "creditRevision", uri(REVISION));
            if (successor) put(CommandPolicy.CURRENT, CREDIT, RV + "modelRevision", uri(definition));
            put(CommandPolicy.REVISIONS, REVISION, RV + "component", uri(CREDIT));
            put(CommandPolicy.REVISIONS, REVISION, RV + "workRevision", uri(HEAD));
            put(CommandPolicy.REVISIONS, REVISION, RV + "confirmedBy", uri(ACTOR));
            put(CommandPolicy.REVISIONS, REVISION, RV + "modelRevision", uri(definition));
            put(CommandPolicy.REVISIONS, REVISION, RV + "shapeRevision", uri(definition));
            put(CommandPolicy.REVISIONS, REVISION, RV + "dataEpoch", text("credit-epoch"));
            put(CommandPolicy.REVISIONS, REVISION, RV + "sequence", integer(12));
            for (String[] link : new String[][] { { "authorCredit", CREDIT }, { "creditRevision", REVISION },
                { "work", WORK }, { "workRevision", HEAD }, { "expectedHead", HEAD }, { "sourceIntent", CREDIT } })
                put(CommandPolicy.RECEIPTS, RECEIPT, RV + link[0], uri(link[1]));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "admittedScope", text("work:edit:" + WORK));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "authorityEpoch", text("7"));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "outcome", uri(RV + "Succeeded"));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "dataEpoch", text("credit-epoch"));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "sequence", integer(12));
            binding.putAll(Map.of("credit", CREDIT, "revision", REVISION, "work", WORK, "work-head", HEAD,
                "key", "s17", "ordinal", "2", "actor", ACTOR, "receipt", RECEIPT, "scope", "work:edit:" + WORK));
            binding.putAll(Map.of("epoch", "7", "intent", CREDIT, "provider", "vndb", "namespace", "staff",
                "role", successor ? "performer" : "author"));
        }
        void put(String graph, String subject, String predicate, Node value) {
            data.deleteAny(uri(graph), uri(subject), uri(predicate), Node.ANY);
            data.add(uri(graph), uri(subject), uri(predicate), value);
        }
        List<CommandService.Validation> entries(Map<String, String> args, List<String> graphs) {
            return List.of(new CommandService.Validation(profile, profiles.get(profile), definition + "/credit-shape", List.of(CREDIT), graphs, args),
                new CommandService.Validation(profile, profiles.get(profile), definition + "/revision-shape", List.of(REVISION), graphs, args));
        }
        String check() { return BindingPolicy.check(data, profile, profiles.get(profile).binding(), entries(binding, GRAPHS)); }
        @Override public void close() { data.abort(); data.end(); data.close(); }
    }

    @Test public void explicitSuccessorKeepsTheExactOwnerBindingAndV1Default() {
        for (boolean successor : List.of(false, true)) try (var f = new Fixture(false, successor)) {
            assertNull(f.check());
            for (boolean revision : List.of(false, true)) {
                String subject = revision ? REVISION : CREDIT;
                var selected = CanonicalPolicy.select(f.profiles, f.data, subject, revision);
                assertEquals(f.profile, selected.route().profile());
                assertNull(CanonicalPolicy.validateSelected(f.profiles, f.data, subject, selected));
                assertEquals(f.profile, CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, subject, revision));
            }
        }
    }

    @Test public void bothParticipantFamiliesNeedExactSuccessorPinsAndExternalCreditsStillForbidAgents() {
        for (boolean agent : List.of(false, true)) try (var f = new Fixture(agent, true)) {
            assertNull(CanonicalPolicy.validate(f.profiles, f.data, CREDIT, false));
            assertNull(CanonicalPolicy.validate(f.profiles, f.data, REVISION, true));
            f.put(CommandPolicy.REVISIONS, REVISION, RV + "shapeRevision", uri(f.definition.replace("-v2", "-v1")));
            assertNotNull(CanonicalPolicy.validate(f.profiles, f.data, REVISION, true));
            f.put(CommandPolicy.REVISIONS, REVISION, RV + "shapeRevision", uri(f.definition));
            f.data.deleteAny(uri(CommandPolicy.CURRENT), uri(CREDIT), uri(RV + "modelRevision"), Node.ANY);
            assertNotNull(CanonicalPolicy.validate(f.profiles, f.data, CREDIT, false));
            f.put(CommandPolicy.CURRENT, CREDIT, RV + "modelRevision", uri(f.definition));
            if (!agent) {
                f.put(CommandPolicy.CURRENT, CREDIT, RV + "agent", uri(AGENT));
                assertNotNull(CanonicalPolicy.validate(f.profiles, f.data, CREDIT, false));
            } else assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, CREDIT, false));
        }
    }

    @Test public void successorBindingRefusesOtherReceiptsWorkHeadsAndParticipants() {
        for (String field : List.of("receipt", "work", "work-head", "key", "provider", "namespace", "ordinal", "actor", "intent"))
            try (var f = new Fixture(false, true)) {
                f.binding.put(field, switch (field) {
                    case "key", "provider", "namespace" -> "other";
                    case "ordinal" -> "3";
                    default -> id(99);
                });
                if (field.equals("work")) f.binding.put("scope", "work:edit:" + id(99));
                assertNotNull(field, f.check());
            }
        for (String field : List.of("authorCredit", "creditRevision", "work", "workRevision", "expectedHead", "sourceIntent"))
            try (var f = new Fixture(false, true)) {
                f.put(CommandPolicy.RECEIPTS, RECEIPT, RV + field, uri(id(99)));
                assertNotNull(field, f.check());
            }
    }

    @Test public void selectedSuccessorCannotUseOmittedHistoricalOrMixedBindings() throws Exception {
        try (var f = new Fixture(false, true)) {
            var entries = f.entries(f.binding, GRAPHS);
            Method focus = CommandService.class.getDeclaredMethod("boundFocus", List.class, String.class, String.class);
            focus.setAccessible(true);
            String demand = CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, CREDIT, false);
            assertEquals("work-author-credit-v2", demand);
            assertEquals(true, focus.invoke(null, entries, demand, CREDIT));
            assertEquals(false, focus.invoke(null, List.of(), demand, CREDIT));
            var historical = new CommandService.Validation("work-author-credit-v1", f.profiles.get("work-author-credit-v1"),
                "https://rezics.com/definition/work-author-credit-v1/credit-shape", List.of(CREDIT), GRAPHS, f.binding);
            assertEquals(false, focus.invoke(null, List.of(historical), demand, CREDIT));
            assertThrows(IllegalArgumentException.class, () -> BindingPolicy.check(f.data, f.profile,
                f.profiles.get(f.profile).binding(), f.entries(Map.of(), GRAPHS)));
            var mixed = new ArrayList<>(entries);
            var changed = new LinkedHashMap<>(f.binding); changed.put("key", "other");
            mixed.set(1, f.entries(changed, GRAPHS).get(1));
            assertThrows(IllegalArgumentException.class, () -> BindingPolicy.check(f.data, f.profile,
                f.profiles.get(f.profile).binding(), mixed));
        }
    }

    @SuppressWarnings("unchecked")
    private static List<CommandService.Validation> parse(Fixture f, List<String> graphs) throws Exception {
        var rows = new JsonArray();
        for (var validation : f.entries(f.binding, graphs)) {
            var entry = new JsonObject();
            entry.put("profile", validation.profileId()); entry.put("sha256", validation.profile().sha256());
            entry.put("shape", validation.shape());
            var focus = new JsonArray(); validation.focus().forEach(focus::add); entry.put("focus", focus);
            var selected = new JsonArray(); validation.graphs().forEach(selected::add); entry.put("graphs", selected);
            var args = new JsonObject(); validation.binding().forEach(args::put); entry.put("binding", args);
            rows.add(entry);
        }
        Method parse = CommandService.class.getDeclaredMethod("parseValidations", JsonValue.class);
        parse.setAccessible(true);
        try {
            return (List<CommandService.Validation>) parse.invoke(new CommandService(f.profiles,
                "1".repeat(64).getBytes(), "2".repeat(64).getBytes(), "3".repeat(64).getBytes()), rows);
        } catch (InvocationTargetException e) {
            if (e.getCause() instanceof IllegalArgumentException invalid) throw invalid;
            throw e;
        }
    }

    @Test public void successorValidationAdmitsOnlyTheCompleteReceiptGraphSet() throws Exception {
        try (var f = new Fixture(false, true)) {
            assertEquals(2, parse(f, GRAPHS).size());
            for (String omitted : GRAPHS) assertThrows(IllegalArgumentException.class,
                () -> parse(f, GRAPHS.stream().filter(graph -> !graph.equals(omitted)).toList()));
            var extra = new ArrayList<>(GRAPHS); extra.add("urn:rezics:graph:source");
            assertThrows(IllegalArgumentException.class, () -> parse(f, extra));
        }
    }

    @Test public void fixedGlobalAndUndemandedAgentKeepTheirExistingExceptions() {
        try (var f = new Fixture(true, true)) {
            assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, CREDIT, false));
            assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, REVISION, true));
            String global = "urn:rezics:classification-context:global";
            f.put(CommandPolicy.CURRENT, global, RDF.type.getURI(), uri(RV + "ClassificationContext"));
            f.put(CommandPolicy.CURRENT, global, RV + "contextRole", uri(RV + "GlobalClassification"));
            assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, global, false));
        }
    }

    private static String string(JsonObject value, String key) { return value.get(key).getAsString().value(); }
    private static JsonArray retainedCommands() throws Exception {
        try (var input = CreditBindingPolicyTest.class.getResourceAsStream("/credit-retained-binding-commands.json")) {
            assertNotNull("actual TypeScript writer captures", input);
            var captured = JSON.parse(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("318fa527a68777e9b297adc4df93131adab91321ae97d00485be5093b756022c",
                string(captured, "reviewedCounterexampleSha256"));
            assertEquals(4, captured.get("envelopes").getAsArray().size());
            return captured.get("envelopes").getAsArray();
        }
    }

    /** The owner test compares these captures with the currently emitted TS
     * envelopes and owner-produced prestate. Exercise the full native runtime,
     * including transaction guards, canonical admission, bindings and SHACL. */
    private static final class RetainedCommand implements AutoCloseable {
        final JsonObject row, command;
        final DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        final CommandService service = new CommandService(registry(), "1".repeat(64).getBytes(),
            "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
        final List<CommandService.Validation> validations;
        RetainedCommand(JsonObject row) throws Exception {
            this.row = row; command = row.get("command").getAsObject();
            data.begin(ReadWrite.WRITE);
            try {
                RDFParser.fromString(string(row, "seed"), Lang.TRIG).parse(data);
                data.commit();
            } catch (RuntimeException | Error error) {
                data.abort();
                throw error;
            } finally { data.end(); }
            validations = parse(command);
        }
        @SuppressWarnings("unchecked")
        private List<CommandService.Validation> parse(JsonObject envelope) throws Exception {
            Method parse = CommandService.class.getDeclaredMethod("parseValidations", JsonValue.class);
            parse.setAccessible(true);
            return (List<CommandService.Validation>) parse.invoke(service, envelope.get("validations"));
        }
        Map<String, Object> run(JsonObject envelope) throws Exception {
            return service.runCommand(data, string(envelope, "receipt"), string(envelope, "digest"),
                string(envelope, "update"), parse(envelope), System.nanoTime() + 30_000_000_000L);
        }
        Map<String, Object> run(List<CommandService.Validation> entries) {
            return run(string(command, "update"), entries);
        }
        Map<String, Object> run(String update, List<CommandService.Validation> entries) {
            return service.runCommand(data, string(command, "receipt"), string(command, "digest"),
                update, entries, System.nanoTime() + 30_000_000_000L);
        }
        Set<Quad> snapshot() {
            data.begin(ReadWrite.READ);
            try { var result = new HashSet<Quad>(); data.find().forEachRemaining(result::add); return result; }
            finally { data.end(); }
        }
        void change(Consumer<DatasetGraph> change) {
            data.begin(ReadWrite.WRITE);
            try { change.accept(data); data.commit(); }
            catch (RuntimeException | Error error) { data.abort(); throw error; }
            finally { data.end(); }
        }
        @Override public void close() { data.close(); }
    }

    @Test public void emittedRetainedBootstrapCommitsAndReplaysThroughTheNativeRuntime() throws Exception {
        for (var entry : retainedCommands()) try (var f = new RetainedCommand(entry.getAsObject())) {
            assertEquals(2, f.validations.size());
            assertTrue(f.validations.stream().allMatch(v -> v.profileId().equals(string(f.row, "profile"))));
            var original = f.snapshot().stream().filter(q -> q.getSubject().equals(uri(REVISION))
                || q.getSubject().equals(uri(string(f.row, "originalReceipt")))).collect(java.util.stream.Collectors.toSet());
            var first = f.run(f.validations);
            assertEquals(first.toString(), "committed", first.get("status"));
            var after = f.snapshot();
            String head = string(f.row, "associationHead"), receipt = string(f.command, "receipt");
            assertTrue(after.contains(Quad.create(uri(CommandPolicy.CURRENT), uri(CREDIT), uri(RV + "associationHead"), uri(head))));
            assertTrue(after.contains(Quad.create(uri(CommandPolicy.REVISIONS), uri(head), uri(RV + "operation"), uri(string(f.row, "operation")))));
            assertTrue(after.contains(Quad.create(uri(CommandPolicy.REVISIONS), uri(head), uri(RV + "modelGeneration"), uri(string(f.row, "modelGeneration")))));
            assertTrue(after.contains(Quad.create(uri(CommandPolicy.RECEIPTS), uri(receipt), uri(RV + "operation"), uri(string(f.row, "operation")))));
            assertNotEquals(receipt, string(f.row, "originalReceipt"));
            assertEquals(original, after.stream().filter(q -> q.getSubject().equals(uri(REVISION))
                || q.getSubject().equals(uri(string(f.row, "originalReceipt")))).collect(java.util.stream.Collectors.toSet()));
            for (var participation : f.row.get("participations").getAsArray())
                assertTrue(after.contains(Quad.create(uri(CommandPolicy.REVISIONS), uri(participation.getAsString().value()),
                    uri(RV + "occurrence"), uri(CREDIT))));
            var replay = f.run(f.validations);
            assertEquals(replay.toString(), "committed", replay.get("status"));
            assertEquals(first.get("position"), replay.get("position"));
            assertEquals("replay keeps the sealed operation, heads and allocations", after, f.snapshot());
        }
    }

    @Test public void emittedRetainedBootstrapStillRefusesEmptyValidationAndAnotherReceipt() throws Exception {
        for (var entry : retainedCommands()) {
            try (var f = new RetainedCommand(entry.getAsObject())) {
                var before = f.snapshot();
                var result = f.run(List.of());
                assertEquals(result.toString(), "invalid", result.get("status"));
                assertEquals("product data requires profile validation", result.get("report"));
                assertEquals("refused validation must roll back product data", before, f.snapshot());
            }
            if (entry.getAsObject().get("agent").getAsBoolean().value()) continue;
            try (var f = new RetainedCommand(entry.getAsObject())) {
                var before = f.snapshot();
                var wrong = f.validations.stream().map(v -> {
                    var args = new LinkedHashMap<>(v.binding());
                    args.put("receipt", string(f.command, "receipt"));
                    return new CommandService.Validation(v.profileId(), v.profile(), v.shape(), v.focus(), v.graphs(), args);
                }).toList();
                var result = f.run(wrong);
                assertEquals(result.toString(), "invalid", result.get("status"));
                assertEquals("compatibility admission is not the original native credit receipt", before, f.snapshot());
            }
        }
    }

    @Test public void emittedRetainedSuccessorPreservesHistoryAndAllocations() throws Exception {
        for (var entry : retainedCommands()) try (var f = new RetainedCommand(entry.getAsObject())) {
            var first = f.run(f.validations);
            assertEquals(first.toString(), "committed", first.get("status"));
            var afterFirst = f.snapshot();
            String oldHead = string(f.row, "associationHead"), oldReceipt = string(f.command, "receipt");
            var history = afterFirst.stream().filter(q -> q.getSubject().equals(uri(oldHead))
                || q.getSubject().equals(uri(oldReceipt))).collect(java.util.stream.Collectors.toSet());
            var successor = f.row.get("successor").getAsObject();
            var command = successor.get("command").getAsObject();
            var second = f.run(command);
            assertEquals(second.toString(), "committed", second.get("status"));
            var afterSecond = f.snapshot();
            String head = string(successor, "associationHead");
            assertNotEquals(oldHead, head);
            assertTrue(afterSecond.contains(Quad.create(uri(CommandPolicy.CURRENT), uri(CREDIT), uri(RV + "associationHead"), uri(head))));
            assertFalse(afterSecond.contains(Quad.create(uri(CommandPolicy.CURRENT), uri(CREDIT), uri(RV + "associationHead"), uri(oldHead))));
            assertTrue(afterSecond.contains(Quad.create(uri(CommandPolicy.REVISIONS), uri(head), uri(RV + "predecessor"), uri(oldHead))));
            assertEquals(history, afterSecond.stream().filter(q -> q.getSubject().equals(uri(oldHead))
                || q.getSubject().equals(uri(oldReceipt))).collect(java.util.stream.Collectors.toSet()));
            assertEquals(f.row.get("participations").toString(), successor.get("participations").toString());
            for (var participant : f.row.get("participations").getAsArray())
                assertTrue(afterSecond.contains(Quad.create(uri(CommandPolicy.REVISIONS), uri(head),
                    uri(RV + "participation"), uri(participant.getAsString().value()))));
            var allocations = afterSecond.stream().filter(q -> q.getGraph().equals(uri(CommandPolicy.REVISIONS))
                && q.getPredicate().equals(uri(RV + "occurrence")) && q.getObject().equals(uri(CREDIT))).toList();
            assertEquals("a successor reuses the single allocation set", 2, allocations.size());
            assertEquals(second.get("position"), f.run(command).get("position"));
            assertEquals(afterSecond, f.snapshot());
        }
    }

    @Test public void emittedRetainedBootstrapFencesHeadsRetirementErasureAndGeneration() throws Exception {
        for (var entry : retainedCommands()) for (String change : List.of("work-head", "retired", "protected", "erased", "generation"))
            try (var f = new RetainedCommand(entry.getAsObject())) {
                f.change(data -> {
                    switch (change) {
                        case "work-head" -> {
                            data.deleteAny(uri(CommandPolicy.CURRENT), uri(WORK), uri(RV + "head"), Node.ANY);
                            data.add(uri(CommandPolicy.CURRENT), uri(WORK), uri(RV + "head"), uri(id(99)));
                        }
                        case "retired" -> data.add(uri(CommandPolicy.CURRENT), uri(CREDIT), uri(RV + "retiredBy"), uri(id(99)));
                        case "protected" -> data.add(uri(CommandPolicy.CURRENT), uri(CREDIT), uri(RV + "protectionHead"), uri(id(99)));
                        case "erased" -> data.add(uri(CommandPolicy.REVISIONS), uri(REVISION), RDF.type.asNode(), uri(RV + "ErasedRevision"));
                        case "generation" -> data.deleteAny(uri(CommandPolicy.CURRENT), Node.ANY, uri(RV + "generationHead"), Node.ANY);
                        default -> throw new IllegalArgumentException(change);
                    }
                });
                var before = f.snapshot();
                var result = f.run(f.validations);
                assertEquals(change + ": " + result, change.equals("work-head") ? "guard-unmatched" : "invalid", result.get("status"));
                if (!change.equals("work-head")) assertEquals(switch (change) {
                    case "generation" -> "retained credit receipt or model basis differs";
                    case "erased" -> "erased exact revision cannot be reactivated";
                    default -> "retained credit original is unavailable";
                }, result.get("report"));
                assertEquals("failed owner fence must not allocate or seal", before, f.snapshot());
            }
    }

    @Test public void retainedMetadataAdmissionCannotRewriteTheOriginalCreditOrItsSeal() throws Exception {
        for (var entry : retainedCommands()) for (String change : List.of("role", "native-revision", "receipt", "participant", "profile"))
            try (var f = new RetainedCommand(entry.getAsObject())) {
                String update = string(f.command, "update");
                String pointer = "<" + CREDIT + "> rv:associationHead";
                update = switch (change) {
                    case "role" -> update.replace(pointer, "<" + CREDIT + "> <" + SCHEMA + "roleName> \"author\" ; rv:associationHead");
                    case "native-revision" -> update.replace("GRAPH <" + CommandPolicy.REVISIONS + "> {", "GRAPH <"
                        + CommandPolicy.REVISIONS + "> { <" + REVISION + "> <" + SCHEMA + "roleName> \"author\" . ");
                    case "receipt" -> update.replace("rv:operation <" + string(f.row, "operation") + "> ; rv:component",
                        "rv:operation <" + id(99) + "> ; rv:component");
                    case "participant" -> update.replace("rv:occurrence <" + CREDIT + ">", "rv:occurrence <" + id(99) + ">");
                    case "profile" -> update.replace("rv:compatibilityProfile <https://rezics.com/definition/retained-credit-associations-v1>",
                        "rv:compatibilityProfile <https://rezics.com/definition/native-agent-credit-v1>");
                    default -> throw new IllegalArgumentException(change);
                };
                assertNotEquals("negative case must change the real emitted command", string(f.command, "update"), update);
                var before = f.snapshot();
                var result = f.run(update, f.validations);
                assertEquals(change + ": " + result, "invalid", result.get("status"));
                assertEquals("retained metadata cannot provide an escape from native immutability", before, f.snapshot());
            }
    }
}
