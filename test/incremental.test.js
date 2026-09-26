import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, parse } from "./support/parser.js";

const histories = [
  [
    "insert whitespace before the section name",
    "[core]",
    [{ byte: 1, deleteBytes: 0, insert: " \t" }],
  ],
  [
    "remove whitespace before the section name",
    "[ \tcore]",
    [{ byte: 1, deleteBytes: 2, insert: "" }],
  ],
  [
    "insert whitespace before the section close",
    "[core]",
    [{ byte: 5, deleteBytes: 0, insert: " \t" }],
  ],
  [
    "turn invalid whitespace into a subsection separator",
    "[core ]",
    [{ byte: 6, deleteBytes: 0, insert: '"x"' }],
  ],
  [
    "complete a quoted subsection after an unfinished legacy header",
    "[remote.origin ",
    [{ byte: 15, deleteBytes: 0, insert: '"x"]' }],
  ],
  [
    "end an unfinished subsection separator with a newline",
    "[core ",
    [{ byte: 6, deleteBytes: 0, insert: "\nx=y" }],
  ],
  [
    "remove invalid whitespace after a quoted subsection",
    '[remote "x" \t]',
    [{ byte: 11, deleteBytes: 2, insert: "" }],
  ],
  [
    "add a quoted subsection after a dotted name",
    "[remote.origin]",
    [{ byte: 14, deleteBytes: 0, insert: ' "branch"' }],
  ],
  [
    "remove a quoted subsection and expose a legacy separator",
    '[remote.origin "branch"]',
    [{ byte: 14, deleteBytes: 9, insert: "" }],
  ],
  [
    "insert a section name before an unseparated subsection",
    '["x"]',
    [{ byte: 1, deleteBytes: 0, insert: "remote" }],
  ],
  [
    "remove a section name before an unseparated subsection",
    '[remote"x"]',
    [{ byte: 1, deleteBytes: 6, insert: "" }],
  ],
  ["close a header", "[core", [{ byte: 5, deleteBytes: 0, insert: "]" }]],
  [
    "remove a header and expose orphan variable",
    "[x]\na=1",
    [{ byte: 0, deleteBytes: 4, insert: "" }],
  ],
  [
    "insert a section before an orphan",
    "a=1",
    [{ byte: 0, deleteBytes: 0, insert: "[x]\n" }],
  ],
  [
    "turn variable into comment",
    "[x]\na=1",
    [{ byte: 4, deleteBytes: 0, insert: "#" }],
  ],
  [
    "turn comment into variable",
    "[x]\n#a=1",
    [{ byte: 4, deleteBytes: 1, insert: "" }],
  ],
  [
    "remove assignment operator",
    "[x]\na = b",
    [{ byte: 6, deleteBytes: 1, insert: "" }],
  ],
  [
    "close a value quote",
    '[x]\na="b',
    [{ byte: 8, deleteBytes: 0, insert: '"' }],
  ],
  [
    "remove a subsection quote",
    '[x "a"]\nb=1',
    [{ byte: 5, deleteBytes: 1, insert: "" }],
  ],
  [
    "insert continuation before a header",
    "[x]\na=1\n[y]\nb=2",
    [{ byte: 7, deleteBytes: 0, insert: "\\" }],
  ],
  [
    "remove continuation and reveal a header",
    "[x]\na=1\\\n[y]\nb=2",
    [{ byte: 7, deleteBytes: 1, insert: "" }],
  ],
  ["split CRLF", "[x]\r\na=1", [{ byte: 4, deleteBytes: 1, insert: "" }]],
  [
    "insert initial BOM",
    "[x]\na=1",
    [{ byte: 0, deleteBytes: 0, insert: "\uFEFF" }],
  ],
  [
    "remove initial BOM",
    "\uFEFF[x]\na=1",
    [{ byte: 0, deleteBytes: 3, insert: "" }],
  ],
  ["split Unicode", "[x]\na=é", [{ byte: 7, deleteBytes: 1, insert: "" }]],
  [
    "repair invalid UTF-8",
    Buffer.from([91, 120, 93, 10, 97, 61, 255]),
    [{ byte: 6, deleteBytes: 1, insert: "é" }],
  ],
  [
    "move header between sections",
    "[x]\na=1\n[y]\nb=2",
    [
      { byte: 8, deleteBytes: 4, insert: "" },
      { byte: 4, deleteBytes: 0, insert: "[y]\n" },
    ],
  ],
];
for (const [name, source, edits] of histories) {
  test(`gitconfig: ${name}`, () =>
    assert.deepEqual(parse(source, edits), parse(applyEdits(source, edits))));
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
        error.message += `\n${JSON.stringify({ source, edits })}`;
        throw error;
      }
    }
  }
});
