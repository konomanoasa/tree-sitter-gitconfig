import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nodeTypes from "../src/node-types.json" with { type: "json" };
import { issues, leaves, owners, parse } from "./support/parser.js";

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

const valueCases = [
  [
    "legacy subsection retains case and additional dots",
    "[remote.Origin.More]",
    [
      ["section_open", "["],
      ["name_text", "remote"],
      ["subsection_separator", "."],
      ["subsection_text", "Origin.More"],
      ["section_close", "]"],
    ],
  ],
  [
    "quoted subsection keeps dots in the section name",
    '[remote.name "Origin"]',
    [
      ["section_open", "["],
      ["name_text", "remote.name"],
      ["quote_open", '"'],
      ["subsection_text", "Origin"],
      ["quote_close", '"'],
      ["section_close", "]"],
    ],
  ],
  [
    "empty legacy subsection keeps the separator",
    "[remote.]",
    [
      ["section_open", "["],
      ["name_text", "remote"],
      ["subsection_separator", "."],
      ["section_close", "]"],
    ],
  ],
  ["empty document", "", [["document", ""]]],
  ["blank line", " \t\n", [["line_ending", "\n"]]],
  ["blank final line", " \t", [["blank_line", " \t"]]],
  [
    "standalone comment",
    " # hi\n",
    [
      ["comment_marker", "#"],
      ["comment_text", " hi"],
      ["line_ending", "\n"],
    ],
  ],
  [
    "section and same-line variable",
    "[core] a = b\n",
    [
      ["section_open", "["],
      ["name_text", "core"],
      ["section_close", "]"],
      ["name_text", "a"],
      ["assignment_operator", "="],
      ["value_text", "b"],
      ["line_ending", "\n"],
    ],
  ],
  [
    "section-only file",
    "[core]",
    [
      ["section_open", "["],
      ["name_text", "core"],
      ["section_close", "]"],
    ],
  ],
  [
    "empty subsection",
    '[remote ""]\n',
    [
      ["section_open", "["],
      ["name_text", "remote"],
      ["quote_open", '"'],
      ["quote_close", '"'],
      ["section_close", "]"],
      ["line_ending", "\n"],
    ],
  ],
];
for (const [name, source, expected] of valueCases) {
  test(`gitconfig: ${name}`, () => {
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), []);
    assert.deepEqual(leaves(source, nodes), expected);
  });
}
const validCases = [
  ["space and tab separate a quoted subsection", '[remote \t "x"]\nx=y\n'],
  ["value-free variable", "[core]\nbare\n"],
  ["empty assignment", "[core]\nname=  # comment\n"],
  ["empty quoted value", '[core]\nname=""\n'],
  ["quoted and unquoted parts", '[core]\nname=a" b "c\n'],
  ["quoted comment markers", '[core]\nname="#;"\n'],
  ["subsection escapes are not value escapes", '[remote "a\\q\\0"]\nname=x'],
  ["value escapes", '[core]\nname=\\n\\t\\b\\\\\\"\n'],
  ["unquoted continuation", "[core]\nname=a\\\n[other]\n"],
  ["quoted continuation", '[core]\nname="a\\\nb"\n'],
  ["continuation ends at EOF", "[core]\nname=a\\\n"],
  ["CRLF layout and continuation", "[core]\r\nname=a\\\r\nb\r\n"],
  ["initial BOM", "\uFEFF[core]\nname=日本"],
  ["NUL and bare CR in values", "[core]\nname=a\0\rb"],
  [
    "include and conditional include",
    '[include]\npath=~/x\n[includeIf "gitdir:~/src/**"]\npath=x\n',
  ],
  ["two sections", "[core]\na=1\n[remote]\nb=2\n"],
  ["indented sections and comments", " [core] ; a\n  # b\n [remote] x=y\n"],
];
for (const [name, source] of validCases) {
  test(`gitconfig: ${name}`, () => assert.deepEqual(issues(parse(source)), []));
}
const invalidCases = [
  [
    "contiguous forbidden section name characters form one issue",
    "[co@@re]",
    [["invalid_syntax", "invalid_name_character", 3, 5]],
    ["section_name"],
  ],
  [
    "normal section name characters separate issues",
    "[co@r@e]",
    [
      ["invalid_syntax", "invalid_name_character", 3, 4],
      ["invalid_syntax", "invalid_name_character", 5, 6],
    ],
    ["section_name", "section_name"],
  ],
  [
    "contiguous forbidden variable name characters form one issue",
    "[x]\na@@b=1",
    [["invalid_syntax", "invalid_name_character", 5, 7]],
    ["variable_name"],
  ],
  [
    "contiguous forbidden legacy subsection characters form one issue",
    "[x.@@y]",
    [["invalid_syntax", "invalid_name_character", 3, 5]],
    ["subsection"],
  ],
  [
    "contiguous NUL characters in a subsection form one issue",
    '[x "a\0\0b"]',
    [["invalid_syntax", "invalid_subsection_character", 5, 7]],
    ["subsection"],
  ],
  [
    "a forbidden initial digit does not absorb valid name characters",
    "[x] 12a=1",
    [["invalid_syntax", "invalid_name_character", 4, 5]],
    ["variable_name"],
  ],
  [
    "adjacent invalid escapes remain independent",
    "[x] a=\\q\\z",
    [
      ["invalid_syntax", "invalid_escape", 6, 8],
      ["invalid_syntax", "invalid_escape", 8, 10],
    ],
    ["value", "value"],
  ],
  [
    "space after the opening bracket preserves the section name",
    "[ core]",
    [["invalid_syntax", "unexpected_header_content", 1, 2]],
    ["section_header"],
  ],
  [
    "space before the closing bracket preserves its delimiter",
    "[core ]",
    [["invalid_syntax", "unexpected_header_content", 5, 6]],
    ["section_header"],
  ],
  [
    "mixed whitespace on both sides of the name has separate ranges",
    "[ \tcore \t]",
    [
      ["invalid_syntax", "unexpected_header_content", 1, 3],
      ["invalid_syntax", "unexpected_header_content", 7, 9],
    ],
    ["section_header", "section_header"],
  ],
  [
    "whitespace after a quoted subsection is header content",
    '[remote "x" \t]',
    [["invalid_syntax", "unexpected_header_content", 11, 13]],
    ["section_header"],
  ],
  [
    "whitespace after a legacy subsection is header content",
    "[remote.origin \t]",
    [["invalid_syntax", "unexpected_header_content", 14, 16]],
    ["section_header"],
  ],
  [
    "invalid whitespace cannot absorb a header decoding failure",
    Buffer.from([91, 120, 32, 34, 97, 34, 32, 255, 32, 93]),
    [
      ["invalid_syntax", "unexpected_header_content", 6, 7],
      ["invalid_syntax", "invalid_encoding", 7, 8],
      ["invalid_syntax", "unexpected_header_content", 8, 9],
    ],
    ["section_header", "section_header", "section_header"],
  ],
  [
    "EOF can still turn whitespace after the name into a subsection separator",
    "[core \t",
    [["incomplete_syntax", "missing_section_close", 7, 7]],
    ["section_header"],
  ],
  [
    "EOF can still turn a legacy name into a dotted name and quoted subsection",
    "[remote.origin \t",
    [["incomplete_syntax", "missing_section_close", 16, 16]],
    ["section_header"],
  ],
  [
    "newline fixes whitespace after the name as invalid header content",
    "[core \t\nx=y\n",
    [
      ["invalid_syntax", "unexpected_header_content", 5, 7],
      ["invalid_syntax", "missing_section_close", 7, 7],
    ],
    ["section_header", "section_header"],
  ],
  [
    "comment fixes whitespace after the name as invalid header content",
    "[core #tail",
    [
      ["invalid_syntax", "unexpected_header_content", 5, 6],
      ["invalid_syntax", "missing_section_close", 6, 6],
    ],
    ["section_header", "section_header"],
  ],
  [
    "EOF cannot repair whitespace after the opening bracket",
    "[ ",
    [
      ["invalid_syntax", "unexpected_header_content", 1, 2],
      ["incomplete_syntax", "missing_section_name", 2, 2],
      ["incomplete_syntax", "missing_section_close", 2, 2],
    ],
    ["section_header", "section_header", "section_header"],
  ],
  [
    "EOF cannot repair whitespace after a quoted subsection",
    '[remote "x" ',
    [
      ["invalid_syntax", "unexpected_header_content", 11, 12],
      ["incomplete_syntax", "missing_section_close", 12, 12],
    ],
    ["section_header", "section_header"],
  ],
  [
    "same-line bracket text follows the documented variable syntax",
    "[core][other]\nx=y\n",
    [
      ["invalid_syntax", "invalid_name_character", 6, 7],
      ["invalid_syntax", "invalid_name_character", 12, 13],
    ],
    ["variable_name", "variable_name"],
  ],
  [
    "spaces after a header do not start another section",
    "[core] [other]\nx=y\n",
    [
      ["invalid_syntax", "invalid_name_character", 7, 8],
      ["invalid_syntax", "invalid_name_character", 13, 14],
    ],
    ["variable_name", "variable_name"],
  ],
  [
    "variable outside section",
    "a=1",
    [["invalid_syntax", "missing_section_header", 0, 0]],
    ["variable"],
  ],
  [
    "incomplete section name and close",
    "[",
    [
      ["incomplete_syntax", "missing_section_name", 1, 1],
      ["incomplete_syntax", "missing_section_close", 1, 1],
    ],
    ["section_header", "section_header"],
  ],
  [
    "empty section name",
    "[]",
    [["invalid_syntax", "missing_section_name", 1, 1]],
    ["section_header"],
  ],
  [
    "incomplete section close",
    "[core",
    [["incomplete_syntax", "missing_section_close", 5, 5]],
    ["section_header"],
  ],
  [
    "ended section close",
    "[core\n",
    [["invalid_syntax", "missing_section_close", 5, 5]],
    ["section_header"],
  ],
  [
    "subsection without a section name",
    '["x"]',
    [["invalid_syntax", "missing_section_name", 1, 1]],
    ["section_header"],
  ],
  [
    "subsection after whitespace without a section name",
    '[ \t"x"]',
    [
      ["invalid_syntax", "unexpected_header_content", 1, 3],
      ["invalid_syntax", "missing_section_name", 3, 3],
    ],
    ["section_header", "section_header"],
  ],
  [
    "invalid section name still requires a subsection separator",
    '[_"x"]',
    [
      ["invalid_syntax", "invalid_name_character", 1, 2],
      ["invalid_syntax", "missing_subsection_separator", 2, 2],
    ],
    ["section_name", "section_header"],
  ],
  [
    "subsection without separator",
    '[x"a"]',
    [["invalid_syntax", "missing_subsection_separator", 2, 2]],
    ["section_header"],
  ],
  [
    "subsection NUL",
    '[x "a\0b"]',
    [["invalid_syntax", "invalid_subsection_character", 5, 6]],
    ["subsection"],
  ],
  [
    "header junk",
    '[x "a" z]',
    [["invalid_syntax", "unexpected_header_content", 6, 8]],
    ["section_header"],
  ],
  [
    "consecutive header junk is one issue per run",
    '[x ab "c"d]',
    [["invalid_syntax", "unexpected_header_content", 2, 10]],
    ["section_header"],
  ],
  [
    "invalid section character",
    "[a_b]",
    [["invalid_syntax", "invalid_name_character", 2, 3]],
    ["section_name"],
  ],
  [
    "invalid first variable character",
    "[x] 1a=2",
    [["invalid_syntax", "invalid_name_character", 4, 5]],
    ["variable_name"],
  ],
  [
    "missing variable name",
    "[x] =2",
    [["invalid_syntax", "missing_variable_name", 4, 4]],
    ["variable"],
  ],
  [
    "missing assignment",
    "[x] a b",
    [["invalid_syntax", "missing_assignment_operator", 6, 6]],
    ["variable"],
  ],
  [
    "invalid value escape",
    "[x] a=\\q",
    [["invalid_syntax", "invalid_escape", 6, 8]],
    ["value"],
  ],
  [
    "incomplete value escape",
    "[x] a=\\",
    [["incomplete_syntax", "incomplete_escape", 6, 7]],
    ["value"],
  ],
  [
    "incomplete quote",
    '[x] a="b',
    [["incomplete_syntax", "missing_quote_close", 8, 8]],
    ["quoted_value"],
  ],
  [
    "ended quote",
    '[x] a="b\n',
    [["invalid_syntax", "missing_quote_close", 8, 8]],
    ["quoted_value"],
  ],
];
for (const [name, source, expected, expectedOwners] of invalidCases) {
  test(`gitconfig: ${name}`, () => {
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), expected);
    assert.deepEqual(owners(nodes), expectedOwners);
    for (const node of nodes.filter(({ kind }) => kind === "syntax_issue"))
      assert.equal(node.field, "issue");
  });
}

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
    const source = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([255, 254, 128]),
      Buffer.from(suffix),
    ]);
    const tree = parse(source);
    assert.deepEqual(issues(tree), [
      [
        "invalid_syntax",
        "invalid_encoding",
        Buffer.byteLength(prefix),
        Buffer.byteLength(prefix) + 3,
      ],
    ]);
    assert.deepEqual(owners(tree), [owner]);
  });
}

