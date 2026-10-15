#!/usr/bin/env python3
"""Render OMP's own vector mark into the canonical and renderer brand assets.

The small, controlled SVG uses rounded polylines. Its geometry is also the
source of the transparent macOS template mask; no PI bitmap is transformed.
Run this before make-icon.py and make-dmg-background.py. Requires Pillow.
"""

from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
RENDERER = ROOT / "apps" / "desktop" / "src" / "assets" / "brand"
SOURCE = BUILD / "omp-mark.svg"
BASE = 1024
SCALE = 2
TILE = (20, 61, 53, 255)
MINT = (214, 255, 234, 255)


def mark_mask() -> Image.Image:
    svg = ET.parse(SOURCE).getroot()
    if svg.attrib.get("viewBox") != "0 0 512 512":
        raise ValueError("OMP mark must use the canonical 512x512 viewBox")
    mask = Image.new("L", (BASE * SCALE, BASE * SCALE), 0)
    draw = ImageDraw.Draw(mask)
    factor = BASE * SCALE / 512
    for element in svg:
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "title":
            continue
        if tag != "polyline":
            raise ValueError(f"unsupported brand geometry: {tag}")
        points = [
            tuple(float(value) * factor for value in point.split(","))
            for point in element.attrib["points"].split()
        ]
        width = round(float(element.attrib["stroke-width"]) * factor)
        draw.line(points, fill=255, width=width, joint="curve")
        # Match SVG's round caps and joins, including the closed outer loop.
        radius = width / 2
        for x, y in points:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    if mask.getbbox() is None:
        raise ValueError("OMP mark is empty")
    return mask.resize((BASE, BASE), Image.Resampling.LANCZOS)


def colored_mark(mask: Image.Image, color: tuple[int, int, int, int]) -> Image.Image:
    image = Image.new("RGBA", mask.size, color)
    image.putalpha(mask)
    return image


def main() -> None:
    mask = mark_mask()
    tile = Image.new("RGBA", (BASE * SCALE, BASE * SCALE), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle(
        (64 * SCALE, 64 * SCALE, 960 * SCALE, 960 * SCALE),
        radius=204 * SCALE,
        fill=TILE,
    )
    master = tile.resize((BASE, BASE), Image.Resampling.LANCZOS)
    master.alpha_composite(colored_mark(mask, MINT))
    master.save(BUILD / "icon_1024.png", optimize=True)
    master.save(BUILD / "logo_dark.png", optimize=True)
    colored_mark(mask, (0, 0, 0, 255)).save(BUILD / "omp-mark-mask.png", optimize=True)
    RENDERER.mkdir(parents=True, exist_ok=True)
    for theme, color in [("light", TILE), ("dark", MINT)]:
        image = colored_mark(mask, color).resize((96, 96), Image.Resampling.LANCZOS)
        image.save(RENDERER / f"logo-{theme}.png", optimize=True)
    print(f"rendered OMP master, template mask and renderer marks from {SOURCE}")


if __name__ == "__main__":
    main()
