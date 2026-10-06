import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, issues, parse } from "./support/parser.js";

test("gitconfig: a normal name character splits and rejoins an invalid run", () => {
  const source = "[co@@re]";
  const edits = [{ byte: 4, deleteBytes: 0, insert: "a" }];
  const split = parse(source, edits);
  assert.deepEqual(issues(split), [
    ["invalid_syntax", "invalid_name_character", 3, 4],
    ["invalid_syntax", "invalid_name_character", 5, 6],
  ]);
  assert.deepEqual(split, parse("[co@a@re]"));
  edits.push({ byte: 4, deleteBytes: 1, insert: "" });
  const joined = parse(source, edits);
  assert.deepEqual(issues(joined), [
    ["invalid_syntax", "invalid_name_character", 3, 5],
  ]);
  assert.deepEqual(joined, parse(source));
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
      const incremental = parse(source, edits);
      assert.deepEqual(incremental, parse(applyEdits(source, edits)));
      assert.deepEqual(
        incremental
          .filter(({ kind }) => kind === "syntax_issue")
          .map(({ start, end }) => [start, end]),
        [[offset, offset + 2]],
      );
    });
  }
}

const histories = [
  {
    name: "insert whitespace before the section name",
    source: "[core]",
    edits: [{ byte: 1, deleteBytes: 0, insert: " \t" }],
  },
  {
    name: "remove whitespace before the section name",
    source: "[ \tcore]",
    edits: [{ byte: 1, deleteBytes: 2, insert: "" }],
  },
  {
    name: "insert whitespace before the section close",
    source: "[core]",
    edits: [{ byte: 5, deleteBytes: 0, insert: " \t" }],
  },
  {
    name: "turn invalid whitespace into a subsection separator",
    source: "[core ]",
    edits: [{ byte: 6, deleteBytes: 0, insert: '"x"' }],
  },
  {
    name: "complete a quoted subsection after an unfinished legacy header",
    source: "[remote.origin ",
    edits: [{ byte: 15, deleteBytes: 0, insert: '"x"]' }],
  },
  {
    name: "end an unfinished subsection separator with a newline",
    source: "[core ",
    edits: [{ byte: 6, deleteBytes: 0, insert: "\nx=y" }],
  },
  {
    name: "remove invalid whitespace after a quoted subsection",
    source: '[remote "x" \t]',
    edits: [{ byte: 11, deleteBytes: 2, insert: "" }],
  },
  {
    name: "add a quoted subsection after a dotted name",
    source: "[remote.origin]",
    edits: [{ byte: 14, deleteBytes: 0, insert: ' "branch"' }],
  },
  {
    name: "remove a quoted subsection and expose a legacy separator",
    source: '[remote.origin "branch"]',
    edits: [{ byte: 14, deleteBytes: 9, insert: "" }],
  },
  {
    name: "insert a section name before an unseparated subsection",
    source: '["x"]',
    edits: [{ byte: 1, deleteBytes: 0, insert: "remote" }],
  },
  {
    name: "remove a section name before an unseparated subsection",
    source: '[remote"x"]',
    edits: [{ byte: 1, deleteBytes: 6, insert: "" }],
  },
  {
    name: "close a header",
    source: "[core",
    edits: [{ byte: 5, deleteBytes: 0, insert: "]" }],
  },
  {
    name: "remove a header and expose orphan variable",
    source: "[x]\na=1",
    edits: [{ byte: 0, deleteBytes: 4, insert: "" }],
  },
  {
    name: "insert a section before an orphan",
    source: "a=1",
    edits: [{ byte: 0, deleteBytes: 0, insert: "[x]\n" }],
  },
  {
    name: "turn variable into comment",
    source: "[x]\na=1",
    edits: [{ byte: 4, deleteBytes: 0, insert: "#" }],
  },
  {
    name: "turn comment into variable",
    source: "[x]\n#a=1",
    edits: [{ byte: 4, deleteBytes: 1, insert: "" }],
  },
  {
    name: "remove assignment operator",
    source: "[x]\na = b",
    edits: [{ byte: 6, deleteBytes: 1, insert: "" }],
  },
  {
    name: "close a value quote",
    source: '[x]\na="b',
    edits: [{ byte: 8, deleteBytes: 0, insert: '"' }],
  },
  {
    name: "remove a subsection quote",
    source: '[x "a"]\nb=1',
    edits: [{ byte: 5, deleteBytes: 1, insert: "" }],
  },
  {
    name: "insert continuation before a header",
    source: "[x]\na=1\n[y]\nb=2",
    edits: [{ byte: 7, deleteBytes: 0, insert: "\\" }],
  },
  {
    name: "remove continuation and reveal a header",
    source: "[x]\na=1\\\n[y]\nb=2",
    edits: [{ byte: 7, deleteBytes: 1, insert: "" }],
  },
  {
    name: "split CRLF",
    source: "[x]\r\na=1",
    edits: [{ byte: 4, deleteBytes: 1, insert: "" }],
  },
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
  {
    name: "split and merge a decode failure run inside a quoted value",
    source: Buffer.from([91, 120, 93, 10, 97, 61, 34, 255, 254, 128, 34]),
    edits: [
      { byte: 8, deleteBytes: 0, insert: "é" },
      { byte: 8, deleteBytes: 2, insert: "" },
      { byte: 7, deleteBytes: 3, insert: "x" },
    ],
  },
  {
    name: "separate decode failures between a section name and subsection",
    source: Buffer.from([91, 255, 254, 128, 93]),
    edits: [
      { byte: 2, deleteBytes: 0, insert: "." },
      { byte: 2, deleteBytes: 1, insert: "" },
    ],
  },
  {
    name: "move header between sections",
    source: "[x]\na=1\n[y]\nb=2",
    edits: [
      { byte: 8, deleteBytes: 4, insert: "" },
      { byte: 4, deleteBytes: 0, insert: "[y]\n" },
    ],
  },
];
for (const { name, source, edits } of histories) {
  test(`gitconfig: ${name}`, () =>
    assert.deepEqual(parse(source, edits), parse(applyEdits(source, edits))));
}

