import { mount } from "@vue/test-utils";
import type { ComponentMountingOptions } from "@vue/test-utils";
import type { Component } from "vue";

import { createAppI18n } from "@/i18n";
import type { AppI18nOptions } from "@/i18n";

/**
 * Mounts a component with the vue-i18n plugin installed. Each call builds a fresh i18n
 * instance, so a test that runs in `es` never changes the locale of the next one.
 */
export function mountWithI18n<T extends Component>(
  component: T,
  options: ComponentMountingOptions<T> = {},
  i18nOptions: AppI18nOptions = {},
) {
  const i18n = createAppI18n(i18nOptions);
  const global = options.global ?? {};
  return mount(component, {
    ...options,
    global: { ...global, plugins: [...(global.plugins ?? []), i18n] },
  });
}
