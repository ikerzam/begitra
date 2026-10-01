// Types of scripts/release-files.mjs for the tests.

export interface Installer {
  kind: "nsis" | "msi";
  name: string;
  path: string;
  size: number;
  sha256: string;
  signature: string;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

export interface Release {
  version: string;
  date: string;
  title: Record<string, string>;
  /** What the hero's pill says about a minor release, when not its title. */
  highlight?: Record<string, string>;
  notes: Record<string, string>;
}

export interface UpdaterKey {
  key: string;
  id: string;
}

export interface SiteFacts {
  version: string;
  key: UpdaterKey;
  installers: Pick<Installer, "kind" | "name" | "size" | "sha256">[];
}

export const LANGUAGES: string[];

export function readVersions(root: string): Record<string, string | null>;

export function agreedVersion(versions: Record<string, string | null>): string;

export function checkTag(version: string, tag: string): void;

export function releaseDownloads(endpoints: string[]): { repository: string; downloads: string };

export function installerFiles(
  bundleDir: string,
  version: string,
): Pick<Installer, "kind" | "name" | "path">[];

export function findInstallers(bundleDir: string, version: string): Installer[];

export function updaterKey(pubkey: string): UpdaterKey;

export function verifySignature(bytes: Uint8Array, signature: string, pubkey: string): void;

export function minisignature(signature: string): string;

export function updateManifest(input: {
  version: string;
  date: Date;
  notes: string;
  downloads: string;
  installers: Pick<Installer, "kind" | "name" | "signature">[];
}): UpdateManifest;

export function siteFacts(input: {
  version: string;
  key: UpdaterKey;
  installers: Pick<Installer, "kind" | "name" | "size" | "sha256">[];
}): SiteFacts;

export function releaseOf(releases: Release[], version: string): Release;

export function releaseBody(release: Release): string;

export function stageRelease(input: {
  root: string;
  releases: Release[];
  installers: string;
  out: string;
  date: Date;
}): { version: string; assets: string[] };
