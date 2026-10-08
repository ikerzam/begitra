<script setup lang="ts">
// "Open on <forge>" in a menu: the forge's page of what the menu is for, in the browser.

import { ExternalLink } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenuItem from "@/components/ContextMenuItem.vue";

import { useLinks, type Link } from "./useLinks";

const props = defineProps<{ link: Link }>();

const { t } = useI18n();
const links = useLinks();
</script>

<template>
  <ContextMenuItem
    :label="t('links.open', { forge: props.link.forge })"
    :icon="ExternalLink"
    data-testid="menu-open-link"
    @select="() => void links.open(props.link)"
  />
</template>
