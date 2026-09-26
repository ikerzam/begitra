#!/usr/bin/env python3
"""Generates the site's images in site/assets/ and their sizes in site/images.json
for the product and download pages:

- the screenshots, cut from 2x Windows captures of the app (captures/shot-*.png,
  2880x1800 for a 1440x900 window) with the crops the pages show, at the width each is shown
  and twice that (never wider than the capture allows), as AVIF and WebP: <name>-<width>.avif and
  .webp; a -narrow crop is the one a 390-wide screen shows;
- the 1200x630 Open Graph image (og.png): the icon and the wordmark, the headline and a crop of
  the review screenshot, on --bg-app;
- the icons: icon.svg (design/brand/begitra-icon.svg), favicon.ico and apple-touch-icon.png (180)
  from the app's icons in src-tauri/icons/.

Needs Pillow (with AVIF), fontTools and brotli (for Geist's woff2):
pip install pillow fonttools brotli. Run from the repository root:
python scripts/generate-site-images.py
"""

import json
import shutil
from io import BytesIO
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
EXPORTS = ROOT / "captures"
ICONS = ROOT / "src-tauri" / "icons"
SITE = ROOT / "site"
OUT = SITE / "assets"
FONTS = ROOT / "node_modules" / "@fontsource-variable" / "geist" / "files"

# The captures are 2x: a point is two pixels.
SCALE = 2

# name, capture, the region of the 1440x900 window (x, y, width, height), the width it is shown
# at, and any smaller width a narrow screen asks for.
SHOTS = [
    ("hero", "shot-review-1440.png", (0, 0, 1440, 900), 1152, [700]),
    ("review", "shot-review-focus-1440.png", (640, 40, 800, 580), 688, []),
    ("review-narrow", "shot-review-focus-1440.png", (1000, 56, 440, 478), 350, []),
    ("worktrees", "shot-worktrees-1440.png", (240, 40, 1200, 260), 1152, [700]),
    ("worktrees-narrow", "shot-worktrees-1440.png", (240, 40, 520, 253), 350, []),
    ("compare", "shot-compare-1440.png", (240, 40, 760, 519), 688, []),
    ("compare-narrow", "shot-compare-1440.png", (240, 40, 520, 446), 350, []),
    ("palette", "shot-palette-1440.png", (396, 36, 648, 358), 724, []),
    ("palette-narrow", "shot-palette-1440.png", (396, 36, 464, 352), 329, []),
    ("commit", "shot-changes-1440.png", (240, 668, 280, 194), 312, []),
    ("branches", "shot-compare-1440.png", (0, 128, 240, 166), 312, []),
]

# --bg-app, --text, --text-secondary and --border-strong of the dark theme, --lane-3.
BG = (0, 0, 0)
TEXT = (237, 237, 237)
SECONDARY = (161, 161, 161)
BORDER = (51, 51, 51)
BRAND = (56, 189, 248)


def geist(size: int, weight: int) -> ImageFont.FreeTypeFont:
    """Geist at `size` px and `weight`, from the app's woff2 through an in-memory TTF."""
    font = TTFont(str(FONTS / "geist-latin-wght-normal.woff2"))
    font.flavor = None
    buffer = BytesIO()
    font.save(buffer)
    buffer.seek(0)
    face = ImageFont.truetype(buffer, size)
    face.set_variation_by_axes([weight])
    return face


def screenshots() -> dict:
    sizes = {}
    for name, export, (x, y, w, h), shown, extra in SHOTS:
        source = Image.open(EXPORTS / export).convert("RGB")
        region = source.crop((x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE))
        widths = sorted({min(width, region.width) for width in [shown, shown * 2, *extra]})
        for width in widths:
            height = round(region.height * width / region.width)
            image = region.resize((width, height), Image.Resampling.LANCZOS)
            # Thin coloured text stays sharp without chroma subsampling.
            image.save(OUT / f"{name}-{width}.avif", "AVIF", quality=62, subsampling="4:4:4")
            image.save(OUT / f"{name}-{width}.webp", "WEBP", quality=86, method=6)
        sizes[name] = {"width": shown, "height": round(h * shown / w), "widths": widths}
    return sizes


def images_json(sizes: dict) -> str:
    """The sizes as Prettier writes them (objects open, arrays on one line), so CI's format check
    passes on a freshly generated file."""
    lines = ["{"]
    for i, (name, size) in enumerate(sizes.items()):
        widths = ", ".join(str(width) for width in size["widths"])
        comma = "," if i < len(sizes) - 1 else ""
        lines += [
            f"  {json.dumps(name)}: {{",
            f'    "width": {size["width"]},',
            f'    "height": {size["height"]},',
            f'    "widths": [{widths}]',
            f"  }}{comma}",
        ]
    return "\n".join([*lines, "}"]) + "\n"


def rounded(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *image.size), radius, fill=255)
    out = Image.new("RGBA", image.size)
    out.paste(image, (0, 0), mask)
    return out


def open_graph() -> None:
    card = Image.new("RGB", (1200, 630), BG)
    draw = ImageDraw.Draw(card)
    # The review screenshot below the top bar, its diff and overview, on the right side.
    review = Image.open(EXPORTS / "shot-review-1440.png").convert("RGB")
    crop = review.crop((760, 120, 2880, 1500)).resize((706, 460), Image.Resampling.LANCZOS)
    frame = Image.new("RGB", (crop.width + 2, crop.height + 2), BORDER)
    frame.paste(crop, (1, 1))
    card.paste(rounded(frame, 12), (560, 118), rounded(frame, 12))
    # The icon and the wordmark.
    icon = Image.open(ICONS / "icon.png").convert("RGBA").resize((48, 48), Image.Resampling.LANCZOS)
    card.paste(icon, (64, 64), icon)
    mark = geist(34, 600)
    x = 64 + 48 + 16
    for part, colour in (("Be", TEXT), ("git", BRAND), ("ra", TEXT)):
        draw.text((x, 68), part, font=mark, fill=colour)
        x += draw.textlength(part, font=mark)
    # The headline and what Begitra is.
    headline = geist(62, 600)
    draw.text((64, 220), "Look before", font=headline, fill=TEXT)
    draw.text((64, 292), "you merge.", font=headline, fill=TEXT)
    sub = geist(24, 400)
    for i, line in enumerate(("A Git client for reviewing", "the code your agents write.")):
        draw.text((64, 400 + i * 34), line, font=sub, fill=SECONDARY)
    card.save(OUT / "og.png", optimize=True)


def icons() -> None:
    shutil.copyfile(ROOT / "design" / "brand" / "begitra-icon.svg", OUT / "icon.svg")
    shutil.copyfile(ICONS / "icon.ico", OUT / "favicon.ico")
    touch = Image.open(ICONS / "icon.png").convert("RGBA").resize((180, 180), Image.Resampling.LANCZOS)
    touch.save(OUT / "apple-touch-icon.png", optimize=True)


def main() -> None:
    # Everything in the folder is this script's output: a crop that is gone leaves no file.
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    sizes = screenshots()
    (SITE / "images.json").write_text(images_json(sizes), encoding="utf-8")
    open_graph()
    icons()
    total = 0
    for path in sorted(OUT.iterdir()):
        total += path.stat().st_size
        print(f"{path.name:36} {path.stat().st_size / 1024:8.1f} KB")
    print(f"{'total':36} {total / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
