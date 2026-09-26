// The parts of a release that decide what the server holds: the version the three manifests
// agree on, the installers a build left, the update manifest, and the site's pages (the product
// page and the download page, in English and Spanish). Used by
// scripts/release.mjs and tested in tests/release.test.ts.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The version each manifest declares: `package.json`, the Cargo workspace, `tauri.conf.json`. */
export function readVersions(root) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  ).version;
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const section = cargoToml.split(/^\[workspace\.package\]\s*$/m)[1] ?? "";
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(section.split(/^\[/m)[0] ?? "")?.[1] ?? null;
  return {
    "package.json": packageJson ?? null,
    "src-tauri/Cargo.toml": cargo,
    "tauri.conf.json": tauri ?? null,
  };
}

/** The one version the manifests agree on; throws naming each when they differ or one is missing. */
export function agreedVersion(versions) {
  const values = Object.values(versions);
  const first = values[0];
  if (!first || values.some((value) => value !== first)) {
    const listed = Object.entries(versions)
      .map(([file, value]) => `${file}: ${value ?? "none"}`)
      .join(", ");
    throw new Error(`the versions differ or one is missing (${listed})`);
  }
  return first;
}

/** The folder the updater endpoint lives in, with a trailing slash: where the site is served. */
export function siteBase(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !url.pathname.endsWith("/latest.json")) {
    throw new Error(
      `the updater endpoint must be an https URL ending in /latest.json: ${endpoint}`,
    );
  }
  url.pathname = url.pathname.slice(0, -"latest.json".length);
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The NSIS and MSI installers of `version` a Windows build left under `bundleDir`, each with its
 * updater signature and its SHA-256: `{ kind, name, path, size, sha256, signature }`. Throws when
 * one is missing, since a release without both, or unsigned, is not one to publish.
 */
export function findInstallers(bundleDir, version) {
  const kinds = [
    { kind: "nsis", folder: "nsis", suffix: "-setup.exe" },
    { kind: "msi", folder: "msi", suffix: ".msi" },
  ];
  return kinds.map(({ kind, folder, suffix }) => {
    const dir = join(bundleDir, folder);
    const names = readdirSync(dir).filter(
      (name) => name.endsWith(suffix) && name.includes(`_${version}_`),
    );
    if (names.length !== 1) {
      throw new Error(
        `expected one ${kind} installer of ${version} in ${dir}, found ${names.length}`,
      );
    }
    const name = names[0];
    const path = join(dir, name);
    let signature;
    try {
      signature = readFileSync(`${path}.sig`, "utf8").trim();
    } catch {
      throw new Error(
        `${name} has no updater signature (${name}.sig): was the key in the environment?`,
      );
    }
    // A build without the updater's artifacts leaves the last signature beside a new installer.
    if (statSync(`${path}.sig`).mtimeMs < statSync(path).mtimeMs) {
      throw new Error(`${name}.sig is older than ${name}: build the release again with the key`);
    }
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { kind, name, path, size: bytes.length, sha256, signature };
  });
}

/**
 * `latest.json` as the updater reads it: the version, its date and, per installer, the file's
 * URL and signature. `windows-x86_64` is the NSIS installer, as `tauri-action` writes it with
 * `updaterJsonPreferNsis`; a copy installed from the MSI finds its own entry first.
 */
export function updateManifest({ version, date, notes, base, installers }) {
  const url = (installer) => new URL(`releases/v${version}/${installer.name}`, base).toString();
  const entry = (installer) => ({ signature: installer.signature, url: url(installer) });
  const byKind = Object.fromEntries(installers.map((installer) => [installer.kind, installer]));
  if (!byKind.nsis || !byKind.msi) {
    throw new Error("a release needs the NSIS and the MSI installers");
  }
  return {
    version,
    notes,
    pub_date: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: {
      "windows-x86_64": entry(byKind.nsis),
      "windows-x86_64-nsis": entry(byKind.nsis),
      "windows-x86_64-msi": entry(byKind.msi),
    },
  };
}

/**
 * The updater's public key as minisign takes it (`-P`) and its key id, from
 * `plugins.updater.pubkey`: the base64 of a minisign public key file, whose key is "Ed", the
 * key id (8 bytes, little-endian) and the Ed25519 key.
 */
export function updaterKey(pubkey) {
  const text = Buffer.from(pubkey, "base64").toString("utf8");
  const key = text.split(/\r?\n/)[1]?.trim() ?? "";
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("plugins.updater.pubkey is not a minisign public key");
  }
  const id = Buffer.from(bytes.subarray(2, 10)).reverse().toString("hex").toUpperCase();
  return { key, id };
}

