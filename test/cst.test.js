import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../scripts/tree-sitter.js";
import nodeTypes from "../src/node-types.json" with { type: "json" };
import { parseCorpus } from "./support/corpus.js";
import { issues, leaves, owners, parseCst } from "./support/cst.js";
import {
  applyEdits,
  assertEditHistory,
  assertIncrementalEqualsFresh,
  parse,
} from "./support/parser.js";

const corpusDirectory = join(root, "test/corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  assert.ok(file.endsWith(".txt"), `unexpected corpus entry: ${file}`);
  const entries = parseCorpus(
    readFileSync(join(corpusDirectory, file), "utf8"),
  );
  for (const { name, source } of entries) {
    test(`gitconfig: corpus source coverage issue structure and fresh determinism: ${file}: ${name}`, () => {
      const tree = parse(source);
      issues(tree);
      for (const node of tree.filter(({ kind }) => kind === "syntax_issue")) {
        assert.equal(node.field, "issue");
      }
      assert.deepEqual(parse(source), tree);
    });
  }
}

test("gitconfig: corpus inputs retain BOM NUL whitespace and line endings", () => {
  const text = [
    "==================\nEmpty\n==================\n\n---\n(document)\n\n",
    "==================\nLayout\n:cst\n==================\n",
    "\uFEFF \t\v\f\r\na text\n\n\n---\nignored output\n\n",
    "==================\nNUL\n:cst\n==================\n",
    "\0=\0\n---\nignored output\n\n",
    "==================\nFinal CR\n:cst\n==================\n",
    "a text\r\r\n---\nignored output\n",
  ].join("");
  assert.deepEqual(parseCorpus(text), [
    { name: "Empty", source: "" },
    { name: "Layout", source: "\uFEFF \t\v\f\r\na text\n\n" },
    { name: "NUL", source: "\0=\0" },
    { name: "Final CR", source: "a text\r" },
  ]);
});

test("gitconfig: corpus input reader rejects unsupported conditions and framing", () => {
  for (const text of [
    "not a corpus file",
    "==================\nUnclosed header\n",
    "==================\nSkipped\n:skip\n==================\na text\n---\n",
    "==================\nNo separator\n==================\na text\n",
  ]) {
    assert.throws(() => parseCorpus(text), { code: "ERR_ASSERTION" }, text);
  }
});

test("gitconfig: public issue nodes have one outcome and one reason leaf", () => {
  const issue = nodeTypes.find(({ type }) => type === "syntax_issue");
  assert.ok(issue);
  assert.ok(issue.children);
  assert.equal(issue.children.required, true);
  assert.equal(issue.children.multiple, false);
  assert.deepEqual(
    issue.children.types.map(({ type }) => type),
    ["incomplete_syntax", "invalid_syntax"],
  );
  for (const { type } of issue.children.types) {
    const outcome = nodeTypes.find((node) => node.type === type);
    assert.ok(outcome, type);
    assert.ok(outcome.children, type);
    assert.equal(outcome.children.required, true);
    assert.equal(outcome.children.multiple, false);
    for (const child of outcome.children.types) {
      const reason = nodeTypes.find((node) => node.type === child.type);
      assert.ok(reason, child.type);
      assert.equal(reason.children, undefined);
    }
  }
});

test("gitconfig: invalid whitespace cannot absorb a header decoding failure", () => {
  const source = Buffer.from([91, 120, 32, 34, 97, 34, 32, 255, 32, 93]);
  const nodes = parse(source);
  assert.deepEqual(issues(nodes), [
    ["invalid_syntax", "unexpected_header_content", 6, 7],
    ["invalid_syntax", "invalid_encoding", 7, 8],
    ["invalid_syntax", "unexpected_header_content", 8, 9],
  ]);
  assert.deepEqual(owners(nodes), [
    "section_header",
    "section_header",
    "section_header",
  ]);
  for (const node of nodes.filter(({ kind }) => kind === "syntax_issue"))
    assert.equal(node.field, "issue");
});

test("gitconfig: invalid encoding before continuation preserves value text ranges", () => {
  const source = Buffer.from([
    91, 120, 93, 32, 97, 61, 255, 92, 10, 32, 32, 99,
  ]);
  const nodes = parse(source);
  assert.deepEqual(issues(nodes), [
    ["invalid_syntax", "invalid_encoding", 6, 7],
  ]);
  assert.deepEqual(
    nodes
      .filter(({ kind }) => kind === "value_text")
      .map(({ start, end }) => [
        start,
        end,
        source.subarray(start, end).toString(),
      ]),
    [[9, 12, "  c"]],
  );
});

for (const [name, prefix, suffix, owner] of [
  ["section name", "[a", "b]", "section_name"],
  ["variable name", "[x] a", "b=1", "variable_name"],
  ["subsection", '[x "a', 'b"]', "subsection"],
  ["value", "[x] a=b", "c", "value"],
  ["quoted value", '[x] a="b', 'c"', "quoted_value"],
  ["comment", "# a", "b", "comment"],
  ["after value escape", "[x] a=\\", "b", "value"],
  ["after subsection escape", '[x "a\\', 'b"]', "subsection"],
  ["header tail", '[x "a"', "]", "section_header"],
]) {
  test(`gitconfig: invalid UTF-8 runs in ${name}`, () => {
    const invalidBytes = Buffer.from([255, 254, 128]);
    const source = Buffer.concat([
      Buffer.from(prefix),
      invalidBytes,
      Buffer.from(suffix),
    ]);
    const tree = parse(source);
    assert.deepEqual(issues(tree), [
      [
        "invalid_syntax",
        "invalid_encoding",
        Buffer.byteLength(prefix),
        Buffer.byteLength(prefix) + invalidBytes.length,
      ],
    ]);
    assert.deepEqual(owners(tree), [owner]);
  });
}

