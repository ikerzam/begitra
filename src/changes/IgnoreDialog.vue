<script setup lang="ts">
// The ignore dialog (`Changes / Ignore dialog`): what to ignore of an untracked file and
// where, as the app's radios with their hints, the line it adds, Cancel and Ignore. Each group
// is one tab stop whose arrows move the choice; Enter on a radio ignores and Escape cancels,
// the focus going back to the row it opened from.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import RadioGroup from "@/components/RadioGroup.vue";
import type { RadioOption } from "@/components/types";
import type { IgnorePlace, IgnoreRule } from "@/ipc/schemas";
import { baseName } from "@/shell/format";

import { isFolderEntry } from "./ignore";
import { placeName } from "./useIgnoreDialog";

const props = defineProps<{
  /** The untracked file, repository-relative. */
  path: string;
  /** The rules the file has something for. */
  rules: IgnoreRule[];
  /** The line the chosen rule writes. */
  line: string;
  /** The repository, named in the folder view's title. */
  repository?: string | null;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const rule = defineModel<IgnoreRule>("rule", { required: true });
const place = defineModel<IgnorePlace>("place", { required: true });
const { t } = useI18n();

const name = computed(() => baseName(props.path));
const folder = computed(() => props.path.replace(/\/$/, "").split("/").slice(0, -1).join("/"));
const title = computed(() =>
  props.repository
    ? t("changes.ignoreDialog.titleIn", { name: name.value, repository: props.repository })
    : t("changes.ignoreDialog.title", { name: name.value }),
);
const extension = computed(() => name.value.slice(name.value.lastIndexOf(".")));

const ruleOptions = computed<RadioOption[]>(() =>
  props.rules.map((option) => {
    if (option === "file") {
      // A folder git lists whole (a nested repository) is ignored as itself.
      const folderEntry = isFolderEntry(props.path);
      return {
        value: option,
        label: t(folderEntry ? "changes.ignoreDialog.thisFolder" : "changes.ignoreDialog.file"),
        hint: t(
          folderEntry ? "changes.ignoreDialog.thisFolderHint" : "changes.ignoreDialog.fileHint",
          { path: props.path },
        ),
      };
    }
    if (option === "extension") {
      return {
        value: option,
        label: t("changes.ignoreDialog.extension", { extension: extension.value }),
        hint: t("changes.ignoreDialog.extensionHint"),
      };
    }
    return {
      value: option,
      label: t("changes.ignoreDialog.folder", { folder: `${folder.value}/` }),
      hint: t("changes.ignoreDialog.folderHint"),
    };
  }),
);

const placeOptions = computed<RadioOption[]>(() =>
  (["gitignore", "exclude"] as const).map((option) => ({
    value: option,
    label: placeName(option),
    hint: t(`changes.ignoreDialog.${option}Hint`),
  })),
);

const chosenRule = computed({
  get: () => rule.value,
  set: (value: string) => {
    if (value === "file" || value === "extension" || value === "folder") rule.value = value;
  },
});
/** Enter on a radio ignores; a held Enter's repeats do not, so the dialog is always seen first. */
function onEnter(event: KeyboardEvent): void {
  event.preventDefault();
  if (!event.repeat) emit("confirm");
}

const chosenPlace = computed({
  get: () => place.value,
  set: (value: string) => {
    if (value === "gitignore" || value === "exclude") place.value = value;
  },
});
</script>

<template>
  <Dialog
    :title="title"
    :confirm-label="t('changes.ignoreDialog.confirm')"
    data-testid="ignore-dialog"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <!-- Enter on a radio ignores: the focus starts on the first group, where a radio's own
         Enter does nothing. -->
    <div class="contents" @keydown.enter="onEnter">
      <div class="flex flex-col gap-2">
        <p class="text-sm font-semibold text-fg-secondary">{{ t("changes.ignoreDialog.what") }}</p>
        <RadioGroup
          v-model="chosenRule"
          :options="ruleOptions"
          :label="t('changes.ignoreDialog.what')"
          data-testid="ignore-rules"
        />
      </div>
      <div class="flex flex-col gap-2">
        <p class="text-sm font-semibold text-fg-secondary">{{ t("changes.ignoreDialog.where") }}</p>
        <RadioGroup
          v-model="chosenPlace"
          :options="placeOptions"
          :label="t('changes.ignoreDialog.where')"
          data-testid="ignore-places"
        />
      </div>
      <div class="flex flex-col gap-2">
        <p class="text-sm font-semibold text-fg-secondary">{{ t("changes.ignoreDialog.line") }}</p>
        <code
          class="block rounded-sm border border-line bg-app px-2 py-1 font-mono text-code break-all text-fg"
          data-testid="ignore-line"
          >{{ props.line }}</code
        >
      </div>
    </div>
  </Dialog>
</template>
