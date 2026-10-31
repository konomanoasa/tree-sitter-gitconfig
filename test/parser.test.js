import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasError } from "./support/cst.js";
import {
  applyEdits,
  assertEditMatchesContract,
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
  trailingSpaces: 200_000,
  continuations: 10_000,
  invalidQuotes: 10_000,
  invalidNameBytes: 10_000,
};
for (const [name, source, expectedError] of [
  [
    "long trailing whitespace",
    `[x]\na=b${" ".repeat(largeInputCounts.trailingSpaces)}`,
    false,
  ],
  [
    "many continuations",
    `[x]\na=${"a\\\n".repeat(largeInputCounts.continuations)}end`,
    false,
  ],
  [
    "many unterminated quotes",
    '[x]\na="b\n'.repeat(largeInputCounts.invalidQuotes),
    true,
  ],
  [
    "long invalid variable name",
    `[x]\na${"_".repeat(largeInputCounts.invalidNameBytes)}=1`,
    true,
  ],
]) {
  test(`gitconfig: large input: ${name}`, () => {
    assert.equal(hasError(parse(source)), expectedError);
  });
}

for (const [name, source, edit, expectedTextRanges] of [
  [
    "header layout around a decode failure",
    Buffer.from([91, 120, 32, 34, 97, 34, 32, 255, 32, 93]),
    { byte: 7, deleteBytes: 1, insert: "" },
    [],
  ],
  [
    "decode failure before continuation",
    Buffer.from([91, 120, 93, 32, 97, 61, 255, 92, 10, 32, 32, 99]),
    { byte: 6, deleteBytes: 1, insert: "b" },
    [
      [6, 7],
      [9, 12],
    ],
  ],
]) {
  test(`gitconfig: repairing ${name} restores normal structure`, () => {
    assert.ok(hasError(parse(source)));
    const repaired = applyEdits(source, [edit]);
    const fresh = parse(repaired);
    assert.equal(hasError(fresh), false);
    const incremental = assertEditMatchesContract(source, [edit], repaired);
    assert.deepEqual(incremental, fresh);
    assert.deepEqual(
      incremental
        .filter(({ kind }) => kind === "value_text")
        .map(({ start, end }) => [start, end]),
      expectedTextRanges,
    );
  });
}

const trailingCrCases = [
  { name: "section name", source: "[a\r", completedError: true },
  { name: "legacy subsection name", source: "[a.b\r", completedError: true },
  { name: "variable name", source: "[a]\nx\r", completedError: false },
  {
    name: "space before a possible value",
    source: "[a]\nx \r",
    completedError: false,
  },
  {
    name: "tab before a possible value",
    source: "[a]\nx\t\r",
    completedError: false,
  },
  { name: "variable outside a section", source: "x \r", completedError: true },
  { name: "same-line variable", source: "[a] x \r", completedError: false },
  {
    name: "unquoted continuation",
    source: "[a]\nx=x\\\r",
    completedError: false,
  },
  {
    name: "quoted continuation",
    source: '[a]\nx="x\\\r',
    completedError: true,
  },
  { name: "header close", source: '[a "b"\r', completedError: true },
  { name: "invalid name before CR", source: "[a@\r", completedError: true },
  { name: "header layout before CR", source: "[a \r", completedError: true },
  { name: "CR-only line", source: "\r", completedError: false },
];
for (const { name, source, completedError } of trailingCrCases) {
  test(`gitconfig: completing CRLF changes the syntax boundary in ${name}`, () => {
    assert.ok(hasError(parse(source)));
    const byte = Buffer.byteLength(source);
    const edits = [{ byte, deleteBytes: 0, insert: "\n" }];
    const completed = `${source}\n`;
    assert.equal(hasError(parse(completed)), completedError);
    assertEditMatchesContract(source, edits, completed);
    edits.push({ byte, deleteBytes: 1, insert: "" });
    assertEditMatchesContract(source, edits, source);
  });
}

test("gitconfig: LF cannot repair an assignment with non-layout content", () => {
  for (const source of [
    "[a]\nx y\r",
    "[a]\nx \r\r",
    "[a]\nx \rz",
    "[a]\nx \r ",
    "[a]\nx \r#",
  ]) {
    assert.ok(hasError(parse(source)), JSON.stringify(source));
    const edits = [
      { byte: Buffer.byteLength(source), deleteBytes: 0, insert: "\n" },
    ];
    assert.ok(hasError(parse(`${source}\n`)), JSON.stringify(source));
    assertEditMatchesContract(source, edits, `${source}\n`);
  }
});

test("gitconfig: replacing invalid name characters restores one name leaf", () => {
  const source = "[co@@re]";
  const edits = [
    { byte: 4, deleteBytes: 0, insert: "a" },
    { byte: 3, deleteBytes: 3, insert: "" },
  ];
  const repaired = applyEdits(source, edits);
  const nodes = assertEditMatchesContract(source, edits, repaired);
  assert.equal(hasError(nodes), false);
  assert.deepEqual(
    nodes
      .filter(({ kind }) => kind === "name_text")
      .map(({ start, end }) => [start, end]),
    [[1, 5]],
  );
});

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
    const nodes = assertEditMatchesContract(
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
