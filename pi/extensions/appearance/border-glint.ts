import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";

type WorkingIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type Editor = ReturnType<EditorFactory>;

function glintBorder(border: string, width: number, startedAt: number, theme: Theme, borderColor: (text: string) => string): string {
  if (width < 1) return border;
  const phase = ((Date.now() - startedAt) % 6400) / 3200;
  const center = Math.round((phase <= 1 ? phase : 2 - phase) * (width - 1));
  return [...stripVTControlCharacters(border)].map((char, column) => {
    const distance = Math.abs(column - center);
    if (char !== "─" || distance > 2) return borderColor(char);
    if (distance === 0) return theme.fg("accent", "●");
    return theme.fg(distance === 1 ? "accent" : "muted", "─");
  }).join("");
}

/** Decorate compatible custom editors without replacing their editing behavior. */
export function withBorderGlint(editor: Editor, getTheme: () => Theme): Editor {
  if (!("embedWorkingStatus" in editor) || !("setWorkingStatusIndicator" in editor)
    || typeof editor.setWorkingStatusIndicator !== "function" || !("borderColor" in editor)
    || typeof editor.borderColor !== "function") return editor;
  const base = editor as Editor & Pick<CustomEditor, "setWorkingStatusIndicator" | "borderColor">;
  let indicator: WorkingIndicator;
  let startedAt = 0;
  const setIndicator = (next: WorkingIndicator) => {
    if (next && next !== indicator) startedAt = Date.now();
    indicator = next;
    base.setWorkingStatusIndicator(undefined);
  };
  const render = (width: number) => {
    const lines = base.render(width).slice();
    if (indicator && lines.length) {
      lines[0] = glintBorder(lines[0], width, startedAt, getTheme(), text => base.borderColor(text));
    }
    return lines;
  };
  return new Proxy(editor, {
    get(target, key) {
      if (key === "embedWorkingStatus") return true;
      if (key === "setWorkingStatusIndicator") return setIndicator;
      if (key === "render") return render;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Uses Pi's working-loader clock and lifecycle; no independent animation timer. */
export class BorderGlintEditor extends CustomEditor {
  private indicator: WorkingIndicator;
  private startedAt = 0;
  private getTheme: () => Theme;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    getTheme: () => Theme,
  ) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.getTheme = getTheme;
  }

  override setWorkingStatusIndicator(indicator: WorkingIndicator): void {
    if (indicator && indicator !== this.indicator) this.startedAt = Date.now();
    this.indicator = indicator;
    // Keep the stock scroll border, but replace its working label with a glint.
    super.setWorkingStatusIndicator(undefined);
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const border = super.renderTopBorder(width, hiddenLineCount);
    if (!this.indicator || width < 1) return border;
    return glintBorder(border, width, this.startedAt, this.getTheme(), text => this.borderColor(text));
  }
}
