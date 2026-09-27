/**
 * Text of the Overview "Token rate" card. Kept pure so its provenance wording
 * is unit-tested: a total says whether it is backend-reported or derived from
 * token events, and output chunks are never presented as tokens.
 */
import type { Metrics } from "../query/metrics";
import { fmtMs, fmtRate } from "./format";

export interface TokenCardModel {
    value: string;
    sub: string;
    evidence: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

export function tokenCardModel(m: Metrics): TokenCardModel {
    const t = m.tokens;
    const window = `last ${t.windowMs / 1000}s`;
    const notes: string[] = [];
    if (t.chunks > 0 && t.provenance !== "unavailable") {
        notes.push(`${plural(t.chunks, "output chunk")} not counted as tokens`);
    }
    if (t.uncountedRequests > 0 && t.provenance !== "unavailable") {
        notes.push(`${plural(t.uncountedRequests, "request")} without a token count yet`);
    }
    const reporting = m.requests.filter((r) => r.backendTokens !== null).length;
    let evidence: string;
    switch (t.provenance) {
        case "backend-reported":
            evidence = `backend-reported · completion_tokens of ${plural(reporting, "request")}`;
            break;
        case "derived":
            evidence = `derived · ${plural(t.total, "token")} from inference.token.generated`;
            break;
        case "mixed":
            evidence = `mixed · ${t.fromBackend} backend-reported (${plural(reporting, "request")}) + ${t.fromEvents} from inference.token.generated`;
            break;
        default:
            evidence =
                t.chunks > 0
                    ? `unavailable · ${plural(t.chunks, "output chunk")} seen, no token count reported yet`
                    : "unavailable · no token events yet";
    }
    if (notes.length > 0) {
        evidence += ` · ${notes.join(" · ")}`;
    }
    if (t.provenance === "unavailable") {
        return {
            value: "—",
            sub: t.chunks > 0 ? `${window} · chunks carry no token count; totals arrive with request.completed` : `${window} · no tokens`,
            evidence,
        };
    }
    const decode = t.overallRate !== null ? `decode ${fmtRate(t.overallRate)} tok/s over ${fmtMs(t.activeDecodeMs)} generating` : "decode rate n/a";
    return {
        value: `${fmtRate(t.recentRate)} tok/s`,
        sub: `${window} · ${decode} · ${plural(t.total, "token")}`,
        evidence,
    };
}
