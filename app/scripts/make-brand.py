#!/usr/bin/env python3
"""Render OMP's own vector mark into the canonical and renderer brand assets.

The small, controlled SVG uses colored pixel rectangles. Its geometry is also the
source of the transparent macOS template mask; no PI bitmap is transformed.
Run this before make-icon.py and make-dmg-background.py. Requires Pillow.
"""

from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageColor, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
RENDERER = ROOT / "apps" / "desktop" / "src" / "assets" / "brand"
SOURCE = BUILD / "omp-mark.svg"
BASE = 1024
SCALE = 2
TILE = (0, 0, 0, 255)


def render_mark() -> Image.Image:
    svg = ET.parse(SOURCE).getroot()
    if svg.attrib.get("viewBox") != "0 0 512 512":
        raise ValueError("OMP mark must use the canonical 512x512 viewBox")
    mark = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    factor = BASE / 512
    for element in svg:
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "title":
            continue
        if tag != "rect":
            raise ValueError(f"unsupported brand geometry: {tag}")
        x, y, width, height = (
            round(float(element.attrib[key]) * factor)
            for key in ("x", "y", "width", "height")
        )
        # Pillow paste uses exclusive right/bottom edges, matching SVG rectangles
        # without the one-pixel overlap introduced by ImageDraw.rectangle.
        mark.paste(
            ImageColor.getcolor(element.attrib["fill"], "RGBA"),
            (x, y, x + width, y + height),
        )
    if mark.getbbox() is None:
        raise ValueError("OMP mark is empty")
    return mark


def colored_mark(mask: Image.Image, color: tuple[int, int, int, int]) -> Image.Image:
    image = Image.new("RGBA", mask.size, color)
    image.putalpha(mask)
    return image


def main() -> None:
    mark = render_mark()
    mask = mark.getchannel("A")
    tile = Image.new("RGBA", (BASE * SCALE, BASE * SCALE), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle(
        (64 * SCALE, 64 * SCALE, 960 * SCALE, 960 * SCALE),
        radius=204 * SCALE,
        fill=TILE,
    )
    master = tile.resize((BASE, BASE), Image.Resampling.LANCZOS)
    master.alpha_composite(mark)
    master.save(BUILD / "icon_1024.png", optimize=True)
    master.save(BUILD / "logo_dark.png", optimize=True)
    colored_mark(mask, (0, 0, 0, 255)).save(BUILD / "omp-mark-mask.png", optimize=True)
    RENDERER.mkdir(parents=True, exist_ok=True)
    for theme in ("light", "dark"):
        image = mark.resize((96, 96), Image.Resampling.LANCZOS)
        image.save(RENDERER / f"logo-{theme}.png", optimize=True)
    master.resize((512, 512), Image.Resampling.LANCZOS).save(
        ROOT / "docs" / "public" / "app-icon.png", optimize=True
    )
    master.resize((512, 512), Image.Resampling.LANCZOS).save(
        ROOT / "docs" / "image" / "readme" / "logo.png", optimize=True
    )
    print(f"rendered OMP master, template mask and renderer marks from {SOURCE}")


if __name__ == "__main__":
    main()
