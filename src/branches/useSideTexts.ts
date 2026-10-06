// The sentences that name the operation's sides: "Use main's version" in a conflict's menu and
// on the unmerged card, and the confirmation of a side taken, which says what goes (and that
// the file goes too, where the side taken has no version of it).

import { useI18n } from "vue-i18n";

import type { ConflictKind, OperationSides, Side, SideName } from "@/ipc/schemas";
import { baseName } from "@/shell/format";

import { otherSide, sideHasFile, sideParams } from "./sides";

export function useSideTexts() {
  const { t } = useI18n();

  /** "Use main's version", "Use the version from a1b2c3d", "Use the version before a1b2c3d". */
  function takeLabel(side: SideName): string {
    return t(`sequencer.side.use.${side.kind}`, sideParams(side));
  }

  /** The confirmation of taking `side` for the conflict of `path`, of `kind`. */
  function confirmation(
    sides: OperationSides,
    path: string,
    kind: ConflictKind,
    side: Side,
  ): { title: string; body: string; confirm: string } {
    const taken = sides[side];
    const other = sides[otherSide(side)];
    const lost = t(`sequencer.side.lost.${other.kind}`, { ...sideParams(other), path });
    const body = sideHasFile(kind, side)
      ? t("sequencer.side.body", { lost })
      : t("sequencer.side.bodyDeleted", {
          lost,
          holder: t(`sequencer.side.holder.${taken.kind}`, sideParams(taken)),
        });
    return {
      title: t(`sequencer.side.title.${taken.kind}`, {
        ...sideParams(taken),
        file: baseName(path),
      }),
      body,
      confirm: takeLabel(taken),
    };
  }

  return { takeLabel, confirmation };
}
