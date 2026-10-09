<script setup lang="ts">
// Root: applies the theme and the fonts of the settings and renders the shell once they are
// read (`useStartUp`); the tooltip host serves every screen. Until then the root paints nothing,
// so the page's start-up screen shows on the window's own background.

import TooltipHost from "@/components/TooltipHost.vue";
import AppShell from "@/shell/AppShell.vue";
import { useFonts } from "@/shell/useFonts";
import { useTheme } from "@/shell/useTheme";

import { useStartUp } from "./useStartUp";

const ready = useStartUp();
useTheme();
useFonts();
</script>

<template>
  <div class="h-full text-fg" :class="{ 'bg-app': ready }" data-testid="app-root">
    <AppShell v-if="ready" />
    <TooltipHost />
  </div>
</template>
