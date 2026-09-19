import { describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import type { PropType } from "vue";
import { useI18n } from "vue-i18n";

import { mountWithI18n } from "@/test/mount";

import en from "./en.json";
import es from "./es.json";
import { createAppI18n, i18n, locales, setLocale } from "./index";

type Messages = { [key: string]: string | Messages };

/** Flattens a message tree into dotted keys, so the two locales compare as sets. */
function keysOf(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : keysOf(value, path);
  });
}

function leavesOf(messages: Messages): string[] {
  return Object.values(messages).flatMap((value) =>
    typeof value === "string" ? [value] : leavesOf(value),
  );
}

/** Renders one paragraph per key, through `useI18n`, like every component does. */
const Probe = defineComponent({
  props: { keys: { type: Array as PropType<string[]>, required: true } },
  setup(props) {
    const { t } = useI18n();
    return () =>
      h(
        "div",
        props.keys.map((key) => h("p", t(key))),
      );
  },
});

describe("i18n", () => {
  it("has the same key set in English and Spanish", () => {
    const enKeys = keysOf(en).sort();
    const esKeys = keysOf(es).sort();
    expect(esKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(20);
  });

  it("has no empty strings in either locale", () => {
    for (const messages of [en, es]) {
      for (const leaf of leavesOf(messages)) {
        expect(leaf.trim()).not.toBe("");
      }
    }
  });

  it("lists both locales and defaults to English", () => {
    expect(locales).toEqual(["en", "es"]);
    expect(i18n.global.locale.value).toBe("en");
  });

  it("renders every key in Spanish without a missing-key warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = vi.fn();
    const keys = keysOf(en);
    const wrapper = mountWithI18n(Probe, { props: { keys } }, { locale: "es", missing });

    const rendered = wrapper.findAll("p").map((p) => p.text());
    expect(rendered).toHaveLength(keys.length);
    expect(rendered).toContain("Marcar como revisado");
    expect(rendered).not.toContain("Mark reviewed");
    expect(missing).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports a missing key through the handler", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = vi.fn();
    const wrapper = mountWithI18n(Probe, { props: { keys: ["nope.missing"] } }, { missing });
    expect(wrapper.text()).toBe("nope.missing");
    expect(missing).toHaveBeenCalled();
    expect(missing.mock.calls[0]?.slice(0, 2)).toEqual(["en", "nope.missing"]);
    warn.mockRestore();
  });

  it("switches the app locale and the document language", () => {
    setLocale("es");
    expect(i18n.global.locale.value).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    expect(i18n.global.t("hunkRow.markReviewed")).toBe("Marcar como revisado");
    setLocale("en");
    expect(i18n.global.t("hunkRow.markReviewed")).toBe("Mark reviewed");
  });

  it("builds fresh instances that start in English with an English fallback", () => {
    const fresh = createAppI18n();
    expect(fresh.global.locale.value).toBe("en");
    expect(fresh.global.fallbackLocale.value).toBe("en");
  });
});
