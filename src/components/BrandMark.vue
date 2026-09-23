<script setup lang="ts">
// The Begitra mark: a branch that splits from a commit and merges back draws an eye, whose
// pupil is the commit under review. The branches take two lane colours and the commits the
// text colour, so the mark follows the theme; the app icons draw it on their own dark square
// (design/brand/). The two end commits sit on rings of the page background (`--bg-app`), which
// keep them apart from the branches at small sizes, as in the icon. Sized by its caller;
// decorative, since whatever sits beside it names the app.
</script>

<template>
  <svg
    viewBox="152 152 720 720"
    aria-hidden="true"
    focusable="false"
    class="shrink-0"
    data-testid="brand-mark"
  >
    <g fill="none" stroke-width="64" stroke-linecap="round">
      <path class="stroke-lane-3" d="M232,512 C352,326 672,326 792,512" />
      <path class="stroke-lane-2" d="M232,512 C352,698 672,698 792,512" />
    </g>
    <circle class="fill-app" cx="232" cy="512" r="80" />
    <circle class="fill-app" cx="792" cy="512" r="80" />
    <circle class="fill-fg" cx="232" cy="512" r="60" />
    <circle class="fill-fg" cx="792" cy="512" r="60" />
    <circle class="fill-fg" cx="512" cy="512" r="92" />
  </svg>
</template>
