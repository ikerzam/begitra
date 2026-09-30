<script setup lang="ts">
// The backdrop of every modal overlay (the palette, the picker, dialogs and sheets): the whole
// window in --shadow-color. Only a press that starts on the scrim dismisses: a click whose press
// began in the panel (a selection dragged past its edge) is dispatched to the scrim too.

const props = withDefaults(
  defineProps<{
    /** Centred (dialogs and sheets), or at the top where the panel sets its own offset. */
    align?: "center" | "top";
  }>(),
  { align: "center" },
);

const emit = defineEmits<{ dismiss: [] }>();

/*
 * A press on the scrim never moves the focus: its default is taken, since the overlay unmounts
 * at once on the main button and the follow-up mousedown would blur the element it gives the
 * focus back to, and another button would send the focus to the body. Only the main button
 * dismisses; the others' menu is kept from the window behind.
 */
function onPointerdown(event: PointerEvent): void {
  if (event.target !== event.currentTarget) return;
  event.preventDefault();
  if (event.button === 0) emit("dismiss");
}
</script>

<template>
  <div
    class="fixed inset-0 flex justify-center bg-shadow"
    :class="props.align === 'center' ? 'items-center' : 'items-start'"
    @pointerdown="onPointerdown"
    @contextmenu.self.prevent
  >
    <slot />
  </div>
</template>
