import { describe, expect, it } from "vitest";
import { isDesktop } from "../src/integrations/desktop";
import { modeBadge, runtimeMode } from "../src/integrations/mode";

describe("runtime mode", () => {
    it("maps the Tauri check to desktop or browser", () => {
        expect(runtimeMode(true)).toBe("desktop");
        expect(runtimeMode(false)).toBe("browser");
    });

    it("labels each mode", () => {
        expect(modeBadge("desktop").text).toBe("desktop");
        expect(modeBadge("browser").text).toBe("browser");
        expect(modeBadge("browser").title).toMatch(/browser/);
    });

    it("is browser mode outside the Tauri shell", () => {
        expect(isDesktop()).toBe(false);
        expect(runtimeMode(isDesktop())).toBe("browser");
    });
});
