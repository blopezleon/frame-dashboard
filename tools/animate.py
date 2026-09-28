"""Turn a still illustration into a seamless looping MP4 for the frame.

Every effect is periodic in the loop length T, so the last frame flows back
into the first. Output is H.264 1280x800 (the frame's screen), no audio.

Usage: python animate.py <scene> <src image> <out.mp4> [--preview out.png]
Scenes are defined at the bottom of this file.
"""
import math
import zlib
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 1280, 800           # frame screen
FPS = 24
T = 10.0                   # loop length in seconds
N = int(FPS * T)
TAU = 2 * math.pi


# ---------- helpers ----------

def load(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255.0


def rgb_to_hsv_np(img):
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    mx, mn = img.max(-1), img.min(-1)
    d = mx - mn + 1e-6
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6.0
    s = np.where(mx > 0, (mx - mn) / (mx + 1e-6), 0)
    return h, s, mx


def soft_box(shape, x0, y0, x1, y1, feather=40):
    """Mask that is 1 inside a box and fades out over `feather` pixels."""
    hgt, wid = shape
    ys = np.arange(hgt)[:, None]
    xs = np.arange(wid)[None, :]
    mx = np.clip(np.minimum(xs - x0, x1 - xs) / feather + 0.5, 0, 1)
    my = np.clip(np.minimum(ys - y0, y1 - ys) / feather + 0.5, 0, 1)
    return (mx * my).astype(np.float32)


def blur(mask, radius):
    im = Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0


def hue_rotate(img, angle):
    """Rotate hue in YIQ space (cheap, good enough for glowing RGB bits)."""
    c, s = math.cos(angle), math.sin(angle)
    to_yiq = np.array([[0.299, 0.587, 0.114], [0.596, -0.274, -0.322], [0.211, -0.523, 0.312]], np.float32)
    rot = np.array([[1, 0, 0], [0, c, -s], [0, s, c]], np.float32)
    m = np.linalg.inv(to_yiq) @ rot @ to_yiq
    return img @ m.T.astype(np.float32)


class Layer:
    """Additive light layer drawn with PIL then blurred."""

    def __init__(self, size):
        self.im = Image.new('RGB', size, (0, 0, 0))
        self.draw = ImageDraw.Draw(self.im)

    def out(self, blur_radius=0):
        im = self.im.filter(ImageFilter.GaussianBlur(blur_radius)) if blur_radius else self.im
        return np.asarray(im, dtype=np.float32) / 255.0


def rain(size, t, drops, color=(200, 215, 255), angle=0.12, region=None):
    """drops: list of (x, y0, loops, length, alpha). loops is an integer, so
    each drop falls an exact number of screen heights per loop (seamless)."""
    wid, hgt = size
    lay = Layer(size)
    for x, y0, loops, length, alpha in drops:
        y = (y0 + loops * hgt * t / T) % (hgt + length) - length
        xx = x + y * angle
        c = tuple(int(v * alpha) for v in color)
        lay.draw.line([(xx, y), (xx + length * angle, y + length)], fill=c, width=2)
    out = lay.out(0.6)
    if region is not None:
        out = out * region[..., None]
    return out


def particles(size, t, parts, blur_radius=2.5):
    """parts: (x, y, ax, ay, fx, fy, phase, r, color, rise_loops).
    Wobble frequencies fx/fy and rise_loops are integers → periodic in T."""
    wid, hgt = size
    lay = Layer(size)
    for x, y, ax, ay, fx, fy, ph, r, col, rise in parts:
        u = t / T
        px = x + ax * math.sin(TAU * fx * u + ph)
        py = (y - rise * hgt * u + ay * math.sin(TAU * fy * u + ph * 1.7)) % hgt
        tw = 0.55 + 0.45 * math.sin(TAU * (fx + 1) * u + ph * 2.3)  # twinkle
        c = tuple(int(v * tw) for v in col)
        lay.draw.ellipse([px - r, py - r, px + r, py + r], fill=c)
    return lay.out(blur_radius)


def camera(frame, t, zoom=0.03, pan=(0.0, 0.0)):
    """Crop the 16:9 source to 16:10 with a slow, looping push-in and drift."""
    hgt, wid, _ = frame.shape
    z = 1.0 + zoom * (1 - math.cos(TAU * t / T)) / 2
    cw, ch = hgt * 1.6 / z, hgt / z
    cx = wid / 2 + pan[0] * math.sin(TAU * t / T)
    cy = hgt / 2 + pan[1] * math.sin(TAU * t / T)
    cx = min(max(cx, cw / 2), wid - cw / 2)   # keep the crop inside the image
    cy = min(max(cy, ch / 2), hgt - ch / 2)
    box = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)
    im = Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8))
    return im.resize((W, H), Image.BICUBIC, box=box)


