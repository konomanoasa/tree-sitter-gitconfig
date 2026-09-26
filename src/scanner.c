#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"
#include <stdint.h>
#include <string.h>

enum Token {
  LINE_START,
  SECTION_START,
  SECTION_END,
  BLANK_START,
  VARIABLE_START,
  COMMENT_START,
  COMMENT_END,
  NAME_START,
  NAME_END,
  VALUE_START,
  VALUE_END,
  LAYOUT,
  END_OF_FILE,
  LINE_ENDING,
  SECTION_OPEN,
  SECTION_CLOSE,
  NAME_TEXT,
  SUBSECTION_TEXT,
  VALUE_TEXT,
  QUOTE_OPEN,
  QUOTE_CLOSE,
  ASSIGNMENT_OPERATOR,
  COMMENT_MARKER,
  COMMENT_TEXT,
  ESCAPE,
  LINE_CONTINUATION,
  ESCAPE_PREFIX,
  HEADER_TAIL_START,
  SUBSECTION_SEPARATOR,
  SUBSECTION_END,
  INVALID_ENCODING,
  INVALID_NAME_CHARACTER,
  INVALID_SUBSECTION_CHARACTER,
  INVALID_ESCAPE,
  ENDED_ESCAPE,
  INCOMPLETE_ESCAPE,
  MISSING_SECTION_NAME,
  INCOMPLETE_SECTION_NAME,
  MISSING_SECTION_CLOSE,
  INCOMPLETE_SECTION_CLOSE,
  MISSING_QUOTE_CLOSE,
  INCOMPLETE_QUOTE_CLOSE,
  MISSING_VARIABLE_NAME,
  MISSING_SUBSECTION_SEPARATOR,
  UNEXPECTED_HEADER_CONTENT,
  MISSING_ASSIGNMENT_OPERATOR,
  MISSING_SECTION_HEADER,
  ERROR_SENTINEL,
};

// NAME also scans legacy subsections with header-name rules, returning to
// name_return.
enum Mode {
  START,
  HEADER_OPEN,
  HEADER_NAME,
  NAME,
  HEADER_AFTER_NAME,
  SUBSECTION_OPEN,
  LEGACY_SUBSECTION,
  SUBSECTION,
  HEADER_CLOSE,
  HEADER_TAIL,
  AFTER_HEADER,
  VARIABLE_HEADER,
  VARIABLE_NAME,
  VARIABLE_AFTER_NAME,
  VALUE_BEFORE,
  VALUE,
  QUOTED_VALUE,
  VARIABLE_TAIL,
  COMMENT_MARK,
  COMMENT,
  COMMENT_ENDING,
  BLANK
};

// Positions count characters from the current line start.
typedef struct {
  uint32_t position, content_end, line_end, subsection_at;
  uint8_t mode, name_return, comment_return;
  bool ready, section, first, separated;
} Scanner;

typedef char scanner_fits_buffer
  [sizeof(Scanner) <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE ? 1 : -1];

