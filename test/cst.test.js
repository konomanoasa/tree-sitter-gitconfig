import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../scripts/tree-sitter.js";
import nodeTypes from "../src/node-types.json" with { type: "json" };
import { hasError, leaves, parseCst } from "./support/cst.js";
import { parse } from "./support/parser.js";

function parseCorpus(text) {
  const sections = text.split("==================\n");
  assert.equal(sections.shift(), "", "corpus must begin with a header");
  assert.equal(sections.length % 2, 0, "corpus headers must be paired");
  const cases = [];
  for (let index = 0; index < sections.length; index += 2) {
    const [name, ...attributes] = sections[index].trimEnd().split("\n");
    assert.ok(name, "corpus case must have a name");
    for (const attribute of attributes) {
      assert.ok(
        attribute === ":cst" || attribute === ":error",
        `unsupported corpus attribute: ${attribute}`,
      );
    }
    const parts = sections[index + 1].split("\n---\n");
    assert.equal(parts.length, 2, `${name}: expected one output separator`);
    const source = parts[0].endsWith("\r") ? parts[0].slice(0, -1) : parts[0];
    cases.push({ name, source });
  }
  return cases;
}

const corpusDirectory = join(root, "test/corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  assert.ok(file.endsWith(".txt"), `unexpected corpus entry: ${file}`);
  const entries = parseCorpus(
    readFileSync(join(corpusDirectory, file), "utf8"),
  );
  for (const { name, source } of entries) {
    test(`gitconfig: corpus source coverage and full fresh determinism: ${file}: ${name}`, () => {
      const tree = parse(source);
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

test("gitconfig: public metadata describes normal structure without diagnostic nodes", () => {
  for (const node of nodeTypes) {
    assert.ok(!/issue|invalid|incomplete|missing/.test(node.type), node.type);
    assert.ok(!node.fields || !("issue" in node.fields), node.type);
  }
  for (const [kind, fields] of Object.entries({
    section: ["header"],
    section_header: ["opening", "name", "closing"],
    variable: ["name"],
    quoted_value: ["opening", "closing"],
  })) {
    const node = nodeTypes.find(({ type }) => type === kind);
    assert.ok(node?.fields, kind);
    for (const field of fields) assert.equal(node.fields[field].required, true);
  }
});

const largeInputCounts = {
  sections: 10_000,
  valueCharacters: 200_000,
};
const largeInputCases = [
  ["many sections", "[x]\na=1\n".repeat(largeInputCounts.sections), false],
  [
    "long value",
    `[x]\na=${"a".repeat(largeInputCounts.valueCharacters)}`,
    false,
  ],
];
for (const [name, source, expectedError] of largeInputCases) {
  test(`gitconfig: large input: ${name}`, () =>
    assert.equal(hasError(parse(source)), expectedError));
}

for (const [name, prefix, suffix] of [
  ["section name", "[a", "b]"],
  ["variable name", "[x] a", "b=1"],
  ["subsection", '[x "a', 'b"]'],
  ["value", "[x] a=b", "c"],
  ["quoted value", '[x] a="b', 'c"'],
  ["comment", "# a", "b"],
  ["after value escape", "[x] a=\\", "b"],
  ["after subsection escape", '[x "a\\', 'b"]'],
  ["header tail", '[x "a"', "]"],
]) {
  test(`gitconfig: invalid UTF-8 runs in ${name}`, () => {
    const invalidBytes = Buffer.from([255, 254, 128]);
    const source = Buffer.concat([
      Buffer.from(prefix),
      invalidBytes,
      Buffer.from(suffix),
    ]);
    const tree = parse(source);
    assert.ok(hasError(tree));
    assert.deepEqual(parse(source), tree);
  });
}

test("gitconfig: invalid UTF-8 sequence cannot become ordinary value text", () => {
  const source = Buffer.from([91, 120, 93, 32, 97, 61, 0xc3, 0x28]);
  assert.ok(hasError(parse(source)));
});

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

test("gitconfig: CST helpers retain standard artifacts and reject truncated roots", () => {
  assert.throws(() => parseCst("0:0 - 0:1   document", "é"));
  const root = parseCst("0:0 - 0:1   ERROR", "a");
  assert.deepEqual(root, [
    { kind: "ERROR", field: null, start: 0, end: 1, parent: null },
  ]);
  const missing = parseCst(
    "0:0 - 0:1   document\n0:1 - 0:1     • section_close",
    "a",
  );
  assert.equal(missing[1].kind, "MISSING section_close");
  assert.ok(hasError(root));
  assert.ok(hasError(missing));
});
