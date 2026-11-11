import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseSpans } from "./replyMarkdown.ts";

test("a fenced block is code, with its language, and a block still being written stays code", () => {
  const done = parseMarkdown("Before\n\n```ts\nconst a = 1;\n```\n\nAfter");
  assert.deepEqual(done.map((block) => block.type), ["paragraph", "code", "paragraph"]);
  assert.deepEqual(done[1], { type: "code", lang: "ts", text: "const a = 1;" });
  const open = parseMarkdown("```py\nprint(1)");
  assert.deepEqual(open, [{ type: "code", lang: "py", text: "print(1)" }]);
});

test("markup inside a code block is left as it is", () => {
  const [block] = parseMarkdown("```\n**not bold** `x` # not a heading\n```");
  assert.deepEqual(block, { type: "code", lang: "", text: "**not bold** `x` # not a heading" });
});

test("lists, headings and quotes", () => {
  const blocks = parseMarkdown("## Title\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n> more");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "list", "list", "quote"]);
  assert.equal((blocks[1] as { ordered: boolean }).ordered, false);
  assert.equal((blocks[2] as { items: unknown[] }).items.length, 2);
  assert.equal((blocks[0] as { level: number }).level, 2);
});

test("spans: code, bold, italic and links; anything unclosed stays as typed", () => {
  assert.deepEqual(parseSpans("a `b` **c** *d* [e](f)"), [
    { type: "text", text: "a " },
    { type: "code", text: "b" },
    { type: "text", text: " " },
    { type: "bold", children: [{ type: "text", text: "c" }] },
    { type: "text", text: " " },
    { type: "italic", children: [{ type: "text", text: "d" }] },
    { type: "text", text: " " },
    { type: "link", text: "e", href: "f" },
  ]);
  assert.deepEqual(parseSpans("2 * 3 * 4 and **open"), [{ type: "text", text: "2 * 3 * 4 and **open" }]);
});

test("html in a reply is plain text, never markup", () => {
  const [block] = parseMarkdown('<img src=x onerror="alert(1)"> <script>x</script>');
  assert.equal(block.type, "paragraph");
  assert.deepEqual((block as { spans: unknown[] }).spans, [{ type: "text", text: '<img src=x onerror="alert(1)"> <script>x</script>' }]);
});
