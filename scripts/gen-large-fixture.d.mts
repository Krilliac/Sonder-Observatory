// Type declarations for scripts/gen-large-fixture.mjs so Vitest perf tests
// (TypeScript, strict) can import the generator directly.
import type { ObservatoryEvent } from "../src/protocol/events";

export declare const DEFAULT_SEED: number;
export declare const PRESET_SIZES: { readonly "10k": number; readonly "100k": number; readonly "1m": number };
export declare function rng(seed: number): () => number;
export declare function parseSize(text: string): number;
export declare function generateEvents(count: number, seed?: number): Generator<ObservatoryEvent, void, undefined>;
export declare function generateNdjson(count: number, seed?: number): string;
export declare function writeFixture(path: string, count: number, seed?: number): Promise<number>;