for (const { name, source, edits, expected } of [
  {
    name: "insert content before continuation",
    source: "[x] a=\\\n  c",
    edits: [{ byte: 6, deleteBytes: 0, insert: "b" }],
    expected: [
      [6, 7],
      [9, 12],
    ],
  },
  {
    name: "remove content before continuation",
    source: "[x] a=b\\\n  c",
    edits: [{ byte: 6, deleteBytes: 1, insert: "" }],
    expected: [[10, 11]],
  },
  {
    name: "fill empty quotes before continuation",
    source: '[x] a=""\\\n  c',
    edits: [{ byte: 7, deleteBytes: 0, insert: " " }],
    expected: [
      [7, 8],
      [11, 14],
    ],
  },
  {
    name: "empty quotes before continuation",
    source: '[x] a="b"\\\n  c',
    edits: [{ byte: 7, deleteBytes: 1, insert: "" }],
    expected: [[12, 13]],
  },
  {
    name: "remove escaped content before continuation",
    source: "[x] a=\\t\\\n  c",
    edits: [{ byte: 6, deleteBytes: 2, insert: "" }],
    expected: [[10, 11]],
  },
]) {
  test(`gitconfig: ${name} reclassifies value whitespace`, () => {
    const nodes = parse(source, edits);
    assert.deepEqual(nodes, parse(applyEdits(source, edits)));
    assert.deepEqual(
      nodes
        .filter(({ kind }) => kind === "value_text")
        .map(({ start, end }) => [start, end]),
      expected,
    );
  });
}

test("gitconfig: fixed-seed generated histories preserve source structure and issue ranges", () => {
  let state = 0x67ac421;
  const next = (maximum) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % maximum;
  };
  const alphabet = 'ab12 []";#=\\\n\r\t-_.é';
  const seeds = [
    "",
    "[core]\na=1\n",
    '[remote "a\\q"]\nbare\n',
    "[remote.Origin.More]\nx=y\n",
    '[x]\na="b\\\nc"\n',
    "# a\n[x]\na\\",
    "[x]\na=1\n[y]\nb=2",
    "a=1",
    '[x] a="unterminated',
    "[ \tcore \t] x=y\n",
    "[remote.origin \t",
    '[remote "x" \t]',
  ];
  for (let sample = 0; sample < 160; sample++) {
    const source = seeds[sample % seeds.length];
    let bytes = Buffer.from(source);
    const edits = [];
    for (let step = 0; step < 4; step++) {
      const byte = next(bytes.length + 1);
      const edit = {
        byte,
        deleteBytes: Math.min(next(4), bytes.length - byte),
        insert: alphabet[next(alphabet.length)],
      };
      edits.push(edit);
      bytes = applyEdits(bytes, [edit]);
      try {
        assert.deepEqual(parse(source, edits), parse(bytes));
      } catch (error) {
        if (error instanceof Error)
          error.message += `\n${JSON.stringify({ source, edits })}`;
        throw error;
      }
    }
  }
});