for (const [name, source, expected] of [
  [
    "EOF ends subsection escape and two delimiters",
    '[x "a\\',
    [
      ["incomplete_syntax", "incomplete_escape", 5, 6],
      ["incomplete_syntax", "missing_quote_close", 6, 6],
      ["incomplete_syntax", "missing_section_close", 6, 6],
    ],
  ],
  [
    "newline ends subsection escape and two delimiters",
    '[x "a\\\n',
    [
      ["invalid_syntax", "incomplete_escape", 5, 6],
      ["invalid_syntax", "missing_quote_close", 6, 6],
      ["invalid_syntax", "missing_section_close", 6, 6],
    ],
  ],
  [
    "EOF ends quote after completed continuation",
    '[x] a="b\\\n',
    [["incomplete_syntax", "missing_quote_close", 10, 10]],
  ],
  [
    "escape cannot hide subsection NUL",
    '[x "a\\\0b"]',
    [["invalid_syntax", "invalid_subsection_character", 6, 7]],
  ],
  [
    "invalid escape cannot start a comment",
    "[x] a=\\#b",
    [["invalid_syntax", "invalid_escape", 6, 8]],
  ],
  [
    "invalid UTF-8 sequence reports the failed range",
    Buffer.from([91, 120, 93, 32, 97, 61, 0xc3, 0x28]),
    [["invalid_syntax", "invalid_encoding", 6, 7]],
  ],
]) {
  test(`gitconfig: ${name}`, () =>
    assert.deepEqual(issues(parse(source)), expected));
}

