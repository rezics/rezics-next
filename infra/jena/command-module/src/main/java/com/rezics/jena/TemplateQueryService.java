package com.rezics.jena;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.datatypes.TypeMapper;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.ResultSetFormatter;
import org.apache.jena.query.Syntax;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Var;
import org.apache.jena.sparql.engine.binding.Binding;
import org.apache.jena.sparql.engine.binding.BindingBuilder;
import org.apache.jena.sparql.expr.Expr;
import org.apache.jena.sparql.expr.ExprFunctionOp;
import org.apache.jena.sparql.syntax.*;
import org.apache.jena.sparql.syntax.syntaxtransform.ElementTransformCopyBase;
import org.apache.jena.sparql.syntax.syntaxtransform.QueryTransformOps;

/** Native term binding for server-reviewed SELECTs. This is not a physical
 * eligibility proof: the calling adapter must supply its qualified candidate
 * source before executing a template. No query text comes from public clients. */
final class TemplateQueryService {
    static final int MAX_ROWS = 256;
    static final int MAX_BYTES = 512 * 1024;
    private static final Set<String> GRAPHS = Set.of(
        "urn:rezics:graph:current", "urn:rezics:graph:revisions");

    record Terms(List<Var> columns, List<Binding> rows) {}
    record Prepared(Query query, Binding parameters,List<Binding> candidates) {}

    static Prepared prepare(JsonObject body) {
        try { return prepareInput(body); }
        catch (IllegalArgumentException error) { throw error; }
        catch (RuntimeException error) { throw new IllegalArgumentException("invalid template query input", error); }
    }

    private static Prepared prepareInput(JsonObject body) {
        if (!Set.of("query", "bindings", "tables", "limit","candidates").containsAll(body.keys())
            || !body.keys().containsAll(Set.of("query","bindings","tables","limit")))
            throw new IllegalArgumentException("invalid template query fields");
        int limit = integer(body.get("limit"), 1, MAX_ROWS);
        String source = ProfileRegistry.required(body, "query");
        if (source.length() > 64 * 1024) throw new IllegalArgumentException("template text exceeds bound");
        Query query = QueryFactory.create(source, Syntax.syntaxSPARQL_11);
        review(query);
        Binding parameters = binding(body.get("bindings").getAsObject());
        if (parameters.size() > 64) throw new IllegalArgumentException("too many parameter terms");
        List<Terms> tables = new ArrayList<>();
        Set<List<Var>> signatures = new HashSet<>();
        int rows = 0;
        for (JsonValue value : body.get("tables").getAsArray()) {
            JsonObject table = value.getAsObject();
            List<Var> columns = new ArrayList<>();
            for (JsonValue column : table.get("columns").getAsArray()) columns.add(variable(column.getAsString().value()));
            if (columns.isEmpty() || columns.size() > 16 || new HashSet<>(columns).size() != columns.size()
                || !signatures.add(List.copyOf(columns))) throw new IllegalArgumentException("invalid table columns");
            for (Var column : columns) if (parameters.contains(column))
                throw new IllegalArgumentException("table and scalar binding overlap");
            List<Binding> bindings = new ArrayList<>();
            for (JsonValue row : table.get("rows").getAsArray()) {
                var cells = row.getAsArray();
                if (cells.size() != columns.size()) throw new IllegalArgumentException("table row arity differs");
                BindingBuilder builder = BindingBuilder.create();
                for (int i = 0; i < columns.size(); i++) builder.add(columns.get(i), term(cells.get(i).getAsObject()));
                bindings.add(builder.build());
                if (++rows > MAX_ROWS) throw new IllegalArgumentException("candidate terms exceed bound");
            }
            tables.add(new Terms(List.copyOf(columns), List.copyOf(bindings)));
            if (tables.size() > 4) throw new IllegalArgumentException("too many binding tables");
        }
        Set<List<Var>> consumed = new HashSet<>();
        query = QueryTransformOps.transform(query, new ElementTransformCopyBase() {
            @Override public Element transform(ElementData data) {
                for (Terms table : tables) if (data.getVars().equals(table.columns())) {
                    if (!data.getRows().isEmpty() || !consumed.add(table.columns()))
                        throw new IllegalArgumentException("binding table must replace one empty VALUES block");
                    return new ElementData(table.columns(), table.rows());
                }
                return super.transform(data);
            }
        });
        if (consumed.size() != tables.size()) throw new IllegalArgumentException("binding table has no template slot");
        Set<String> anchors = new HashSet<>();
        parameters.forEach((variable,node) -> { if(node.isURI()) anchors.add(variable.getVarName()); });
        for(Terms table : tables) for(Binding row : table.rows()) row.forEach((variable,node) -> {
            if(node.isURI()) anchors.add(variable.getVarName());
        });
        reviewHops(query,anchors);
        // LIMIT is a parsed-query property. Neither scalars nor tuple cells are
        // serialized into SPARQL; Jena substitutes RDF Nodes in the syntax tree.
        query.setLimit(limit);
        List<Binding> candidates=new ArrayList<>();
        if(body.get("candidates")!=null) for(var row:body.get("candidates").getAsArray()) {
            candidates.add(binding(row.getAsObject()));
            if(candidates.size()>MAX_ROWS) throw new IllegalArgumentException("too many candidate qualifications");
        }
        return new Prepared(query, parameters,List.copyOf(candidates));
    }

