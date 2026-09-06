import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUser } from "./question.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user one question and wait for their answer. Offer choices when useful; the user can always type an answer instead. Without choices, show a text input. Requires interactive Pi or an RPC client that supports extension dialogs.",
    promptSnippet: "Ask for missing information or a decision using a choice or text dialog.",
    promptGuidelines: [
      "Use ask_user when an answer would materially affect the work. Continue routine work already authorized by the user without asking again.",
      "Cancellation, an empty answer, or unavailable UI is not an answer or approval. Do not invent a response; leave dependent work pending and state the question to the user.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 8, uniqueItems: true })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return askUser(params, ctx, signal);
    },
  });
}
