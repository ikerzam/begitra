import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import prettier from "eslint-config-prettier";

/** Every element but the components whose `title` is a prop, and the message for the rest. */
const titledComponents = {
  element: "/^(?!(Dialog|Sheet|PanelHeader|SettingsSection|ReviewFilesPanel)$)/",
  message: "Use data-tooltip: the app draws its own tooltips, so a native title never shows.",
};

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
      // The app shows its own tooltips (data-tooltip, TooltipHost): no native title, except on
      // the components whose `title` is a prop.
      "vue/no-restricted-static-attribute": ["error", { key: "title", ...titledComponents }],
      "vue/no-restricted-v-bind": ["error", { argument: "title", ...titledComponents }],
    },
  },
  {
    name: "begitra/scripts",
    files: ["scripts/**/*.mjs", "*.config.js", "*.config.ts"],
    extends: [vueTsConfigs.disableTypeChecked],
  },
  prettier,
);
