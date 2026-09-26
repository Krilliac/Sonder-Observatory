import tokens from "../../design/tokens.json";
import { tokensToCssVariables } from "../design/tokens";
import { isDesktop } from "../integrations/desktop";
import { modeBadge, runtimeMode } from "../integrations/mode";
import { ObservatoryApp } from "./app";
import type { ObservatoryPanel } from "./panels";
import "./styles.css";
import "./views.css";

for (const [name, value] of Object.entries(tokensToCssVariables(tokens))) {
    document.documentElement.style.setProperty(name, value);
}

const root = document.getElementById("app");
if (!root) {
    throw new Error("missing #app root");
}
// Extra generic panels can be registered here. Diagnostics and topology are
// wired as analysis-view tabs inside ObservatoryApp (see app.ts VIEWS).
const panels: ObservatoryPanel[] = [];

new ObservatoryApp(root, panels).start(new URLSearchParams(window.location.search));

// Desktop vs browser mode badge, next to the other header badges.
const mode = runtimeMode(isDesktop());
const { text, title } = modeBadge(mode);
const badge = document.createElement("span");
badge.id = "mode-badge";
badge.className = "badge";
badge.dataset.mode = mode;
badge.textContent = text;
badge.title = title;
document.getElementById("capture-badge")?.after(badge);
