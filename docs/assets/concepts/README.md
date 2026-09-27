# Concept Asset Manifest

These concept images were generated during the initial Sonder Observatory design session and define visual/product direction, not implementation screenshots.

Files:

- `standalone-live-inference.png` — standalone live dashboard with central "3D Inference View"
- `flutter-embedded-observatory.png` — Developer > Observatory control/embedded experience in the Sonder app
- `agent-replay-topology.png` — replay session with agent topology, inspector, and event timeline
- `design-system-board.png` — icon, palette, typography, components, node styles

`inference-space-concept.png` (a broad conceptual 3D model-inference
illustration) was planned but has not been provided; it is not in this
directory.

Use them as:
- composition references
- visual-language references
- UX discussion artifacts

Do not treat generated text, model names, dates, exact measurements, or visualized internal-state claims in these images as product requirements or factual telemetry. In particular the per-layer attention/activation panels, logprobs, "Aurora-7B", layer counts and layer-inspector numbers in `standalone-live-inference.png` are illustrative: the 3D Inference tab draws layer planes, operators and token probabilities only when a producer sends them, and says which producer and backend cannot ([3D Inference notes](../../integration/inference3d.md)).

The canonical implementation requirements live in the Markdown docs and protocol schema.
