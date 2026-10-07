package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonString;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;

/** Exact owner-custodied edition recovery under both writer fences. Historical
 * intent, result and event stay in their existing owners; only the current
 * edition representation and the held restore's scoped cursors are rebuilt. */
final class MetadataRestorePolicy {
    private static final String PREFIX = "urn:rezics:name-migration:metadata-restore:";
    private static final String RV = "https://rezics.com/vocab/";
    private static final String PROFILE_V1 = "https://rezics.com/definition/work-metadata-details-v1";
    private static final String PROFILE_V2 = "https://rezics.com/definition/work-metadata-details-v2";
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS), RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static final Node DEFAULT = Quad.defaultGraphNodeGenerated, PRODUCT = uri("urn:rezics:dataset:product");
    private static final Node MAIN = uri(CommandInvariant.MAIN_STREAM_SCOPE);
    private static final int MAX_FACTS = 64, MAX_STATE_BYTES = 65_536;
    private static final Set<Node> RECEIPT_FIELDS = fields("commandFamily", "requestDigest", "outcome", "datasetId", "dataEpoch", "sequence",
        "work", "sourceReceipt", "sourceDigest", "sourcePayloadDigest", "sourceDataEpoch", "sourceSequence", "sourceMainSequence",
        "sourceAdmissionId", "sourceAuthorityEpoch", "sourceScope", "sourcePredecessor", "metadataComponent", "metadataRevision",
        "metadataManifest", "metadataModel", "metadataState");
    private static final Set<Node> HEADER_FIELDS = fields("work", "metadataKind", "metadataHead", "editionState", "editionLanguage",
        "contentLanguages", "titleLanguage", "tracklistLanguage", "originalLanguages", "isTranslation");
    private static final Set<Node> CURSORS = fields("reconciledPriorSequence", "reconciledPriorMainSequence");
    private static final Set<String> GRANDFATHERED_LANGUAGES = Set.of("en-gb-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak",
        "i-klingon", "i-lux", "i-mingo", "i-navajo", "i-pwn", "i-tao", "i-tay", "i-tsu", "sgn-be-fr", "sgn-be-nl", "sgn-ch-de",
        "art-lojban", "cel-gaulish", "no-bok", "no-nyn", "zh-guoyu", "zh-hakka", "zh-min", "zh-min-nan", "zh-xiang");
    private static final java.util.regex.Pattern LANGUAGE_SYNTAX = java.util.regex.Pattern.compile(
        "^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?"
            + "((?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)((?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)(?:-x(?:-[a-z0-9]{1,8})+)?$",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    @FunctionalInterface interface EditionProjection {
        List<Quad> project(DatasetGraph logical, Node component, Node revision, Node manifest, Node model);
    }
    record Key(Node graph, Node subject) {}
    record Snapshot(DatasetGraph logical, CommandPolicy.Plan plan, Node own, Node work, Node component, Node marker,
        Set<Quad> receipt, Set<Quad> componentFacts, Quad workPointer, Set<Quad> cursors,
        Map<Key,Set<Quad>> expected, String error) {}

    static boolean applies(String receipt) { return receipt.startsWith(PREFIX); }
    static String templateDigest(String update) { return hash(update); }
    static Node templateDigestPredicate() { return rv("metadataRestoreTemplateDigest"); }

    static void validateTemplate(CommandPolicy.Plan plan, String receipt) {
        if (!receipt.matches(PREFIX + "[0-9a-f]{64}") || !(plan.request().getOperations().getFirst() instanceof UpdateModify modify))
            throw new IllegalArgumentException("metadata restore requires its guarded maintenance identity");
        Node own = uri(receipt), component = value(modify,own,"metadataComponent"), revision = value(modify,own,"metadataRevision");
        Node work = value(modify,own,"work");
        if (!plan.graphs().equals(Set.of(CommandPolicy.CONTROL,CommandPolicy.CURRENT,CommandPolicy.REVISIONS,CommandPolicy.RECEIPTS))
            || !plan.current().equals(Set.of(work.getURI(),component.getURI())) || !plan.revisions().equals(Set.of(revision.getURI())))
            throw new IllegalArgumentException("metadata restore graph footprint differs");
        for (Quad quad : modify.getInsertQuads()) {
            if (!quad.getPredicate().isURI() || !(quad.getObject().isURI() || quad.getObject().isLiteral()))
                throw new IllegalArgumentException("metadata restore values must be concrete");
            if (quad.getGraph().equals(RECEIPTS) && (!quad.getSubject().equals(own)
                || !(quad.getPredicate().equals(RDF.type.asNode()) || RECEIPT_FIELDS.contains(quad.getPredicate()))))
                throw new IllegalArgumentException("metadata restore writes only its source-bound maintenance receipt");
            if (quad.getGraph().equals(CONTROL) && !CURSORS.contains(quad.getPredicate()))
                throw new IllegalArgumentException("metadata restore control footprint differs");
        }
        for (Quad quad : modify.getDeleteQuads()) {
            boolean cursor = quad.getGraph().equals(CONTROL) && CURSORS.contains(quad.getPredicate());
            boolean edition = quad.getGraph().equals(CURRENT) && quad.getSubject().equals(component)
                && (HEADER_FIELDS.contains(quad.getPredicate()) || quad.getPredicate().equals(RDF.type.asNode()));
            boolean pointer = quad.getGraph().equals(CURRENT) && quad.getSubject().equals(work) && quad.getPredicate().equals(rv("editionsRevision"));
            if (!(cursor || edition || pointer)) throw new IllegalArgumentException("metadata restore delete footprint differs");
        }
        if (new HashSet<>(modify.getInsertQuads()).size() != modify.getInsertQuads().size())
            throw new IllegalArgumentException("metadata restore footprint is ambiguous");
    }

    static Snapshot capture(DatasetGraph physical, String receipt, String digest, CommandPolicy.Plan plan, EditionProjection projection) {
        try {
            validateTemplate(plan,receipt);
            UpdateModify modify = (UpdateModify)plan.request().getOperations().getFirst(); Node own = uri(receipt);
            Node component = value(modify,own,"metadataComponent"), revision = value(modify,own,"metadataRevision");
            Node work = value(modify,own,"work"), manifest = value(modify,own,"metadataManifest"), model = value(modify,own,"metadataModel");
            Node original = value(modify,own,"sourceReceipt"), predecessor = value(modify,own,"sourcePredecessor");
            Node epoch = value(modify,own,"dataEpoch"), oldEpoch = value(modify,own,"sourceDataEpoch");
            String admission = lexical(value(modify,own,"sourceAdmissionId")), sourceDigest = lexical(value(modify,own,"sourceDigest"));
            String payloadDigest = lexical(value(modify,own,"sourcePayloadDigest"));
            BigInteger diagnostic = number(value(modify,own,"sourceSequence")), mainSequence = number(value(modify,own,"sourceMainSequence"));
            var control = CommandInvariant.readControl(physical);
            if (!nativeId(work) || !nativeId(component) || !nativeId(revision) || !nativeId(predecessor)
                || Set.of(work,component,revision).size() != 3 || revision.equals(predecessor)
                || !manifest.isURI() || !manifest.getURI().matches("urn:rezics:sha256:[0-9a-f]{64}")
                || !Set.of(uri(PROFILE_V1),uri(PROFILE_V2)).contains(model)
                || !epoch.isLiteral() || !oldEpoch.isLiteral() || diagnostic.signum() < 1 || mainSequence.signum() < 1
                || !admission.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                || !sourceDigest.matches("[0-9a-f]{64}") || !payloadDigest.matches("[0-9a-f]{64}")
                || !lexical(value(modify,own,"sourceAuthorityEpoch")).matches("[0-9]+")
                || !value(modify,own,"sourceScope").equals(text("work:edit:" + work.getURI()))
                || !original.equals(uri("urn:rezics:receipt:" + hash(admission + '\0' + "edit-metadata-work"))))
                return failure("metadata restore source identity, authority or pins differ");
            if (control == null || !control.held() || control.marker() == null || control.sequence().signum() != 0
                || !epoch.equals(control.epoch()) || !oldEpoch.equals(control.priorEpoch())
                || !CommandInvariant.hasControlGuards(plan,control)) return failure("metadata restore requires its exact held lineage");
            Node marker = control.marker();
            BigInteger previousDiagnostic = control.cursor() == null ? control.priorSequence() : control.cursor();
            Node savedMain = one(physical,CONTROL,marker,rv("priorMainSequence"));
            Node cursorDiagnostic = one(physical,CONTROL,marker,rv("reconciledPriorSequence"));
            Node cursorMain = one(physical,CONTROL,marker,rv("reconciledPriorMainSequence"));
            if (savedMain == null || (cursorDiagnostic == null) != (cursorMain == null)
                || cursorDiagnostic != null && !number(cursorDiagnostic).equals(control.cursor()))
                return failure("metadata restore saved Main cut or paired cursors are incomplete");
            BigInteger savedMainSequence = number(savedMain);
            BigInteger previousMain = cursorMain == null ? number(savedMain) : number(cursorMain);
            if (previousDiagnostic == null || savedMainSequence.signum() < 0 || previousMain.compareTo(savedMainSequence) < 0
                || diagnostic.compareTo(previousDiagnostic) <= 0 || !mainSequence.equals(previousMain.add(BigInteger.ONE)))
                return failure("metadata restore diagnostic or Main cursor differs");
            String identity = jsonArray("held-slim-metadata-restore-v1",lexical(epoch),lexical(control.routing()),original.getURI(),
                sourceDigest,payloadDigest,lexical(oldEpoch),diagnostic.toString(),mainSequence.toString(),component.getURI(),revision.getURI());
            if (!digest.equals(hash(identity)) || !receipt.equals(PREFIX + digest)
                || !value(modify,own,"requestDigest").equals(text(digest))
                || !value(modify,own,"commandFamily").equals(text("metadata-restore-v1"))
                || !value(modify,own,"datasetId").equals(PRODUCT) || number(value(modify,own,"sequence")).signum() != 0
                || !value(modify,own,"outcome").equals(rv("Succeeded"))
                || !value(modify,own,RDF.type.asNode()).equals(rv("OperationReceipt"))) return failure("metadata restore envelope differs");
            if (physical.contains(RECEIPTS,own,Node.ANY,Node.ANY) || physical.contains(REVISIONS,revision,Node.ANY,Node.ANY))
                return failure("metadata restore source or maintenance receipt is partial or already present");
            if (!physical.contains(CURRENT,work,RDF.type.asNode(),uri("https://schema.org/CreativeWork"))
                || workErased(physical,work) || erased(physical,component) || erased(physical,revision)
                || physical.contains(CURRENT,work,rv("protectionHead"),Node.ANY)) return failure("metadata restore source is erased or unavailable");
            Set<Quad> oldComponent = componentRecord(physical,component);
            if (predecessor.equals(component) ? !oldComponent.isEmpty()
                : !predecessor.equals(onePhysical(physical,component,"metadataHead"))
                    || !work.equals(onePhysical(physical,component,"work")) || erased(physical,predecessor))
                return failure("metadata restore local predecessor or owner differs");
            Node stateNode = required(modify,REVISIONS,revision,rv("metadataState"));
            String stateText = lexical(stateNode);
            if (stateText.getBytes(StandardCharsets.UTF_8).length > MAX_STATE_BYTES
                || !"http://www.w3.org/2001/XMLSchema#string".equals(stateNode.getLiteralDatatypeURI()))
                return failure("metadata restore state exceeds its exact string bound");
            JsonObject state = JSON.parse(stateText);
            Set<Quad> logicalHeader = header(component,work,revision,model,state);
            Node duplicateState = optional(modify,RECEIPTS,own,rv("metadataState"));
            if (duplicateState != null && !duplicateState.equals(stateNode)) return failure("metadata restore duplicate state differs");
            String request = "{\"profile\":" + quote(model.getURI()) + ",\"work\":" + quote(work.getURI())
                + ",\"expectedHead\":" + (predecessor.equals(component) ? "null" : quote(predecessor.getURI())) + ",\"state\":" + stateText + "}";
            if (!sourceDigest.equals(hash(request))) return failure("metadata restore original request digest differs from retained state");
            Set<Quad> revisionRecord = record(REVISIONS,revision,Map.ofEntries(Map.entry(RDF.type.asNode(),rv(model.equals(uri(PROFILE_V2))
                ? "WorkMetadataDetailsV2Revision" : "WorkMetadataRevision")),Map.entry(rv("component"),component),Map.entry(rv("metadataState"),stateNode),
                Map.entry(rv("manifest"),manifest),Map.entry(rv("modelRevision"),model),Map.entry(rv("shapeRevision"),model),
                Map.entry(rv("datasetId"),PRODUCT),Map.entry(rv("dataEpoch"),oldEpoch),Map.entry(rv("sequence"),integer(diagnostic))));
            revisionRecord.add(new Quad(REVISIONS,revision,RDF.type.asNode(),rv("RevisionAnchor")));
            if (!predecessor.equals(component)) revisionRecord.add(new Quad(REVISIONS,revision,rv("predecessor"),predecessor));
            Quad pointer = new Quad(CURRENT,work,rv("editionsRevision"),revision);
            Set<Quad> cursors = Set.of(new Quad(CONTROL,marker,rv("reconciledPriorSequence"),integer(diagnostic)),
                new Quad(CONTROL,marker,rv("reconciledPriorMainSequence"),integer(mainSequence)));
            if (!insertRecord(modify,CURRENT,component).equals(logicalHeader)
                || !insertRecord(modify,CURRENT,work).equals(Set.of(pointer))
                || !insertRecord(modify,REVISIONS,revision).equals(revisionRecord)
                || !graphQuads(modify.getInsertQuads(),CONTROL).equals(cursors)) return failure("metadata restore exact state footprint differs");
            for (Quad quad : modify.getDeleteQuads()) if (quad.getGraph().equals(CONTROL) && !quad.getSubject().equals(marker))
                return failure("metadata restore cursor subject differs");
            CommandOverlay logical = new CommandOverlay(new CommandService.CurrentScope(physical));
            logical.deleteAny(CURRENT,component,Node.ANY,Node.ANY); logical.deleteAny(CURRENT,work,rv("editionsRevision"),Node.ANY);
            logicalHeader.forEach(logical::add); logical.add(pointer); revisionRecord.forEach(logical::add);
            Set<Quad> ownFacts = insertRecord(modify,RECEIPTS,own); ownFacts.forEach(logical::add);
            Set<Quad> projected = projection.project(logical,component,revision,manifest,model).stream()
                .map(MetadataRestorePolicy::canonicalGraph).collect(java.util.stream.Collectors.toUnmodifiableSet());
            if (projected.isEmpty() || projected.size() > MAX_FACTS || projected.stream().anyMatch(q -> !q.getSubject().equals(component)
                || !(q.getGraph().equals(CURRENT) || Quad.isDefaultGraph(q.getGraph())) || !q.getPredicate().isURI()
                || !(q.getObject().isURI() || q.getObject().isLiteral()))) return failure("metadata restore physical projection exceeds component scope");
            if (!projected.contains(new Quad(DEFAULT,component,rv("manifest"),manifest))
                || !projected.contains(new Quad(DEFAULT,component,rv("modelRevision"),model))
                || projected.stream().filter(q -> q.getPredicate().equals(rv("metadataHead"))).count() != 1
                || projected.stream().noneMatch(q -> q.getPredicate().equals(rv("metadataHead")) && q.getObject().equals(revision))
                || projected.stream().filter(q -> q.getPredicate().equals(rv("work"))).count() != 1
                || projected.stream().noneMatch(q -> q.getPredicate().equals(rv("work")) && q.getObject().equals(work)))
                return failure("metadata restore physical projection lost exact pins");
            Map<Key,Set<Quad>> expected = new HashMap<>();
            expected.put(new Key(DEFAULT,component),projected.stream().filter(q -> Quad.isDefaultGraph(q.getGraph())).collect(java.util.stream.Collectors.toSet()));
            expected.put(new Key(CURRENT,component),projected.stream().filter(q -> q.getGraph().equals(CURRENT)).collect(java.util.stream.Collectors.toSet()));
            expected.put(new Key(CONTROL,PRODUCT),boundedRecord(physical,CONTROL,PRODUCT));
            expected.put(new Key(CONTROL,MAIN),boundedRecord(physical,CONTROL,MAIN));
            Set<Quad> markerAfter = new HashSet<>(boundedRecord(physical,CONTROL,marker)); markerAfter.removeIf(q -> CURSORS.contains(q.getPredicate())); markerAfter.addAll(cursors);
            expected.put(new Key(CONTROL,marker),Set.copyOf(markerAfter)); expected.put(new Key(RECEIPTS,own),ownFacts);
            expected.put(new Key(REVISIONS,revision),Set.of()); expected.put(new Key(RECEIPTS,original),boundedRecord(physical,RECEIPTS,original));
            return new Snapshot(logical,plan,own,work,component,marker,ownFacts,projected,pointer,cursors,Map.copyOf(expected),null);
        } catch (RuntimeException ex) { return failure("metadata restore exact source is invalid: " + ex.getMessage()); }
    }

    static void apply(DatasetGraph physical, Snapshot snapshot) {
        if (snapshot.error() != null) throw new IllegalArgumentException(snapshot.error());
        physical.deleteAny(CURRENT,snapshot.component(),Node.ANY,Node.ANY); physical.deleteAny(DEFAULT,snapshot.component(),Node.ANY,Node.ANY);
        physical.deleteAny(CURRENT,snapshot.work(),rv("editionsRevision"),Node.ANY); physical.deleteAny(DEFAULT,snapshot.work(),rv("editionsRevision"),Node.ANY);
        snapshot.componentFacts().forEach(quad -> addPhysical(physical,quad)); addPhysical(physical,snapshot.workPointer());
        snapshot.receipt().forEach(quad -> addPhysical(physical,quad));
        for (Node predicate : CURSORS) physical.deleteAny(CONTROL,snapshot.marker(),predicate,Node.ANY);
        snapshot.cursors().forEach(quad -> addPhysical(physical,quad));
    }
    static String check(DatasetGraph physical, Snapshot snapshot) {
        if (snapshot.error() != null) return snapshot.error();
        for (var expected : snapshot.expected().entrySet()) if (!boundedRecord(physical,expected.getKey().graph(),expected.getKey().subject()).equals(expected.getValue()))
            return "metadata restore physical poststate or held control differs: " + expected.getKey();
        Set<Quad> pointers = physicalProperty(physical,snapshot.work(),rv("editionsRevision"));
        return pointers.equals(Set.of(snapshot.workPointer())) ? null : "metadata restore Work edition pointer differs";
    }
    private static Snapshot failure(String error) { return new Snapshot(null,null,null,null,null,null,Set.of(),Set.of(),null,Set.of(),Map.of(),error); }
    private static Set<Quad> header(Node component,Node work,Node revision,Node model,JsonObject state) {
        if (!ProfileRegistry.required(state,"kind").equals("edition") || !ProfileRegistry.required(state,"id").equals(component.getURI())
            || !Set.of("active","withdrawn").contains(ProfileRegistry.required(state,"status"))) throw new IllegalArgumentException("retained edition state identity differs");
        boolean v2 = model.equals(uri(PROFILE_V2));
        Set<String> allowed = new HashSet<>(List.of("kind","id","status","title","editionStatement","publisher","publicationYear","isbn13"));
        allowed.addAll(v2 ? List.of("contentLanguages","isTranslation","originalLanguages","titleLanguage","tracklistLanguage") : List.of("contentLanguage"));
        if (!state.keys().equals(allowed)) throw new IllegalArgumentException("retained edition state fields differ from its profile");
        Set<Quad> facts = record(CURRENT,component,Map.of(RDF.type.asNode(),rv(v2 ? "EditionRecord" : "WorkMetadataComponent"),rv("work"),work,
            rv("metadataKind"),text("edition"),rv("metadataHead"),revision,rv("editionState"),rv(ProfileRegistry.required(state,"status").equals("active") ? "Active" : "Withdrawn")));
        if (v2) {
            List<String> languages = tags(state.get("contentLanguages"),8), originals = tags(state.get("originalLanguages"),4);
            if (languages.stream().anyMatch(tag -> tag.equalsIgnoreCase("und"))
                || languages.stream().anyMatch(tag -> tag.equalsIgnoreCase("zxx")) && languages.size() != 1
                || originals.stream().anyMatch(tag -> tag.equalsIgnoreCase("zxx")))
                throw new IllegalArgumentException("retained edition language semantics differ");
            boolean translation = state.get("isTranslation").getAsBoolean().value();
            if (translation == originals.isEmpty()) throw new IllegalArgumentException("retained edition translation languages differ");
            if (!languages.isEmpty()) facts.add(new Quad(CURRENT,component,rv("contentLanguages"),text(String.join(" ",languages))));
            if (languages.size() == 1) facts.add(new Quad(CURRENT,component,rv("editionLanguage"),text(languages.getFirst())));
            if (!originals.isEmpty()) facts.add(new Quad(CURRENT,component,rv("originalLanguages"),text(String.join(" ",originals))));
            if (translation) facts.add(new Quad(CURRENT,component,rv("isTranslation"),text("true")));
            addLanguage(facts,component,state,"titleLanguage",true); addLanguage(facts,component,state,"tracklistLanguage",true);
        } else addLanguage(facts,component,state,"contentLanguage",false,"editionLanguage");
        return Set.copyOf(facts);
    }
    private static List<String> tags(JsonValue value,int limit) {
        JsonArray array = value.getAsArray(); if (array.size() > limit) throw new IllegalArgumentException("retained language list exceeds bound");
        List<String> tags = new ArrayList<>(); for (JsonValue item : array) { String tag = item.getAsString().value(); language(tag);
            if (tag.equalsIgnoreCase("mul")) throw new IllegalArgumentException("retained language list contains mul"); tags.add(tag); }
        if (tags.stream().map(tag -> tag.toLowerCase(java.util.Locale.ROOT)).distinct().count() != tags.size()
            || !tags.equals(tags.stream().sorted().toList())) throw new IllegalArgumentException("retained language list is not canonical");
        return tags;
    }
    private static void addLanguage(Set<Quad> facts,Node component,JsonObject state,String field,boolean optionalText) { addLanguage(facts,component,state,field,optionalText,field); }
    private static void addLanguage(Set<Quad> facts,Node component,JsonObject state,String field,boolean optionalText,String predicate) {
        JsonValue value = state.get(field); if (!value.isNull()) { String tag = value.getAsString().value(); language(tag);
            if (optionalText && (tag.equalsIgnoreCase("und") || tag.equalsIgnoreCase("mul"))) throw new IllegalArgumentException("retained optional text language is not admitted");
            facts.add(new Quad(CURRENT,component,rv(predicate),text(tag))); }
    }
    /** Match Main's RFC 5646 syntax admission, including its uncommon recorded
     * forms. Comparison folds case only for duplicate detection; the retained
     * spelling and JSON bytes remain untouched. */
    private static void language(String tag) {
        String comparison = tag.toLowerCase(java.util.Locale.ROOT);
        if (tag.matches("(?i)^x(?:-[a-z0-9]{1,8})+$") || GRANDFATHERED_LANGUAGES.contains(comparison)) return;
        var match = LANGUAGE_SYNTAX.matcher(tag);
        if (!match.matches()) throw new IllegalArgumentException("retained language tag differs");
        Set<String> variants = new HashSet<>();
        for (String variant : match.group(1).toLowerCase(java.util.Locale.ROOT).split("-"))
            if (!variant.isEmpty() && !variants.add(variant)) throw new IllegalArgumentException("retained language variant is duplicated");
        Set<String> singletons = new HashSet<>();
        for (String extension : match.group(2).toLowerCase(java.util.Locale.ROOT).split("-"))
            if (extension.length() == 1 && !singletons.add(extension)) throw new IllegalArgumentException("retained language extension singleton is duplicated");
    }
    private static boolean erased(DatasetGraph data,Node node) {
        if (data.contains(REVISIONS,node,RDF.type.asNode(),rv("ErasedRevision"))) return true;
        Node head = onePhysical(data,node,"head"); return head != null && data.contains(REVISIONS,head,RDF.type.asNode(),rv("ErasedRevision"));
    }
    private static boolean workErased(DatasetGraph data,Node work) {
        if (erased(data,work)) return true;
        // Match the live Work mutation's unerased predicate. The resource index
        // scopes this existence check to one Work; an edition's 64-quad bound
        // does not impose a new limit on that Work's published variants.
        var variants = data.find(CURRENT,Node.ANY,rv("resource"),work);
        try {
            while (variants.hasNext()) {
                Node variant = variants.next().getSubject();
                Node publication = one(data,CURRENT,variant,rv("contentPublicationHead"));
                if (publication == null) continue;
                if (!publication.isURI()) throw new IllegalArgumentException("restored publication head is not an IRI");
                Node revision = one(data,REVISIONS,publication,rv("contentRevision"));
                if (revision != null && !revision.isURI()) throw new IllegalArgumentException("restored Content revision is not an IRI");
                if (revision != null && data.contains(REVISIONS,revision,RDF.type.asNode(),rv("ErasedRevision"))) return true;
            }
            return false;
        } finally { Iter.close(variants); }
    }
    private static Node onePhysical(DatasetGraph data,Node subject,String field) {
        Set<Node> values = new HashSet<>(); for (Quad q : physicalProperty(data,subject,rv(field))) values.add(q.getObject());
        if (values.size() > 1) throw new IllegalArgumentException("metadata restore physical field is ambiguous"); return values.isEmpty() ? null : values.iterator().next();
    }
    private static Set<Quad> physicalProperty(DatasetGraph data,Node subject,Node predicate) {
        Set<Quad> values = new HashSet<>(); for (Node graph : List.of(CURRENT,DEFAULT)) {
            var iter = data.find(graph,subject,predicate,Node.ANY); try { while (iter.hasNext()) { if (values.size() >= MAX_FACTS) throw new IllegalArgumentException("metadata restore property exceeds bound"); values.add(canonicalGraph(iter.next())); } } finally { Iter.close(iter); }
        } return values;
    }
    private static Set<Quad> componentRecord(DatasetGraph data,Node component) {
        Set<Quad> result = new HashSet<>(boundedRecord(data,CURRENT,component)); result.addAll(boundedRecord(data,DEFAULT,component));
        if (result.size() > MAX_FACTS) throw new IllegalArgumentException("metadata restore component exceeds quad bound"); return result;
    }
    private static Set<Quad> boundedRecord(DatasetGraph data,Node graph,Node subject) {
        Set<Quad> result = new HashSet<>(); var iter = data.find(graph,subject,Node.ANY,Node.ANY);
        try { while (iter.hasNext()) { if (result.size() >= MAX_FACTS) throw new IllegalArgumentException("metadata restore record exceeds quad bound"); result.add(canonicalGraph(iter.next())); } } finally { Iter.close(iter); } return Set.copyOf(result);
    }
    private static Quad canonicalGraph(Quad quad) { return Quad.isDefaultGraph(quad.getGraph()) ? new Quad(DEFAULT,quad.asTriple()) : quad; }
    private static void addPhysical(DatasetGraph data,Quad quad) { data.add(quad.getGraph(),quad.getSubject(),quad.getPredicate(),quad.getObject()); }
    private static Node one(DatasetGraph data,Node graph,Node subject,Node predicate) {
        var iter = data.find(graph,subject,predicate,Node.ANY); try { if (!iter.hasNext()) return null; Node value = iter.next().getObject();
            if (iter.hasNext()) throw new IllegalArgumentException("metadata restore control field is ambiguous"); return value; } finally { Iter.close(iter); }
    }
    private static Set<Quad> graphQuads(List<Quad> quads,Node graph) { Set<Quad> result = new HashSet<>(); for (Quad q : quads) if (q.getGraph().equals(graph)) result.add(q); return result; }
    private static Set<Quad> insertRecord(UpdateModify modify,Node graph,Node subject) { Set<Quad> result = new HashSet<>(); for (Quad q : modify.getInsertQuads()) if (q.getGraph().equals(graph) && q.getSubject().equals(subject)) result.add(q); return Set.copyOf(result); }
    private static Node value(UpdateModify modify,Node own,String field) { return required(modify,RECEIPTS,own,rv(field)); }
    private static Node value(UpdateModify modify,Node own,Node predicate) { return required(modify,RECEIPTS,own,predicate); }
    private static Node required(UpdateModify modify,Node graph,Node subject,Node predicate) { Node value = optional(modify,graph,subject,predicate); if (value == null) throw new IllegalArgumentException("required restore source field missing: " + predicate); return value; }
    private static Node optional(UpdateModify modify,Node graph,Node subject,Node predicate) { Node result = null; for (Quad q : modify.getInsertQuads()) if (q.getGraph().equals(graph) && q.getSubject().equals(subject) && q.getPredicate().equals(predicate)) {
        if (result != null) throw new IllegalArgumentException("ambiguous restore source field: " + predicate); result = q.getObject(); } return result; }
    private static Set<Quad> record(Node graph,Node subject,Map<Node,Node> values) { Set<Quad> result = new HashSet<>(); values.forEach((p,o) -> result.add(new Quad(graph,subject,p,o))); return result; }
    private static Set<Node> fields(String... names) { Set<Node> result = new HashSet<>(); for (String name : names) result.add(rv(name)); return Set.copyOf(result); }
    private static BigInteger number(Node value) { if (value == null || !value.isLiteral() || !"http://www.w3.org/2001/XMLSchema#integer".equals(value.getLiteralDatatypeURI())) throw new IllegalArgumentException("restore position is not an integer"); return new BigInteger(value.getLiteralLexicalForm()); }
    private static String lexical(Node value) { if (!value.isLiteral()) throw new IllegalArgumentException("restore source field is not a literal"); return value.getLiteralLexicalForm(); }
    private static boolean nativeId(Node value) { return value != null && value.isURI() && value.getURI().matches("https://rezics.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}"); }
    private static String jsonArray(String... values) {
        return java.util.Arrays.stream(values).map(MetadataRestorePolicy::quote)
            .collect(java.util.stream.Collectors.joining(",", "[", "]"));
    }
    private static String quote(String value) { return JSON.toStringFlat(new JsonString(value)); }
    private static String hash(String value) { try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); } catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); } }
    private static Node integer(BigInteger value) { return NodeFactory.createLiteralByValue(value,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node rv(String value) { return uri(RV + value); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private MetadataRestorePolicy() {}
}