test("gitconfig: section, variable and comment ranges have explicit owners", () => {
  const source = " [x] ;h\n a=1 #v\n\n [y] b=2";
  const nodes = parse(source);
  assert.deepEqual(
    nodes
      .filter(({ kind }) =>
        [
          "section",
          "section_header",
          "variable",
          "comment",
          "blank_line",
        ].includes(kind),
      )
      .map(({ kind, start, end, parent }) => [
        kind,
        start,
        end,
        nodes[parent].kind,
      ]),
    [
      ["section", 0, 17, "document"],
      ["section_header", 1, 4, "section"],
      ["comment", 5, 7, "section"],
      ["variable", 8, 16, "section"],
      ["comment", 13, 15, "variable"],
      ["blank_line", 16, 17, "section"],
      ["section", 17, 25, "document"],
      ["section_header", 18, 21, "section"],
      ["variable", 21, 25, "section"],
    ],
  );
});

test("gitconfig: header whitespace preserves names, delimiters and following variables", () => {
  const source = "[ core ] x=y\n[next]\nz=w";
  const nodes = parse(source);
  assert.deepEqual(leaves(source, nodes), [
    ["section_open", "["],
    ["unexpected_header_content", " "],
    ["name_text", "core"],
    ["unexpected_header_content", " "],
    ["section_close", "]"],
    ["name_text", "x"],
    ["assignment_operator", "="],
    ["value_text", "y"],
    ["line_ending", "\n"],
    ["section_open", "["],
    ["name_text", "next"],
    ["section_close", "]"],
    ["line_ending", "\n"],
    ["name_text", "z"],
    ["assignment_operator", "="],
    ["value_text", "w"],
  ]);
  const sections = nodes.flatMap((node, index) =>
    node.kind === "section" ? [index] : [],
  );
  assert.equal(sections.length, 2);
  assert.deepEqual(
    nodes.filter(({ kind }) => kind === "variable").map(({ parent }) => parent),
    sections,
  );
});

