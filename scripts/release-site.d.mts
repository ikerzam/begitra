// Types of scripts/release-site.mjs for the tests.

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

export interface SiteInput {
  version: string;
  release: Release;
  releases: Release[];
  installers: Pick<Installer, "kind" | "name" | "size" | "sha256">[];
  key: { key: string; id: string };
  base: string;
  strings: Record<string, unknown>;
  site: { publisher: string; donate: string | null };
  assets: Record<string, string>;
  images: Record<string, { width: number; height: number; widths: number[] }>;
  icons: Record<string, string>;
}

export const ICONS: string[];

export const LANGUAGES: string[];

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

export function updaterKey(pubkey: string): { key: string; id: string };

export function minisignature(signature: string): string;

export function releaseOf(releases: Release[], version: string): Release;

export function megabytes(size: number, locale?: string): string;

export function loadIcons(iconsDir: string, names: string[]): Record<string, string>;

export function pagePath(lang: string, page: "product" | "download"): string;

export function productPage(input: SiteInput, lang: string): string;

export function downloadPage(input: SiteInput, lang: string): string;

export function sitePages(input: SiteInput): Record<string, string>;

export function hashedName(name: string, content: string | Uint8Array): string;
