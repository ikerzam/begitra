// Types of scripts/release-site.mjs for the tests.

export interface Installer {
  kind: "nsis" | "msi";
  name: string;
  path: string;
  size: number;
  signature: string;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

export function readVersions(root: string): Record<string, string | null>;

export function agreedVersion(versions: Record<string, string | null>): string;

export function siteBase(endpoint: string): string;

export function findInstallers(bundleDir: string, version: string): Installer[];

export function updateManifest(input: {
  version: string;
  date: Date;
  notes: string;
  base: string;
  installers: Pick<Installer, "kind" | "name" | "signature">[];
}): UpdateManifest;

export function downloadPage(input: {
  version: string;
  date: Date;
  installers: Pick<Installer, "kind" | "name" | "size">[];
}): string;
