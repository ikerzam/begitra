<script setup lang="ts">
// The popover of the Path filter: one repository-relative path (a file or a directory) and
// Apply; Enter applies, Escape and a click outside close, an empty value clears the filter.

import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";

const props = defineProps<{
  /** The path currently filtering, shown as the initial value. */
  path: string;
  /** The button that opened the popover; clicks on it do not count as outside. */
  anchor?: HTMLElement | null;
}>();
const emit = defineEmits<{ apply: [path: string]; close: [] }>();

const { t } = useI18n();
const root = useTemplateRef<HTMLElement>("root");
const value = ref(props.path);

function apply(): void {
  emit("apply", value.value.trim());
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    apply();
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

function onPointerDownOutside(event: PointerEvent): void {
  if (!root.value || !(event.target instanceof Node)) return;
  if (root.value.contains(event.target) || props.anchor?.contains(event.target)) return;
  emit("close");
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  root.value?.querySelector("input")?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
});
</script>

<template>
  <div
    ref="root"
    role="dialog"
    :aria-label="t('graph.pathFilter')"
    class="path-popover absolute top-full left-0 z-20 mt-1 flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-2 shadow-overlay"
    data-testid="path-popover"
    @keydown="onKeydown"
  >
    <Input v-model="value" :placeholder="t('graph.pathPlaceholder')" spellcheck="false" />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" @click="emit('close')">{{ t("dialog.cancel") }}</Button>
      <Button variant="primary" data-testid="path-apply" @click="apply">
        {{ t("graph.apply") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* The popover is as wide as the palette's narrow controls (320px); not on the spacing scale. */
.path-popover {
  width: 320px;
}
</style>
