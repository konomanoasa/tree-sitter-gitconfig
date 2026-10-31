#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"
#include <stdint.h>
#include <string.h>

enum Token {
  LINE_START,
  SECTION_START,
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
  SUBSECTION_SEPARATOR,
  SUBSECTION_END,
  ERROR_SENTINEL,
};

enum Mode {
  START,
  HEADER_OPEN,
  HEADER_NAME,
  HEADER_NAME_TEXT,
  HEADER_AFTER_NAME,
  LEGACY_SUBSECTION,
  SUBSECTION,
  HEADER_CLOSE,
  AFTER_HEADER,
  VARIABLE_NAME,
  VARIABLE_NAME_TEXT,
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

#define NONE UINT32_MAX

// Positions are line-relative character offsets.
typedef struct {
  uint32_t position, content_end, line_end, subsection_at;
  uint16_t mode, comment_return;
  uint8_t ready, first, separated, value_started;
} Scanner;

typedef char scanner_fits_inline_state[sizeof(Scanner) == 24 ? 1 : -1];

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

static bool header_name(const Scanner *s) {
  switch ((enum Mode)s->mode) {
    case HEADER_NAME:
    case HEADER_NAME_TEXT:
    case LEGACY_SUBSECTION:
      return true;
    default:
      return false;
  }
}

static bool header_delimiter(int32_t c) {
  return space(c) || comment(c) || c == ']' || c == '"';
}

static bool name_boundary(const Scanner *s, int32_t c) {
  if (at_end(s)) return true;
  if (header_name(s))
    return s->position == s->subsection_at || header_delimiter(c);
  return space(c) || comment(c) || c == '=';
}

static bool name_character(const Scanner *s, int32_t c) {
  if (!header_name(s) && s->first) return alpha(c);
  return alpha(c) || digit(c) || c == '-' || (header_name(s) && c == '.');
}

static bool text_end(bool subsection, bool quoted, int32_t c) {
  if (c == '"' || c == '\\' || c == -1) return true;
  return (subsection && c == 0) || (!quoted && comment(c));
}

static void advance(Scanner *s, TSLexer *lexer) {
  lexer->advance(lexer, false);
  s->position++;
}

static void skip_spaces(Scanner *s, TSLexer *lexer) {
  while (!at_end(s) && space(lexer->lookahead)) advance(s, lexer);
}

static bool emit(TSLexer *lexer, const bool *valid, enum Token token) {
  if (!valid[token]) return false;
  lexer->result_symbol = token;
  return true;
}

static bool
take(Scanner *s, TSLexer *lexer, const bool *valid, enum Token token) {
  advance(s, lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}

static bool start_line(Scanner *s, TSLexer *lexer, const bool *valid) {
  s->position = 0;
  int32_t last = 0;
  lexer->mark_end(lexer);
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    last = lexer->lookahead;
    advance(s, lexer);
  }
  s->content_end = s->position;
  if (last == '\r' && !lexer->eof(lexer)) s->content_end--;
  s->line_end = s->position + (!lexer->eof(lexer) ? 1 : 0);
  s->position = 0;
  s->ready = true;
  return emit(lexer, valid, LINE_START);
}

static bool
finish_line(Scanner *s, TSLexer *lexer, const bool *valid, enum Token token) {
  while (s->position < s->line_end) advance(s, lexer);
  lexer->mark_end(lexer);
  s->ready = false;
  return emit(lexer, valid, token);
}

// Clear finished-line state to preserve reuse after edits.
static bool end_line(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (lexer->eof(lexer)) return emit(lexer, valid, END_OF_FILE);
  const bool ended = finish_line(s, lexer, valid, LINE_ENDING);
  *s = (Scanner){.mode = s->mode};
  return ended;
}

static bool layout(Scanner *s, TSLexer *lexer, const bool *valid) {
  skip_spaces(s, lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, LAYOUT);
}

static bool start_comment(Scanner *s, TSLexer *lexer, const bool *valid) {
  s->comment_return = s->mode;
  s->mode = COMMENT_MARK;
  return emit(lexer, valid, COMMENT_START);
}

static bool header_space(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (s->mode == HEADER_AFTER_NAME) s->separated = true;
  return layout(s, lexer, valid);
}

static uint32_t legacy_separator(const Scanner *s, TSLexer *lexer) {
  uint32_t separator = NONE;
  uint32_t position = s->position;
  while (position < s->content_end && !header_delimiter(lexer->lookahead)) {
    const bool dot = lexer->lookahead == '.' && position > s->position;
    if (dot && separator == NONE) separator = position;
    lexer->advance(lexer, false);
    position++;
  }
  while (position < s->content_end && space(lexer->lookahead)) {
    lexer->advance(lexer, false);
    position++;
  }
  if (position < s->content_end && lexer->lookahead == '"') return NONE;
  return separator;
}

static bool
escape(Scanner *s, TSLexer *lexer, const bool *valid, bool subsection) {
  advance(s, lexer);
  lexer->mark_end(lexer);
  if (!subsection && at_end(s) && !lexer->eof(lexer))
    return finish_line(s, lexer, valid, LINE_CONTINUATION);
  if (!subsection) s->value_started = true;
  if (at_end(s)) return false;
  const int32_t c = lexer->lookahead;
  if (c == -1 || (subsection && c == 0)) return false;
  const bool known = c == '"' || c == '\\' || c == 'n' || c == 't' || c == 'b';
  if (!subsection && !known) return false;
  return take(s, lexer, valid, ESCAPE);
}

static bool start_content(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (lexer->eof(lexer)) return false;
  skip_spaces(s, lexer);
  lexer->mark_end(lexer);
  if (at_end(s)) {
    s->mode = BLANK;
    return emit(lexer, valid, BLANK_START);
  }
  if (lexer->lookahead == '[') {
    s->mode = HEADER_OPEN;
    return emit(lexer, valid, SECTION_START);
  }
  if (comment(lexer->lookahead)) return start_comment(s, lexer, valid);
  s->mode = VARIABLE_NAME;
  return emit(lexer, valid, VARIABLE_START);
}

static bool name_start(Scanner *s, TSLexer *lexer, const bool *valid) {
  const bool header = s->mode == HEADER_NAME;
  const int32_t c = lexer->lookahead;
  if (header && !at_end(s) && space(c)) return header_space(s, lexer, valid);
  s->first = true;
  s->separated = false;
  if (name_boundary(s, c) || !name_character(s, c)) return false;
  if (header) s->subsection_at = legacy_separator(s, lexer);
  s->mode = header ? HEADER_NAME_TEXT : VARIABLE_NAME_TEXT;
  return emit(lexer, valid, NAME_START);
}

static bool name_piece(Scanner *s, TSLexer *lexer, const bool *valid) {
  const bool legacy = s->mode == LEGACY_SUBSECTION;
  const int32_t c = lexer->lookahead;
  if (name_boundary(s, c)) {
    s->mode = legacy                ? HEADER_CLOSE
      : s->mode == HEADER_NAME_TEXT ? HEADER_AFTER_NAME
                                    : VARIABLE_AFTER_NAME;
    return emit(lexer, valid, legacy ? SUBSECTION_END : NAME_END);
  }
  if (!name_character(s, c)) return false;
  s->first = false;
  do advance(s, lexer);
  while (
    !name_boundary(s, lexer->lookahead) && name_character(s, lexer->lookahead)
  );
  lexer->mark_end(lexer);
  return emit(lexer, valid, legacy ? SUBSECTION_TEXT : NAME_TEXT);
}

static bool text_piece(Scanner *s, TSLexer *lexer, const bool *valid) {
  const bool subsection = s->mode == SUBSECTION;
  const bool quoted = s->mode != VALUE;
  const int32_t c = lexer->lookahead;
  if (!quoted && (at_end(s) || comment(c))) {
    s->mode = VARIABLE_TAIL;
    return emit(lexer, valid, VALUE_END);
  }
  if (at_end(s)) return false;
  if (!quoted && !s->value_started && space(c)) {
    const uint32_t start = s->position;
    skip_spaces(s, lexer);
    if (!at_end(s) && !comment(lexer->lookahead)) {
      lexer->mark_end(lexer);
      return emit(lexer, valid, LAYOUT);
    }
    s->position = start;
    s->mode = VARIABLE_TAIL;
    return emit(lexer, valid, VALUE_END);
  }
  if (c == '"') {
    s->mode = quoted ? (subsection ? HEADER_CLOSE : VALUE) : QUOTED_VALUE;
    return take(s, lexer, valid, quoted ? QUOTE_CLOSE : QUOTE_OPEN);
  }
  if (c == -1 || (subsection && c == 0)) return false;
  if (c == '\\') return escape(s, lexer, valid, subsection);
  const uint32_t start = s->position;
  uint32_t end = start;
  while (!at_end(s) && !text_end(subsection, quoted, lexer->lookahead)) {
    const bool content = quoted || !space(lexer->lookahead);
    advance(s, lexer);
    if (content) {
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
  if (!subsection) s->value_started = true;
  return emit(lexer, valid, subsection ? SUBSECTION_TEXT : VALUE_TEXT);
}

static bool scan(Scanner *s, TSLexer *lexer, const bool *valid) {
  if (valid[ERROR_SENTINEL]) return false;
  if (!s->ready) {
    if (!lexer->eof(lexer)) return start_line(s, lexer, valid);
    s->position = s->content_end = s->line_end = 0;
    s->ready = true;
  }
  lexer->mark_end(lexer);
  for (;;) {
    const int32_t c = lexer->lookahead;
    switch ((enum Mode)s->mode) {
      case START:
        return start_content(s, lexer, valid);
      case HEADER_OPEN:
        s->subsection_at = NONE;
        s->mode = HEADER_NAME;
        return take(s, lexer, valid, SECTION_OPEN);
      case HEADER_NAME:
      case VARIABLE_NAME:
        return name_start(s, lexer, valid);
      case HEADER_NAME_TEXT:
      case VARIABLE_NAME_TEXT:
      case LEGACY_SUBSECTION:
        return name_piece(s, lexer, valid);
      case HEADER_AFTER_NAME:
        if (s->position == s->subsection_at) {
          s->mode = LEGACY_SUBSECTION;
          return take(s, lexer, valid, SUBSECTION_SEPARATOR);
        }
        if (!at_end(s) && space(c)) return header_space(s, lexer, valid);
        if (!at_end(s) && c == '"') {
          if (!s->separated) return false;
          s->mode = SUBSECTION;
          return take(s, lexer, valid, QUOTE_OPEN);
        }
        s->mode = HEADER_CLOSE;
        continue;
      case HEADER_CLOSE:
        if (!at_end(s) && space(c)) return header_space(s, lexer, valid);
        if (at_end(s) || c != ']') return false;
        s->mode = AFTER_HEADER;
        return take(s, lexer, valid, SECTION_CLOSE);
      case AFTER_HEADER:
        if (!at_end(s) && space(c)) {
          skip_spaces(s, lexer);
          lexer->mark_end(lexer);
          if (at_end(s) || comment(lexer->lookahead))
            return emit(lexer, valid, LAYOUT);
        }
        if (at_end(s)) {
          s->mode = START;
          return end_line(s, lexer, valid);
        }
        if (comment(lexer->lookahead)) return start_comment(s, lexer, valid);
        s->mode = VARIABLE_NAME;
        return emit(lexer, valid, VARIABLE_START);
      case VARIABLE_AFTER_NAME:
        if (!at_end(s) && space(c)) return layout(s, lexer, valid);
        if (at_end(s) || comment(c)) {
          s->mode = VARIABLE_TAIL;
          continue;
        }
        if (c != '=') return false;
        s->mode = VALUE_BEFORE;
        return take(s, lexer, valid, ASSIGNMENT_OPERATOR);
      case VALUE_BEFORE:
        if (!at_end(s) && space(c)) return layout(s, lexer, valid);
        if (at_end(s) || comment(c)) {
          s->mode = VARIABLE_TAIL;
          continue;
        }
        s->mode = VALUE;
        s->value_started = false;
        return emit(lexer, valid, VALUE_START);
      case SUBSECTION:
      case VALUE:
      case QUOTED_VALUE:
        return text_piece(s, lexer, valid);
      case VARIABLE_TAIL:
        if (!at_end(s) && space(c)) return layout(s, lexer, valid);
        if (!at_end(s) && comment(c)) return start_comment(s, lexer, valid);
        s->mode = START;
        return end_line(s, lexer, valid);
      case COMMENT_MARK:
        s->mode = COMMENT;
        return take(s, lexer, valid, COMMENT_MARKER);
      case COMMENT:
        if (at_end(s)) {
          s->mode = COMMENT_ENDING;
          if (s->comment_return == START && !lexer->eof(lexer))
            return end_line(s, lexer, valid);
          continue;
        }
        if (c == -1) return false;
        while (!at_end(s) && lexer->lookahead != -1) advance(s, lexer);
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
}

void *tree_sitter_gitconfig_external_scanner_create(void) {
  return ts_calloc(1, sizeof(Scanner));
}

void tree_sitter_gitconfig_external_scanner_destroy(void *payload) {
  ts_free(payload);
}

unsigned
tree_sitter_gitconfig_external_scanner_serialize(void *payload, char *buffer) {
  if (payload == NULL) return 0;
  memcpy(buffer, payload, sizeof(Scanner));
  return sizeof(Scanner);
}

void tree_sitter_gitconfig_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  if (payload == NULL) return;
  memset(payload, 0, sizeof(Scanner));
  if (length == sizeof(Scanner)) memcpy(payload, buffer, length);
}

bool tree_sitter_gitconfig_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid
) {
  if (payload == NULL) return false;
  Scanner next = *(Scanner *)payload;
  if (!scan(&next, lexer, valid)) return false;
  *(Scanner *)payload = next;
  return true;
}
