import { test } from "node:test";
import {
  applyEdits,
  assertEditHistory,
  assertIncrementalEqualsFresh,
} from "./support/parser.js";

const editCases = [
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

test("gitconfig: fixed-seed generated histories preserve source structure and issue ranges", () => {
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
      assertIncrementalEqualsFresh(source, edits, bytes);
    }
  }
});
