import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issues, owners } from "./support/cst.js";
import {
  applyEdits,
  assertEditHistory,
  assertIncrementalEqualsFresh,
  parse,
} from "./support/parser.js";

test("gitconfig: Git runtime checks the documented supplementary cases", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "git-syntax-reference-"));
  const run = (args) =>
    spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(directory, "absent-config"),
      },
    });
  try {
    const version = run(["--version"]);
    assert.equal(version.status, 0, version.stderr);
    t.diagnostic(
      `Supplementary behavior established with Git 2.55.0 (value whitespace: 2.56.0); checked with ${version.stdout.trim()}`,
    );
    assert.equal(run(["init", "--quiet"]).status, 0);
    const path = join(directory, "config-input");
    const config = (source) => {
      writeFileSync(path, source);
      return run([
        "config",
        "--file",
        path,
        "--no-includes",
        "--null",
        "--list",
      ]);
    };
    const valueCases = [
      ["[core]\nx=y\n", "core.x\ny\0"],
      ['[remote "x"]\nx=y\n', "remote.x.x\ny\0"],
      ['[remote\t"x"]\nx=y\n', "remote.x.x\ny\0"],
      ['[remote \t "x"]\nx=y\n', "remote.x.x\ny\0"],
      ["[remote.Origin]\nx=y\n", "remote.origin.x\ny\0"],
      ["[remote.Origin.More]\nx=y\n", "remote.origin.more.x\ny\0"],
      ['[remote "origin.more"]\nx=y\n', "remote.origin.more.x\ny\0"],
      ['[remote.name "Origin"]\nx=y\n', "remote.name.Origin.x\ny\0"],
      ["[core]\nx=\\\n  c\n", "core.x\nc\0"],
      ["[core]\nx=\\\r\n\tc\r\n", "core.x\nc\0"],
      ["[core]\nx=\\\n \\\n  c\n", "core.x\nc\0"],
      ['[core]\nx=\\\n  "" c\n', "core.x\nc\0"],
      ['[core]\nx=""\\\n  c\n', "core.x\nc\0"],
      ['[core]\nx=""  c\n', "core.x\nc\0"],
      ["[core]\nx=b\\\n  c\n", "core.x\nb  c\0"],
      ["[core]\nx=\\t\\\n  c\n", "core.x\n\t  c\0"],
      ['[core]\nx="\\\n  c"\n', "core.x\n  c\0"],
      ['[core]\nx=" "\\\n  c\n', "core.x\n   c\0"],
      ["[core]\nx=\\\n  #comment\n", "core.x\n\0"],
      ["[core]\nx=b\\\n \tc \t#tail\n", "core.x\nb \tc\0"],
    ];
    for (const [source, expected] of valueCases) {
      const result = config(source);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected, source);
    }
    for (const header of [
      "[ core]",
      "[\tcore]",
      "[core ]",
      "[core\t]",
      "[ \tcore \t]",
      '[ remote "x"]',
      '[remote "x" ]',
      '[remote "x"\t]',
      "[remote.origin ]",
      "[remote.origin\t]",
    ]) {
      const source = `${header}\nx=y\n`;
      const result = config(source);
      assert.equal(result.status, 128, source);
      assert.equal(result.stdout, "", source);
      assert.ok(result.stderr.includes("bad config line 1"), result.stderr);
    }
    for (const source of ["[core][other]\nx=y\n", "[core] [other]\nx=y\n"]) {
      const result = config(source);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "other.x\ny\0", source);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const largeInputCounts = {
  sections: 10_000,
  valueCharacters: 200_000,
  trailingSpaces: 200_000,
  continuations: 10_000,
  invalidQuotes: 10_000,
};
const largeInputCases = [
  ["many sections", "[x]\na=1\n".repeat(largeInputCounts.sections), 0],
  ["long value", `[x]\na=${"a".repeat(largeInputCounts.valueCharacters)}`, 0],
  [
    "long trailing whitespace",
    `[x]\na=b${" ".repeat(largeInputCounts.trailingSpaces)}`,
    0,
  ],
  [
    "many continuations",
    `[x]\na=${"a\\\n".repeat(largeInputCounts.continuations)}end`,
    0,
  ],
  [
    "many invalid quotes",
    '[x]\na="b\n'.repeat(largeInputCounts.invalidQuotes),
    largeInputCounts.invalidQuotes,
  ],
];
for (const [name, source, expectedIssues] of largeInputCases) {
  test(`gitconfig: large input: ${name}`, () =>
    assert.equal(issues(parse(source)).length, expectedIssues));
}

test("gitconfig: a long invalid name run forms one issue with its full range", () => {
  const invalidNameBytes = 10_000;
  const prefix = "[x]\n";
  const startByte = Buffer.byteLength(prefix);
  const tree = parse(`${prefix}${"_".repeat(invalidNameBytes)}=1`);
  assert.deepEqual(issues(tree), [
    [
      "invalid_syntax",
      "invalid_name_character",
      startByte,
      startByte + invalidNameBytes,
    ],
  ]);
  assert.deepEqual(owners(tree), ["variable_name"]);
});