/** The minisign signature file a Tauri updater signature holds: what `minisign -V` reads. */
export function minisignature(signature) {
  const text = Buffer.from(signature, "base64").toString("utf8");
  if (!text.startsWith("untrusted comment:") || !text.includes("\ntrusted comment:")) {
    throw new Error("the updater signature is not a minisign signature");
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The entry of `version` in `site/releases.json`; throws when the version has none. */
export function releaseOf(releases, version) {
  const release = releases.find((entry) => entry.version === version);
  if (!release) {
    throw new Error(
      `site/releases.json has no entry for ${version}: add its date, title and notes`,
    );
  }
  for (const lang of LANGUAGES) {
    if (!release.title?.[lang] || !release.notes?.[lang]) {
      throw new Error(`site/releases.json's ${version} needs a title and notes in "${lang}"`);
    }
  }
  return release;
}

/** Binary megabytes to one decimal, as Windows and the browsers show a download's size. */
export function megabytes(size, locale = "en-US") {
  const value = (size / (1024 * 1024)).toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${value} MB`;
}

/**
 * The inner markup of each named Lucide icon (the `@lucide/vue` modules' `__iconData` nodes),
 * for the pages to draw inline: `{ name: '<path d="…"/>…' }`.
 */
export function loadIcons(iconsDir, names) {
  return Object.fromEntries(
    names.map((name) => {
      const source = readFileSync(join(iconsDir, `${name}.mjs`), "utf8");
      const elements = [...source.matchAll(/\[\s*"(\w+)",\s*\{([^}]*)\}\s*\]/g)].map(
        ([, tag, body]) => {
          const attributes = [...body.matchAll(/(\w+):\s*"([^"]*)"/g)]
            .filter(([, attribute]) => attribute !== "key")
            .map(([, attribute, value]) => ` ${attribute}="${escapeHtml(value)}"`)
            .join("");
          return `<${tag}${attributes}/>`;
        },
      );
      if (elements.length === 0) throw new Error(`the icon ${name} has no elements`);
      return [name, elements.join("")];
    }),
  );
}

/** The icons the pages draw. */
export const ICONS = [
  "arrow-right",
  "chart-no-axes-column",
  "check",
  "check-check",
  "command",
  "download",
  "eye",
  "fold-vertical",
  "folder",
  "folder-git-2",
  "folders",
  "gauge",
  "git-branch",
  "git-commit-horizontal",
  "git-compare-arrows",
  "git-merge",
  "hard-drive",
  "heart",
  "minus",
  "notebook-pen",
  "package",
  "plus",
  "refresh-cw",
  "shield-alert",
  "shield-check",
  "sparkles",
  "trash",
];

/** The site's languages; the first is served at the root and is `x-default`. */
export const LANGUAGES = ["en", "es"];

const PAGE_PATHS = { product: "", download: "download/" };

/** The path of a page in a language, relative to the site's root: `""`, `es/download/`. */
export function pagePath(lang, page) {
  return `${lang === LANGUAGES[0] ? "" : `${lang}/`}${PAGE_PATHS[page]}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A string with `{name}` placeholders filled in, as plain text. */
function format(template, values = {}) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
}

/** A string with `{name}` placeholders filled in, escaped for HTML. */
function fill(template, values = {}) {
  return escapeHtml(format(template, values));
}

function formatDate(day, locale) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/** Everything a page's markup needs, for one language and one page. */
function context(input, lang, page) {
  const path = pagePath(lang, page);
  const strings = input.strings[lang];
  const index = input.releases.indexOf(input.release);
  const nsis = input.installers.find((installer) => installer.kind === "nsis");
  const msi = input.installers.find((installer) => installer.kind === "msi");
  if (!nsis || !msi) throw new Error("the site needs the NSIS and the MSI installers");
  return {
    ...input,
    lang,
    page,
    path,
    root: "../".repeat(path.split("/").length - 1),
    s: strings,
    locale: strings.dateLocale,
    date: formatDate(input.release.date, strings.dateLocale),
    year: input.release.date.slice(0, 4),
    nsis,
    msi,
    recent: input.releases.slice(index, index + 3),
    older: input.releases.slice(index + 1),
  };
}

function link(ctx, lang, page, hash = "") {
  return `${ctx.root}${pagePath(lang, page)}${hash}` || "./";
}

function asset(ctx, name) {
  const hashed = ctx.assets[name];
  if (!hashed) throw new Error(`the site has no asset ${name}`);
  return `${ctx.root}assets/${hashed}`;
}

function installerHref(ctx, version, name) {
  return `${ctx.root}releases/v${escapeHtml(version)}/${escapeHtml(name)}`;
}

function icon(ctx, name, size = 16, className = "") {
  const inner = ctx.icons[name];
  if (inner === undefined) throw new Error(`the site has no icon ${name}`);
  const classes = ["icon", className].filter(Boolean).join(" ");
  return `<svg class="${classes}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/** A screenshot as AVIF and WebP at each width the image script made, with a narrow crop. */
function picture(ctx, name, { alt, eager = false, sizes, narrow, narrowSizes }) {
  const image = ctx.images[name];
  if (!image) throw new Error(`the site has no image ${name}`);
  const srcset = (crop, ext) =>
    ctx.images[crop].widths
      .map((width) => `${asset(ctx, `${crop}-${width}.${ext}`)} ${width}w`)
      .join(", ");
  const sources = [];
  if (narrow) {
    const small = ctx.images[narrow];
    for (const ext of ["avif", "webp"]) {
      sources.push(
        `<source media="(max-width: 600px)" type="image/${ext}" srcset="${srcset(narrow, ext)}" sizes="${narrowSizes}" width="${small.width}" height="${small.height}">`,
      );
    }
  }
  for (const ext of ["avif", "webp"]) {
    sources.push(`<source type="image/${ext}" srcset="${srcset(name, ext)}" sizes="${sizes}">`);
  }
  const loading = eager ? `loading="eager" fetchpriority="high"` : `loading="lazy"`;
  return `<picture>${sources.join("")}<img src="${asset(ctx, `${name}-${image.width}.webp`)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(alt)}" ${loading} decoding="async"></picture>`;
}

function head(ctx, { title, description }) {
  const url = (lang) => new URL(pagePath(lang, ctx.page), ctx.base).toString();
  const alternates = LANGUAGES.map(
    (lang) => `<link rel="alternate" hreflang="${lang}" href="${url(lang)}">`,
  ).join("\n    ");
  const otherLocales = LANGUAGES.filter((lang) => lang !== ctx.lang)
    .map((lang) => `<meta property="og:locale:alternate" content="${ctx.strings[lang].locale}">`)
    .join("\n    ");
  const og = new URL(`assets/${ctx.assets["og.png"]}`, ctx.base).toString();
  return `<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${url(ctx.lang)}">
    ${alternates}
    <link rel="alternate" hreflang="x-default" href="${url(LANGUAGES[0])}">
    <meta name="color-scheme" content="dark light">
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Begitra">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${url(ctx.lang)}">
    <meta property="og:image" content="${og}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeHtml(ctx.s.meta.ogAlt)}">
    <meta property="og:locale" content="${ctx.s.locale}">
    ${otherLocales}
    <meta name="twitter:card" content="summary_large_image">
    <link rel="icon" href="${ctx.root}favicon.ico" sizes="32x32">
    <link rel="icon" href="${asset(ctx, "icon.svg")}" type="image/svg+xml">
    <link rel="apple-touch-icon" href="${asset(ctx, "apple-touch-icon.png")}">
    <link rel="preload" href="${asset(ctx, "geist.woff2")}" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="${asset(ctx, "site.css")}">
  </head>`;
}

function wordmark(ctx, size) {
  return `<img src="${asset(ctx, "icon.svg")}" alt="" width="${size}" height="${size}"><span>Be<span class="git">git</span>ra</span>`;
}

function donateLink(ctx, className, label = ctx.s.nav.donate) {
  if (!ctx.site.donate) return "";
  return `<a class="${className}" href="${escapeHtml(ctx.site.donate)}" rel="noopener">${icon(ctx, "heart", 14, "heart")}<span class="label">${escapeHtml(label)}</span></a>`;
}

function languageLinks(ctx) {
  return LANGUAGES.filter((lang) => lang !== ctx.lang)
    .map((lang) => {
      const name = ctx.strings[lang].name;
      return `<a class="lang" href="${link(ctx, lang, ctx.page)}" hreflang="${lang}" lang="${lang}"><span class="long">${escapeHtml(name)}</span><span class="short" aria-hidden="true">${lang.toUpperCase()}</span></a>`;
    })
    .join("");
}

function topBar(ctx) {
  const product = (hash) => link(ctx, ctx.lang, "product", hash);
  const n = ctx.s.nav;
  return `<header class="top">
      <div class="wrap">
        <a class="wordmark" href="${link(ctx, ctx.lang, "product")}" aria-label="${escapeHtml(n.home)}">${wordmark(ctx, 28)}</a>
        <nav aria-label="${escapeHtml(n.label)}">
          <a href="${product("#features")}">${escapeHtml(n.features)}</a>
          <a href="${product("#whats-new")}">${escapeHtml(n.whatsNew)}</a>
          <a href="${product("#questions")}">${escapeHtml(n.questions)}</a>
        </nav>
        ${languageLinks(ctx)}
        <div class="actions">
          ${donateLink(ctx, "btn btn-small btn-outline donate")}
          <a class="btn btn-small" href="${link(ctx, ctx.lang, "download")}">${escapeHtml(n.download)}</a>
        </div>
      </div>
    </header>`;
}

function footer(ctx) {
  const f = ctx.s.footer;
  const product = (hash) => link(ctx, ctx.lang, "product", hash);
  const languages = LANGUAGES.map(
    (lang) =>
      `<a href="${link(ctx, lang, ctx.page)}" hreflang="${lang}" lang="${lang}"${lang === ctx.lang ? ' aria-current="page"' : ""}>${escapeHtml(ctx.strings[lang].name)}</a>`,
  ).join("");
  return `<footer>
      <div class="wrap">
        <div class="footer-top">
          <div class="brand">
            <a class="wordmark" href="${link(ctx, ctx.lang, "product")}" aria-label="${escapeHtml(ctx.s.nav.home)}">${wordmark(ctx, 24)}</a>
            <p>${escapeHtml(f.tagline)}</p>
            ${donateLink(ctx, "btn btn-small btn-outline donate")}
          </div>
          <nav class="links" aria-label="${escapeHtml(f.product)}">
            <h2>${escapeHtml(f.product)}</h2>
            <a href="${product("#features")}">${escapeHtml(ctx.s.nav.features)}</a>
            <a href="${product("#whats-new")}">${escapeHtml(ctx.s.nav.whatsNew)}</a>
            <a href="${product("#questions")}">${escapeHtml(ctx.s.nav.questions)}</a>
          </nav>
          <nav class="links" aria-label="${escapeHtml(f.downloads)}">
            <h2>${escapeHtml(f.downloads)}</h2>
            <a href="${installerHref(ctx, ctx.version, ctx.nsis.name)}">${escapeHtml(f.installer)}</a>
            <a href="${link(ctx, ctx.lang, "download", "#files")}"><span class="long">${escapeHtml(f.checksums)}</span><span class="short">${escapeHtml(f.checksumsShort)}</span></a>
            <a href="${link(ctx, ctx.lang, "download", "#older")}">${escapeHtml(f.older)}</a>
          </nav>
          <nav class="links languages" aria-label="${escapeHtml(f.language)}">
            <h2>${escapeHtml(f.language)}</h2>
            ${languages}
          </nav>
        </div>
        <div class="footer-bottom">
          <p>${fill(f.copyright, { year: ctx.year, publisher: ctx.site.publisher })} · <a href="${ctx.root}licenses.txt">${escapeHtml(f.licenses)}</a></p>
          <p class="key">${escapeHtml(f.key)} <code>${escapeHtml(ctx.key.id)}</code></p>
        </div>
      </div>
    </footer>`;
}

function page(ctx, meta, main) {
  return `<!doctype html>
<html lang="${ctx.lang}">
  ${head(ctx, meta)}
  <body>
    <a class="skip" href="#main">${escapeHtml(ctx.s.skip)}</a>
    ${topBar(ctx)}
    <main id="main">
${main}
    </main>
    ${footer(ctx)}
  </body>
</html>
`;
}

function label(ctx, iconName, text) {
  return `<p class="label">${icon(ctx, iconName, 16)}${escapeHtml(text)}</p>`;
}

function keys(ctx, groups) {
  const items = groups
    .map(
      ([letters, text]) =>
        `<li>${letters.map((letter) => `<kbd>${escapeHtml(letter)}</kbd>`).join("")}<span>${escapeHtml(text)}</span></li>`,
    )
    .join("");
  return `<ul class="keys">${items}</ul>`;
}

function hero(ctx) {
  const h = ctx.s.hero;
  const highlight =
    ctx.releases
      .slice(ctx.releases.indexOf(ctx.release))
      .find((entry) => /\.0$/.test(entry.version)) ?? ctx.release;
  const minor = highlight.version.split(".").slice(0, 2).join(".");
  const facts = h.facts.map((fact) => `<li>${fill(fact, { version: ctx.version })}</li>`).join("");
  return `      <section class="hero">
        <div class="wrap">
          <a class="pill" href="#whats-new"><strong>${fill(h.pillLabel, { version: minor })}</strong><span class="pill-long">${escapeHtml(highlight.highlight?.[ctx.lang] ?? highlight.title[ctx.lang])}</span><span class="pill-short">${escapeHtml(highlight.title[ctx.lang])}</span>${icon(ctx, "arrow-right", 14)}</a>
          <h1>${escapeHtml(h.headline)}</h1>
          <p class="lede">${escapeHtml(h.sub)}</p>
          <div class="cta">
            <a class="btn btn-large" href="${installerHref(ctx, ctx.version, ctx.nsis.name)}">${icon(ctx, "download", 18)}${escapeHtml(h.download)}</a>
            <a class="btn btn-large btn-outline" href="#whats-new">${escapeHtml(h.whatsNew)}</a>
          </div>
          <ul class="facts">${facts}</ul>
          <div class="stage">
            <div class="shot app-dark">${picture(ctx, "hero", { alt: h.imageAlt, eager: true, sizes: "(max-width: 1200px) calc(100vw - 40px), 1152px" })}</div>
          </div>
        </div>
      </section>`;
}

function features(ctx) {
  const r = ctx.s.review;
  const w = ctx.s.worktrees;
  const c = ctx.s.compare;
  const pointIcons = ["check-check", "notebook-pen", "chart-no-axes-column", "fold-vertical"];
  const points = r.points
    .map((point, i) => `<li>${icon(ctx, pointIcons[i], 18)}<span>${escapeHtml(point)}</span></li>`)
    .join("");
  const detailSizes = "(max-width: 1080px) calc(100vw - 48px), 688px";
  return `      <section class="feature split" id="features">
        <div class="wrap">
          <div class="copy">
            ${label(ctx, "eye", r.label)}
            <h2>${escapeHtml(r.title)}</h2>
            <p>${escapeHtml(r.body)}</p>
            <ul class="points">${points}</ul>
            ${keys(ctx, r.keys)}
          </div>
          <div class="shot detail fade-left fade-bottom app-dark">${picture(ctx, "review", { alt: r.imageAlt, sizes: detailSizes, narrow: "review-narrow", narrowSizes: "calc(100vw - 40px)" })}</div>
        </div>
      </section>
      <section class="feature wide">
        <div class="wrap">
          <div class="head">
            <div class="copy">
              ${label(ctx, "folder-git-2", w.label)}
              <h2>${escapeHtml(w.title)}</h2>
            </div>
            <p>${escapeHtml(w.body)}</p>
          </div>
          <div class="shot strip fade-right-narrow app-dark">${picture(ctx, "worktrees", { alt: w.imageAlt, sizes: "(max-width: 1200px) calc(100vw - 48px), 1152px", narrow: "worktrees-narrow", narrowSizes: "calc(100vw - 40px)" })}</div>
        </div>
      </section>
      <section class="feature split flip">
        <div class="wrap">
          <div class="shot detail fade-right fade-bottom app-dark">${picture(ctx, "compare", { alt: c.imageAlt, sizes: detailSizes, narrow: "compare-narrow", narrowSizes: "calc(100vw - 40px)" })}</div>
          <div class="copy">
            ${label(ctx, "git-compare-arrows", c.label)}
            <h2>${escapeHtml(c.title)}</h2>
            <p>${escapeHtml(c.body)}</p>
          </div>
        </div>
      </section>`;
}

function performance(ctx) {
  const p = ctx.s.performance;
  const stats = p.stats
    .map(([value, text]) => `<div><dt>${escapeHtml(value)}</dt><dd>${escapeHtml(text)}</dd></div>`)
    .join("");
  return `      <section class="feature wide performance">
        <div class="wrap">
          <div class="head">
            <div class="copy">
              ${label(ctx, "gauge", p.label)}
              <h2>${escapeHtml(p.title)}</h2>
            </div>
            <p>${escapeHtml(p.body)}</p>
          </div>
          <dl class="stats">${stats}</dl>
          <p class="note">${escapeHtml(p.note)}</p>
        </div>
      </section>`;
}

function card(ctx, { className, iconName, title, body, badge, visual }) {
  const badgeHtml = badge ? `<span class="badge">${escapeHtml(badge)}</span>` : "";
  return `<article class="card ${className}">
              <div class="card-copy">
                <p class="card-top">${icon(ctx, iconName, 20)}${badgeHtml}</p>
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(body)}</p>
              </div>
              ${visual}
            </article>`;
}

function everyday(ctx) {
  const e = ctx.s.everyday;
  // The lane colours of the design's folder list, one per repository.
  const lanes = [1, 4, 3, 2];
  const repos = e.folder.repos
    .map(
      ([name, branch, state], i) =>
        `<li${i === e.folder.repos.length - 1 ? ' class="quiet"' : ""}><span class="dot lane-${lanes[i % lanes.length]}"></span><span class="name">${escapeHtml(name)}</span><span class="branch">${escapeHtml(branch)}</span><span class="state">${escapeHtml(state)}</span></li>`,
    )
    .join("");
  const network = e.privacy.rows
    .map(
      ([what, when], i) =>
        `<li class="${i < 2 ? "" : "quiet"}">${icon(ctx, i < 2 ? "check" : "minus", 14)}<span class="name">${escapeHtml(what)}</span><span class="state">${escapeHtml(when)}</span></li>`,
    )
    .join("");
  const shot = (name, alt, extra = {}) =>
    `<div class="card-shot app-dark">${picture(ctx, name, { alt, ...extra })}</div>`;
  return `      <section class="feature everyday">
        <div class="wrap">
          <div class="copy head-narrow">
            ${label(ctx, "git-branch", e.label)}
            <h2>${escapeHtml(e.title)}</h2>
          </div>
          <div class="cards">
            <div class="cards-top">
            ${card(ctx, {
              className: "card-palette",
              iconName: "command",
              title: e.palette.title,
              body: e.palette.body,
              visual: shot("palette", e.palette.imageAlt, {
                sizes: "(max-width: 1080px) calc(100vw - 72px), 724px",
                narrow: "palette-narrow",
                narrowSizes: "calc(100vw - 61px)",
              }),
            })}
            ${card(ctx, {
              className: "card-folder",
              iconName: "folders",
              title: e.folder.title,
              body: e.folder.body,
              badge: e.folder.badge,
              visual: `<div class="mini app-dark"><p class="mini-head">${icon(ctx, "folder", 14)}<code>~/code/geoportal</code><span>${escapeHtml(e.folder.count)}</span></p><ul>${repos}</ul></div>`,
            })}
            </div>
            <div class="cards-bottom">
            ${card(ctx, {
              className: "card-commit",
              iconName: "git-commit-horizontal",
              title: e.commit.title,
              body: e.commit.body,
              visual: shot("commit", e.commit.imageAlt, { sizes: "312px" }),
            })}
            ${card(ctx, {
              className: "card-branches",
              iconName: "git-merge",
              title: e.branches.title,
              body: e.branches.body,
              visual: shot("branches", e.branches.imageAlt, { sizes: "312px" }),
            })}
            ${card(ctx, {
              className: "card-privacy",
              iconName: "shield-check",
              title: e.privacy.title,
              body: e.privacy.body,
              visual: `<div class="mini app-dark"><p class="mini-head"><span>${escapeHtml(e.privacy.head)}</span></p><ul>${network}</ul></div>`,
            })}
            </div>
          </div>
        </div>
      </section>`;
}

function releases(ctx) {
  const r = ctx.s.releases;
  const items = ctx.recent
    .map(
      (entry) => `<li>
              <p class="release-side"><strong>${escapeHtml(entry.version)}</strong><time datetime="${escapeHtml(entry.date)}">${escapeHtml(formatDate(entry.date, ctx.locale))}</time></p>
              <div>
                <h3>${escapeHtml(entry.title[ctx.lang])}</h3>
                <p>${escapeHtml(entry.notes[ctx.lang])}</p>
              </div>
            </li>`,
    )
    .join("\n            ");
  return `      <section class="feature two-columns" id="whats-new">
        <div class="wrap">
          <div class="copy">
            ${label(ctx, "sparkles", r.label)}
            <h2>${escapeHtml(r.title)}</h2>
            <p>${escapeHtml(r.body)}</p>
          </div>
          <ol class="releases">
            ${items}
          </ol>
        </div>
      </section>`;
}

function closing(ctx) {
  const c = ctx.s.closing;
  const meta = c.meta
    .map(
      (part) =>
        `<li>${fill(part, { version: ctx.version, size: megabytes(ctx.nsis.size, ctx.locale), date: ctx.date })}</li>`,
    )
    .join("");
  return `      <section class="feature closing">
        <div class="wrap">
          <div class="panel">
            <img src="${asset(ctx, "icon.svg")}" alt="" width="72" height="72">
            <h2>${escapeHtml(c.title)}</h2>
            <p>${escapeHtml(c.sub)}</p>
            <div class="cta">
              <a class="btn btn-large" href="${installerHref(ctx, ctx.version, ctx.nsis.name)}">${icon(ctx, "download", 18)}${escapeHtml(c.download)}</a>
              <a class="btn btn-large btn-outline" href="${link(ctx, ctx.lang, "download")}">${escapeHtml(c.checksums)}</a>
            </div>
            <ul class="facts">${meta}</ul>
          </div>
        </div>
      </section>`;
}

function questions(ctx) {
  const q = ctx.s.questions;
  const [freeQuestion, freeAnswer, [before, donate, after]] = q.free;
  const donateSentence = ctx.site.donate
    ? ` ${escapeHtml(before)}<a href="${escapeHtml(ctx.site.donate)}" rel="noopener">${escapeHtml(donate)}</a>${escapeHtml(after)}`
    : "";
  const item = (question, answer, open = false) => `<details${open ? " open" : ""}>
              <summary><span>${question}</span>${icon(ctx, "plus", 18, "closed")}${icon(ctx, "minus", 18, "opened")}</summary>
              <p>${answer}</p>
            </details>`;
  const items = [
    item(escapeHtml(freeQuestion), `${escapeHtml(freeAnswer)}${donateSentence}`, true),
    ...q.items.map(([question, answer]) => item(escapeHtml(question), escapeHtml(answer))),
  ].join("\n            ");
  return `      <section class="feature two-columns" id="questions">
        <div class="wrap">
          <div class="copy">
            <h2>${escapeHtml(q.title)}</h2>
          </div>
          <div class="questions">
            ${items}
          </div>
        </div>
      </section>`;
}

/** The product page of one language. */
export function productPage(input, lang) {
  const ctx = context(input, lang, "product");
  const main = [
    hero(ctx),
    features(ctx),
    performance(ctx),
    everyday(ctx),
    releases(ctx),
    closing(ctx),
    questions(ctx),
  ].join("\n");
  return page(
    ctx,
    { title: ctx.s.meta.productTitle, description: ctx.s.meta.productDescription },
    main,
  );
}

function downloadMain(ctx) {
  const d = ctx.s.download;
  const size = (installer) => megabytes(installer.size, ctx.locale);
  const [fileColumn, sizeColumn, hashColumn, signatureColumn] = d.columns;
  const rows = [ctx.nsis, ctx.msi]
    .map(
      (installer) => `<tr>
                  <td class="file"><a href="${installerHref(ctx, ctx.version, installer.name)}">${escapeHtml(installer.name)}</a></td>
                  <td class="size" data-label="${escapeHtml(sizeColumn)}">${escapeHtml(size(installer))}</td>
                  <td class="hash" data-label="${escapeHtml(hashColumn)}"><code>${escapeHtml(installer.sha256)}</code></td>
                  <td class="signature" data-label="${escapeHtml(signatureColumn)}"><a href="${installerHref(ctx, ctx.version, `${installer.name}.minisig`)}" aria-label="${fill(d.signatureOf, { file: installer.name })}">.minisig</a></td>
                </tr>`,
    )
    .join("\n                ");
  const steps = d.warning.steps
    .map((step, i) => `<li><span class="number">${i + 1}</span>${escapeHtml(step)}</li>`)
    .join("");
  const requirements = d.requirements.items
    .map((item) => `<li>${icon(ctx, "check", 14)}<span>${escapeHtml(item)}</span></li>`)
    .join("");
  const support = ctx.site.donate
    ? `<section class="aside-card support" aria-labelledby="support-title">
              <h2 id="support-title">${icon(ctx, "heart", 16, "heart")}${escapeHtml(d.support.title)}</h2>
              <p>${escapeHtml(d.support.body)}</p>
              <a class="btn btn-medium btn-outline donate" href="${escapeHtml(ctx.site.donate)}" rel="noopener">${icon(ctx, "heart", 16, "heart")}${escapeHtml(d.support.button)}</a>
            </section>`
    : "";
  const [updatesTitle, updatesBody] = d.after.updates;
  const [uninstallTitle, uninstallBody] = d.after.uninstall;
  const [dataTitle, dataBody, logsLabel] = d.after.data;
  const older = ctx.older
    .map((entry) => {
      const exe = `Begitra_${entry.version}_x64-setup.exe`;
      const msi = `Begitra_${entry.version}_x64_en-US.msi`;
      return `<li>
              <strong>${escapeHtml(entry.version)}</strong>
              <time datetime="${escapeHtml(entry.date)}">${escapeHtml(formatDate(entry.date, ctx.locale))}</time>
              <span class="title">${escapeHtml(entry.title[ctx.lang])}</span>
              <span class="older-links"><a href="${installerHref(ctx, entry.version, exe)}">${escapeHtml(d.older.exe)}</a><a href="${installerHref(ctx, entry.version, msi)}">${escapeHtml(d.older.msi)}</a></span>
            </li>`;
    })
    .join("\n            ");
  const olderSection = ctx.older.length
    ? `      <section class="older" id="older" aria-labelledby="older-title">
        <div class="wrap">
          <div class="older-head">
            <h2 id="older-title">${escapeHtml(d.older.title)}</h2>
            <p>${escapeHtml(d.older.body)}</p>
          </div>
          <ol>
            ${older}
          </ol>
        </div>
      </section>`
    : "";
  return `      <section class="download-head">
        <div class="wrap">
          <h1>${escapeHtml(d.title)}</h1>
          <p>${fill(d.sub, { version: ctx.version, date: ctx.date })}</p>
        </div>
      </section>
      <div class="download-main">
        <div class="wrap">
          <div class="download-left">
            <section class="primary" aria-labelledby="platform-title">
              <div class="platform">
                <img src="${asset(ctx, "icon.svg")}" alt="" width="40" height="40">
                <div>
                  <h2 id="platform-title">${escapeHtml(d.platform)}</h2>
                  <p>${escapeHtml(d.platformSub)}</p>
                </div>
              </div>
              <div class="primary-action">
                <a class="btn btn-large" href="${installerHref(ctx, ctx.version, ctx.nsis.name)}">${icon(ctx, "download", 18)}${escapeHtml(d.button)}</a>
                <span>${fill(d.size, { size: size(ctx.nsis) })}</span>
              </div>
              <p class="note"><span class="size-inline">${fill(d.size, { size: size(ctx.nsis) })}. </span>${escapeHtml(d.note)}</p>
              <p class="msi">${icon(ctx, "package", 16)}<a href="${installerHref(ctx, ctx.version, ctx.msi.name)}">${escapeHtml(d.msi)}</a><span>${fill(d.msiHint, { size: size(ctx.msi) })}</span></p>
            </section>
            <section class="files" id="files" aria-labelledby="files-title">
              <h2 id="files-title">${escapeHtml(d.files)}</h2>
              <table>
                <thead>
                  <tr><th scope="col">${escapeHtml(fileColumn)}</th><th scope="col">${escapeHtml(sizeColumn)}</th><th scope="col">${escapeHtml(hashColumn)}</th><th scope="col">${escapeHtml(signatureColumn)}</th></tr>
                </thead>
                <tbody>
                ${rows}
                </tbody>
              </table>
            </section>
            <section class="check" aria-labelledby="check-title">
              <h2 id="check-title">${escapeHtml(d.checkTitle)}</h2>
              <p>${escapeHtml(d.checkHash)}</p>
              <pre><code>Get-FileHash .\\${escapeHtml(ctx.nsis.name)}</code></pre>
              <p>${escapeHtml(d.checkSignature)}</p>
              <pre><code>minisign -Vm ${escapeHtml(ctx.nsis.name)} -P ${escapeHtml(ctx.key.key)}</code></pre>
              <p class="key">${escapeHtml(d.keyLabel)} <code>${escapeHtml(ctx.key.id)}</code></p>
            </section>
          </div>
          <div class="download-right">
            <section class="aside-card warning" aria-labelledby="warning-title">
              <h2 id="warning-title">${icon(ctx, "shield-alert", 16, "warn")}${escapeHtml(d.warning.title)}</h2>
              <p>${escapeHtml(d.warning.body)}</p>
              <ol class="steps">${steps}</ol>
              <p>${escapeHtml(d.warning.foot)}</p>
            </section>
            <section class="requirements" aria-labelledby="requirements-title">
              <h2 id="requirements-title">${escapeHtml(d.requirements.title)}</h2>
              <ul>${requirements}</ul>
            </section>
            ${support}
          </div>
        </div>
      </div>
      <section class="after" aria-labelledby="after-title">
        <div class="wrap">
          <h2 id="after-title">${escapeHtml(d.after.title)}</h2>
          <div class="after-grid">
            <div><h3>${icon(ctx, "refresh-cw", 16)}${escapeHtml(updatesTitle)}</h3><p>${escapeHtml(updatesBody)}</p></div>
            <div><h3>${icon(ctx, "trash", 16)}${escapeHtml(uninstallTitle)}</h3><p>${escapeHtml(uninstallBody)}</p></div>
            <div><h3>${icon(ctx, "hard-drive", 16)}${escapeHtml(dataTitle)}</h3><p>${escapeHtml(dataBody)}</p><p><code>%APPDATA%\\dev.begitra.app</code></p><p>${escapeHtml(logsLabel)}</p><p><code>%LOCALAPPDATA%\\dev.begitra.app\\logs</code></p></div>
          </div>
        </div>
      </section>
${olderSection}`;
}

/** The download page of one language. */
export function downloadPage(input, lang) {
  const ctx = context(input, lang, "download");
  const meta = {
    title: ctx.s.meta.downloadTitle,
    description: format(ctx.s.meta.downloadDescription, { version: ctx.version }),
  };
  return page(ctx, meta, downloadMain(ctx));
}

/**
 * Every page of the site and the files that list them, as `{ path: content }`: both pages in each
 * language, `robots.txt` and `sitemap.xml`. `input` holds the facts (`version`, `release`,
 * `releases`, `installers`, `key`, `base`), the copy (`strings` by language, `site`) and what the
 * staging made (`assets`: the hashed name of each asset, `images`: each screenshot's sizes,
 * `icons`: each icon's markup).
 */
export function sitePages(input) {
  const pages = {};
  for (const lang of LANGUAGES) {
    pages[`${pagePath(lang, "product")}index.html`] = productPage(input, lang);
    pages[`${pagePath(lang, "download")}index.html`] = downloadPage(input, lang);
  }
  const urls = LANGUAGES.flatMap((lang) =>
    Object.keys(PAGE_PATHS).map((pageName) =>
      new URL(pagePath(lang, pageName), input.base).toString(),
    ),
  );
  pages["sitemap.xml"] = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${escapeHtml(url)}</loc><lastmod>${escapeHtml(input.release.date)}</lastmod></url>`).join("\n")}
</urlset>
`;
  pages["robots.txt"] = `User-agent: *
Allow: /

Sitemap: ${new URL("sitemap.xml", input.base).toString()}
`;
  return pages;
}

/** A file's name with the first 10 hex digits of its content's SHA-256: `site.1a2b3c4d5e.css`. */
export function hashedName(name, content) {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}.${hash}${name.slice(dot)}` : `${name}.${hash}`;
}
