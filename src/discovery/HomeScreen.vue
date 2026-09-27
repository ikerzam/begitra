<script setup lang="ts">
// The home screen with an index:
// header, scan folders, the projects and the repository table. The empty Home stays in the
// shell as `HomeEmpty`.

import { ref } from "vue";

import HomeHeader from "./HomeHeader.vue";
import ProjectsSection from "./ProjectsSection.vue";
import RepoTable from "./RepoTable.vue";
import ScanFolders from "./ScanFolders.vue";

const emit = defineEmits<{ openFolder: [] }>();

const table = ref<{ focus(): void } | null>(null);

defineExpose({ focus: () => table.value?.focus() });
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col overflow-y-auto" data-testid="home-screen">
    <HomeHeader @open-folder="emit('openFolder')" />
    <ScanFolders />
    <ProjectsSection />
    <RepoTable ref="table" />
  </section>
</template>
