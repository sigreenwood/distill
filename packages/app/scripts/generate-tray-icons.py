#!/usr/bin/env python3
"""Generate tray icons for distill.

Electron 33 on Apple Silicon can't reliably parse SVG data URLs for
tray icons; nativeImage.createFromDataURL returns an empty image. This
script produces PNG files on disk that tray.ts loads directly, dodging
the SVG path entirely.

Generates 4 variants × 2 sizes (22px base + 44px @2x for Retina):
  trayTemplate.png / trayTemplate@2x.png     idle (black, template)
  trayProcessing.png / trayProcessing@2x.png green
  trayPaused.png / trayPaused@2x.png         amber
  trayError.png / trayError@2x.png           red

Uses only Python stdlib (zlib, struct, math) — no Pillow required, so
there's nothing to install. Run once after cloning:

  cd packages/app
  python3 scripts/generate-tray-icons.py

Commit the resulting PNG files; they're small (each under 1KB).
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', 'resources', 'icons'))

# Colour palette — matches the STATE_COLOUR constants in tray.ts.
VARIANTS = {
    'Template':   (0x00, 0x00, 0x00),
    'Processing': (0x22, 0xc5, 0x5e),
    'Paused':     (0xf5, 0x9e, 0x0b),
    'Error':      (0xef, 0x44, 0x44),
}


def _chunk(ctype: bytes, data: bytes) -> bytes:
    """Build a PNG chunk with length, type, data, and CRC."""
    crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
    return struct.pack('>I', len(data)) + ctype + data + struct.pack('>I', crc)


def write_png(path: str, size: int, pixels: list) -> None:
    """Write an RGBA PNG at `size`x`size`. `pixels` is a flat row-major list
    of 4-byte RGBA entries."""
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA

    # Raw pixel data: each row prefixed with a filter byte (0 = None).
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixels[y * size + x])
    idat = zlib.compress(bytes(raw), 9)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')  # signature
        f.write(_chunk(b'IHDR', ihdr))
        f.write(_chunk(b'IDAT', idat))
        f.write(_chunk(b'IEND', b''))


def in_microphone(fx: float, fy: float) -> bool:
    """Return True if the point (fx, fy) in the unit square [0,1]^2 lies
    inside the microphone shape.

    Shape (expressed as fractions of the icon):
      - Body:  capsule (rounded rect) from x=0.28..0.72, y=0.08..0.55
      - Stand: U-shaped arc (outer ellipse minus inner ellipse), lower half
      - Stem:  vertical rectangle from x=0.44..0.56, y=0.80..0.96

    All thresholds tuned for legibility at 22px — the body is the largest
    mass, so even after template inversion + Retina downsampling the icon
    still reads as a microphone.
    """
    # --- body (capsule) ---
    body_l, body_r = 0.28, 0.72
    body_t, body_b = 0.08, 0.55
    rx = (body_r - body_l) / 2  # "radius" of the rounded caps
    cx = (body_l + body_r) / 2
    if body_l <= fx <= body_r and body_t <= fy <= body_b:
        if fy < body_t + rx:
            cy = body_t + rx
            if (fx - cx) ** 2 + (fy - cy) ** 2 <= rx ** 2:
                return True
        elif fy > body_b - rx:
            cy = body_b - rx
            if (fx - cx) ** 2 + (fy - cy) ** 2 <= rx ** 2:
                return True
        else:
            return True  # middle straight section

    # --- U-shaped stand (lower half of elliptical ring) ---
    if fy > 0.5:
        outer = ((fx - 0.5) / 0.42) ** 2 + ((fy - 0.5) / 0.32) ** 2
        inner = ((fx - 0.5) / 0.32) ** 2 + ((fy - 0.5) / 0.22) ** 2
        if outer <= 1 and inner > 1:
            return True

    # --- vertical stem ---
    if 0.44 <= fx <= 0.56 and 0.80 <= fy <= 0.96:
        return True

    return False


def build_icon(size: int, rgb: tuple) -> list:
    """Build an `size`x`size` icon with 4x supersampling for anti-aliasing.

    Each output pixel is sampled 16 times (4x4 subpixel grid) and its
    alpha is set to the fraction of subsamples inside the microphone
    shape. RGB stays at the variant colour everywhere, giving a clean
    anti-aliased coloured shape on a transparent background.
    """
    r, g, b = rgb
    pixels: list = []
    for y in range(size):
        for x in range(size):
            hits = 0
            for sy in range(4):
                for sx in range(4):
                    fx = (x + (sx + 0.5) / 4) / size
                    fy = (y + (sy + 0.5) / 4) / size
                    if in_microphone(fx, fy):
                        hits += 1
            alpha = (255 * hits) // 16
            pixels.append(bytes((r, g, b, alpha)))
    return pixels


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    print(f'Generating tray icons in {OUT}\n')
    for name, rgb in VARIANTS.items():
        for scale in (1, 2):
            size = 22 * scale
            suffix = '' if scale == 1 else '@2x'
            path = os.path.join(OUT, f'tray{name}{suffix}.png')
            pixels = build_icon(size, rgb)
            write_png(path, size, pixels)
            print(f'  {os.path.relpath(path, os.getcwd())}')
    print('\nDone. Commit these PNGs; they\'re < 1 KB each.')


if __name__ == '__main__':
    main()
