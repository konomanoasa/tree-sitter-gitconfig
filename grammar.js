const issueKinds = [
  ["invalid_encoding", "invalid_syntax", "invalid_encoding"],
  ["invalid_name_character", "invalid_syntax", "invalid_name_character"],
  [
    "invalid_subsection_character",
    "invalid_syntax",
    "invalid_subsection_character",
  ],
  ["invalid_escape", "invalid_syntax", "invalid_escape"],
  ["ended_escape", "invalid_syntax", "incomplete_escape"],
  ["incomplete_escape", "incomplete_syntax", "incomplete_escape"],
  ...["section_name", "section_close", "quote_close"].flatMap((name) => [
    [`missing_${name}`, "invalid_syntax", `missing_${name}`],
    [`incomplete_${name}`, "incomplete_syntax", `missing_${name}`],
  ]),
  ["missing_variable_name", "invalid_syntax", "missing_variable_name"],
  [
    "missing_subsection_separator",
    "invalid_syntax",
    "missing_subsection_separator",
  ],
  ["unexpected_header_content", "invalid_syntax", "unexpected_header_content"],
  [
    "missing_assignment_operator",
    "invalid_syntax",
    "missing_assignment_operator",
  ],
  ["missing_section_header", "invalid_syntax", "missing_section_header"],
];
const issueRules = Object.fromEntries(
  issueKinds.flatMap(([token, outcome, reason]) => [
    [`_${token}_outcome`, ($) => alias($[`_${token}`], $[reason])],
    [`_${token}_issue`, ($) => alias($[`_${token}_outcome`], $[outcome])],
  ]),
);
const issue = ($, name) =>
  field("issue", alias($[`_${name}_issue`], $.syntax_issue));
const missing = ($, name) =>
  choice(issue($, `missing_${name}`), issue($, `incomplete_${name}`));
// The owner holds a backslash before the issue of the unit it cannot escape.
const valuePieces = ($) => [
  $.value_text,
  $.escape,
  $.line_continuation,
  issue($, "invalid_encoding"),
  issue($, "invalid_escape"),
  issue($, "incomplete_escape"),
  $._escape_prefix,
];

export default grammar({
  name: "gitconfig",
  externals: ($) => [
    $._line_start,
    $._section_start,
    $._section_end,
    $._blank_start,
    $._variable_start,
    $._comment_start,
    $._comment_end,
    $._name_start,
    $._name_end,
    $._value_start,
    $._value_end,
    $._layout,
    $._eof,
    $.line_ending,
    $.section_open,
    $.section_close,
    $.name_text,
    $.subsection_text,
    $.value_text,
    $.quote_open,
    $.quote_close,
    $.assignment_operator,
    $.comment_marker,
    $.comment_text,
    $.escape,
    $.line_continuation,
    $._escape_prefix,
    $._header_tail_start,
    $.subsection_separator,
    $._subsection_end,
    ...issueKinds.map(([name]) => $[`_${name}`]),
    $._error_sentinel,
  ],
  extras: ($) => [$._line_start, $._layout],
  rules: {
    document: ($) =>
      repeat(choice($.section, $.blank_line, $.comment, $.variable)),
    section: ($) =>
      seq(
        $._section_start,
        field("header", $.section_header),
        repeat(choice($.variable, $.blank_line, $.comment, $.line_ending)),
        $._section_end,
      ),
    section_header: ($) =>
      seq(
        field("opening", $.section_open),
        optional(issue($, "unexpected_header_content")),
        choice(field("name", $.section_name), missing($, "section_name")),
        optional(
          seq(
            optional(issue($, "missing_subsection_separator")),
            field("subsection", $.subsection),
          ),
        ),
        $._header_tail_start,
        repeat(
          choice(
            issue($, "unexpected_header_content"),
            issue($, "invalid_encoding"),
          ),
        ),
        choice(field("closing", $.section_close), missing($, "section_close")),
      ),
    section_name: ($) => $._name,
    variable_name: ($) => $._name,
    _name: ($) =>
      seq(
        $._name_start,
        repeat1(
          choice(
            $.name_text,
            issue($, "invalid_name_character"),
            issue($, "invalid_encoding"),
          ),
        ),
        $._name_end,
      ),
    subsection: ($) =>
      choice(
        $._quoted_subsection,
        seq(
          $.subsection_separator,
          repeat(
            choice(
              $.subsection_text,
              issue($, "invalid_name_character"),
              issue($, "invalid_encoding"),
            ),
          ),
          $._subsection_end,
        ),
      ),
    _quoted_subsection: ($) =>
      seq(
        field("opening", $.quote_open),
        repeat(
          choice(
            $.subsection_text,
            $.escape,
            issue($, "invalid_encoding"),
            issue($, "invalid_subsection_character"),
            issue($, "ended_escape"),
            issue($, "incomplete_escape"),
            $._escape_prefix,
          ),
        ),
        choice(field("closing", $.quote_close), missing($, "quote_close")),
      ),
    variable: ($) =>
      seq(
        $._variable_start,
        optional(issue($, "missing_section_header")),
        choice(
          field("name", $.variable_name),
          issue($, "missing_variable_name"),
        ),
        optional(
          seq(
            choice(
              field("operator", $.assignment_operator),
              issue($, "missing_assignment_operator"),
            ),
            optional(field("value", $.value)),
          ),
        ),
        optional($.comment),
        choice($.line_ending, $._eof),
      ),
    value: ($) =>
      seq(
        $._value_start,
        repeat1(choice($.quoted_value, ...valuePieces($))),
        $._value_end,
      ),
    quoted_value: ($) =>
      seq(
        field("opening", $.quote_open),
        repeat(choice(...valuePieces($))),
        choice(field("closing", $.quote_close), missing($, "quote_close")),
      ),
    comment: ($) =>
      seq(
        $._comment_start,
        $.comment_marker,
        repeat(choice($.comment_text, issue($, "invalid_encoding"))),
        optional($.line_ending),
        $._comment_end,
      ),
    blank_line: ($) => seq($._blank_start, choice($.line_ending, $._eof)),
    ...issueRules,
  },
});