def pulse(t, freq, phase=0.0):
    """0..1 wave with an integer number of cycles per loop."""
    return 0.5 + 0.5 * math.sin(TAU * freq * t / T + phase)


# ---------- scenes ----------
# Each returns a function f(t) -> float image (source resolution).

def rng_for(name):
    return np.random.default_rng(zlib.crc32(name.encode()))


def scene_garage(img):
    hgt, wid, _ = img.shape
    rng = rng_for('garage')
    h, s, v = rgb_to_hsv_np(img)
    neon = blur(((s > 0.45) & (v > 0.75) & ((h > 0.8) | (h < 0.05) | ((h > 0.42) & (h < 0.55)))).astype(np.float32), 6)
    drops = [(rng.uniform(-100, wid), rng.uniform(0, hgt), int(rng.integers(5, 9)),
              rng.uniform(18, 40), rng.uniform(0.25, 0.6)) for _ in range(420)]
    # Rain mostly outside: strong at the edges and the open door, faint inside.
    region = np.clip(1 - soft_box((hgt, wid), 200, 60, 1330, 700, 60) * 0.8, 0, 1)
    floor_y = 700

    def f(t):
        flick = 0.85 + 0.15 * pulse(t, 3) + (0.25 if (int(t * FPS) % 97) in (3, 5) else 0)
        out = img * (1 + 0.35 * neon[..., None] * (flick - 0.85))
        # Puddle shimmer: shift floor rows sideways in a travelling wave
        rows = np.arange(floor_y, hgt)
        shift = (3 * np.sin(TAU * (rows / 14.0 + 2 * t / T))).astype(int)
        cols = (np.arange(wid)[None, :] + shift[:, None]) % wid
        out[floor_y:] = out[floor_y:][np.arange(len(rows))[:, None], cols]
        return out + rain((wid, hgt), t, drops, region=region)
    return f, dict(zoom=0.035, pan=(10, 0))


def scene_gamer(img):
    hgt, wid, _ = img.shape
    rng = rng_for('gamer')
    h, s, v = rgb_to_hsv_np(img)
    keyboard = soft_box((hgt, wid), 500, 610, 900, 740, 15) * ((s > 0.35) & (v > 0.45))
    keyboard = blur(keyboard, 2)
    tower = soft_box((hgt, wid), 1140, 380, 1300, 740, 25) * ((s > 0.4) & (v > 0.35))
    tower = blur(tower, 4)
    window = soft_box((hgt, wid), 700, 0, 1520, 470, 20)
    drops = [(rng.uniform(650, 1560), rng.uniform(0, hgt), int(rng.integers(4, 8)),
              rng.uniform(14, 30), rng.uniform(0.2, 0.45)) for _ in range(260)]
    lights = soft_box((hgt, wid), 700, 0, 1520, 470, 20) * (v > 0.7)

    def f(t):
        rot = hue_rotate(img, TAU * t / T)                     # RGB wave on the keyboard
        out = img + keyboard[..., None] * (rot * 1.15 - img)
        out = out * (1 + 0.3 * tower[..., None] * pulse(t, 2))
        out = out * (1 + 0.25 * lights[..., None] * (pulse(t, 5, 1.0) - 0.5))  # city lights twinkle
        return out + rain((wid, hgt), t, drops, color=(170, 190, 255), angle=0.05, region=window)
    return f, dict(zoom=0.03, pan=(0, 6))


def scene_gym(img):
    hgt, wid, _ = img.shape
    rng = rng_for('gym')
    h, s, v = rgb_to_hsv_np(img)
    beams = blur((v > 0.8).astype(np.float32), 25)
    parts = [(rng.uniform(250, 1100), rng.uniform(0, hgt), rng.uniform(10, 40), rng.uniform(5, 20),
              int(rng.integers(1, 3)), int(rng.integers(1, 3)), rng.uniform(0, TAU),
              rng.uniform(1.0, 2.6), (255, 220, 170), int(rng.integers(0, 2))) for _ in range(140)]

    def f(t):
        out = img * (1 + 0.12 * beams[..., None] * (pulse(t, 1) - 0.5))
        dust = particles((wid, hgt), t, parts, 1.5)
        # Dust only shows where light is
        return out + dust * (0.25 + 0.9 * blur(beams, 40)[..., None])
    return f, dict(zoom=0.03, pan=(14, 0))


