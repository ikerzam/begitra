<script setup lang="ts">
// "Copy link" in a menu: the forge's page of what the menu is for, with a toast.

import { Link as LinkIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenuItem from "@/components/ContextMenuItem.vue";

import { useLinks, type Link } from "./useLinks";

const props = defineProps<{ link: Link }>();

const { t } = useI18n();
const links = useLinks();
</script>

<template>
  <ContextMenuItem
    :label="t('links.copy')"
    :icon="LinkIcon"
    data-testid="menu-copy-link"
    @select="() => void links.copy(props.link)"
  />
</template>