static bool space(int32_t c) {
  return c == ' ' || c == '\t';
}
static bool comment(int32_t c) {
  return c == '#' || c == ';';
}
static bool alpha(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
static bool digit(int32_t c) {
  return c >= '0' && c <= '9';
}
static bool at_end(const Scanner *s) {
  return s->position == s->content_end;
}
static void advance(Scanner *s, TSLexer *lexer) {
  lexer->advance(lexer, false);
  s->position++;
}
static bool emit(TSLexer *lexer, const bool *valid, enum Token token) {
  if (!valid[token])
    return false;
  lexer->result_symbol = token;
  return true;
}
static bool
take(Scanner *s, TSLexer *lexer, const bool *valid, enum Token token) {
  advance(s, lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}
// The content excludes the CR of a CRLF ending.
static bool line_start(Scanner *s, TSLexer *lexer, const bool *valid) {
  s->position = 0;
  int32_t last = 0;
  lexer->mark_end(lexer);
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    last = lexer->lookahead;
    advance(s, lexer);
  }
  s->content_end = s->position;
  if (last == '\r' && !lexer->eof(lexer))
    s->content_end--;
  s->line_end = s->position + (!lexer->eof(lexer) ? 1 : 0);
  s->position = 0;
  s->ready = true;
  return emit(lexer, valid, LINE_START);
}
static bool
finish_line(Scanner *s, TSLexer *lexer, const bool *valid, enum Token token) {
  while (s->position < s->line_end)
    advance(s, lexer);
  lexer->mark_end(lexer);
  s->ready = false;
  return emit(lexer, valid, token);
}
static bool end_line(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (lexer->eof(lexer))
    return emit(lexer, valid, END_OF_FILE);
  return finish_line(s, lexer, valid, LINE_ENDING);
}
static bool layout(Scanner *s, TSLexer *lexer, const bool *valid) {
  while (!at_end(s) && space(lexer->lookahead))
    advance(s, lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, LAYOUT);
}
static bool start_comment(Scanner *s, TSLexer *lexer, const bool *valid) {
  s->comment_return = s->mode;
  s->mode = COMMENT_MARK;
  return emit(lexer, valid, COMMENT_START);
}
static enum Token
absent(TSLexer *lexer, enum Token missing, enum Token incomplete) {
  return lexer->eof(lexer) ? incomplete : missing;
}
static bool header_name(const Scanner *s) {
  return s->name_return == HEADER_AFTER_NAME;
}
static bool header_delimiter(int32_t c) {
  return space(c) || comment(c) || c == ']' || c == '"';
}
static bool name_boundary(const Scanner *s, int32_t c) {
  if (at_end(s))
    return true;
  if (header_name(s))
    return s->position == s->subsection_at || header_delimiter(c);
  return space(c) || comment(c) || c == '=';
}
static bool text_end(bool subsection, bool quoted, int32_t c) {
  if (c == '"' || c == '\\' || c == -1)
    return true;
  return (subsection && c == 0) || (!quoted && comment(c));
}
static bool name_character(const Scanner *s, int32_t c) {
  if (!header_name(s) && s->first)
    return alpha(c);
  return alpha(c) || digit(c) || c == '-' || (header_name(s) && c == '.');
}
static bool header_junk(const Scanner *s, int32_t c) {
  return !at_end(s) && !comment(c) && c != ']' && c != -1;
}
static bool header_space(Scanner *s, TSLexer *lexer, const bool *valid) {
  const uint32_t start = s->position;
  while (!at_end(s) && space(lexer->lookahead))
    advance(s, lexer);
  if (s->mode == HEADER_NAME) {
    lexer->mark_end(lexer);
    return emit(lexer, valid, UNEXPECTED_HEADER_CONTENT);
  }
  bool separator =
    s->mode == HEADER_AFTER_NAME && !at_end(s) && lexer->lookahead == '"';
  if (separator || lexer->eof(lexer)) {
    lexer->mark_end(lexer);
    s->separated = true;
    return emit(lexer, valid, LAYOUT);
  }
  // Rescan rejected whitespace with the rest of the header tail.
  s->position = start;
  s->mode = HEADER_TAIL;
  return emit(lexer, valid, HEADER_TAIL_START);
}
// The first noninitial dot starts a legacy subsection unless a quoted
// subsection follows. Lookahead only advances the lexer.
static uint32_t legacy_separator(const Scanner *s, TSLexer *lexer) {
  uint32_t separator = UINT32_MAX;
  uint32_t position = s->position;
  while (position < s->content_end && !header_delimiter(lexer->lookahead)) {
    bool dot = lexer->lookahead == '.' && position > s->position;
    if (dot && separator == UINT32_MAX)
      separator = position;
    lexer->advance(lexer, false);
    position++;
  }
  while (position < s->content_end && space(lexer->lookahead)) {
    lexer->advance(lexer, false);
    position++;
  }
  if (position < s->content_end && lexer->lookahead == '"')
    return UINT32_MAX;
  return separator;
}
static bool
escape(Scanner *s, TSLexer *lexer, const bool *valid, bool subsection) {
  advance(s, lexer);
  lexer->mark_end(lexer);
  if (at_end(s)) {
    if (!subsection && !lexer->eof(lexer))
      return finish_line(s, lexer, valid, LINE_CONTINUATION);
    return emit(lexer, valid, absent(lexer, ENDED_ESCAPE, INCOMPLETE_ESCAPE));
  }
  int32_t c = lexer->lookahead;
  if (c == -1 || (subsection && c == 0))
    return emit(lexer, valid, ESCAPE_PREFIX);
  bool known = c == '"' || c == '\\' || c == 'n' || c == 't' || c == 'b';
  return take(s, lexer, valid, subsection || known ? ESCAPE : INVALID_ESCAPE);
}
static bool scan(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (valid[ERROR_SENTINEL])
    return false;
  if (!s->ready) {
    if (!lexer->eof(lexer))
      return line_start(s, lexer, valid);
    s->position = s->content_end = s->line_end = 0;
    s->ready = true;
  }
  lexer->mark_end(lexer);
  int32_t c = lexer->lookahead;
  switch ((enum Mode)s->mode) {
  case START: {
    if (lexer->eof(lexer)) {
      if (!s->section)
        return false;
      s->section = false;
      return emit(lexer, valid, SECTION_END);
    }
    while (!at_end(s) && space(lexer->lookahead))
      advance(s, lexer);
    if (!at_end(s) && lexer->lookahead == '[' && s->section) {
      // Zero-width at the line start; the line is rescanned afterwards.
      s->position = 0;
      s->section = false;
      return emit(lexer, valid, SECTION_END);
    }
    lexer->mark_end(lexer);
    if (at_end(s)) {
      s->mode = BLANK;
      return emit(lexer, valid, BLANK_START);
    }
    if (lexer->lookahead == '[') {
      s->section = true;
      s->mode = HEADER_OPEN;
      return emit(lexer, valid, SECTION_START);
    }
    if (comment(lexer->lookahead))
      return start_comment(s, lexer, valid);
    s->mode = VARIABLE_HEADER;
    return emit(lexer, valid, VARIABLE_START);
  }
  case HEADER_OPEN:
    s->subsection_at = UINT32_MAX;
    s->mode = HEADER_NAME;
    return take(s, lexer, valid, SECTION_OPEN);
  case HEADER_NAME:
  case VARIABLE_NAME: {
    const bool header = s->mode == HEADER_NAME;
    if (header && !at_end(s) && space(c))
      return header_space(s, lexer, valid);
    s->name_return = header ? HEADER_AFTER_NAME : VARIABLE_AFTER_NAME;
    s->first = true;
    s->separated = false;
    if (name_boundary(s, c)) {
      s->mode = s->name_return;
      // A variable name is never missing at EOF: the line has a first
      // character, which is `=` here.
      return emit(
        lexer,
        valid,
        header ? absent(lexer, MISSING_SECTION_NAME, INCOMPLETE_SECTION_NAME)
               : MISSING_VARIABLE_NAME
      );
    }
    if (header)
      s->subsection_at = legacy_separator(s, lexer);
    s->mode = NAME;
    return emit(lexer, valid, NAME_START);
  }
  case NAME:
  case LEGACY_SUBSECTION: {
    const bool legacy = s->mode == LEGACY_SUBSECTION;
    if (name_boundary(s, c)) {
      s->mode = legacy ? HEADER_CLOSE : s->name_return;
      return emit(lexer, valid, legacy ? SUBSECTION_END : NAME_END);
    }
    if (c == -1 || !name_character(s, c)) {
      s->first = false;
      return take(
        s,
        lexer,
        valid,
        c == -1 ? INVALID_ENCODING : INVALID_NAME_CHARACTER
      );
    }
    do {
      advance(s, lexer);
      s->first = false;
    } while (
      !name_boundary(s, lexer->lookahead) && name_character(s, lexer->lookahead)
    );
    lexer->mark_end(lexer);
    return emit(lexer, valid, legacy ? SUBSECTION_TEXT : NAME_TEXT);
  }
  case HEADER_AFTER_NAME:
    if (s->position == s->subsection_at) {
      s->mode = LEGACY_SUBSECTION;
      return take(s, lexer, valid, SUBSECTION_SEPARATOR);
    }
    if (!at_end(s) && space(c))
      return header_space(s, lexer, valid);
    if (!at_end(s) && c == '"') {
      s->mode = SUBSECTION_OPEN;
      if (!s->first && !s->separated)
        return emit(lexer, valid, MISSING_SUBSECTION_SEPARATOR);
      return scan(s, lexer, valid);
    }
    s->mode = HEADER_CLOSE;
    return scan(s, lexer, valid);
  case SUBSECTION_OPEN:
    s->mode = SUBSECTION;
    return take(s, lexer, valid, QUOTE_OPEN);
  case HEADER_CLOSE:
    if (s->subsection_at != UINT32_MAX && !at_end(s) && space(c))
      return header_space(s, lexer, valid);
    s->mode = HEADER_TAIL;
    return emit(lexer, valid, HEADER_TAIL_START);
  case HEADER_TAIL:
    if (at_end(s) || comment(c)) {
      s->mode = AFTER_HEADER;
      return emit(
        lexer,
        valid,
        absent(lexer, MISSING_SECTION_CLOSE, INCOMPLETE_SECTION_CLOSE)
      );
    }
    if (c == ']') {
      s->mode = AFTER_HEADER;
      return take(s, lexer, valid, SECTION_CLOSE);
    }
    if (c == -1)
      return take(s, lexer, valid, INVALID_ENCODING);
    do
      advance(s, lexer);
    while (header_junk(s, lexer->lookahead));
    lexer->mark_end(lexer);
    return emit(lexer, valid, UNEXPECTED_HEADER_CONTENT);
  case AFTER_HEADER:
    if (!at_end(s) && space(c)) {
      while (!at_end(s) && space(lexer->lookahead))
        advance(s, lexer);
      lexer->mark_end(lexer);
      if (at_end(s) || comment(lexer->lookahead))
        return emit(lexer, valid, LAYOUT);
      s->mode = VARIABLE_HEADER;
      return emit(lexer, valid, VARIABLE_START);
    }
    if (at_end(s)) {
      s->mode = START;
      if (lexer->eof(lexer))
        return scan(s, lexer, valid);
      return end_line(s, lexer, valid);
    }
    if (comment(c))
      return start_comment(s, lexer, valid);
    s->mode = VARIABLE_HEADER;
    return emit(lexer, valid, VARIABLE_START);
  case VARIABLE_HEADER:
    s->mode = VARIABLE_NAME;
    if (!s->section)
      return emit(lexer, valid, MISSING_SECTION_HEADER);
    return scan(s, lexer, valid);
  case VARIABLE_AFTER_NAME:
    if (!at_end(s) && space(c))
      return layout(s, lexer, valid);
    if (at_end(s) || comment(c)) {
      s->mode = VARIABLE_TAIL;
      return scan(s, lexer, valid);
    }
    s->mode = VALUE_BEFORE;
    if (c == '=')
      return take(s, lexer, valid, ASSIGNMENT_OPERATOR);
    return emit(lexer, valid, MISSING_ASSIGNMENT_OPERATOR);
  case VALUE_BEFORE:
    if (!at_end(s) && space(c))
      return layout(s, lexer, valid);
    if (at_end(s) || comment(c)) {
      s->mode = VARIABLE_TAIL;
      return scan(s, lexer, valid);
    }
    s->mode = VALUE;
    return emit(lexer, valid, VALUE_START);
  case SUBSECTION:
  case VALUE:
  case QUOTED_VALUE: {
    const bool subsection = s->mode == SUBSECTION;
    const bool quoted = s->mode != VALUE;
    if (at_end(s)) {
      if (quoted) {
        s->mode = subsection ? HEADER_CLOSE : VALUE;
        return emit(
          lexer,
          valid,
          absent(lexer, MISSING_QUOTE_CLOSE, INCOMPLETE_QUOTE_CLOSE)
        );
      }
      s->mode = VARIABLE_TAIL;
      return emit(lexer, valid, VALUE_END);
    }
    if (!quoted && comment(c)) {
      s->mode = VARIABLE_TAIL;
      return emit(lexer, valid, VALUE_END);
    }
    if (c == '"') {
      s->mode = quoted ? (subsection ? HEADER_CLOSE : VALUE) : QUOTED_VALUE;
      return take(s, lexer, valid, quoted ? QUOTE_CLOSE : QUOTE_OPEN);
    }
    if (c == -1 || (subsection && c == 0))
      return take(
        s,
        lexer,
        valid,
        c == -1 ? INVALID_ENCODING : INVALID_SUBSECTION_CHARACTER
      );
    if (c == '\\')
      return escape(s, lexer, valid, subsection);
    // Unquoted text ends before trailing spaces unless more value follows.
    const uint32_t start = s->position;
    uint32_t end = start;
    while (!at_end(s) && !text_end(subsection, quoted, lexer->lookahead)) {
      c = lexer->lookahead;
      advance(s, lexer);
      if (quoted || !space(c)) {
        lexer->mark_end(lexer);
        end = s->position;
      }
    }
    if (!quoted && !at_end(s) && !comment(lexer->lookahead)) {
      lexer->mark_end(lexer);
      end = s->position;
    }
    s->position = end;
    if (end == start) {
      s->mode = VARIABLE_TAIL;
      return emit(lexer, valid, VALUE_END);
    }
    return emit(lexer, valid, subsection ? SUBSECTION_TEXT : VALUE_TEXT);
  }
  case VARIABLE_TAIL:
    if (!at_end(s) && space(c))
      return layout(s, lexer, valid);
    if (!at_end(s) && comment(c))
      return start_comment(s, lexer, valid);
    s->mode = START;
    return end_line(s, lexer, valid);
  case COMMENT_MARK:
    s->mode = COMMENT;
    return take(s, lexer, valid, COMMENT_MARKER);
  case COMMENT:
    if (at_end(s)) {
      // A comment line owns its line ending; a trailing comment leaves it
      // to the variable or section.
      s->mode = COMMENT_ENDING;
      if (s->comment_return == START && !lexer->eof(lexer))
        return end_line(s, lexer, valid);
      return scan(s, lexer, valid);
    }
    if (c == -1)
      return take(s, lexer, valid, INVALID_ENCODING);
    while (!at_end(s) && lexer->lookahead != -1)
      advance(s, lexer);
    lexer->mark_end(lexer);
    return emit(lexer, valid, COMMENT_TEXT);
  case COMMENT_ENDING:
    s->mode = s->comment_return;
    return emit(lexer, valid, COMMENT_END);
  case BLANK:
    s->mode = START;
    return end_line(s, lexer, valid);
  }
  return false;
}

void *tree_sitter_gitconfig_external_scanner_create(void) {
  return ts_calloc(1, sizeof(Scanner));
}
void tree_sitter_gitconfig_external_scanner_destroy(void *payload) {
  ts_free(payload);
}
unsigned
tree_sitter_gitconfig_external_scanner_serialize(void *payload, char *buffer) {
  memcpy(buffer, payload, sizeof(Scanner));
  return sizeof(Scanner);
}
void tree_sitter_gitconfig_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  memset(payload, 0, sizeof(Scanner));
  if (length == sizeof(Scanner))
    memcpy(payload, buffer, length);
}
bool tree_sitter_gitconfig_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid
) {
  Scanner next = *(Scanner *)payload;
  if (!scan(&next, lexer, valid))
    return false;
  *(Scanner *)payload = next;
  return true;
}
