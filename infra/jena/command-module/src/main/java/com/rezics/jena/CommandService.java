package com.rezics.jena;

import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.atlas.json.JsonObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.fuseki.servlets.ActionService;
import org.apache.jena.fuseki.servlets.HttpAction;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.jena.shacl.ShaclValidator;
import org.apache.jena.shacl.Shapes;
import org.apache.jena.shacl.ValidationReport;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;

final class CommandService extends ActionService {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String SH = "http://www.w3.org/ns/shacl#";
    private static final int MAX_REQUEST = 2_000_000;
    private final ProfileRegistry profiles;

    CommandService(ProfileRegistry profiles) { this.profiles = profiles; }

    @Override public void validate(HttpAction action) {}
    @Override public void execute(HttpAction action) {}
    @Override public void execGet(HttpAction action) { respond(action, 200, Map.of("moduleVersion", "0.3.0", "profiles", profiles.digests())); }
    @Override public void execPost(HttpAction action) {
        if (!"application/json".equalsIgnoreCase(action.getRequestContentType())) {
            respond(action, 415, Map.of("status", "bad-request", "message", "application/json required")); return;
        }
        try {
            byte[] bytes = action.getRequestInputStream().readNBytes(MAX_REQUEST + 1);
            if (bytes.length > MAX_REQUEST) throw new IllegalArgumentException("request too large");
            JsonObject body = JSON.parse(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
            String receipt = iri(ProfileRegistry.required(body, "receipt"));
            String digest = ProfileRegistry.required(body, "digest");
            String update = ProfileRegistry.required(body, "update");
            JsonValue deadlineValue = body.get("deadlineMs");
            long deadlineMs = deadlineValue == null ? 10_000 : deadlineValue.getAsNumber().value().longValue();
            if (deadlineMs < 1 || deadlineMs > 120_000) throw new IllegalArgumentException("invalid deadlineMs");
            List<Validation> validations = parseValidations(body.get("validations"));
            CommandPolicy.Plan plan = CommandPolicy.parse(update, receipt);
            long deadline = System.nanoTime() + deadlineMs * 1_000_000L;
            respond(action, 200, run(action.getDataService().getDataset(), receipt, digest, plan, validations, deadline));
        } catch (UnknownProfile ex) {
            respond(action, 200, Map.of("status", "unknown-profile"));
        } catch (IllegalArgumentException ex) {
            respond(action, 400, Map.of("status", "bad-request", "message", ex.getMessage()));
        } catch (IOException ex) {
            respond(action, 400, Map.of("status", "bad-request", "message", "invalid JSON"));
        } catch (RuntimeException ex) {
            action.log.error("command failed", ex);
            respond(action, 500, Map.of("status", "error"));
        }
    }

    private record Validation(ProfileRegistry.Profile profile, String shape, List<String> focus, List<String> graphs) {}
    private List<Validation> parseValidations(JsonValue entries) {
        if (entries == null || !entries.isArray() || entries.getAsArray().size() > 100) throw new IllegalArgumentException("invalid validations");
        List<Validation> result = new ArrayList<>();
        for (JsonValue item : entries.getAsArray()) {
            JsonObject entry = item.getAsObject();
            ProfileRegistry.Profile profile = profiles.get(ProfileRegistry.required(entry, "profile"));
            if (profile == null || !profile.sha256().equalsIgnoreCase(ProfileRegistry.required(entry, "sha256")))
                throw new UnknownProfile();
            String shape = iri(ProfileRegistry.required(entry, "shape"));
            if (!profile.shapes().contains(ResourceFactory.createResource(shape), org.apache.jena.vocabulary.RDF.type, ResourceFactory.createResource(SH + "NodeShape"))) throw new UnknownProfile();
            List<String> graphs = iris(entry.get("graphs"));
            if (graphs.stream().anyMatch(graph -> !graph.equals(CommandPolicy.CURRENT)
                && !graph.equals(CommandPolicy.REVISIONS))) throw new IllegalArgumentException("validation graph not admitted");
            result.add(new Validation(profile, shape, iris(entry.get("focus")), graphs));
        }
        return result;
    }
    private static List<String> iris(JsonValue array) {
        if (array == null || !array.isArray() || array.getAsArray().isEmpty() || array.getAsArray().size() > 100) throw new IllegalArgumentException("invalid IRI list");
        List<String> result = new ArrayList<>();
        array.getAsArray().forEach(item -> result.add(iri(item.getAsString().value())));
        return result;
    }
    private static String iri(String value) {
        if (!(value.startsWith("https://") || value.startsWith("http://") || value.startsWith("urn:")) || value.contains(" "))
            throw new IllegalArgumentException("invalid IRI");
        return value;
    }
    private static final class UnknownProfile extends IllegalArgumentException {}

    private Map<String, Object> run(DatasetGraph dataset, String receipt, String digest, CommandPolicy.Plan plan,
                                    List<Validation> validations, long deadline) {
        dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
        boolean commit = false;
        try {
            String existing = receiptValue(dataset, receipt, "requestDigest");
            if (existing != null) return existing.equals(digest) ? committed(dataset, receipt) : Map.of("status", "conflict");
            String preflight = CommandInvariant.preflight(dataset, receipt, plan);
            if (preflight != null) return invalid(preflight);
            CommandInvariant.Control before = plan.bootstrap() ? null : CommandInvariant.readControl(dataset);
            UpdateAction.execute(plan.request(), DatasetFactory.wrap(dataset));
            String stored = receiptValue(dataset, receipt, "requestDigest");
            if (stored == null) return Map.of("status", "guard-unmatched");
            if (!stored.equals(digest)) return Map.of("status", "conflict");
            String invariant = CommandInvariant.check(dataset, receipt, digest, plan, before);
            if (invariant != null) return invalid(invariant);
            Map<String, Object> scope = validateScope(dataset, plan, validations);
            if (scope != null) return scope;
            for (Validation validation : validations) {
                Map<String, Object> invalid = validateOne(dataset, validation);
                if (invalid != null) return invalid;
                if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            }
            if (System.nanoTime() >= deadline) return Map.of("status", "deadline");
            Map<String, Object> result = committed(dataset, receipt);
            if (!result.containsKey("position")) return Map.of("status", "invalid", "report", "receipt position incomplete");
            dataset.commit(); commit = true;
            return result;
        } finally {
            if (!commit) dataset.abort();
            dataset.end();
        }
    }
    private Map<String, Object> validateScope(DatasetGraph dataset, CommandPolicy.Plan plan,
                                              List<Validation> validations) {
        boolean productData = !plan.current().isEmpty() || !plan.revisions().isEmpty()
            || plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH) && !plan.bootstrap();
        if (productData && validations.isEmpty()) return invalid("product data requires profile validation");
        Set<String> directCurrent = new HashSet<>();
        Set<String> revisionFocus = new HashSet<>();
        for (Validation validation : validations) {
            if (validation.graphs().contains(CommandPolicy.CURRENT)) directCurrent.addAll(validation.focus());
            if (validation.graphs().contains(CommandPolicy.REVISIONS)) revisionFocus.addAll(validation.focus());
        }
        Node revisionGraph = NodeFactory.createURI(CommandPolicy.REVISIONS);
        Node component = NodeFactory.createURI(RV + "component");
        for (String subject : plan.current()) {
            boolean covered = directCurrent.contains(subject);
            if (!covered) {
                Node node = NodeFactory.createURI(subject);
                for (String focus : revisionFocus) {
                    if (dataset.contains(revisionGraph, NodeFactory.createURI(focus), component, node)) {
                        covered = true; break;
                    }
                }
            }
            if (!covered) return invalid("current graph focus omitted: " + subject);
            Map<String, Object> canonical = validateCanonical(dataset, subject, false);
            if (canonical != null) return canonical;
        }
        for (String subject : plan.revisions()) {
            Map<String, Object> canonical = validateCanonical(dataset, subject, true);
            if (canonical != null) return canonical;
            Node node = NodeFactory.createURI(subject);
            for (String type : List.of("PublicationDecision", "PublicationSelection",
                "RealmPublicationRejection", "ClassificationDecision", "RatingObservationRevision")) {
                if (dataset.contains(revisionGraph, node,
                    org.apache.jena.vocabulary.RDF.type.asNode(), NodeFactory.createURI(RV + type))
                    && !revisionFocus.contains(subject)) return invalid("revision graph focus omitted: " + subject);
            }
        }
        return null;
    }
    private static Map<String, Object> invalid(String report) {
        return Map.of("status", "invalid", "report", report);
    }
    private record Canonical(String profile, String shape) {}
    private Map<String, Object> validateCanonical(DatasetGraph dataset, String subject, boolean revision) {
        Node graph = NodeFactory.createURI(revision ? CommandPolicy.REVISIONS : CommandPolicy.CURRENT);
        Node node = NodeFactory.createURI(subject);
        Set<String> types = new HashSet<>();
        dataset.find(graph, node, org.apache.jena.vocabulary.RDF.type.asNode(), Node.ANY)
            .forEachRemaining(quad -> { if (quad.getObject().isURI()) types.add(quad.getObject().getURI()); });
        if (!revision && types.isEmpty()) return invalid("current graph subject has no type: " + subject);
        Canonical canonical = null;
        String basis = "https://rezics.com/definition/";
        if (types.contains("https://schema.org/CreativeWork"))
            canonical = new Canonical("work-metadata-v1", "work-shape");
        else if (types.contains(RV + "MainVersion"))
            canonical = new Canonical("work-metadata-v1", "main-version-shape");
        else if (types.contains(RV + "Space")) canonical = new Canonical("space-realm-v1", "space-shape");
        else if (types.contains(RV + "Realm")) canonical = new Canonical("space-realm-v1", "realm-shape");
        else if (types.contains(RV + "RatingContext"))
            canonical = new Canonical("realm-standing-rating-context-v1", "context-shape");
        else if (types.contains(RV + "RatingObservation"))
            canonical = new Canonical("realm-standing-rating-observation-v1", "observation-shape");
        else if (types.contains(RV + "RatingObservationRevision"))
            canonical = new Canonical("realm-standing-rating-observation-v1", "revision-shape");
        else if (types.contains(RV + "TextContribution"))
            canonical = new Canonical("text-contribution-v1", "contribution-shape");
        else if (types.contains(RV + "PublicationDecision"))
            canonical = new Canonical("text-publication-v1", "decision-shape");
        else if (types.contains(RV + "ClassificationApplication"))
            canonical = new Canonical("classification-direct-decision-v1", "application-shape");
        else if (types.contains(RV + "ClassificationDecision"))
            canonical = new Canonical("classification-direct-decision-v1", "decision-shape");
        else if (types.contains(RV + "ClassificationSense"))
            canonical = new Canonical("classification-proposition-v1", "sense-shape");
        else if (types.contains(RV + "ClassificationContext")) {
            String role = singleObject(dataset, graph, node, RV + "contextRole");
            canonical = new Canonical("classification-context-v1",
                (RV + "GlobalClassification").equals(role) ? "global-shape" : "context-shape");
        } else if (types.contains(RV + "PublicationSelection")) {
            String selectionBasis = singleObject(dataset, graph, node, RV + "selectionBasis");
            canonical = (RV + "MainMaintainer").equals(selectionBasis)
                ? new Canonical("main-default-selection-v1", "selection-shape")
                : new Canonical("realm-local-selection-v1", "selection-shape");
        } else if (types.contains(RV + "RealmPublicationRejection"))
            canonical = new Canonical("realm-local-rejection-v1", "rejection-shape");
        else if (types.contains("http://www.w3.org/2004/02/skos/core#ConceptScheme"))
            canonical = new Canonical("classification-proposition-v1", "scheme-shape");
        else if (types.contains("http://www.w3.org/2004/02/skos/core#Concept"))
            canonical = new Canonical("classification-proposition-v1", "concept-shape");
        else if (types.contains(RV + "ConceptPath"))
            canonical = new Canonical("classification-proposition-v1", "path-shape");
        else if (types.contains(RV + "ClassificationExpression"))
            canonical = new Canonical("classification-proposition-v1", "expression-shape");
        else if (types.contains(RV + "RealmPublicationSlot")) {
            for (String predicate : List.of("realm", "mainVersion", "work", "selectionHead")) {
                if (singleObject(dataset, graph, node, RV + predicate) == null)
                    return invalid("incomplete Realm publication slot: " + subject);
            }
            return null;
        }
        if (canonical == null) return revision ? null : invalid("unrecognized current graph type: " + subject);
        ProfileRegistry.Profile profile = profiles.get(canonical.profile());
        if (profile == null) return invalid("canonical profile unavailable: " + canonical.profile());
        return validateOne(dataset, new Validation(profile, basis + canonical.profile() + "/" + canonical.shape(),
            List.of(subject), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS)));
    }
    private static String singleObject(DatasetGraph dataset, Node graph, Node subject, String predicate) {
        var values = dataset.find(graph, subject, NodeFactory.createURI(predicate), Node.ANY);
        if (!values.hasNext()) return null;
        Node first = values.next().getObject();
        if (values.hasNext()) return null;
        return first.isURI() ? first.getURI() : first.isLiteral() ? first.getLiteralLexicalForm() : null;
    }
    private Map<String, Object> validateOne(DatasetGraph dataset, Validation validation) {
        Model shapes = ModelFactory.createDefaultModel().add(validation.profile().shapes());
        for (String focus : validation.focus()) {
            Resource wrapper = shapes.createResource();
            wrapper.addProperty(shapes.createProperty(SH, "targetNode"), shapes.createResource(focus));
            wrapper.addProperty(shapes.createProperty(SH, "node"), shapes.createResource(validation.shape()));
            wrapper.addProperty(org.apache.jena.vocabulary.RDF.type, shapes.createResource(SH + "NodeShape"));
        }
        Graph union = ModelFactory.createDefaultModel().getGraph();
        for (String graph : validation.graphs()) {
            Graph source = dataset.getGraph(NodeFactory.createURI(graph));
            if (source != null) source.find(Node.ANY, Node.ANY, Node.ANY).forEachRemaining(union::add);
        }
        ValidationReport report = ShaclValidator.get().validate(Shapes.parse(shapes.getGraph()), union);
        if (!report.conforms()) return Map.of("status", "invalid", "report", boundedReport(report.getModel()));
        return null;
    }
    private static String boundedReport(Model report) {
        StringBuilder summary = new StringBuilder();
        var statements = report.listStatements();
        int count = 0;
        while (statements.hasNext() && count++ < 20 && summary.length() < 4000) {
            summary.append(statements.next()).append("\n");
        }
        return summary.substring(0, Math.min(4096, summary.length()));
    }
    private static String receiptValue(DatasetGraph dataset, String receipt, String predicate) {
        var iter = dataset.find(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(receipt),
            NodeFactory.createURI(RV + predicate), Node.ANY);
        if (!iter.hasNext()) return null;
        Node value = iter.next().getObject();
        if (iter.hasNext()) throw new IllegalArgumentException("ambiguous receipt " + predicate);
        return value.isURI() ? value.getURI() : value.getLiteralLexicalForm();
    }
    private static Map<String, Object> committed(DatasetGraph dataset, String receipt) {
        String datasetId = receiptValue(dataset, receipt, "datasetId");
        String epoch = receiptValue(dataset, receipt, "dataEpoch");
        String sequence = receiptValue(dataset, receipt, "sequence");
        if (datasetId == null || epoch == null || sequence == null) return Map.of("status", "committed");
        return Map.of("status", "committed", "position", Map.of("datasetId", datasetId, "dataEpoch", epoch, "sequence", sequence));
    }
    private static JsonObject jsonObject(Map<String, ?> payload) {
        JsonObject result = new JsonObject();
        payload.forEach((key, value) -> {
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> nested = new LinkedHashMap<>();
                map.forEach((k, v) -> nested.put(String.valueOf(k), v));
                result.put(key, jsonObject(nested));
            } else if (value instanceof Number number) result.put(key, number.longValue());
            else result.put(key, String.valueOf(value));
        });
        return result;
    }
    private static void respond(HttpAction action, int status, Map<String, ?> payload) {
        try {
            action.getResponse().setStatus(status);
            action.getResponse().setContentType("application/json; charset=utf-8");
            JSON.write(action.getResponse().getOutputStream(), jsonObject(payload));
        } catch (IOException ex) { throw new IllegalStateException(ex); }
    }
}