test("gitconfig: invalid UTF-8 sequence reports the failed range", () => {
  const source = Buffer.from([91, 120, 93, 32, 97, 61, 0xc3, 0x28]);
  assert.deepEqual(issues(parse(source)), [
    ["invalid_syntax", "invalid_encoding", 6, 7],
  ]);
});

for (const [owner, prefix, suffix] of [
  ["quoted value", '[a]\nx="', '"'],
  ["comment", "# a", "b"],
  ["section name", "[a", "]"],
]) {
  for (const bom of ["", "\uFEFF"]) {
    test(`gitconfig: splitting the character after a decoding failure merges the issue in ${owner}${bom && " after a BOM"}`, () => {
      const offset = Buffer.byteLength(bom + prefix);
      const source = Buffer.concat([
        Buffer.from(bom + prefix),
        Buffer.from([255]),
        Buffer.from(`é${suffix}`),
      ]);
      const edits = [{ byte: offset + 2, deleteBytes: 1, insert: "" }];
      const incremental = assertIncrementalEqualsFresh(
        source,
        edits,
        applyEdits(source, edits),
      );
      assert.deepEqual(
        incremental
          .filter(({ kind }) => kind === "syntax_issue")
          .map(({ start, end }) => [start, end]),
        [[offset, offset + 2]],
      );
    });
  }
}

const editCases = [
  {
    name: "insert initial BOM",
    source: "[x]\na=1",
    edits: [{ byte: 0, deleteBytes: 0, insert: "\uFEFF" }],
  },
  {
    name: "remove initial BOM",
    source: "\uFEFF[x]\na=1",
    edits: [{ byte: 0, deleteBytes: 3, insert: "" }],
  },
  {
    name: "split Unicode",
    source: "[x]\na=é",
    edits: [{ byte: 7, deleteBytes: 1, insert: "" }],
  },
  {
    name: "repair invalid UTF-8",
    source: Buffer.from([91, 120, 93, 10, 97, 61, 255]),
    edits: [{ byte: 6, deleteBytes: 1, insert: "é" }],
  },
];
for (const entry of editCases) {
  test(`gitconfig: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

test("gitconfig: CST helpers preserve fields, hierarchy and UTF-8 ranges across CRLF", () => {
  const source = " [core]\r\nname=日本";
  const text = [
    "0:0  - 1:11   document",
    "0:0  - 1:11     section",
    "0:1  - 0:7        header: section_header",
    "0:1  - 0:2          opening: section_open `[`",
    "0:2  - 0:6          name: section_name",
    "0:2  - 0:6            name_text `core`",
    "0:6  - 0:7          closing: section_close `]`",
    "0:7  - 1:0        line_ending",
    "0:7  - 0:9          `\\r\\n`",
    "1:0  - 1:11       variable",
    "1:0  - 1:4          name: variable_name",
    "1:0  - 1:4            name_text `name`",
    "1:4  - 1:5          operator: assignment_operator `=`",
    "1:5  - 1:11         value: value",
    "1:5  - 1:11           value_text `日本`",
  ].join("\n");
  const nodes = parseCst(text, source);
  assert.deepEqual(nodes, [
    { kind: "document", field: null, start: 0, end: 20, parent: null },
    { kind: "section", field: null, start: 0, end: 20, parent: 0 },
    { kind: "section_header", field: "header", start: 1, end: 7, parent: 1 },
    { kind: "section_open", field: "opening", start: 1, end: 2, parent: 2 },
    { kind: "section_name", field: "name", start: 2, end: 6, parent: 2 },
    { kind: "name_text", field: null, start: 2, end: 6, parent: 4 },
    { kind: "section_close", field: "closing", start: 6, end: 7, parent: 2 },
    { kind: "line_ending", field: null, start: 7, end: 9, parent: 1 },
    { kind: "variable", field: null, start: 9, end: 20, parent: 1 },
    { kind: "variable_name", field: "name", start: 9, end: 13, parent: 8 },
    { kind: "name_text", field: null, start: 9, end: 13, parent: 9 },
    {
      kind: "assignment_operator",
      field: "operator",
      start: 13,
      end: 14,
      parent: 8,
    },
    { kind: "value", field: "value", start: 14, end: 20, parent: 8 },
    { kind: "value_text", field: null, start: 14, end: 20, parent: 12 },
  ]);
  assert.deepEqual(leaves(source, nodes), [
    ["section_open", "["],
    ["name_text", "core"],
    ["section_close", "]"],
    ["line_ending", "\r\n"],
    ["name_text", "name"],
    ["assignment_operator", "="],
    ["value_text", "日本"],
  ]);
});

test("gitconfig: CST helpers reject truncated roots and native recovery nodes", () => {
  assert.throws(() => parseCst("0:0 - 0:1   document", "é"));
  for (const kind of ["ERROR", "MISSING"]) {
    const text = `0:0 - 0:1   document\n0:0 - 0:1     ${kind}`;
    assert.throws(() => parseCst(text, "a"));
  }
});
