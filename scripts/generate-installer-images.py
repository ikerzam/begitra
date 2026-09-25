#!/usr/bin/env python3
"""Generates the Windows installers' images in src-tauri/icons/installer/ from the app icon
(src-tauri/icons/icon.png, which scripts/generate-icons.mjs makes from design/brand/) and the
Geist the app bundles (@fontsource-variable/geist): the NSIS header (150x57) and sidebar
(164x314) and the WiX banner (493x58) and dialog (493x312), as 24-bit BMPs, the format both
installers take.

The name is the wordmark: Geist semibold, "git" in --lane-3. The
dark panels (the NSIS sidebar, the WiX dialog's left column) carry the icon and the wordmark in
the dark theme's colours on --bg-app. The header and the banner stay white, since both
installers draw their page titles in black beside them: Tauri's NSIS template puts the header
at the left of the title, so it carries the icon and the wordmark in the light theme's colours;
WiX draws the title over the banner's left side, so the banner carries the icon at its right
edge.

Needs Pillow, fontTools and brotli (for the woff2): pip install pillow fonttools brotli.
Run from the repository root: python scripts/generate-installer-images.py
"""

from io import BytesIO
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "src-tauri" / "icons" / "icon.png"
GEIST = (
    ROOT
    / "node_modules"
    / "@fontsource-variable"
    / "geist"
    / "files"
    / "geist-latin-wght-normal.woff2"
)
OUT = ROOT / "src-tauri" / "icons" / "installer"

# --bg-app, --text and --lane-3 of both themes (src/styles/tokens.css).
BG_APP = (0, 0, 0)
DARK = ((237, 237, 237), (56, 189, 248))
LIGHT = ((23, 23, 23), (2, 132, 199))
WHITE = (255, 255, 255)
PARTS = ("Be", "git", "ra")


def geist(size: int) -> ImageFont.FreeTypeFont:
    """Geist at `size` px and weight 600, from the app's woff2 through an in-memory TTF."""
    font = TTFont(str(GEIST))
    font.flavor = None
    buffer = BytesIO()
    font.save(buffer)
    buffer.seek(0)
    face = ImageFont.truetype(buffer, size)
    face.set_variation_by_axes([600])
    return face


def icon(size: int) -> Image.Image:
    return Image.open(ICON).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)


def wordmark(draw: ImageDraw.ImageDraw, left: int, middle: int, size: int, colours) -> None:
    """The wordmark with its ink box starting at `left` and centred on `middle`."""
    font = geist(size)
    name = "".join(PARTS)
    box = draw.textbbox((0, 0), name, font=font)
    x = left - box[0]
    y = middle - (box[3] - box[1]) // 2 - box[1]
    text, git = colours
    for index, part in enumerate(PARTS):
        before = "".join(PARTS[:index])
        draw.text((x + font.getlength(before), y), part, font=font, fill=git if part == "git" else text)


def wordmark_width(size: int) -> int:
    box = ImageDraw.Draw(Image.new("RGB", (1, 1))).textbbox((0, 0), "".join(PARTS), font=geist(size))
    return box[2] - box[0]


def panel(width: int, height: int, icon_size: int, text_size: int) -> Image.Image:
    """The dark panel: the icon above the wordmark, both centred, a little above the middle."""
    image = Image.new("RGB", (width, height), BG_APP)
    mark = icon(icon_size)
    gap = text_size
    block = icon_size + gap + text_size
    top = (height - block) // 2 - height // 12
    image.paste(mark, ((width - icon_size) // 2, top), mark)
    middle = top + icon_size + gap + text_size // 2
    wordmark(ImageDraw.Draw(image), (width - wordmark_width(text_size)) // 2, middle, text_size, DARK)
    return image


def header(width: int, height: int, icon_size: int, margin: int, text_size: int) -> Image.Image:
    """The white header: the icon at the left edge and the wordmark beside it."""
    image = Image.new("RGB", (width, height), WHITE)
    mark = icon(icon_size)
    image.paste(mark, (margin, (height - icon_size) // 2), mark)
    wordmark(ImageDraw.Draw(image), margin + icon_size + margin, height // 2, text_size, LIGHT)
    return image


def strip(width: int, height: int, icon_size: int, margin: int) -> Image.Image:
    """The white strip: the icon at the right edge, vertically centred."""
    image = Image.new("RGB", (width, height), WHITE)
    mark = icon(icon_size)
    image.paste(mark, (width - margin - icon_size, (height - icon_size) // 2), mark)
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    header(150, 57, 36, 10, 18).save(OUT / "nsis-header.bmp")
    panel(164, 314, 88, 22).save(OUT / "nsis-sidebar.bmp")
    strip(493, 58, 40, 12).save(OUT / "wix-banner.bmp")
    dialog = Image.new("RGB", (493, 312), WHITE)
    dialog.paste(panel(164, 312, 88, 22), (0, 0))
    dialog.save(OUT / "wix-dialog.bmp")
    for name in sorted(path.name for path in OUT.glob("*.bmp")):
        print(f"wrote src-tauri/icons/installer/{name}")


if __name__ == "__main__":
    main()
