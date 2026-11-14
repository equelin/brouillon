import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Coach, type CoachEvent } from "../src/agent/coach.ts";
import type { CoachModels } from "../src/agent/models.ts";
import type { Workspace } from "../src/agent/tools.ts";

function setup() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const comments: [string, string][] = [];
  const workspace: Workspace = {
    article: () => ({ path: "a.fr.md", lang: "fr", text: "A sentence to review.\n" }),
    listPosts: async () => [],
    readPost: async () => "",
    addComment: (quote, note) => comments.push([quote, note]),
    addSuggestion: () => undefined,
    pendingTranslation: () => undefined,
    writeTranslation: async () => "",
  };
  const coach = new Coach({
    models: models as CoachModels,
    model: faux.getModel(),
    thinkingLevel: "low",
    workspace,
    systemPrompt: "You are a writing coach.",
  });
  const events: CoachEvent[] = [];
  coach.subscribe((event) => events.push(event));
  return { faux, coach, events, comments };
}

test("a turn runs the coach's tools and reports replies between start and end", async () => {
  const { faux, coach, events, comments } = setup();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("comment", { quote: "A sentence", note: "Vague subject." })],
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage([fauxText("I left one note.")]),
  ]);
  await coach.send("Review this.");

  assert.deepEqual(comments, [["A sentence", "Vague subject."]]);
  assert.equal(events[0]?.type, "start");
  assert.equal(events.at(-1)?.type, "end");
  assert.deepEqual(
    events.find((event) => event.type === "tool"),
    { type: "tool", label: "Comment" },
  );
  const replies = events.flatMap((event) => (event.type === "reply" ? [event.text] : []));
  assert.equal(replies.at(-1), "I left one note.");
  assert.ok(!coach.busy);
});

test("a tool refusal goes back to the model instead of reaching the article", async () => {
  const { faux, coach, comments, events } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("comment", { quote: "words not there", note: "x" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("Sorry, let me quote exactly.")]),
  ]);
  await coach.send("Review this.");
  assert.deepEqual(comments, []);
  assert.ok(!events.some((event) => event.type === "error"));
  assert.equal(faux.state.callCount, 2);
});

test("reset forgets the conversation and keeps the coach usable", async () => {
  const { faux, coach, events } = setup();
  faux.setResponses([fauxAssistantMessage([fauxText("First.")])]);
  await coach.send("Hello");
  await coach.reset();
  faux.setResponses([fauxAssistantMessage([fauxText("Second.")])]);
  await coach.send("Hello again");
  const replies = events.flatMap((event) => (event.type === "reply" ? [event.text] : []));
  assert.equal(replies.at(-1), "Second.");
});
