package com.rezics.jena;

import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.atlas.json.JsonObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
import org.apache.jena.update.UpdateFactory;

final class CommandService extends ActionService {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String SH = "http://www.w3.org/ns/shacl#";
    private static final int MAX_REQUEST = 2_000_000;
    private final ProfileRegistry profiles;

    CommandService(ProfileRegistry profiles) { this.profiles = profiles; }

    @Override public void validate(HttpAction action) {}
    @Override public void execute(HttpAction action) {}
    @Override public void execGet(HttpAction action) { respond(action, 200, Map.of("moduleVersion", "0.1.0", "profiles", profiles.digests())); }
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
            long deadline = System.nanoTime() + deadlineMs * 1_000_000L;
            respond(action, 200, run(action.getDataService().getDataset(), receipt, digest, update, validations, deadline));
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
            result.add(new Validation(profile, shape, iris(entry.get("focus")), iris(entry.get("graphs"))));
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

    private Map<String, Object> run(DatasetGraph dataset, String receipt, String digest, String update, List<Validation> validations, long deadline) {
        dataset.begin(org.apache.jena.query.ReadWrite.WRITE);
        boolean commit = false;
        try {
            String existing = receiptValue(dataset, receipt, "requestDigest");
            if (existing != null) return existing.equals(digest) ? committed(dataset, receipt) : Map.of("status", "conflict");
            UpdateAction.execute(UpdateFactory.create(update), DatasetFactory.wrap(dataset));
            String stored = receiptValue(dataset, receipt, "requestDigest");
            if (stored == null) return Map.of("status", "guard-unmatched");
            if (!stored.equals(digest)) return Map.of("status", "conflict");
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
        var iter = dataset.find(Node.ANY, NodeFactory.createURI(receipt), NodeFactory.createURI(RV + predicate), Node.ANY);
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
