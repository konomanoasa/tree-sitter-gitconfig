[
  (comment_marker)
  (comment_text)
] @comment

[
  (section_open)
  (section_close)
] @punctuation.bracket

(section_name
  (name_text) @type)

(variable_name
  (name_text) @property)

[
  (subsection_text)
  (value_text)
  (quote_open)
  (quote_close)
] @string

(assignment_operator) @operator

[
  (escape)
  (line_continuation)
] @string.escape

(subsection_separator) @punctuation.delimiter
