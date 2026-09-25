// Drives the app's `Select` in tests as a user does: opens it and clicks an option. The list
// renders inside the select's root, so a wrapper around the select finds it.

import { nextTick } from "vue";

/** A wrapper around a select, a mounted component or an element found in one. */
interface Root {
  get(selector: string): { trigger(event: string): Promise<void>; text(): string };
  findAll(selector: string): { text(): string }[];
}

/** Opens the select under `root` and clicks the option whose value is `value`. */
export async function chooseOption(root: Root, value: string): Promise<void> {
  await root.get('[data-testid="select-button"]').trigger("click");
  await nextTick();
  await root.get(`[data-testid="option"][data-value="${value}"]`).trigger("click");
  await nextTick();
}

/** The labels of the options of the select under `root`, opening and closing it. */
export async function optionLabels(root: Root): Promise<string[]> {
  const button = root.get('[data-testid="select-button"]');
  await button.trigger("click");
  await nextTick();
  const labels = root.findAll('[data-testid="option"]').map((option) => option.text());
  await button.trigger("click");
  await nextTick();
  return labels;
}

/** The label the select under `root` shows. */
export function shownLabel(root: Root): string {
  return root.get('[data-testid="select-button"]').text();
}
