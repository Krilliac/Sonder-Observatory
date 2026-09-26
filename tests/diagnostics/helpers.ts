import { DIAGNOSTIC_CASES, type DiagnosticCase } from "../../src/diagnostics/fixtures";
import { DETECTORS, resolveConfig, runDiagnostics, type DiagnosticsConfigOverrides, type Finding, type FindingKind } from "../../src/diagnostics/index";
import { sortEvents } from "../../src/diagnostics/util";
import type { ObservatoryEvent } from "../../src/protocol/events";

export function getCase(kind: FindingKind, expect: DiagnosticCase["expect"]): DiagnosticCase {
    const c = DIAGNOSTIC_CASES.find((x) => x.kind === kind && x.expect === expect);
    if (!c) {
        throw new Error(`no ${expect} case for ${kind}`);
    }
    return c;
}

/** Runs one detector directly (replay-ordered input, resolved config). */
export function detect(kind: FindingKind, events: readonly ObservatoryEvent[], config: DiagnosticsConfigOverrides = {}): Finding[] {
    return DETECTORS[kind](sortEvents(events), resolveConfig(config));
}

/** Asserts every finding cites >=1 event that exists in the input and its time range matches the evidence. */
export function assertEvidence(findings: readonly Finding[], events: readonly ObservatoryEvent[]): void {
    const byId = new Map(events.map((e) => [e.event_id, e]));
    for (const f of findings) {
        if (f.evidenceEventIds.length === 0) {
            throw new Error(`${f.id} has no evidence`);
        }
        const times = f.evidenceEventIds.map((id) => {
            const e = byId.get(id);
            if (!e) {
                throw new Error(`${f.id} cites unknown event ${id}`);
            }
            return e.mono_ns;
        });
        if (f.startNs !== Math.min(...times) || f.endNs !== Math.max(...times)) {
            throw new Error(`${f.id} time range does not match evidence`);
        }
    }
}

export { runDiagnostics };
