import { test } from "node:test";
import {
  applyEdits,
  assertEditHistory,
  assertEditMatchesContract,
} from "./support/parser.js";

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
    name: "turn header layout into a subsection separator",
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
    name: "remove layout after a quoted subsection",
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
    name: "move header between sections",
    source: "[x]\na=1\n[y]\nb=2",
    edits: [
      { byte: 8, deleteBytes: 4, insert: "" },
      { byte: 4, deleteBytes: 0, insert: "[y]\n" },
    ],
  },
];
for (const entry of editCases) {
  test(`gitconfig: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

test("gitconfig: fixed-seed generated histories match fresh parsing after repair", () => {
  const seed = 0x67ac421;
  const historyCount = 160;
  const editsPerHistory = 4;
  const maxDeletedBytes = 3;
  const lcgMultiplier = 1_664_525;
  const lcgIncrement = 1_013_904_223;
  let state = seed;
  const next = (maximum) => {
    state = (Math.imul(state, lcgMultiplier) + lcgIncrement) >>> 0;
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
  for (let sample = 0; sample < historyCount; sample++) {
    const source = seeds[sample % seeds.length];
    let bytes = Buffer.from(source);
    const edits = [];
    for (let step = 0; step < editsPerHistory; step++) {
      const byte = next(bytes.length + 1);
      const edit = {
        byte,
        deleteBytes: Math.min(next(maxDeletedBytes + 1), bytes.length - byte),
        insert: alphabet[next(alphabet.length)],
      };
      edits.push(edit);
      bytes = applyEdits(bytes, [edit]);
      assertEditMatchesContract(source, edits, bytes);
    }
    const repaired = "[core]\na=1\n";
    edits.push({ byte: 0, deleteBytes: bytes.length, insert: repaired });
    assertEditMatchesContract(source, edits, repaired);
  }
});
