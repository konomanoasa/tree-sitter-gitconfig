import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createTreeSitter,
  grammars,
  packageName,
  root,
} from "../scripts/tree-sitter.js";

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function renderedCaptures(html, source) {
  const start = html.indexOf("<pre><code>");
  const end = html.indexOf("</code></pre>");
  assert.ok(start >= 0 && end >= start, html);
  const content = html.slice(start + "<pre><code>".length, end);
  const stack = [];
  const captures = [];
  let text = "";
  for (const part of content.matchAll(
    /<span class='([^']*)'>|<[/]span>|([^<]+)/g,
  )) {
    if (part[1] !== undefined) stack.push(part[1].replaceAll(" ", "."));
    else if (part[0] === "</span>") assert.notEqual(stack.pop(), undefined);
    else {
      const decoded = decodeEntities(part[2]);
      text += decoded;
      captures.push(
        ...Array(Buffer.byteLength(decoded)).fill(stack.at(-1) ?? ""),
      );
    }
  }
  assert.equal(stack.length, 0, "unclosed highlight span");
  assert.equal(
    text.replace(/\n$/, ""),
    source.replace(/\n$/, ""),
    "rendered source differs from the input",
  );
  return captures;
}

function createHighlighter({ directory, root, run, captureNames }) {
  const parserDirectory = join(directory, "parsers");
  mkdirSync(parserDirectory);
  // CLI discovery requires a tree-sitter-* entry even when the checkout is renamed.
  symlinkSync(root, join(parserDirectory, "tree-sitter-test"), "junction");
  const configPath = join(directory, "highlight.json");
  const capturePath = join(directory, "captures.txt");
  writeFileSync(
    configPath,
    JSON.stringify({
      "parser-directories": [parserDirectory],
      theme: Object.fromEntries(
        captureNames.map((name, index) => [name, index + 17]),
      ),
    }),
  );
  writeFileSync(capturePath, `${captureNames.join("\n")}\n`);

  return (scope, source, valid = true) => {
    const path = join(directory, "highlight.txt");
    writeFileSync(path, source);
    if (valid) {
      const parsed = run(["parse", "--cst", "--scope", scope, path]);
      assert.doesNotMatch(parsed, /^[0-9: \t-]+•/m, parsed);
    }
    const captures = renderedCaptures(
      run([
        "highlight",
        "--check",
        "--captures-path",
        capturePath,
        "--config-path",
        configPath,
        "--html",
        "--layout",
        "fragment",
        "--style",
        "classes",
        "--scope",
        scope,
        path,
      ]),
      source,
    );
    for (const capture of captures) {
      assert.ok(
        capture === "" || captureNames.includes(capture),
        `unexpected final capture: ${capture}`,
      );
    }
    return captures;
  };
}

function assertCaptures(source, actual, ranges) {
  const bytes = Buffer.from(source);
  const expected = Array(bytes.length).fill("");
  let previousEnd = 0;
  for (const [start, end, capture] of ranges) {
    assert.ok(
      Number.isSafeInteger(start) && start >= previousEnd,
      "expected ranges must be ordered and disjoint",
    );
    assert.ok(
      Number.isSafeInteger(end) && end > start && end <= bytes.length,
      "expected range exceeds source bytes",
    );
    expected.fill(capture, start, end);
    previousEnd = end;
  }
  // HTML emits line breaks outside spans.
  for (const [index, byte] of bytes.entries()) {
    if (byte !== 10)
      assert.equal(
        actual[index],
        expected[index],
        `byte ${index} in ${JSON.stringify(source)}`,
      );
  }
}

const captureNames = [
  "comment",
  "type",
  "property",
  "string",
  "string.escape",
  "operator",
  "punctuation.bracket",
  "punctuation.delimiter",
];
let highlight;

