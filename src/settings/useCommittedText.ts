// A text field that applies on blur and Enter, not on every keystroke: the settings store is
// written when the user is done with the field, and the field follows the store otherwise.

import { ref, watch, type Ref } from "vue";

export interface CommittedText {
  /** What the field shows; edited freely until committed. */
  draft: Ref<string>;
  /** Writes the draft through `apply` when it differs from the stored value. */
  commit: () => void;
  onKeydown: (event: KeyboardEvent) => void;
}

/**
 * `apply` returns `false` to refuse a draft (an unparsable number): the field shows the
 * stored value again.
 */
export function useCommittedText(
  stored: () => string,
  apply: (value: string) => void | false | Promise<void>,
): CommittedText {
  const draft = ref(stored());
  watch(stored, (value) => {
    draft.value = value;
  });

  function commit(): void {
    if (draft.value === stored()) return;
    if (apply(draft.value) === false) draft.value = stored();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      // The stored value returns and the field lets go, so j/k walk the fields again.
      draft.value = stored();
      (event.target as HTMLElement | null)?.blur();
    }
  }

  return { draft, commit, onKeydown };
}