const trailingCrCases = [
  {
    name: "section name",
    source: "[a\r",
    expected: [
      ["incomplete_syntax", "invalid_name_character", 2, 3],
      ["incomplete_syntax", "missing_section_close", 3, 3],
    ],
    completed: [["invalid_syntax", "missing_section_close", 2, 2]],
  },
  {
    name: "legacy subsection name",
    source: "[a.b\r",
    expected: [
      ["incomplete_syntax", "invalid_name_character", 4, 5],
      ["incomplete_syntax", "missing_section_close", 5, 5],
    ],
    completed: [["invalid_syntax", "missing_section_close", 4, 4]],
  },
  {
    name: "variable name",
    source: "[a]\nx\r",
    expected: [["incomplete_syntax", "invalid_name_character", 5, 6]],
    completed: [],
  },
  {
    name: "value without an assignment operator after a space",
    source: "[a]\nx \r",
    expected: [["incomplete_syntax", "missing_assignment_operator", 6, 6]],
    completed: [],
  },
  {
    name: "value without an assignment operator after a tab",
    source: "[a]\nx\t\r",
    expected: [["incomplete_syntax", "missing_assignment_operator", 6, 6]],
    completed: [],
  },
  {
    name: "value without an assignment operator before any section",
    source: "x \r",
    expected: [
      ["invalid_syntax", "missing_section_header", 0, 0],
      ["incomplete_syntax", "missing_assignment_operator", 2, 2],
    ],
    completed: [["invalid_syntax", "missing_section_header", 0, 0]],
  },
  {
    name: "value without an assignment operator on the header line",
    source: "[a] x \r",
    expected: [["incomplete_syntax", "missing_assignment_operator", 6, 6]],
    completed: [],
  },
  {
    name: "unquoted value continuation",
    source: "[a]\nx=x\\\r",
    expected: [["incomplete_syntax", "incomplete_escape", 7, 9]],
    completed: [],
  },
  {
    name: "quoted value continuation",
    source: '[a]\nx="x\\\r',
    expected: [
      ["incomplete_syntax", "incomplete_escape", 8, 10],
      ["incomplete_syntax", "missing_quote_close", 10, 10],
    ],
    completed: [["incomplete_syntax", "missing_quote_close", 11, 11]],
  },
  {
    name: "header tail",
    source: '[a "b"\r',
    expected: [
      ["incomplete_syntax", "unexpected_header_content", 6, 7],
      ["incomplete_syntax", "missing_section_close", 7, 7],
    ],
    completed: [["invalid_syntax", "missing_section_close", 6, 6]],
  },
  {
    name: "name violation before the final CR",
    source: "[a@\r",
    expected: [
      ["invalid_syntax", "invalid_name_character", 2, 3],
      ["incomplete_syntax", "invalid_name_character", 3, 4],
      ["incomplete_syntax", "missing_section_close", 4, 4],
    ],
    completed: [
      ["invalid_syntax", "invalid_name_character", 2, 3],
      ["invalid_syntax", "missing_section_close", 3, 3],
    ],
  },
  {
    name: "header whitespace before the final CR",
    source: "[a \r",
    expected: [
      ["invalid_syntax", "unexpected_header_content", 2, 3],
      ["incomplete_syntax", "unexpected_header_content", 3, 4],
      ["incomplete_syntax", "missing_section_close", 4, 4],
    ],
    completed: [
      ["invalid_syntax", "unexpected_header_content", 2, 3],
      ["invalid_syntax", "missing_section_close", 3, 3],
    ],
  },
  {
    name: "CR-only line before any section",
    source: "\r",
    expected: [
      ["incomplete_syntax", "missing_section_header", 0, 0],
      ["incomplete_syntax", "invalid_name_character", 0, 1],
    ],
    completed: [],
  },
];
for (const { name, source, expected, completed } of trailingCrCases) {
  test(`gitconfig: EOF CR can become CRLF in ${name}`, () => {
    const original = parse(source);
    assert.deepEqual(issues(original), expected);
    const edits = [
      { byte: Buffer.byteLength(source), deleteBytes: 0, insert: "\n" },
    ];
    const incremental = parse(source, edits);
    assert.deepEqual(issues(incremental), completed);
    assert.deepEqual(incremental, parse(`${source}\n`));
    edits.push({ byte: Buffer.byteLength(source), deleteBytes: 1, insert: "" });
    assert.deepEqual(parse(source, edits), original);
  });
}

test("gitconfig: a missing assignment stays invalid when LF cannot remove the whole value", () => {
  for (const source of [
    "[a]\nx y\r",
    "[a]\nx \r\r",
    "[a]\nx \rz",
    "[a]\nx \r ",
    "[a]\nx \r#",
  ]) {
    const expected = [["invalid_syntax", "missing_assignment_operator", 6, 6]];
    assert.deepEqual(issues(parse(source)), expected, JSON.stringify(source));
    const edits = [
      { byte: Buffer.byteLength(source), deleteBytes: 0, insert: "\n" },
    ];
    const incremental = parse(source, edits);
    assert.deepEqual(issues(incremental), expected, JSON.stringify(source));
    assert.deepEqual(incremental, parse(`${source}\n`));
  }
});

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

const editCases = [
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
];
for (const entry of editCases) {
  test(`gitconfig: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
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
    const nodes = assertIncrementalEqualsFresh(
      source,
      edits,
      applyEdits(source, edits),
    );
    assert.deepEqual(
      nodes
        .filter(({ kind }) => kind === "value_text")
        .map(({ start, end }) => [start, end]),
      expected,
    );
  });
}