    /** Pre-plan Node substitution requires removing bound VALUES columns first.
     * This preserves tuple compatibility and allows each selected subject/head
     * to become an exact graph index lookup even across UNION/EXISTS branches. */
    static Query bind(Query query,Binding terms) {
        var values=new java.util.HashMap<Var,Node>();terms.forEach(values::put);
        Query stripped=QueryTransformOps.transform(query,new ElementTransformCopyBase() {
            @Override public Element transform(ElementData table) {
                List<Var> columns=table.getVars().stream().filter(variable->!values.containsKey(variable)).toList();
                List<Binding> rows=new ArrayList<>();
                for(Binding row:table.getRows()) {
                    boolean compatible=true;
                    for(Var variable:table.getVars()) if(values.containsKey(variable) && row.contains(variable)
                        && !values.get(variable).equals(row.get(variable))) compatible=false;
                    if(!compatible) continue;
                    BindingBuilder builder=BindingBuilder.create();
                    for(Var variable:columns) if(row.contains(variable)) builder.add(variable,row.get(variable));
                    rows.add(builder.build());
                }
                return new ElementData(columns,rows);
            }
            @Override public Element transform(ElementBind element,Var variable,Expr expression) {
                return values.containsKey(variable) ? new ElementFilter(new org.apache.jena.sparql.expr.E_Equals(
                    expression,org.apache.jena.sparql.expr.NodeValue.makeNode(values.get(variable))))
                    : super.transform(element,variable,expression);
            }
        });
        return QueryTransformOps.replaceVars(stripped,values);
    }

    static JsonObject select(DatasetGraph dataset, JsonObject body) {
        Prepared prepared = prepare(body);
        dataset.begin(ReadWrite.READ);
        try {
            List<Binding> candidates=prepared.candidates().isEmpty()?List.of(org.apache.jena.sparql.engine.binding.BindingFactory.empty()):prepared.candidates();
            org.apache.jena.atlas.json.JsonArray collected=new org.apache.jena.atlas.json.JsonArray();
            JsonObject head=null;long deadline=System.nanoTime()+10_000_000_000L;
            for(Binding candidate:candidates) {
                BindingBuilder builder=BindingBuilder.create();prepared.parameters().forEach(builder::add);candidate.forEach(builder::add);
                Query query=bind(prepared.query(),builder.build());
                long remaining=(deadline-System.nanoTime())/1_000_000L;
                if(remaining<=0) throw new IllegalArgumentException("template deadline exceeded");
                try(QueryExecution execution=QueryExecution.dataset(DatasetFactory.wrap(dataset)).query(query).timeout(remaining).build()) {
                    ByteArrayOutputStream chunk=new ByteArrayOutputStream();
                    ResultSetFormatter.outputAsJSON(chunk,execution.execSelect());
                    JsonObject result=JSON.parse(chunk.toString(java.nio.charset.StandardCharsets.UTF_8));
                    head=result.get("head").getAsObject();
                    for(var row:result.get("results").getAsObject().get("bindings").getAsArray()) {
                        collected.add(row);
                        if(collected.size()>MAX_ROWS) throw new IllegalArgumentException("template result exceeds candidate bound");
                    }
                }
            }
            JsonObject result=new JsonObject(),bindings=new JsonObject();
            result.put("head",head);bindings.put("bindings",collected);result.put("results",bindings);
            ByteArrayOutputStream output = new ByteArrayOutputStream() {
                @Override public synchronized void write(int value) {
                    if (count >= MAX_BYTES) throw new IllegalArgumentException("template response exceeds byte bound");
                    super.write(value);
                }
                @Override public synchronized void write(byte[] bytes, int offset, int length) {
                    if (length > MAX_BYTES - count) throw new IllegalArgumentException("template response exceeds byte bound");
                    super.write(bytes, offset, length);
                }
            };
            JSON.write(output,result);
            return JSON.parse(output.toString(java.nio.charset.StandardCharsets.UTF_8));
        } finally { dataset.end(); }
    }

