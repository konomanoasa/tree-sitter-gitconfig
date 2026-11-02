import assert from "node:assert/strict";
import { test } from "node:test";
import language from "@konomanoasa/tree-sitter-gitconfig";
import Parser from "tree-sitter";

test("Node.js language parses gitconfig and exposes node metadata and highlights", () => {
  const parser = new Parser();
  parser.setLanguage(language);
  const source = "[core]\nname=value\n";
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.type, "document");
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.text, source);
  assert.ok(
    language.nodeTypeInfo.some(
      (node) => node.type === "document" && node.named,
    ),
  );
  const query = new Parser.Query(language, language.HIGHLIGHTS_QUERY);
  assert.deepEqual(
    query.captures(tree.rootNode).map(({ name, node }) => [name, node.text]),
    [
      ["punctuation.bracket", "["],
      ["type", "core"],
      ["punctuation.bracket", "]"],
      ["property", "name"],
      ["operator", "="],
      ["string", "value"],
    ],
  );
});
