import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { rolldown } from "rolldown";
import * as chat from "./chat.ts";

async function harness() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  let progress!: (event: { thinking: string; text: string }) => void;
  const calls: Array<{ command: string; args: Record<string, any> }> = [];

  const project: chat.Project = { cwd: "C:\\work", agent: "codex", model: "gpt-6.1-sol", effort: "medium", draft: "First prompt", messages: [], sessions: {} };
  const code = readFileSync(new URL("./AgentChat.tsx", import.meta.url), "utf8");
  const bundle = await rolldown({
    input: "composer-fixture",
    external: (id) => id !== "composer-fixture",
    plugins: [{
      name: "composer-fixture",
      resolveId(id) { if (id === "composer-fixture") return id; },
      load(id) {
        if (id === "composer-fixture") return {
          code: code.slice(0, code.indexOf("const isLong")) + "\nexport const testApi = { send, cancel, projects, runs, errors, edit };",
          moduleType: "tsx",
        };
      },
    }],
  });
  const output = await bundle.generate({ format: "cjs" });
  const compiled = output.output[0].code;
  await bundle.close();
  const exports: Record<string, any> = {};
  const store = (value: any) => ({ get: () => value, set: (next: any) => { value = typeof next === "function" ? next(value) : next; } });
  const module = { exports };
  const context = createContext({
    exports, module, crypto: { randomUUID: () => "test-turn" },
    localStorage: { getItem: () => JSON.stringify([project]), setItem() {}, removeItem() {} },
    window: { addEventListener() {}, clearTimeout() {}, setTimeout(callback: () => void) { callback(); return 1; } },
    require: (name: string) => {
      if (name === "chat" || name === "./chat") return chat;
      if (name.includes("lib") && name.includes("store")) return { createStore: store };
      if (name.includes("platform")) return { isNative: true };
      if (name.includes("i18n")) return { t: (text: string) => text };
      if (name === "@tauri-apps/api/core") return {
        Channel: class { constructor(callback: (event: { thinking: string; text: string }) => void) { progress = callback; } },
        invoke: (command: string, args: Record<string, any>) => {
          calls.push({ command, args });
          if (command === "agents_cancel") return Promise.resolve(true);
          // The history file: nothing saved yet, so the old browser copy is carried over.
          if (command === "agents_projects_load") return Promise.resolve(null);
          if (command === "agents_projects_save") return Promise.resolve();
          return new Promise((yes, no) => { resolve = yes; reject = no; });
        },
      };
      return {};
    },
  });
  runInContext(compiled, context);
  // The history is read from its file once, a moment after start.
  await new Promise((done) => setTimeout(done, 0));
  return { ...module.exports.testApi, calls, resolve: (value: unknown) => resolve(value), reject: (error: unknown) => reject(error), emit: (event: { thinking: string; text: string }) => progress(event) };
}

const reply = { text: "Done", tokens: 1, permissionDenied: false, session: "session" };

test("sending clears the box immediately and completing preserves the next draft", async () => {
  const h = await harness();
  const task = h.send(h.projects.get()[0]);
  assert.equal(h.projects.get()[0].draft, "");
  h.edit("C:\\work", { draft: "Next prompt" });
  h.resolve(reply);
  await task;
  assert.equal(h.projects.get()[0].draft, "Next prompt");
  assert.equal(h.projects.get()[0].messages[0].text, "First prompt");
  assert.equal(Object.keys(h.runs.get()).length, 0);
  h.emit({ thinking: "late progress", text: "late" });
  assert.equal(Object.keys(h.runs.get()).length, 0);
});

test("failure restores an empty composer but preserves text already being typed", async () => {
  for (const draft of ["", "Next prompt"]) {
    const h = await harness();
    const task = h.send(h.projects.get()[0]);
    h.edit("C:\\work", { draft });
    h.reject("failed");
    await task;
    assert.equal(h.projects.get()[0].draft, draft || "First prompt");
    assert.equal(Object.keys(h.runs.get()).length, 0);
  }
});

test("cancellation keeps the lock until the turn settles, then another prompt can be sent", async () => {
  const h = await harness();
  const first = h.send(h.projects.get()[0]);
  h.edit("C:\\work", { draft: "Next prompt" });
  await h.cancel("test-turn");
  assert.equal(h.runs.get()["C:\\work"]?.requestId, "test-turn");
  h.reject("cancelled");
  await first;
  assert.equal(h.projects.get()[0].draft, "Next prompt");
  assert.equal(h.errors.get()["C:\\work"], "");
  assert.equal(Object.keys(h.runs.get()).length, 0);
  const next = h.send(h.projects.get()[0]);
  assert.equal(h.projects.get()[0].draft, "");
  h.resolve(reply);
  await next;
  assert.equal(h.projects.get()[0].draft, "");
  assert.equal(h.projects.get()[0].messages[0].text, "Next prompt");
});

test("the reply shows while it is written, and a second message waits for the first in the same project", async () => {
  const h = await harness();
  const task = h.send(h.projects.get()[0]);
  h.emit({ thinking: "Hmm", text: "Par" });
  h.emit({ thinking: "Hmm", text: "Partial answer" });
  assert.equal(h.runs.get()["C:\\work"].reply, "Partial answer");
  assert.equal(h.runs.get()["C:\\work"].thinking, "Hmm");
  const sends = () => h.calls.filter((call: { command: string }) => call.command === "agents_chat").length;
  await h.send({ ...h.projects.get()[0], draft: "Too soon" });
  assert.equal(sends(), 1);
  h.resolve(reply);
  await task;
});

test("a retry after a refused action allows edits and leaves the draft alone", async () => {
  const h = await harness();
  h.edit("C:\\work", { draft: "Half typed" });
  const task = h.send(h.projects.get()[0], { text: "Try again." });
  assert.equal(h.projects.get()[0].draft, "Half typed");
  const call = h.calls.find((item: { command: string }) => item.command === "agents_chat")!;
  assert.equal(call.args.allowEdits, true);
  assert.match(call.args.prompt, /Try again\./);
  h.reject("failed");
  await task;
  assert.equal(h.projects.get()[0].draft, "Half typed");
});
