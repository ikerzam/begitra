// The two sides of an image file for the image view: each read whole through `read_blob` and
// turned into a data URL (bytes as base64, an SVG's text encoded as UTF-8 first), with the
// loading and failure of each side; a file or target change drops what was in flight.

import { ref, watch, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type { BlobAt, FileChange } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import { fileSides, imageType } from "./sides";

export interface ImageSide {
  url: string | null;
  /** Size of the blob in bytes. */
  size: number;
  loading: boolean;
  failed: boolean;
}

const EMPTY: ImageSide = { url: null, size: 0, loading: false, failed: false };

/** Base64 of a text, UTF-8 encoded (`btoa` alone throws past Latin-1). */
export function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function useImageSides(root: Ref<string>, target: Ref<ReviewTarget>, file: Ref<FileChange>) {
  const before = ref<ImageSide>(EMPTY);
  const after = ref<ImageSide>(EMPTY);
  let serial = 0;

  async function read(side: { at: BlobAt; path: string } | null): Promise<ImageSide> {
    if (!side) return EMPTY;
    const type = imageType(side.path) ?? "application/octet-stream";
    try {
      const blob = await ipc.readBlob(root.value, side.at, side.path, newOpId("image"));
      const data = blob.bytes ?? (blob.text !== undefined ? base64OfText(blob.text) : null);
      return {
        url: data ? `data:${type};base64,${data}` : null,
        size: blob.size,
        loading: false,
        failed: data === null,
      };
    } catch {
      return { url: null, size: 0, loading: false, failed: true };
    }
  }

  async function load(): Promise<void> {
    serial += 1;
    const mine = serial;
    const sides = fileSides(target.value, file.value);
    before.value = { ...EMPTY, loading: sides.old !== null };
    after.value = { ...EMPTY, loading: sides.new !== null };
    const [older, newer] = await Promise.all([read(sides.old), read(sides.new)]);
    if (mine !== serial) return;
    before.value = older;
    after.value = newer;
  }

  watch([root, target, () => file.value.path], () => void load(), { immediate: true });

  return { before, after, reload: load };
}
