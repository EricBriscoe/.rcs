import test from "node:test";
import assert from "node:assert/strict";
import { askUser } from "../pi/extensions/ask-user/question.mjs";

test("choice labels cannot collide with the free-text option", async () => {
  const signal = new AbortController().signal;
  const result = await askUser({ question: "Fixture?", choices: ["Type an answer…", "B"] }, {
    hasUI: true,
    ui: { select: async (question, choices, opts) => {
      assert.equal(question, "Fixture?");
      assert.deepEqual(choices, ["1. Type an answer…", "2. B", "Type an answer…"]);
      assert.equal(opts.signal, signal);
      return choices[0];
    } },
  }, signal);
  assert.deepEqual(result.details, { question: "Fixture?", status: "answered", answer: "Type an answer…", source: "choice" });
});

test("choices allow a custom answer, preserving exact text", async () => {
  const result = await askUser({ question: "Fixture?", choices: ["A", "B"] }, {
    hasUI: true,
    ui: { select: async () => "Type an answer…", input: async () => " C with spaces " },
  });
  assert.equal(result.details.answer, " C with spaces ");
  assert.equal(result.details.source, "text");
});

test("free-text question waits for input", async () => {
  let resolve;
  const pending = askUser({ question: "Fixture?" }, {
    hasUI: true, ui: { input: () => new Promise((done) => { resolve = done; }) },
  });
  resolve("typed fixture");
  assert.equal((await pending).details.answer, "typed fixture");
});

test("cancellation and blank answers never choose a default", async () => {
  for (const answer of [undefined, "", "   "]) {
    const result = await askUser({ question: "Fixture?" }, {
      hasUI: true, ui: { input: async () => answer },
    });
    assert.equal(result.details.answer, null);
    assert.equal(result.details.status, answer === undefined ? "cancelled" : "empty");
  }
  const result = await askUser({ question: "Fixture?", choices: ["A", "B"] }, {
    hasUI: true, ui: { select: async () => undefined, input: () => assert.fail("No follow-up after cancel") },
  });
  assert.equal(result.details.status, "cancelled");
});

test("headless mode reports unavailable without opening a dialog", async () => {
  const result = await askUser({ question: "Fixture?" }, { hasUI: false });
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "unavailable");
  assert.equal(result.details.answer, null);
});

test("abort before or during a dialog propagates without an answer", async () => {
  const controller = new AbortController();
  const reason = new Error("Fixture abort");
  await assert.rejects(askUser({ question: "Fixture?" }, {
    hasUI: true, ui: { input: async (_q, _p, opts) => {
      assert.equal(opts.signal, controller.signal);
      controller.abort(reason);
      return "not accepted";
    } },
  }, controller.signal), reason);
  await assert.rejects(askUser({ question: "Fixture?" }, { hasUI: false }, controller.signal), reason);
});