test("gitconfig: trailing value spaces belong to the variable but not value text", () => {
  const source = "[x] a= b c  #tail";
  const nodes = parse(source);
  assert.deepEqual(
    nodes
      .filter(({ kind }) => ["value", "value_text", "comment"].includes(kind))
      .map(({ kind, start, end }) => [kind, start, end]),
    [
      ["value", 7, 10],
      ["value_text", 7, 10],
      ["comment", 12, 17],
    ],
  );
});

for (const { name, source, expected, expectedIssues = [] } of [
  {
    name: "leading spaces after continuation",
    source: "[x] a=\\\n  c\n",
    expected: [[10, 11, "c"]],
  },
  {
    name: "leading tab after CRLF continuation",
    source: "[x] a=\\\r\n\tc\r\n",
    expected: [[10, 11, "c"]],
  },
  {
    name: "leading spaces across continuations",
    source: "[x] a=\\\n \\\n  c",
    expected: [[13, 14, "c"]],
  },
  {
    name: "empty quotes after continuation",
    source: '[x] a=\\\n  "" c',
    expected: [[13, 14, "c"]],
  },
  {
    name: "empty quotes before continuation",
    source: '[x] a=""\\\n  c',
    expected: [[12, 13, "c"]],
  },
  {
    name: "empty quotes before leading spaces",
    source: '[x] a=""  c',
    expected: [[10, 11, "c"]],
  },
  {
    name: "internal spaces after continuation",
    source: "[x] a=b\\\n  c",
    expected: [
      [6, 7, "b"],
      [9, 12, "  c"],
    ],
  },
  {
    name: "escaped content before continuation",
    source: "[x] a=\\t\\\n  c",
    expected: [[10, 13, "  c"]],
  },
  {
    name: "quoted spaces after continuation",
    source: '[x] a="\\\n  c"',
    expected: [[9, 12, "  c"]],
  },
  {
    name: "quoted content before continuation",
    source: '[x] a=" "\\\n  c',
    expected: [
      [7, 8, " "],
      [11, 14, "  c"],
    ],
  },
  {
    name: "continued whitespace before comment",
    source: "[x] a=\\\n  #comment",
    expected: [],
  },
  {
    name: "leading spaces in the next variable",
    source: "[x] a=b\nnext=\\\n  c",
    expected: [
      [6, 7, "b"],
      [17, 18, "c"],
    ],
  },
  {
    name: "internal and trailing spaces after continuation",
    source: "[x] a=b\\\n \tc \t#tail",
    expected: [
      [6, 7, "b"],
      [9, 12, " \tc"],
    ],
  },
  {
    name: "invalid escape before continuation",
    source: "[x] a=\\q\\\n  c",
    expected: [[10, 13, "  c"]],
    expectedIssues: [["invalid_syntax", "invalid_escape", 6, 8]],
  },
  {
    name: "invalid encoding before continuation",
    source: Buffer.from([91, 120, 93, 32, 97, 61, 255, 92, 10, 32, 32, 99]),
    expected: [[9, 12, "  c"]],
    expectedIssues: [["invalid_syntax", "invalid_encoding", 6, 7]],
  },
]) {
  test(`gitconfig: ${name} preserve value text ranges`, () => {
    const nodes = parse(source);
    const bytes = Buffer.from(source);
    assert.deepEqual(issues(nodes), expectedIssues);
    assert.deepEqual(
      nodes
        .filter(({ kind }) => kind === "value_text")
        .map(({ start, end }) => [
          start,
          end,
          bytes.subarray(start, end).toString(),
        ]),
      expected,
    );
  });
}

