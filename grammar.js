export default grammar({
  name: "gitconfig",
  externals: ($) => [
    $._line_start,
    $._section_start,
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
    $.subsection_separator,
    $._subsection_end,
    $._error_sentinel,
  ],
  extras: ($) => [$._line_start, $._layout, $._unmatchable],
  rules: {
    document: ($) => repeat(choice($.section, $.blank_line, $.comment)),
    section: ($) =>
      prec.right(
        seq(
          $._section_start,
          field("header", $.section_header),
          repeat(
            choice($.variable, $.blank_line, $.comment, $.line_ending, $._eof),
          ),
        ),
      ),
    section_header: ($) =>
      seq(
        field("opening", $.section_open),
        field("name", $.section_name),
        optional(field("subsection", $.subsection)),
        field("closing", $.section_close),
      ),
    section_name: ($) => $._name,
    variable_name: ($) => $._name,
    _name: ($) => seq($._name_start, $.name_text, $._name_end),
    subsection: ($) =>
      choice(
        $._quoted_subsection,
        seq(
          $.subsection_separator,
          optional($.subsection_text),
          $._subsection_end,
        ),
      ),
    _quoted_subsection: ($) =>
      seq(
        field("opening", $.quote_open),
        repeat(choice($.subsection_text, $.escape)),
        field("closing", $.quote_close),
      ),
    variable: ($) =>
      seq(
        $._variable_start,
        field("name", $.variable_name),
        optional(
          seq(
            field("operator", $.assignment_operator),
            optional(field("value", $.value)),
          ),
        ),
        optional($.comment),
        choice($.line_ending, $._eof),
      ),
    value: ($) =>
      seq(
        $._value_start,
        repeat1(choice($.quoted_value, $._value_piece)),
        $._value_end,
      ),
    _value_piece: ($) => choice($.value_text, $.escape, $.line_continuation),
    quoted_value: ($) =>
      seq(
        field("opening", $.quote_open),
        repeat($._value_piece),
        field("closing", $.quote_close),
      ),
    comment: ($) =>
      seq(
        $._comment_start,
        $.comment_marker,
        optional($.comment_text),
        optional($.line_ending),
        $._comment_end,
      ),
    blank_line: ($) => seq($._blank_start, choice($.line_ending, $._eof)),
    // Prevent premature EOF acceptance in Tree-sitter 0.27.0.
    _unmatchable: () => token(seq(/[\s\S]/, /[^\s\S]/)),
  },
});
