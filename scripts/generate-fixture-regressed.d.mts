// Type declarations for scripts/generate-fixture-regressed.mjs so Vitest and
// Playwright specs (TypeScript, strict) can import the variant generator.
import type { ObservatoryEvent } from "../src/protocol/events";

export declare const REGRESSED_SESSION_ID: string;
export declare const REGRESSED_RUN_ID: string;
export declare const REGRESSED_EVENT_PREFIX: string;
export declare const DEFAULT_BASE_PATH: string;
export declare const DEFAULT_REGRESSED_PATH: string;
export declare function regressFixtureEvents(baseEvents: readonly ObservatoryEvent[]): ObservatoryEvent[];
export declare function regressFixtureText(baseText: string): string;
export declare function writeRegressedFixture(outPath?: string, basePath?: string): number;
