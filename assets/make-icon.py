# -*- coding: utf-8 -*-
"""Render assets/icon-180.png (and a 512 master) from the same design as icon.svg.

awesome-dsh-plugin only accepts GitHub-hosted bitmap icons (png/jpg/webp), so the
SVG stays the source of truth for the package while this script produces the
bitmap the marketplace actually shows. Run with any Python that has Pillow:

    python assets/make-icon.py
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# Gradient stops taken verbatim from icon.svg.
STOPS = [
    (0.00, (0x2F, 0x7C, 0xF6)),
    (0.55, (0x00, 0xB6, 0xA3)),
    (1.00, (0x7B, 0x5C, 0xF0)),
]
WHITE = (255, 255, 255, 255)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def sample(t: float) -> tuple[int, int, int]:
    t = min(max(t, 0.0), 1.0)
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t <= t1:
            k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(int(round(lerp(c0[j], c1[j], k))) for j in range(3))
    return STOPS[-1][1]


def gradient(size: int) -> Image.Image:
    """Diagonal 135deg gradient, matching linearGradient x1=0 y1=0 x2=1 y2=1."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = sample((x + y) / (2.0 * (size - 1)))
    return img


def render(size: int) -> Image.Image:
    # Same 4/64 inset and 14/64 corner radius as the SVG.
    scale = size / 64.0
    inset = 4 * scale
    radius = 14 * scale
    box = (inset, inset, size - inset, size - inset)

    grad = gradient(size)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(grad, (0, 0), mask)

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    stroke = max(1, int(round(3.2 * scale)))
    dot = 4.2 * scale

    def pt(x: float, y: float) -> tuple[float, float]:
        return (x * scale, y * scale)

    # Faithful to the SVG: spine 32,20 -> 32,30, then a rounded bracket
    # (20,40) -> (20,34) -> arc -> (24,30) -> (40,30) -> arc -> (44,34) -> (44,40).
    d.line([pt(32, 20), pt(32, 30)], fill=WHITE, width=stroke)
    d.line([pt(20, 40), pt(20, 34)], fill=WHITE, width=stroke)
    d.line([pt(24, 30), pt(40, 30)], fill=WHITE, width=stroke)
    d.line([pt(44, 34), pt(44, 40)], fill=WHITE, width=stroke)
    d.arc(
        [pt(20, 30)[0], pt(20, 30)[1], pt(28, 38)[0], pt(28, 38)[1]],
        start=180, end=270, fill=WHITE, width=stroke,
    )
    d.arc(
        [pt(36, 30)[0], pt(36, 30)[1], pt(44, 38)[0], pt(44, 38)[1]],
        start=270, end=360, fill=WHITE, width=stroke,
    )

    for cx, cy in ((32, 16), (20, 44), (32, 44), (44, 44)):
        x, y = pt(cx, cy)
        d.ellipse([x - dot, y - dot, x + dot, y + dot], fill=WHITE)

    canvas = Image.alpha_composite(canvas, layer)

    # Trim to the rounded square so the icon has no transparent gutter.
    s = int(round(inset))
    return canvas.crop((s, s, size - s, size - s))


def main() -> None:
    for name, size in (("icon-512.png", 512), ("icon-180.png", 180)):
        render(size).save(os.path.join(HERE, name), "PNG", optimize=True)
        print("wrote", name)


if __name__ == "__main__":
    main()