test("gitconfig: quoted and unquoted fragments preserve source ranges", () => {
  const source = '[x] a=b" c "d\\t';
  const nodes = parse(source);
  assert.deepEqual(
    nodes
      .filter(({ kind }) =>
        ["value", "quoted_value", "value_text", "escape"].includes(kind),
      )
      .map(({ kind, start, end }) => [kind, start, end]),
    [
      ["value", 6, 15],
      ["value_text", 6, 7],
      ["quoted_value", 7, 12],
      ["value_text", 8, 11],
      ["value_text", 12, 13],
      ["escape", 13, 15],
    ],
  );
});

test("gitconfig: BOM is excluded and Unicode positions retain original bytes", () => {
  const source = '\uFEFF[x] a="日本"';
  const nodes = parse(source);
  assert.equal(nodes.find(({ kind }) => kind === "section_open").start, 3);
  assert.deepEqual(
    nodes
      .filter(({ kind }) => kind === "value_text")
      .map(({ start, end }) => [start, end]),
    [[10, 16]],
  );
});

test("gitconfig: Git runtime checks the documented supplementary cases", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "git-syntax-reference-"));
  const run = (args, input = "") =>
    spawnSync("git", args, {
      cwd: directory,
      input,
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
      assert.deepEqual(issues(parse(source)), [], source);
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
      assert.equal(
        parse(source).filter(({ kind }) => kind === "section").length,
        1,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const largeInputCases = [
  ["many sections", "[x]\na=1\n".repeat(10000), 0],
  ["long value", `[x]\na=${"a".repeat(200000)}`, 0],
  ["long trailing whitespace", `[x]\na=b${" ".repeat(200000)}`, 0],
  ["many continuations", `[x]\na=${"a\\\n".repeat(10000)}end`, 0],
  ["many invalid quotes", '[x]\na="b\n'.repeat(10000), 10000],
];
for (const [name, source, expectedIssues] of largeInputCases) {
  test(`gitconfig: large input: ${name}`, () =>
    assert.equal(issues(parse(source)).length, expectedIssues));
}

test("gitconfig: a long invalid name run forms one issue with its full range", () => {
  const tree = parse(`[x]\n${"_".repeat(10000)}=1`);
  assert.deepEqual(issues(tree), [
    ["invalid_syntax", "invalid_name_character", 4, 10004],
  ]);
  assert.deepEqual(owners(tree), ["variable_name"]);
});
