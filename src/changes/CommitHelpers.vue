<script setup lang="ts">
// The commit box's helpers, after "Sign off": Recent messages, the user's last distinct
// messages on the branch, one of which fills the fields; and Add a co-author, the people who
// wrote the recent commits, filtered by a field, one of whom joins the body as a
// `Co-authored-by:` trailer. Each reads its list when it opens and drops the read when it
// closes, as it does when the box stops taking input or shows another repository; the focus
// comes back to the button unless it went elsewhere.

import { History, Users } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import * as ipc from "@/ipc/commands";
import { relativeDate } from "@/shell/format";
import { useNow } from "@/shell/useNow";

import { withCoAuthor } from "./commitMessage";
import HelperList, { type HelperRow } from "./HelperList.vue";
import { useChanges } from "./useChanges";
import { useHelperRead } from "./useHelperRead";

const props = defineProps<{
  /** The box takes no input: a write runs, or the tree is clean. */
  inert: boolean;
  /** HEAD has no commit: no message of the user's yet. */
  unborn: boolean;
}>();

const { t, n } = useI18n();
const changes = useChanges();
const now = useNow();
// The user is the author line the box shows: who git commits as.
const author = () => changes.context?.author ?? null;
const messages = useHelperRead((root, opId) => ipc.recentMessages(root, author(), opId));
const authors = useHelperRead((root, opId) => ipc.recentAuthors(root, author(), opId));

const shown = ref<"messages" | "authors" | null>(null);
const query = ref("");
const messagesButton = ref<{ $el: HTMLElement } | null>(null);
const authorsButton = ref<{ $el: HTMLElement } | null>(null);

function toggle(which: "messages" | "authors"): void {
  if (shown.value === which) {
    close();
    return;
  }
  close(false);
  const root = changes.root;
  if (!root) return;
  shown.value = which;
  query.value = "";
  void (which === "messages" ? messages : authors).open(root);
}

/**
 * Closes the list shown; its button takes the focus back with `refocus`, not when another
 * list opens or the focus already went elsewhere.
 */
function close(refocus = true): void {
  const was = shown.value;
  messages.close();
  authors.close();
  shown.value = null;
  if (!refocus || was === null) return;
  const button = was === "messages" ? messagesButton.value : authorsButton.value;
  void nextTick(() => button?.$el.focus());
}

watch(
  () => [props.inert, changes.root] as const,
  () => close(false),
);
onBeforeUnmount(() => close(false));

/** "3h ago", as the app writes ages. */
function ago(time: number): string {
  const rel = relativeDate(time, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
}

const messageRows = computed<HelperRow[]>(() => {
  const read = messages.state.value;
  if (read.kind !== "ready") return [];
  return read.value.messages.map((message) => ({
    key: message.hash,
    label: message.message.split("\n")[0] ?? "",
    detail: "",
    count: ago(message.time),
  }));
});

const authorMatches = computed(() => {
  const read = authors.state.value;
  if (read.kind !== "ready") return [];
  const typed = query.value.trim().toLowerCase();
  return read.value.filter(
    (author) =>
      typed === "" ||
      author.name.toLowerCase().includes(typed) ||
      author.email.toLowerCase().includes(typed),
  );
});
const authorRows = computed<HelperRow[]>(() =>
  authorMatches.value.map((author) => ({
    key: author.email,
    label: author.name,
    detail: author.email,
    count: n(author.commits),
  })),
);

const messagesEmpty = computed(() => {
  const read = messages.state.value;
  return read.kind === "ready" && !read.value.identity
    ? t("commitHelpers.noIdentity")
    : t("commitHelpers.noMessages");
});
const authorsEmpty = computed(() =>
  query.value.trim() !== "" ? t("commitHelpers.noMatch") : t("commitHelpers.noAuthors"),
);

/** A list's state as it shows: loading until its read answers. */
function stateOf(read: { kind: string }): "loading" | "ready" | "failed" {
  return read.kind === "failed" ? "failed" : read.kind === "ready" ? "ready" : "loading";
}
const messagesError = computed(() =>
  messages.state.value.kind === "failed" ? messages.state.value.error : null,
);
const authorsError = computed(() =>
  authors.state.value.kind === "failed" ? authors.state.value.error : null,
);

function chooseMessage(index: number): void {
  const read = messages.state.value;
  const chosen = read.kind === "ready" ? read.value.messages[index] : undefined;
  if (chosen) changes.setMessage(chosen.message);
  close();
}

function chooseAuthor(index: number): void {
  const chosen = authorMatches.value[index];
  if (chosen) {
    changes.setDraft({ body: withCoAuthor(changes.draft.body, chosen.name, chosen.email) });
  }
  close();
}
</script>

<template>
  <IconButton
    ref="messagesButton"
    :label="t('commitHelpers.recent')"
    :icon="History"
    :expanded="shown === 'messages'"
    :disabled="props.inert || props.unborn"
    aria-haspopup="dialog"
    data-testid="commit-recent-messages"
    @click="toggle('messages')"
  />
  <IconButton
    ref="authorsButton"
    :label="t('commitHelpers.coAuthor')"
    :icon="Users"
    :expanded="shown === 'authors'"
    :disabled="props.inert"
    aria-haspopup="dialog"
    data-testid="commit-co-authors"
    @click="toggle('authors')"
  />
  <HelperList
    v-if="shown === 'messages' && messagesButton"
    :anchor="messagesButton.$el"
    :label="t('commitHelpers.recent')"
    :rows="messageRows"
    :state="stateOf(messages.state.value)"
    :empty="messagesEmpty"
    :error="messagesError"
    :width="320"
    testid="recent-messages-list"
    @choose="chooseMessage"
    @close="close"
  />
  <HelperList
    v-if="shown === 'authors' && authorsButton"
    v-model:query="query"
    :anchor="authorsButton.$el"
    :label="t('commitHelpers.coAuthor')"
    :rows="authorRows"
    :state="stateOf(authors.state.value)"
    :empty="authorsEmpty"
    :error="authorsError"
    filter
    :placeholder="t('commitHelpers.filter')"
    testid="co-authors-list"
    @choose="chooseAuthor"
    @close="close"
  />
</template>