    private static int integer(JsonValue value, int minimum, int maximum) {
        int number;
        try { number = new java.math.BigDecimal(value.getAsNumber().value().toString()).intValueExact(); }
        catch (ArithmeticException error) { throw new IllegalArgumentException("invalid template row limit", error); }
        if (number < minimum || number > maximum) throw new IllegalArgumentException("invalid template row limit");
        return number;
    }

    private static Var variable(String value) {
        if (!value.matches("[A-Za-z_][A-Za-z0-9_]*")) throw new IllegalArgumentException("invalid binding variable");
        return Var.alloc(value);
    }

    private static Binding binding(JsonObject object) {
        BindingBuilder builder = BindingBuilder.create();
        for (String name : object.keys()) builder.add(variable(name), term(object.get(name).getAsObject()));
        return builder.build();
    }

    static Node term(JsonObject object) {
        if (!Set.of("type", "value", "datatype", "language").containsAll(object.keys()))
            throw new IllegalArgumentException("unsupported RDF term fields");
        String type = ProfileRegistry.required(object, "type");
        JsonValue lexical = object.get("value");
        if (lexical == null || !lexical.isString()) throw new IllegalArgumentException("RDF term value is required");
        String value = lexical.getAsString().value();
        if (value.length() > 8192) throw new IllegalArgumentException("RDF term exceeds bound");
        String datatype = object.get("datatype") == null ? null : object.get("datatype").getAsString().value();
        String language = object.get("language") == null ? null : object.get("language").getAsString().value();
        if ("uri".equals(type)) {
            if (datatype != null || language != null) throw new IllegalArgumentException("IRI has literal metadata");
            return NodeFactory.createURI(absoluteIri(value));
        }
        if (!"literal".equals(type) || datatype != null && language != null)
            throw new IllegalArgumentException("unsupported RDF term");
        if (language != null) {
            if (!language.matches("[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*")) throw new IllegalArgumentException("invalid literal language");
            return NodeFactory.createLiteralLang(value, language);
        }
        return datatype == null ? NodeFactory.createLiteralString(value)
            : NodeFactory.createLiteralDT(value, TypeMapper.getInstance().getSafeTypeByName(absoluteIri(datatype)));
    }

    private static String absoluteIri(String value) {
        if (!value.matches("[A-Za-z][A-Za-z0-9+.-]*:[^<>\\s\"{}|\\\\^`]+"))
            throw new IllegalArgumentException("invalid absolute RDF IRI");
        return value;
    }

    private static void review(Query query) {
        if (!query.isSelectType() || query.hasDatasetDescription() || query.hasOffset()
            || query.hasAggregators() || query.hasGroupBy()) throw new IllegalArgumentException("unsupported template query form");
        review(query.getQueryPattern(), false);
        query.getProject().getExprs().values().forEach(TemplateQueryService::review);
        if (query.getOrderBy() != null) query.getOrderBy().forEach(sort -> review(sort.expression));
        query.getHavingExprs().forEach(TemplateQueryService::review);
    }

