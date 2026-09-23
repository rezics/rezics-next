use oxrdf::Literal;
use spargebra::algebra::GraphPattern;
use spargebra::term::TermPattern;
use spargebra::{Query, SparqlParser};
use std::fs;

const TEMPLATE: &str = r#"
PREFIX text: <http://jena.apache.org/text#>
PREFIX s: <https://example.test/search/>
PREFIX ex: <https://example.test/>
SELECT ?s ?score WHERE {
  GRAPH <urn:g:public> {
    (?s ?score) text:query (s:body "__Q__" 20001) .
    ?s ex:cat ex:science .
  }
} ORDER BY DESC(?score) ?s LIMIT 10
"#;

fn replace_placeholder(p: &mut GraphPattern, value: &str) -> usize {
    match p {
        GraphPattern::Bgp { patterns } => patterns
            .iter_mut()
            .filter(|t| matches!(&t.object, TermPattern::Literal(l) if l.value() == "__Q__"))
            .map(|t| t.object = TermPattern::Literal(Literal::new_simple_literal(value)))
            .count(),
        GraphPattern::Graph { inner, .. }
        | GraphPattern::Project { inner, .. }
        | GraphPattern::Slice { inner, .. }
        | GraphPattern::OrderBy { inner, .. }
        | GraphPattern::Distinct { inner }
        | GraphPattern::Filter { inner, .. } => replace_placeholder(inner, value),
        GraphPattern::Join { left, right } => replace_placeholder(left, value) + replace_placeholder(right, value),
        _ => 0,
    }
}

fn compile(user_input: &str) -> String {
    let lucene: String = user_input
        .split_whitespace()
        .map(|t| {
            let escaped: String = t
                .chars()
                .flat_map(|c| if "\\+-!():^[]\"{}~*?|&/".contains(c) { vec!['\\', c] } else { vec![c] })
                .collect();
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut query = SparqlParser::new().parse_query(TEMPLATE).expect("template parses");
    let replaced = match &mut query {
        Query::Select { pattern, .. } => replace_placeholder(pattern, &lucene),
        _ => 0,
    };
    assert_eq!(replaced, 1, "placeholder must be replaced exactly once");
    query.to_string()
}

fn main() {
    let original = SparqlParser::new().parse_query(TEMPLATE).expect("parses");
    let round_trip = original.to_string();
    let reparsed = SparqlParser::new().parse_query(&round_trip).expect("round trip reparses");
    assert_eq!(original, reparsed, "AST stable across serialization");

    let inputs = ["搜索", "中文 功能", r#"搜索"} } ; DROP ALL # "#];
    let mut out = String::new();
    for input in inputs {
        let q = compile(input);
        SparqlParser::new().parse_query(&q).expect("compiled query reparses");
        out.push_str(&format!("### {input}\n{q}\n"));
    }
    fs::write("../evidence/2026-09-23/spargebra-queries.txt", &out).unwrap();
    println!("round trip:\n{round_trip}\n");
    println!("{out}");
}
