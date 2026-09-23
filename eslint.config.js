import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import prettier from "eslint-config-prettier";

export default defineConfigWithVueTs(
  {
    name: "begitra/ignores",
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "coverage/**",
      "bench/**",
      "src/ipc/fixtures/**",
    ],
  },
  pluginVue.configs["flat/recommended"],
  vueTsConfigs.recommendedTypeChecked,
  {
    name: "begitra/rules",
    files: ["**/*.{ts,vue,js,mjs}"],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "vue/multi-word-component-names": "off",
      "vue/block-lang": ["error", { script: { lang: "ts" } }],
      "vue/component-api-style": ["error", ["script-setup"]],
      "vue/define-macros-order": ["error", { order: ["defineProps", "defineEmits"] }],
    },
  },
  {
    name: "begitra/scripts",
    files: ["scripts/**/*.mjs", "*.config.js", "*.config.ts"],
    extends: [vueTsConfigs.disableTypeChecked],
  },
  prettier,
);