    private static void review(Expr expression) {
        review(expression, false);
    }

    private static void review(Expr expression, boolean namedGraph) {
        if (!expression.isFunction()) return;
        var function = expression.getFunction();
        if (function.getFunctionIRI() != null) throw new IllegalArgumentException("extension functions are not admitted");
        if (function instanceof ExprFunctionOp graph) review(graph.getElement(), namedGraph);
        function.getArgs().forEach(argument -> review(argument, namedGraph));
    }

    private static void review(Element element, boolean namedGraph) {
        if (element instanceof ElementGroup group) group.getElements().forEach(child -> review(child, namedGraph));
        else if (element instanceof ElementUnion union) union.getElements().forEach(child -> review(child, namedGraph));
        else if (element instanceof ElementNamedGraph graph) {
            if (!graph.getGraphNameNode().isURI() || !GRAPHS.contains(graph.getGraphNameNode().getURI()))
                throw new IllegalArgumentException("template graphs must be fixed");
            review(graph.getElement(), true);
        } else if (element instanceof ElementOptional optional) review(optional.getOptionalElement(), namedGraph);
        else if (element instanceof ElementMinus minus) review(minus.getMinusElement(), namedGraph);
        else if (element instanceof ElementFilter filter) review(filter.getExpr(), namedGraph);
        else if (element instanceof ElementBind bind) review(bind.getExpr(), namedGraph);
        else if (element instanceof ElementSubQuery subquery) review(subquery.getQuery());
        else if (element instanceof ElementPathBlock paths) {
            if (!namedGraph) throw new IllegalArgumentException("default graph is not admitted");
            paths.patternElts().forEachRemaining(path -> {
                if (!path.isTriple()) throw new IllegalArgumentException("property paths are not admitted");
            });
        } else if (element instanceof ElementTriplesBlock) {
            if (!namedGraph) throw new IllegalArgumentException("default graph is not admitted");
        } else if (!(element instanceof ElementData)) throw new IllegalArgumentException("unsupported template element");
    }

    /** Count variable-node expansion from supplied RDF anchors, not constraint
     * checks against fixed IRIs/literals. Every graph expansion is at most two
     * edges from a bounded root/candidate. Empty tables execute no expansion. */
    private static void reviewHops(Query query,Set<String> anchors) {
        if(anchors.isEmpty()) return;
        java.util.Map<String,Set<String>> edges = new java.util.HashMap<>();
        java.util.function.Consumer<org.apache.jena.graph.Triple> add = triple -> {
            Node a=triple.getSubject(),b=triple.getObject();
            if(a.isVariable() && b.isVariable()) {
                edges.computeIfAbsent(a.getName(),ignored->new HashSet<>()).add(b.getName());
                edges.computeIfAbsent(b.getName(),ignored->new HashSet<>()).add(a.getName());
            }
        };
        var visitor = new ElementVisitorBase() {
            @Override public void visit(ElementPathBlock block) { block.patternElts().forEachRemaining(path->add.accept(path.asTriple())); }
            @Override public void visit(ElementTriplesBlock block) { block.patternElts().forEachRemaining(add); }
            @Override public void visit(ElementSubQuery sub) { reviewHops(sub.getQuery(),anchors); }
        };
        ElementWalker.walk(query.getQueryPattern(),visitor);
        java.util.Map<String,Integer> distance=new java.util.HashMap<>();
        java.util.ArrayDeque<String> queue=new java.util.ArrayDeque<>();
        anchors.forEach(anchor->{distance.put(anchor,0);queue.add(anchor);});
        while(!queue.isEmpty()) {
            String node=queue.remove();int depth=distance.get(node);
            for(String next:edges.getOrDefault(node,Set.of())) if(!distance.containsKey(next)) {distance.put(next,depth+1);queue.add(next);}
        }
        if(edges.keySet().stream().anyMatch(node->distance.getOrDefault(node,3)>2))
            throw new IllegalArgumentException("template expands beyond two hops from its RDF bindings");
    }

    private TemplateQueryService() {}
}
