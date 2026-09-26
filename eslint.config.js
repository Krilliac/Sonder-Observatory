import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist/", "node_modules/", "coverage/"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts", "tests/**/*.ts", "vite.config.ts"],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ["scripts/**/*.mjs", "eslint.config.js"],
        languageOptions: { globals: globals.node },
    },
);
