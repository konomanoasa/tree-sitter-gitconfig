use konomanoasa_tree_sitter_gitconfig as grammar;
use tree_sitter::{InputEdit, Parser, Point, Query};

#[test]
fn parses_valid_source() {
  let source = "[core]\nname=value\n";
  let language = grammar::LANGUAGE.into();
  let mut parser = Parser::new();
  parser.set_language(&language).unwrap();
  let tree = parser.parse(source, None).unwrap();
  let root = tree.root_node();
  assert_eq!(root.kind(), "document");
  assert_eq!(root.byte_range(), 0..source.len());
  assert!(!root.has_error());
  assert!(grammar::NODE_TYPES.contains("\"document\""));
  Query::new(&language, grammar::HIGHLIGHTS_QUERY).unwrap();
}

#[test]
fn linked_scanner_exposes_an_incomplete_escape_at_eof() {
  let mut parser = Parser::new();
  parser.set_language(&grammar::LANGUAGE.into()).unwrap();
  let tree = parser.parse("[x] a=\\", None).unwrap();
  let root = tree.root_node();
  assert!(!root.has_error());
  let variable = root.named_child(0).unwrap().named_child(1).unwrap();
  let value = variable.child_by_field_name("value").unwrap();
  let issue = value.child_by_field_name("issue").unwrap();
  let outcome = issue.named_child(0).unwrap();
  let reason = outcome.named_child(0).unwrap();
  assert_eq!(issue.kind(), "syntax_issue");
  assert_eq!(outcome.kind(), "incomplete_syntax");
  assert_eq!(reason.kind(), "incomplete_escape");
  assert_eq!(issue.byte_range(), 6..7);
  assert_eq!(outcome.byte_range(), 6..7);
  assert_eq!(reason.byte_range(), 6..7);
}

#[test]
fn inserted_nul_preserves_incremental_value_structure_and_range() {
  let mut parser = Parser::new();
  parser.set_language(&grammar::LANGUAGE.into()).unwrap();
  let mut previous = parser.parse("[x]\na=b", None).unwrap();
  previous.edit(&InputEdit {
    start_byte: 6,
    old_end_byte: 6,
    new_end_byte: 7,
    start_position: Point::new(1, 2),
    old_end_position: Point::new(1, 2),
    new_end_position: Point::new(1, 3),
  });
  let source = "[x]\na=\0b";
  let incremental = parser.parse(source, Some(&previous)).unwrap();
  let fresh = parser.parse(source, None).unwrap();
  assert_eq!(
    incremental.root_node().to_sexp(),
    fresh.root_node().to_sexp()
  );
  for tree in [incremental, fresh] {
    let root = tree.root_node();
    assert!(!root.has_error());
    assert_eq!(root.byte_range(), 0..8);
    let variable = root.named_child(0).unwrap().named_child(2).unwrap();
    let value = variable.child_by_field_name("value").unwrap();
    assert_eq!(value.byte_range(), 6..8);
    assert_eq!(value.named_child(0).unwrap().kind(), "value_text");
  }
}
