#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../src/scanner.c"

#ifdef TREE_SITTER_REUSE_ALLOCATOR
static size_t reuse_live_allocations;
static bool reuse_fail_next_calloc;

static void *reuse_calloc(size_t count, size_t size) {
  if (reuse_fail_next_calloc) {
    reuse_fail_next_calloc = false;
    return NULL;
  }
  void *result = calloc(count, size);
  if (result != NULL) {
    reuse_live_allocations += 1;
  }
  return result;
}

static void reuse_free(void *allocation) {
  if (allocation != NULL) {
    assert(reuse_live_allocations > 0);
    reuse_live_allocations -= 1;
  }
  free(allocation);
}

void *(*ts_current_calloc)(size_t, size_t) = reuse_calloc;
void (*ts_current_free)(void *) = reuse_free;
#endif

struct MockLexer {
  TSLexer lexer;
  const int32_t *input;
  size_t length;
  size_t offset;
  size_t mark;
};

static void mock_advance(TSLexer *lexer, bool skip) {
  (void)skip;
  struct MockLexer *mock = (struct MockLexer *)lexer;
  if (mock->offset < mock->length) {
    mock->offset += 1;
  }
  lexer->lookahead =
    mock->offset < mock->length ? mock->input[mock->offset] : 0;
}

static void mock_mark_end(TSLexer *lexer) {
  struct MockLexer *mock = (struct MockLexer *)lexer;
  mock->mark = mock->offset;
}

static bool mock_eof(const TSLexer *lexer) {
  const struct MockLexer *mock = (const struct MockLexer *)lexer;
  return mock->offset == mock->length;
}

static void
init_mock_lexer(struct MockLexer *mock, const int32_t *input, size_t length) {
  *mock = (struct MockLexer){
    .lexer =
      {
        .lookahead = length == 0 ? 0 : input[0],
        .result_symbol = UINT16_MAX,
        .advance = mock_advance,
        .mark_end = mock_mark_end,
        .eof = mock_eof,
      },
    .input = input,
    .length = length,
    .mark = SIZE_MAX,
  };
}

static void test_lifecycle_and_serialization_round_trip(void) {
  Scanner *scanner = tree_sitter_gitconfig_external_scanner_create();
  assert(scanner != NULL);
  const Scanner initial = {0};
  assert(memcmp(scanner, &initial, sizeof(initial)) == 0);
  const Scanner expected = {
    .position = 1,
    .content_end = UINT32_MAX,
    .line_end = 65536,
    .name_return = VARIABLE_AFTER_NAME,
    .mode = COMMENT,
    .ready = true,
    .section = true,
  };
  *scanner = expected;
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE + 2];
  memset(buffer, 0x5a, sizeof(buffer));
  const unsigned length =
    tree_sitter_gitconfig_external_scanner_serialize(scanner, buffer + 1);
  assert(length == sizeof(Scanner));
  assert(length <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE);
  assert(buffer[0] == 0x5a);
  for (size_t index = length + 1; index < sizeof(buffer); index += 1) {
    assert(buffer[index] == 0x5a);
  }
  tree_sitter_gitconfig_external_scanner_deserialize(scanner, NULL, 0);
  assert(memcmp(scanner, &initial, sizeof(initial)) == 0);
  tree_sitter_gitconfig_external_scanner_deserialize(
    scanner,
    buffer + 1,
    length
  );
  assert(memcmp(scanner, &expected, sizeof(expected)) == 0);
  tree_sitter_gitconfig_external_scanner_deserialize(
    scanner,
    buffer + 1,
    length - 1
  );
  assert(memcmp(scanner, &initial, sizeof(initial)) == 0);
  tree_sitter_gitconfig_external_scanner_destroy(scanner);
}

static void test_disabled_and_recovery_scans_preserve_state(void) {
  const int32_t input[] = {'a', '=', 'b'};
  for (unsigned recovery = 0; recovery <= 1; recovery += 1) {
    bool valid_symbols[ERROR_SENTINEL + 1] = {false};
    for (unsigned symbol = 0; symbol <= ERROR_SENTINEL; symbol += 1) {
      valid_symbols[symbol] = recovery != 0;
    }
    Scanner scanner = {0};
    const Scanner expected = scanner;
    struct MockLexer mock;
    init_mock_lexer(&mock, input, 3);
    assert(!tree_sitter_gitconfig_external_scanner_scan(
      &scanner,
      &mock.lexer,
      valid_symbols
    ));
    assert(memcmp(&scanner, &expected, sizeof(expected)) == 0);
  }
}

static void test_restored_comment_state_preserves_token_ranges(void) {
  const int32_t input[] = {'#', 'a', 0, '\r', '\n'};
  const struct {
    enum Token token;
    size_t start;
    size_t end;
  } cases[] = {
    {LINE_START, 0, 0},
    {COMMENT_START, 0, 0},
    {COMMENT_MARKER, 0, 1},
    {COMMENT_TEXT, 1, 3},
    {LINE_ENDING, 3, 5},
    {COMMENT_END, 5, 5},
  };
  Scanner scanner = {0};
  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index += 1) {
    bool valid_symbols[ERROR_SENTINEL + 1] = {false};
    valid_symbols[cases[index].token] = true;
    struct MockLexer mock;
    init_mock_lexer(&mock, input + cases[index].start, 5 - cases[index].start);
    assert(tree_sitter_gitconfig_external_scanner_scan(
      &scanner,
      &mock.lexer,
      valid_symbols
    ));
    assert(mock.lexer.result_symbol == cases[index].token);
    assert(mock.mark == cases[index].end - cases[index].start);
    char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE];
    const unsigned length =
      tree_sitter_gitconfig_external_scanner_serialize(&scanner, buffer);
    Scanner restored = {0};
    tree_sitter_gitconfig_external_scanner_deserialize(
      &restored,
      buffer,
      length
    );
    scanner = restored;
  }
  assert(scanner.mode == START);
}

#ifdef TREE_SITTER_REUSE_ALLOCATOR
static void test_reuse_allocator_failure_and_cleanup(void) {
  assert(reuse_live_allocations == 0);
  reuse_fail_next_calloc = true;
  assert(tree_sitter_gitconfig_external_scanner_create() == NULL);
  assert(!reuse_fail_next_calloc);
  void *scanner = tree_sitter_gitconfig_external_scanner_create();
  assert(scanner != NULL);
  assert(reuse_live_allocations == 1);
  tree_sitter_gitconfig_external_scanner_destroy(scanner);
  assert(reuse_live_allocations == 0);
}
#endif

int main(void) {
  test_lifecycle_and_serialization_round_trip();
  test_disabled_and_recovery_scans_preserve_state();
  test_restored_comment_state_preserves_token_ranges();
#ifdef TREE_SITTER_REUSE_ALLOCATOR
  test_reuse_allocator_failure_and_cleanup();
#endif
  return 0;
}