let directory;
let runner;
before(() => {
  directory = mkdtempSync(join(tmpdir(), `${packageName}-highlight-`));
  runner = createTreeSitter();
  highlight = createHighlighter({
    directory,
    root,
    run: assertCommand,
    captureNames,
  });
});
after(() => {
  try {
    runner?.close();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function assertCommand(arguments_) {
  const result = runner.run(arguments_, {
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Non-standard highlight captures/);
  return result.stdout;
}

const grammar = grammars[0];

const finalCaptureCases = [
  {
    name: "invalid header whitespace preserves neighboring captures",
    source: "[ core ] x=y",
    captures: [
      [0, 1, "punctuation.bracket"],
      [2, 6, "type"],
      [7, 8, "punctuation.bracket"],
      [9, 10, "property"],
      [10, 11, "operator"],
      [11, 12, "string"],
    ],
  },
  {
    name: "legacy subsection preserves its separator and text",
    source: "[remote.Origin.more]",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 7, "type"],
      [7, 8, "punctuation.delimiter"],
      [8, 19, "string"],
      [19, 20, "punctuation.bracket"],
    ],
  },
  { name: "comment", source: " # note", captures: [[1, 7, "comment"]] },
  {
    name: "section and value",
    source: "[core] a=b",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 5, "type"],
      [5, 6, "punctuation.bracket"],
      [7, 8, "property"],
      [8, 9, "operator"],
      [9, 10, "string"],
    ],
  },
  {
    name: "subsection uses its own escape rule",
    source: '[x "a\\q"]',
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [3, 5, "string"],
      [5, 7, "string.escape"],
      [7, 8, "string"],
      [8, 9, "punctuation.bracket"],
    ],
  },
  {
    name: "normal value escape",
    source: "[x] a=b\\tc",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 5, "property"],
      [5, 6, "operator"],
      [6, 7, "string"],
      [7, 9, "string.escape"],
      [9, 10, "string"],
    ],
  },
  {
    name: "incomplete escape has no capture",
    source: "[x] a=b\\",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 5, "property"],
      [5, 6, "operator"],
      [6, 7, "string"],
    ],
  },
  {
    name: "invalid escape preserves neighboring text",
    source: "[x] a=b\\qc",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 5, "property"],
      [5, 6, "operator"],
      [6, 7, "string"],
      [9, 10, "string"],
    ],
  },
  {
    name: "incomplete quote preserves the next line",
    source: '[x] a="b\nc=1',
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 5, "property"],
      [5, 6, "operator"],
      [6, 8, "string"],
      [9, 10, "property"],
      [10, 11, "operator"],
      [11, 12, "string"],
    ],
  },
  {
    name: "continued value preserves internal whitespace captures",
    source: "[x] a=b\\\n  c",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 5, "property"],
      [5, 6, "operator"],
      [6, 7, "string"],
      [7, 9, "string.escape"],
      [9, 12, "string"],
    ],
  },
  {
    name: "continued value leaves leading whitespace uncaptured",
    source: '[x] a=\\\n  "" c',
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 5, "property"],
      [5, 6, "operator"],
      [6, 8, "string.escape"],
      [10, 12, "string"],
      [13, 14, "string"],
    ],
  },
  {
    name: "boolean and number spellings remain strings",
    source: "[x] true=false 12",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 8, "property"],
      [8, 9, "operator"],
      [9, 17, "string"],
    ],
  },
  {
    name: "include names remain ordinary names",
    source: "[include] path=x",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 8, "type"],
      [8, 9, "punctuation.bracket"],
      [10, 14, "property"],
      [14, 15, "operator"],
      [15, 16, "string"],
    ],
  },
  {
    name: "Unicode ranges use source bytes",
    source: '[x] a="日本"',
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [2, 3, "punctuation.bracket"],
      [4, 5, "property"],
      [5, 6, "operator"],
      [6, 14, "string"],
    ],
  },
  {
    name: "invalid name characters stay uncolored",
    source: "[a_b] x.y=z",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 2, "type"],
      [3, 4, "type"],
      [4, 5, "punctuation.bracket"],
      [6, 7, "property"],
      [8, 9, "property"],
      [9, 10, "operator"],
      [10, 11, "string"],
    ],
  },
];
for (const { name, source, captures } of finalCaptureCases) {
  test(`${grammar.name}: ${name}`, () =>
    assertCaptures(source, highlight(grammar.scope, source, false), captures));
}
