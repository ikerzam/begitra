<script setup lang="ts">
// A conflicted file's blocks in the changes screen's viewer, in place of the "Unmerged file"
// card: the bar with the count, which side is current and which incoming, and the whole-file
// actions; each block (`ConflictBlock`) with the lines around it; "Mark resolved" once every
// block was written here. A file whose markers do not pair, that cannot be read, or that reads
// without a block keeps the card. The keys: n and p move between blocks, c and i take the
// current and the incoming side, b both, e edits; the focus follows each step.

import { ArrowLeftToLine, ArrowRightToLine, Check, CircleCheck, Code } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import { sideParams } from "@/branches/sides";
import { useSideTexts } from "@/branches/useSideTexts";
import Button from "@/components/Button.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { FileChange, SideName } from "@/ipc/schemas";
import DiffGuard from "@/review/DiffGuard.vue";
import { useFileOpener } from "@/review/useFileOpener";
import { branchLanes } from "@/shell/branchLanes";
import { errorText } from "@/shell/errorMessage";
import { baseName } from "@/shell/format";
import { useCodeTheme } from "@/shell/useTheme";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useConflictBlocksStore } from "@/stores/conflictBlocks";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useSequencerStore } from "@/stores/sequencer";

import ConflictBlock, { type SideNames } from "./ConflictBlock.vue";

const props = defineProps<{ file: FileChange; root: string }>();

const { t } = useI18n();
const store = useConflictBlocksStore();
const sequencer = useSequencerStore();
const repo = useRepoStore();
const review = useReviewStore();
const sideTexts = useSideTexts();
const opener = useFileOpener(computed(() => props.root));
const codeTheme = useCodeTheme();

/** What each block exposes for the focus to follow the steps. */
interface BlockHandle {
  focus(): void;
  focusEdit(): void;
}
const blockRefs = ref<(BlockHandle | null)[]>([]);
const markResolved = useTemplateRef<{ $el: HTMLElement }>("markResolved");

watch(
  () => [props.root, props.file.path] as const,
  ([root, path]) => store.show(root, path),
  { immediate: true },
);
onBeforeUnmount(() => store.close());

/** The lines around each block: up to three, never into the next or the previous block. */
const CONTEXT = 3;
const ranges = computed(() => {
  const all = store.blocks;
  const total = store.text?.lines.length ?? 0;
  return all.map((block, index) => {
    const previous = all[index - 1]?.end ?? 0;
    const next = all[index + 1]?.start ?? total;
    return {
      before: [Math.max(previous, block.start - CONTEXT), block.start] as [number, number],
      after: [block.end, Math.min(next, block.end + CONTEXT)] as [number, number],
    };
  });
});

const lanes = computed(() => branchLanes(repo.refs));

/** A side named as the whole-file choices name it, or by its marker's label without them. */
function named(
  side: SideName | undefined,
  label: string,
  which: "current" | "incoming",
): SideNames {
  if (!side) {
    return {
      name: label || t(`conflictBlocks.${which}`),
      use: t(`conflictBlocks.use.${which}`),
      lane: null,
      hash: false,
    };
  }
  const params = sideParams(side);
  const name =
    side.kind === "ref"
      ? side.name
      : side.kind === "commit"
        ? params.hash
        : t("conflictBlocks.before", { hash: params.hash });
  const lane =
    side.kind === "ref"
      ? (lanes.value.get(`refs/heads/${side.name}`) ??
        lanes.value.get(`refs/remotes/${side.name}`) ??
        null)
      : null;
  return {
    name,
    use: t(`conflictBlocks.use.${side.kind}`, params),
    lane,
    hash: side.kind === "commit",
  };
}

const names = computed(() =>
  store.blocks.map((block) => ({
    ours: named(sequencer.sides?.ours, block.ours.label, "current"),
    theirs: named(sequencer.sides?.theirs, block.theirs.label, "incoming"),
  })),
);
/** The bar's sides, from the first block. */
const barNames = computed(() => names.value[0] ?? null);

const failedMessage = computed(() => {
  const failed = store.error;
  if (!failed) return "";
  const said = errorText(failed, baseName(props.file.path));
  return t(said.key, said.params);
});

/** The focus after a step: the block in focus, or "Mark resolved" once none is left. */
async function settleFocus(): Promise<void> {
  await nextTick();
  if (store.noneLeft) {
    markResolved.value?.$el.focus();
    return;
  }
  blockRefs.value[store.focused]?.focus();
}

async function resolve(index: number, kind: "ours" | "theirs" | "both"): Promise<void> {
  if (await store.resolve(index, { kind })) await settleFocus();
}
async function apply(): Promise<void> {
  if (await store.applyEdit()) await settleFocus();
}
async function cancel(index: number): Promise<void> {
  store.cancelEdit();
  await nextTick();
  blockRefs.value[index]?.focusEdit();
}
async function move(step: number): Promise<void> {
  store.move(step);
  await nextTick();
  blockRefs.value[store.focused]?.focus();
}

