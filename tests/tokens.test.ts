import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTokenValue, tokensToCssVariables } from "../src/design/tokens";

const tokens = JSON.parse(readFileSync(fileURLToPath(new URL("../design/tokens.json", import.meta.url)), "utf8"));

describe("design tokens", () => {
    it("flattens design/tokens.json into CSS variables with aliases resolved", () => {
        const vars = tokensToCssVariables(tokens);
        expect(vars["--color-background"]).toBe("#070B14");
        expect(vars["--semantic-token"]).toBe(vars["--color-primary"]);
        expect(vars["--semantic-error"]).toBe("#EF4444");
        expect(Object.values(vars).every((v) => /^#[0-9A-F]{6}$/i.test(v))).toBe(true);
    });

    it("throws on unresolved or cyclic aliases", () => {
        expect(() => resolveTokenValue({}, "{color.nope}")).toThrow(/unresolved/);
        const cyclic = { a: { $value: "{b}" }, b: { $value: "{a}" } };
        expect(() => resolveTokenValue(cyclic, "{a}")).toThrow(/cycle/);
    });
});
