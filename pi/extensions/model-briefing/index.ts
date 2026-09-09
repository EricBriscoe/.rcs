import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerModelBriefing } from "./briefing.mjs";

export default function (pi: ExtensionAPI) {
  registerModelBriefing(pi, getAgentDir);
}
