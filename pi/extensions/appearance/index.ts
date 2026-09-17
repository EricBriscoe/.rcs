import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BorderGlintEditor, withBorderGlint } from "./border-glint.js";

// Paths/model IDs are data, not terminal commands. Extension statuses retain
// their own styling and are never filtered by prose or private package APIs.
const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export default function (pi: ExtensionAPI) {
  let compact = true;
  let current: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  let glintFactory: EditorFactory;
  let previousEditor: EditorFactory;
  let glintEnabled = false;

  function restoreEditor(ctx: ExtensionContext) {
    if (glintFactory && ctx.ui.getEditorComponent() === glintFactory) ctx.ui.setEditorComponent(previousEditor);
    glintFactory = previousEditor = undefined;
    glintEnabled = false;
  }

  function installEditor(ctx: ExtensionContext) {
    if (!glintFactory || ctx.ui.getEditorComponent() !== glintFactory) {
      const original = ctx.ui.getEditorComponent();
      previousEditor = original;
      glintFactory = (tui, theme, keybindings) => {
        if (!original) {
          glintEnabled = true;
          return new BorderGlintEditor(tui, theme, keybindings, () => ctx.ui.theme);
        }
        const editor = original(tui, theme, keybindings);
        const decorated = withBorderGlint(editor, () => ctx.ui.theme);
        glintEnabled = decorated !== editor;
        return decorated;
      };
      ctx.ui.setEditorComponent(glintFactory);
    }
    // Pi owns the animation clock and stops it with the working loader.
    ctx.ui.setWorkingIndicator(glintEnabled
      ? { frames: ["●", "●"], intervalMs: 80 }
      : { frames: ["·", "•", "●", "•"], intervalMs: 300 });
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    current = ctx;
    if (!compact) {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWorkingIndicator();
      restoreEditor(ctx);
      return;
    }
    installEditor(ctx);
    ctx.ui.setFooter((tui, _theme, footerData) => {
      const redraw = () => tui.requestRender();
      requestRender = redraw;
      const unsubscribe = footerData.onBranchChange(redraw);
      let disposed = false;
      return {
        invalidate() {}, // Render fresh: theme, model, usage and statuses are live.
        render(width: number): string[] {
          if (disposed || !current || width < 1) return [];
          const ctx = current;
          const theme = ctx.ui.theme;
          const joiner = theme.fg("dim", " · ");
          const usage = ctx.getContextUsage();
          const percent = usage?.percent;
          const known = typeof percent === "number" && Number.isFinite(percent) && percent >= 0;
          const usageColor = known && percent >= 95 ? "error" : known && percent >= 80 ? "warning" : "muted";
          const context = theme.fg(usageColor, `ctx ${known ? `${Math.round(percent)}%` : "?"}`);
          const model = ctx.model ? plain(ctx.model.id) : "no model";
          const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
          const meta = [theme.fg("muted", model), theme.fg("muted", thinking), context].join(joiner);
          const branch = footerData.getGitBranch();
          const path = plain(basename(ctx.cwd) || ctx.cwd);
          const location = theme.fg("muted", path) + (branch ? joiner + theme.fg("dim", plain(branch)) : "");
          const statuses = new Map(footerData.getExtensionStatuses());
          const quota = statuses.get("codex-pool") || (ctx.model?.provider === "openai-codex" ? "quota unknown" : undefined);
          statuses.delete("codex-pool");
          const lines: string[] = [];
          const wrap = (text: string) => {
            for (const line of text.replace(/\t/g, " ").split(/\r?\n/)) {
              // The final guard handles an unrenderable wide glyph at width 1.
              lines.push(...wrapTextWithAnsi(line, width).map(row => truncateToWidth(row, width)));
            }
          };
          const layout = (right: string) => {
            // Only abbreviate the location; never truncate quota or alerts.
            const available = width - visibleWidth(right) - 2;
            if (available < Math.min(visibleWidth(location), 12)) return false;
            const left = truncateToWidth(location, available);
            lines.push(left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right);
            return true;
          };
          const quotaText = quota ? theme.fg("muted", quota) : undefined;
          if (!quotaText || !layout(meta + joiner + quotaText)) {
            if (!layout(meta)) {
              wrap(location);
              wrap(meta);
            }
            if (quotaText) wrap(quotaText);
          }
          // Stock subagent statuses/widgets remain owned by pi-subagents. Keep
          // every other extension's status, including unfamiliar future ones.
          const extra = [...statuses.values()].filter(Boolean);
          if (extra.length) wrap(extra.join(joiner));
          return lines;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          if (requestRender === redraw) requestRender = undefined;
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => install(ctx));
  // Event contexts can be snapshots. Refresh ours without reinstalling the UI.
  for (const event of ["model_select", "thinking_level_select", "session_tree", "session_compact", "agent_start", "agent_settled", "message_end"] as const) {
    pi.on(event, (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      current = ctx;
      // Later session_start handlers (for example pi-vim) may install an editor.
      if (event === "agent_start" && compact && ctx.ui.getEditorComponent() !== glintFactory) installEditor(ctx);
      requestRender?.();
    });
  }
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    current = undefined;
    requestRender = undefined;
    ctx.ui.setFooter(undefined);
    ctx.ui.setWorkingIndicator();
    restoreEditor(ctx);
  });
  pi.registerCommand("appearance", {
    description: "Use compact footer/border glint or stock appearance (session only)",
    getArgumentCompletions(prefix) {
      return ["compact", "stock"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui") return;
      const value = args.trim();
      if (value !== "compact" && value !== "stock") {
        ctx.ui.notify("/appearance compact|stock — footer and working indicator. Themes: /settings → Theme → quiet-graphite or paper.", "info");
        return;
      }
      compact = value === "compact";
      install(ctx);
    },
  });
}
