import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useOperationsStore } from "./operations";
import { updaterError, useUpdaterStore } from "./updater";

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

const plugin = vi.hoisted(() => ({
  check: vi.fn<() => Promise<unknown>>(),
  relaunch: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));

/** A found update whose download reports three chunks, or fails. */
function fakeUpdate(version: string, failWith?: string) {
  return {
    version,
    currentVersion: "0.1.0",
    body: "notes",
    downloadAndInstall: vi.fn((onEvent?: (event: DownloadEvent) => void): Promise<void> => {
      onEvent?.({ event: "Started", data: { contentLength: 300 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 200 } });
      if (failWith) return Promise.reject(new Error(failWith));
      onEvent?.({ event: "Finished" });
      return Promise.resolve();
    }),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  plugin.check.mockReset();
  plugin.relaunch.mockReset();
});

describe("updater store", () => {
  it("starts idle and reports up to date when the endpoint names nothing newer", async () => {
    plugin.check.mockResolvedValue(null);
    const updater = useUpdaterStore();
    expect(updater.state.kind).toBe("idle");
    const pending = updater.check();
    expect(updater.state.kind).toBe("checking");
    await pending;
    expect(updater.state.kind).toBe("upToDate");
    expect(plugin.check).toHaveBeenCalledTimes(1);
    updater.dismiss();
    expect(updater.state.kind).toBe("idle");
  });

  it("offers the version found, downloads it with its progress in the status bar, then restarts", async () => {
    const update = fakeUpdate("0.2.0");
    plugin.check.mockResolvedValue(update);
    plugin.relaunch.mockResolvedValue();
    const updater = useUpdaterStore();
    const operations = useOperationsStore();
    await updater.check();
    expect(updater.state).toEqual({ kind: "available", version: "0.2.0", body: "notes" });
    const fractions: (number | undefined)[] = [];
    update.downloadAndInstall.mockImplementationOnce((onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 300 } });
      fractions.push(operations.currentFraction);
      onEvent?.({ event: "Progress", data: { chunkLength: 150 } });
      fractions.push(operations.currentFraction);
      onEvent?.({ event: "Progress", data: { chunkLength: 150 } });
      fractions.push(operations.currentFraction);
      onEvent?.({ event: "Finished" });
      return Promise.resolve();
    });
    const pending = updater.install();
    expect(updater.state).toEqual({ kind: "downloading", version: "0.2.0" });
    expect(operations.current?.label).toBe("operations.downloadingUpdate");
    expect(operations.current?.params).toEqual({ version: "0.2.0" });
    await pending;
    expect(fractions).toEqual([0, 0.5, 1]);
    expect(operations.current).toBeUndefined();
    expect(updater.state).toEqual({ kind: "installed", version: "0.2.0" });
    await updater.restart();
    expect(plugin.relaunch).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed check or download as updater.failed with the plugin's words", async () => {
    plugin.check.mockRejectedValue(new Error("Could not fetch a valid release JSON"));
    const updater = useUpdaterStore();
    await updater.check();
    expect(updater.state.kind).toBe("failed");
    if (updater.state.kind === "failed") {
      expect(updater.state.error.code).toBe("updater.failed");
      expect(updater.state.error.message).toBe("Could not fetch a valid release JSON");
      expect(updater.state.error.detail).toBe("Could not fetch a valid release JSON");
    }
    plugin.check.mockResolvedValue(fakeUpdate("0.3.0", "signature mismatch"));
    await updater.check();
    await updater.install();
    expect(updater.state.kind).toBe("failed");
    if (updater.state.kind === "failed") {
      expect(updater.state.error.detail).toBe("signature mismatch");
    }
    expect(useOperationsStore().current).toBeUndefined();
    expect(updaterError("plain text").detail).toBe("plain text");
    expect(updaterError({ reason: 1 }).detail).toBe('{"reason":1}');
  });
});
