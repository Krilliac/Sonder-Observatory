import tokens from "../../design/tokens.json";
import { tokensToCss } from "../design/tokens";
import { mountDesktopIntegration } from "../integrations/desktopUi";
import { ObservatoryApp } from "./app";
import type { ObservatoryPanel } from "./panels";
import { ThemeController } from "./theme";
import "./styles.css";
import "./views.css";

// Both palettes as one stylesheet keyed on <html data-theme> (not inline
// styles on <html>, which would override every [data-theme] rule). Injected
// before the app renders so the first paint already uses the tokens.
const tokenStyle = document.createElement("style");
tokenStyle.id = "design-tokens";
tokenStyle.textContent = tokensToCss(tokens);
document.head.prepend(tokenStyle);

const params = new URLSearchParams(window.location.search);
const theme = new ThemeController(document, window, params.get("theme"));

const root = document.getElementById("app");
if (!root) {
    throw new Error("missing #app root");
}
// Extra generic panels can be registered here. Diagnostics and topology are
// wired as view tabs inside ObservatoryApp (see app.ts VIEWS).
const panels: ObservatoryPanel[] = [];

const app = new ObservatoryApp(root, panels, { theme });
app.start(params);

// Desktop vs browser mode badge; in the Tauri shell also the native
// "Open recording…" dialog, the recent-recordings menu and the --open /
// --connect launch arguments (src/integrations/). The app is the host, so
// recordings load through openRecordingText() and every --connect URL (with
// its own token, if any) goes through connectProducers().
mountDesktopIntegration(app);