const ready = computed(() => store.state === "ready" && store.blocks.length > 0);
const keysOn = () => ready.value && store.editing === null;
useShortcut("conflict-next", () => void move(1), keysOn);
useShortcut("conflict-previous", () => void move(-1), keysOn);
useShortcut("conflict-current", () => void resolve(store.focused, "ours"), keysOn);
useShortcut("conflict-incoming", () => void resolve(store.focused, "theirs"), keysOn);
useShortcut("conflict-both", () => void resolve(store.focused, "both"), keysOn);
useShortcut("conflict-edit", () => store.startEdit(store.focused), keysOn);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-app text-fg" data-testid="conflict-blocks">
    <div
      v-if="store.state === 'loading' || store.state === 'idle'"
      class="min-h-0 flex-1 overflow-hidden bg-app"
      :data-theme="codeTheme"
      data-testid="conflict-blocks-loading"
    >
      <SkeletonRow v-for="k in 12" :key="`skeleton-${k}`" :index="k" height="diff" />
    </div>
    <template v-else-if="store.state === 'unreadable'">
      <DiffGuard :file="props.file" reason="unmerged" :reviewable="false" :root="props.root" />
    </template>
    <template v-else-if="store.state === 'failed'">
      <div class="p-3" data-testid="conflict-blocks-failed">
        <ErrorBanner
          :message="failedMessage"
          :output="store.error?.detail ?? store.error?.message ?? ''"
          :action="t('conflictBlocks.readAgain')"
          @action="() => void store.read()"
        />
      </div>
      <DiffGuard :file="props.file" reason="unmerged" :reviewable="false" :root="props.root" />
    </template>
    <div
      v-else-if="store.noneLeft"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center"
      data-testid="conflict-blocks-done"
    >
      <CircleCheck class="size-icon text-ok" :stroke-width="1.5" aria-hidden="true" />
      <p class="text-md font-medium text-fg">
        {{ t("conflictBlocks.noneLeft", { file: baseName(props.file.path) }) }}
      </p>
      <p class="text-md text-fg-secondary">{{ t("conflictBlocks.noneLeftBody") }}</p>
      <div class="flex items-center gap-2 pt-2">
        <Button
          ref="markResolved"
          variant="primary"
          :icon="Check"
          :disabled="sequencer.busy"
          data-testid="conflict-blocks-mark-resolved"
          @click="() => void sequencer.markResolved([props.file.path])"
        >
          {{ t("sequencer.markResolved") }}
        </Button>
        <Button
          v-if="opener.canOpen(props.file)"
          variant="ghost"
          :icon="Code"
          @click="() => void opener.openFile(props.file)"
        >
          {{ t("fileMenu.openInEditor") }}
        </Button>
      </div>
    </div>
    <template v-else>
      <div
        class="flex min-h-bar-top shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-1"
        data-testid="conflict-blocks-bar"
      >
        <span class="whitespace-nowrap text-md font-medium text-fg">
          {{ t("conflictBlocks.count", { n: store.blocks.length }) }}
        </span>
        <span v-if="barNames" class="min-w-0 truncate text-md text-fg-secondary">
          {{
            t("conflictBlocks.sides", { ours: barNames.ours.name, theirs: barNames.theirs.name })
          }}
        </span>
        <span class="flex-1"></span>
        <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <template v-if="sequencer.sides">
            <Button
              variant="secondary"
              class="max-w-full"
              :icon="ArrowLeftToLine"
              :disabled="sequencer.busy || store.busy"
              :tooltip="sideTexts.takeLabel(sequencer.sides.ours)"
              data-testid="conflict-blocks-take-ours"
              @click="sequencer.askTakeSide(props.file.path, 'ours')"
            >
              <span class="min-w-0 truncate">{{ sideTexts.takeLabel(sequencer.sides.ours) }}</span>
            </Button>
            <Button
              variant="secondary"
              class="max-w-full"
              :icon="ArrowRightToLine"
              :disabled="sequencer.busy || store.busy"
              :tooltip="sideTexts.takeLabel(sequencer.sides.theirs)"
              data-testid="conflict-blocks-take-theirs"
              @click="sequencer.askTakeSide(props.file.path, 'theirs')"
            >
              <span class="min-w-0 truncate">{{
                sideTexts.takeLabel(sequencer.sides.theirs)
              }}</span>
            </Button>
          </template>
          <Button
            v-if="opener.canOpen(props.file)"
            variant="ghost"
            :icon="Code"
            @click="() => void opener.openFile(props.file)"
          >
            {{ t("fileMenu.openInEditor") }}
          </Button>
        </div>
      </div>
      <div
        v-if="store.text"
        class="conflict-list flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
        :data-theme="codeTheme"
        :style="{ '--diff-tab-width': review.tabWidth }"
        data-testid="conflict-blocks-list"
      >
        <ConflictBlock
          v-for="(block, index) in store.blocks"
          :key="`${block.start}-${block.end}`"
          :ref="(handle) => (blockRefs[index] = handle as BlockHandle | null)"
          v-model:draft="store.draft"
          :text="store.text"
          :block="block"
          :index="index"
          :total="store.blocks.length"
          :before="ranges[index]?.before ?? [block.start, block.start]"
          :after="ranges[index]?.after ?? [block.end, block.end]"
          :ours="names[index]?.ours ?? named(undefined, '', 'current')"
          :theirs="names[index]?.theirs ?? named(undefined, '', 'incoming')"
          :focused="store.focused === index"
          :editing="store.editing === index"
          :waiting="store.editing !== null && store.editing !== index"
          :busy="store.busy"
          @focus="store.focused = index"
          @resolve="(kind) => void resolve(index, kind)"
          @edit="store.startEdit(index)"
          @apply="() => void apply()"
          @cancel="() => void cancel(index)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Tabs take the settings' width, as the diff's rows do. */
.conflict-list {
  tab-size: var(--diff-tab-width, 4);
}
</style>
