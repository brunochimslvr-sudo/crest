import { test } from "node:test";
import assert from "node:assert/strict";
import { handoff, planTurn, restoreProjects, shortModel, tokensByModel, type Message } from "./chat.ts";

const user = (text: string): Message => ({ role: "user", text });
const claude = (text: string): Message => ({ role: "claude", text, model: "opus" });
const codex = (text: string): Message => ({ role: "codex", text, model: "gpt-6-luna" });

test("a follow-up to the same agent sends only the new message", () => {
  const messages = [user("first"), claude("answer ".repeat(500))];
  assert.deepEqual(planTurn(messages, "claude", { claude: "s1" }, "next"), { session: "s1", prompt: "next" });
});

test("an agent coming back gets only what happened while it was away", () => {
  const messages = [user("old question"), claude("old answer"), user("for codex"), codex("codex did it")];
  const turn = planTurn(messages, "claude", { claude: "s1", codex: "s2" }, "continue");
  assert.equal(turn.session, "s1");
  assert.ok(turn.prompt.includes("codex did it") && turn.prompt.includes("for codex") && turn.prompt.endsWith("continue"));
  assert.ok(!turn.prompt.includes("old question") && !turn.prompt.includes("old answer"));
});

test("an agent new to the project gets the handoff, a project without history the plain text", () => {
  const turn = planTurn([user("question"), claude("answer")], "codex", { claude: "s1" }, "go");
  assert.equal(turn.session, undefined);
  assert.ok(turn.prompt.includes("Claude Code: answer"));
  assert.deepEqual(planTurn([], "codex", {}, "go"), { prompt: "go" });
});

test("a session the CLI lost falls back to the handoff", () => {
  const messages = [user("question"), claude("answer")];
  const turn = planTurn(messages, "claude", {}, "go");
  assert.equal(turn.session, undefined);
  assert.ok(turn.prompt.includes("answer"));
});

test("the handoff stays small, however long the history is", () => {
  const messages = Array.from({ length: 40 }, (_, i) => (i % 2 ? claude("reply ".repeat(2000)) : user("question ".repeat(2000))));
  const text = "x".repeat(5000);
  const prompt = handoff(messages, text);
  assert.ok(prompt.length - text.length <= 2600, String(prompt.length - text.length));
  assert.ok(prompt.endsWith(text));
  // The longest message in the handoff still fits what the CLI accepts together with the longest draft.
  assert.ok(prompt.length <= 12_000);
});

test("the newest reply keeps its end and its share; older replies are short", () => {
  const prompt = handoff([claude(`${"a".repeat(2000)}OLD`), user("q"), claude(`${"b".repeat(2000)}NEW`)], "go");
  assert.ok(prompt.includes("NEW") && prompt.includes("OLD"));
  assert.ok(prompt.split("b").length - 1 > 1000);
  assert.ok(prompt.split("a").length - 1 < 400);
});

test("a user's long message keeps its start", () => {
  const prompt = handoff([user(`START${"x".repeat(1000)}END`)], "go");
  assert.ok(prompt.includes("START") && !prompt.includes("END"));
});

test("code in a reply is left out, because it is in the files", () => {
  const prompt = handoff([claude("Done:\n```ts\nconst secretCode = 1;\n```\nTests pass.")], "go");
  assert.ok(!prompt.includes("secretCode"));
  assert.ok(prompt.includes("[code omitted]") && prompt.includes("Tests pass."));
  assert.ok(!handoff([claude("cut off ```ts\nconst open = 1;")], "go").includes("const open"));
});

test("a cut never leaves half a character, which the app could not receive", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let extra = 0; extra < 3; extra++) {
    assert.ok(!lone.test(handoff([claude("x".repeat(extra) + "😀".repeat(1000))], "go")));
    assert.ok(!lone.test(handoff([user("x".repeat(extra) + "😀".repeat(400))], "go")));
  }
});

test("restored projects keep their sessions and leave models that no longer work", () => {
  const project = { cwd: "C:\\p", agent: "codex", model: "gpt-5.4", effort: "low", draft: "", messages: [] };
  const [old, kept] = restoreProjects([project, { ...project, model: "gpt-6-luna", sessions: { codex: "s", claude: 1, nobody: "x" } }]);
  assert.equal(old.model, "gpt-6.1-sol");
  assert.deepEqual(old.sessions, {});
  assert.equal(kept.model, "gpt-6-luna");
  assert.deepEqual(kept.sessions, { codex: "s" });
});

test("broken storage restores to nothing", () => {
  assert.deepEqual(restoreProjects("x"), []);
  assert.deepEqual(restoreProjects([{ cwd: "C:\\p" }, null]), []);
});

test("model names shorten for the row, tokens add up per model", () => {
  assert.equal(shortModel("gemini-3.8-flash-medium"), "3.8-flash");
  assert.equal(shortModel("gemini-3.1-pro-high"), "3.1-pro");
  assert.equal(shortModel("gpt-6-luna"), "gpt-6-luna");
  const totals = tokensByModel([user("q"), { ...claude("a"), tokens: 5 }, { ...claude("b"), tokens: 7 }, codex("c")]);
  assert.deepEqual([...totals], [["opus", 12]]);
});
