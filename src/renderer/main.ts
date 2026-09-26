import tokens from "../../design/tokens.json";
import { tokensToCssVariables } from "../design/tokens";
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