def scene_watch(img):
    hgt, wid, _ = img.shape
    rng = rng_for('watch')
    ys, xs = np.mgrid[0:hgt, 0:wid].astype(np.float32)
    watch = blur(soft_box((hgt, wid), 520, 380, 950, 630, 10), 6)
    h, s, v = rgb_to_hsv_np(img)
    bokeh = soft_box((hgt, wid), 0, 0, 1100, 330, 30) * blur((v > 0.45).astype(np.float32), 8)

    def f(t):
        # A light glint sweeps across the watch once per loop
        u = (t / T) % 1.0
        pos = -300 + 1100 * u
        band = np.exp(-(((xs - 520) + (ys - 380) * 0.6 - pos) / 45.0) ** 2)
        out = img + watch[..., None] * band[..., None] * np.array([0.55, 0.6, 0.7], np.float32)
        out = out * (1 + 0.35 * bokeh[..., None] * (pulse(t, 2, 0.5) - 0.5))
        return out
    return f, dict(zoom=0.04, pan=(0, 0))


def scene_trainer(img):
    hgt, wid, _ = img.shape
    rng = rng_for('trainer')
    tail = blur(soft_box((hgt, wid), 630, 610, 760, 740, 20), 10)
    h, s, v = rgb_to_hsv_np(img)
    sun = blur(soft_box((hgt, wid), 180, 220, 380, 360, 40) * (v > 0.8), 30)
    parts = [(rng.uniform(0, wid), rng.uniform(380, hgt), rng.uniform(15, 50), rng.uniform(10, 30),
              int(rng.integers(1, 3)), int(rng.integers(1, 3)), rng.uniform(0, TAU),
              rng.uniform(2, 4), (255, 215, 120), 0) for _ in range(40)]

    def f(t):
        glow = pulse(t, 2)
        out = img + tail[..., None] * np.array([0.2, 0.45, 0.55], np.float32) * glow
        out = out * (1 + 0.15 * sun[..., None] * pulse(t, 1))
        return out + particles((wid, hgt), t, parts, 3) * 1.3
    return f, dict(zoom=0.03, pan=(18, 0))


def scene_synthwave(img):
    hgt, wid, _ = img.shape
    rng = rng_for('synthwave')
    h, s, v = rgb_to_hsv_np(img)
    signs = blur(soft_box((hgt, wid), 0, 0, wid, 560, 30) * ((s > 0.5) & (v > 0.6)), 4)
    moon = blur(soft_box((hgt, wid), 1020, 70, 1190, 240, 20), 25)
    not_car = 1 - blur(soft_box((hgt, wid), 540, 515, 1150, 775, 30), 12)   # streaks pass behind the car
    streaks = []
    for _ in range(40):
        streaks.append((rng.uniform(560, 860), rng.uniform(0, wid), int(rng.integers(2, 5)),
                        rng.uniform(150, 420), [(255, 90, 200), (90, 230, 255), (255, 255, 255)][int(rng.integers(0, 3))],
                        rng.uniform(0.35, 0.8)))

    def f(t):
        out = img * (1 + 0.3 * signs[..., None] * (pulse(t, 4, 0.3) - 0.5))
        out = out + moon[..., None] * 0.08 * pulse(t, 1)
        lay = Layer((wid, hgt))
        for y, x0, loops, length, col, a in streaks:
            span = wid + length
            x = (x0 - loops * span * t / T) % span - length   # rushing past, right to left
            c = tuple(int(ch * a) for ch in col)
            lay.draw.line([(x, y), (x + length, y + (y - 560) * 0.05)], fill=c, width=3)
        return out + lay.out(2.5) * 1.2 * not_car[..., None]
    return f, dict(zoom=0.025, pan=(0, 0))


SCENES = {
    'garage': scene_garage,
    'gamer': scene_gamer,
    'gym': scene_gym,
    'watch': scene_watch,
    'trainer': scene_trainer,
    'synthwave': scene_synthwave,
}


def main():
    scene, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
    preview = sys.argv[5] if len(sys.argv) > 5 and sys.argv[4] == '--preview' else None
    img = load(src)
    f, cam = SCENES[scene](img)

    if preview:
        frames = [camera(f(t), t, **cam) for t in (0, T * 0.25, T * 0.5, T * 0.75)]
        sheet = Image.new('RGB', (W * 2, H * 2))
        for i, fr in enumerate(frames):
            sheet.paste(fr, ((i % 2) * W, (i // 2) * H))
        sheet.resize((W, H)).save(preview)
        return

    ff = subprocess.Popen([
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
        '-preset', 'slow', '-crf', '21', '-movflags', '+faststart', '-an', out,
    ], stdin=subprocess.PIPE)
    for i in range(N):
        ff.stdin.write(np.asarray(camera(f(i / FPS), i / FPS, **cam)).tobytes())
    ff.stdin.close()
    ff.wait()


if __name__ == '__main__':
    main()
