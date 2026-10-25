"""从一张 AI 原创底图出发，用代码合成出各种天气版本。

背景：之前 6 张天气图是用原摄影照片做图生图改的，属于原照片的「改编作品」，
仍有版权关联。现在底图换成 AI 纯原创生成的一张，其余天气全部用代码合成
（调色 + 程序生成的云、雨丝、雪花、闪电），既零成本，也彻底断开与原照片
的派生关系。

用法：
    python _weathers.py 源图.jpg 输出目录
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

SKY_END = 0.235      # 天空区在画面中的相对高度


# ---------- 基底工具 ----------

def to_arr(im):
    return np.array(im.convert("RGB")).astype(np.float64)


def to_img(a):
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def luma(a):
    return a.mean(axis=2)


def desaturate(a, amount):
    """amount=0 保持原样，1 完全灰度"""
    g = luma(a)[..., None]
    return a * (1 - amount) + g * amount


def adjust(a, bright=1.0, sat=1.0, contrast=1.0, tint=None, tint_amt=0.0):
    out = a * bright
    g = luma(out)[..., None]
    out = g + (out - g) * sat
    m = out.mean()
    out = (out - m) * contrast + m
    if tint is not None and tint_amt > 0:
        t = np.array(tint, dtype=np.float64)[None, None, :]
        out = out * (1 - tint_amt) + t * tint_amt
    return out


def sky_mask(h, w, end=SKY_END, soft=0.10):
    """天空权重：上部高，下部渐隐。"""
    yy = np.linspace(0, 1, h)
    m = np.clip((end + soft - yy) / soft, 0, 1)
    return np.repeat(m[:, None], w, axis=1)


def gold_mask(a):
    """金色主体（佛像、配殿）掩膜。

    天气处理要去饱和、压暗、叠白雾，但画面里唯一的暖色就是这尊金佛，
    一起被洗掉就只剩灰糊一片。所以单独把金色区域留出来，最后混回去。
    """
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mx = a.max(axis=2)
    sat = mx - a.min(axis=2)
    m = ((r > g + 18) & (g > b + 12) & (sat > 42) & (mx > 105)).astype(np.float64)
    m = ndimage.gaussian_filter(m, 2.0)
    return np.clip(m * 1.6, 0, 1)


def restore_gold(src, out, strength=0.72):
    """把原图的金色区域按掩膜混回处理结果。"""
    g = gold_mask(src)[..., None]
    return out * (1 - g * strength) + src * (g * strength)


def overlay_color(a, color, mask):
    """按 mask 权重把 color 叠上去。"""
    c = np.array(color, dtype=np.float64)[None, None, :]
    return a * (1 - mask[..., None]) + c * mask[..., None]


def soft_noise(h, w, scale=9, seed=0, octaves=3):
    """低频噪声（值域 0..1），用来生成云斑。"""
    rng = np.random.default_rng(seed)
    acc = np.zeros((h, w))
    amp = 1.0
    total = 0.0
    for o in range(octaves):
        s = max(2, int(scale / (2 ** o)))
        small = rng.random((s, int(s * w / h) + 1))
        up = np.array(Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)) / 255.0
        acc += up * amp
        total += amp
        amp *= 0.5
    acc /= total
    acc -= acc.min()
    acc /= max(acc.max(), 1e-6)
    return acc


# ---------- 天气合成 ----------

def w_sun(a):
    return a


def w_partly(a):
    h, w = a.shape[:2]
    out = adjust(a, bright=1.04, sat=1.10, contrast=1.02)
    # 天空加几团柔和白云：两个尺度叠加，边界更碎
    n = soft_noise(h, w, scale=4, seed=11) * 0.62 + soft_noise(h, w, scale=9, seed=29) * 0.38
    cloud = np.clip((n - 0.50) / 0.20, 0, 1) ** 1.15
    cloud = cloud * sky_mask(h, w, 0.34, soft=0.16)
    out = overlay_color(out, (253, 253, 255), cloud * 0.90)
    return restore_gold(a, out, 0.80)


def w_cloud(a):
    h, w = a.shape[:2]
    out = adjust(a, bright=0.90, sat=0.42, contrast=0.94,
                 tint=(168, 172, 178), tint_amt=0.30)
    # 天空压成均匀灰层
    sm = sky_mask(h, w, 0.40, soft=0.22)
    out = overlay_color(out, (150, 154, 160), sm * 0.72)
    return restore_gold(a, out, 0.82)


def w_fog(a):
    h, w = a.shape[:2]
    out = adjust(a, bright=1.02, sat=0.55, contrast=0.82)
    # 雾从下往上更浓（云海翻上山顶的感觉）
    yy = np.linspace(0, 1, h)[:, None]
    m = 0.22 + 0.46 * np.exp(-((yy - 0.40) ** 2) / (2 * 0.24 ** 2))
    m = np.repeat(m, w, axis=1)
    out = overlay_color(out, (238, 242, 245), m * 0.70)
    # 远处再糊一层
    blurred = np.array(to_img(out).filter(ImageFilter.GaussianBlur(3.2))).astype(np.float64)
    out = blurred * 0.35 + out * 0.65
    return restore_gold(a, out, 0.78)


def w_rain(a):
    h, w = a.shape[:2]
    out = adjust(a, bright=0.82, sat=0.52, contrast=1.04,
                 tint=(96, 112, 128), tint_amt=0.28)
    sm = sky_mask(h, w, 0.40, soft=0.20)
    out = overlay_color(out, (72, 84, 98), sm * 0.62)
    # 雨丝：短、淡、角度分散，避免变成规则划痕
    rng = np.random.default_rng(7)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(760):
        x = rng.uniform(-40, w)
        y = rng.uniform(0, h)
        ln = rng.uniform(14, 46)
        d.line([(x, y), (x - ln * rng.uniform(0.15, 0.42), y + ln)],
               fill=(212, 224, 236, int(rng.uniform(16, 52))), width=1)
    rain_img = to_img(out).convert("RGB")
    rain_img.paste(layer, (0, 0), layer)
    out = np.array(rain_img).astype(np.float64)
    # 地面湿反光：下半部略微提亮对比
    yy = np.linspace(0, 1, h)[:, None]
    wet = np.clip((yy - 0.60) / 0.25, 0, 1)
    wet = np.repeat(wet, w, axis=1)
    out = out * (1 - wet[..., None] * 0.14) + (out * 0.55 + 40) * (wet[..., None] * 0.14)
    return restore_gold(a, out, 0.72)


def w_snow(a):
    h, w = a.shape[:2]
    out = adjust(a, bright=1.06, sat=0.62, contrast=0.90,
                 tint=(196, 212, 228), tint_amt=0.26)
    sm = sky_mask(h, w, 0.36, soft=0.18)
    out = overlay_color(out, (206, 216, 228), sm * 0.60)
    # 雪：多层不同大小
    rng = np.random.default_rng(23)
    for n, (cnt, rmin, rmax, amax) in enumerate([
            (900, 1, 2, 110), (380, 2, 3, 150), (130, 3, 6, 195)]):
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for _ in range(cnt):
            x = rng.uniform(0, w)
            y = rng.uniform(0, h)
            r = rng.uniform(rmin, rmax)
            d.ellipse([x - r, y - r, x + r, y + r],
                      fill=(255, 255, 255, int(rng.uniform(90, amax))))
        si = to_img(out).convert("RGB")
        si.paste(layer, (0, 0), layer)
        out = np.array(si).astype(np.float64)
    # 屋檐/台阶积雪：下半部偏白
    yy = np.linspace(0, 1, h)[:, None]
    snow = np.clip((yy - 0.72) / 0.28, 0, 1)
    snow = np.repeat(snow, w, axis=1)
    out = out * (1 - snow[..., None] * 0.10) + 236 * (snow[..., None] * 0.10)
    return restore_gold(a, out, 0.76)


def w_thunder(a):
    h, w = a.shape[:2]
    out = adjust(a, bright=0.62, sat=0.48, contrast=1.10,
                 tint=(86, 74, 112), tint_amt=0.36)
    sm = sky_mask(h, w, 0.44, soft=0.22)
    out = overlay_color(out, (44, 40, 62), sm * 0.70)
    # 闪电：细主干 + 树枝分叉 + 强辉光
    rng = np.random.default_rng(41)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(2):
        x = rng.uniform(w * 0.18, w * 0.82)
        y = rng.uniform(-h * 0.05, h * 0.08)
        pts = [(x, y)]
        while y < h * 0.56:
            y += rng.uniform(46, 96)
            x += rng.uniform(-22, 22)
            pts.append((x, y))
        # 辉光层
        d.line(pts, fill=(226, 232, 255, 90), width=8)
        # 主干
        d.line(pts, fill=(255, 251, 226, 235), width=2)
        # 树枝分叉
        for i in range(2, len(pts) - 1):
            if rng.random() < 0.45:
                bx, by = pts[i]
                ex = bx + rng.uniform(-70, 70)
                ey = by + rng.uniform(20, 70)
                d.line([(bx, by), (ex, ey)], fill=(255, 248, 214, 150), width=1)
    glow = layer.filter(ImageFilter.GaussianBlur(11))
    base = to_img(out).convert("RGB")
    base.paste(glow, (0, 0), glow)
    base.paste(layer, (0, 0), layer)
    out = np.array(base).astype(np.float64)
    # 密雨
    rl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(rl)
    for _ in range(1100):
        x = rng.uniform(-70, w)
        y = rng.uniform(0, h)
        ln = rng.uniform(30, 88)
        d.line([(x, y), (x - ln * 0.30, y + ln)],
               fill=(200, 212, 228, int(rng.uniform(25, 65))), width=1)
    tl = to_img(out).convert("RGB")
    tl.paste(rl, (0, 0), rl)
    out = np.array(tl).astype(np.float64)
    return restore_gold(a, out, 0.60)


WEATHERS = [
    ("sun", w_sun),
    ("partly", w_partly),
    ("cloud", w_cloud),
    ("fog", w_fog),
    ("rain", w_rain),
    ("snow", w_snow),
    ("thunder", w_thunder),
]


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    im = Image.open(src).convert("RGB")
    a = to_arr(im)
    print("源图 %dx%d" % im.size)
    for name, fn in WEATHERS:
        out = fn(a.copy())
        p = os.path.join(outdir, name + ".jpg")
        to_img(out).save(p, "JPEG", quality=90, optimize=True, progressive=True)
        print("  %-8s %6d KB" % (name, os.path.getsize(p) // 1024))


if __name__ == "__main__":
    main()
