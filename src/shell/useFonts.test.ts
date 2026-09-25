import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import { memoryStorage, useSettingsStore } from "@/stores/settings";

import { familyValue, fontProperties, useFonts } from "./useFonts";

const Host = defineComponent({
  setup() {
    useFonts();
    return () => h("div");
  },
});

const root = () => document.documentElement.style;

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("familyValue", () => {
  it("quotes a family with its trailing comma and leaves generic families bare", () => {
    expect(familyValue("  Cascadia   Code ")).toBe('"Cascadia Code",');
    expect(familyValue("System-UI")).toBe("system-ui,");
    expect(familyValue("   ")).toBe("");
    expect(familyValue("Cascadia Code, Consolas,, monospace")).toBe(
      '"Cascadia Code", "Consolas", monospace,',
    );
    expect(familyValue(" , ,")).toBe("");
  });

  it("drops what could end the value, and control characters, and keeps 64 characters", () => {
    expect(familyValue('Evil"; } body { color: red')).toBe('"Evil body color: red",');
    expect(familyValue("A\u0000B\tC")).toBe('"ABC",');
    expect(familyValue("x".repeat(80))).toBe(`"${"x".repeat(64)}",`);
  });
});

describe("fontProperties", () => {
  it("removes everything at the defaults", () => {
    expect(
      Object.values(
        fontProperties({ uiFont: "", uiWeight: "regular", codeFont: "", codeWeight: "regular" }),
      ).every((value) => value === null),
    ).toBe(true);
  });

  it("moves the three interface weights by one step and sets the code weight on its own", () => {
    expect(
      fontProperties({ uiFont: "", uiWeight: "medium", codeFont: "", codeWeight: "semibold" }),
    ).toMatchObject({
      "--font-weight-normal": "500",
      "--font-weight-medium": "600",
      "--font-weight-semibold": "700",
      "--code-weight": "600",
    });
    expect(
      fontProperties({ uiFont: "", uiWeight: "light", codeFont: "", codeWeight: "light" }),
    ).toMatchObject({ "--font-weight-normal": "300", "--code-weight": "300" });
  });
});

describe("useFonts", () => {
  it("writes the settings on the document root and follows them back to the defaults", async () => {
    const settings = useSettingsStore();
    const wrapper = mount(Host);
    expect(root().getPropertyValue("--font-mono-custom")).toBe("");
    await settings.update("codeFont", "Cascadia Code");
    await settings.update("uiWeight", "medium");
    await nextTick();
    expect(root().getPropertyValue("--font-mono-custom")).toBe('"Cascadia Code",');
    expect(root().getPropertyValue("--font-weight-normal")).toBe("500");
    expect(root().getPropertyValue("--font-ui-custom")).toBe("");
    await settings.update("codeFont", "");
    await settings.update("uiWeight", "regular");
    await nextTick();
    expect(root().getPropertyValue("--font-mono-custom")).toBe("");
    expect(root().getPropertyValue("--font-weight-normal")).toBe("");
    wrapper.unmount();
  });
});
