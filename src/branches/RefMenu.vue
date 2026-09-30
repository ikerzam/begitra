<script setup lang="ts">
// The menu of a ref by its kind, for the graph's badges and the sidebar's rows:
// the stash badge's own menu, or the branch menu of a branch, a remote branch or a tag. What
// is chosen runs through `useBranchActions`. The remotes are listed as the menu opens; until
// they are, a remote branch's remote is read from its name's first part, and the actions wait
// for the list.

import { computed, onMounted } from "vue";

import type { Ref as GitRef } from "@/ipc/schemas";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useStashStore } from "@/stores/stash";

import BranchContextMenu from "./BranchContextMenu.vue";
import StashBadgeMenu from "./StashBadgeMenu.vue";
import { useBranchActions } from "./useBranchActions";

const props = defineProps<{
  target: GitRef;
  x: number;
  y: number;
  /** Whether ↵ on the ref's row checks it out (the sidebar's rows), for the menu's hint. */
  enterChecksOut?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const repo = useRepoStore();
const remotes = useRemotesStore();
const stash = useStashStore();
const actions = useBranchActions();

const current = computed(() => repo.currentBranch?.name ?? null);
const remote = computed(() => {
  if (remotes.loaded) return actions.remoteOfRef(props.target);
  if (props.target.kind !== "remote-branch") return null;
  const at = props.target.name.indexOf("/");
  return at > 0
    ? { remote: props.target.name.slice(0, at), branch: props.target.name.slice(at + 1) }
    : null;
});

onMounted(() => {
  if (props.target.kind !== "stash") actions.ensureRemotes();
});
</script>

<template>
  <StashBadgeMenu
    v-if="props.target.kind === 'stash'"
    :x="props.x"
    :y="props.y"
    :busy="stash.busy !== null"
    @close="emit('close')"
    @choose="(kind) => actions.runStash(kind, props.target)"
  />
  <BranchContextMenu
    v-else
    :target="props.target"
    :current="current"
    :remote="remote"
    :enter-checks-out="props.enterChecksOut"
    :x="props.x"
    :y="props.y"
    @close="emit('close')"
    @choose="(kind) => actions.run(kind, props.target)"
  />
</template>
