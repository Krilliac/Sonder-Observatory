import tokens from "../../design/tokens.json";
import { tokensToCssVariables } from "../design/tokens";
import { ObservatoryApp } from "./app";
import type { ObservatoryPanel } from "./panels";
import "./styles.css";

for (const [name, value] of Object.entries(tokensToCssVariables(tokens))) {
    document.documentElement.style.setProperty(name, value);
}

const root = document.getElementById("app");
if (!root) {
    throw new Error("missing #app root");
}
// Additional panels (topology, diagnostics, ...) are registered here by the integrator.
const panels: ObservatoryPanel[] = [];

new ObservatoryApp(root, panels).start(new URLSearchParams(window.location.search));
