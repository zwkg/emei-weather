"""去掉 AI 生成图片右下角的「AI生成 / WORKBUDDY」水印。

ImageGen 出图自带右下角水印，且位置固定。这里不靠阈值去“猜”文字笔画
（半透明笔画的漏检会留下字影，甚至在填充时被复制扩散），而是直接把文字
所在的那一小块整体换掉，保证零残留：

1. 最近邻延展填充：用矩形外最近的真实像素逐层向内填，纹理连贯、颜色不跳
2. 块内轻高斯模糊：把延展出来的条纹化纹理抹成自然的虚化质感
3. 边缘羽化：矩形边缘保持原延展值，与周边像素完全接得上，看不出接缝

用法：
    python _strip_wm.py in.png out.jpg [--preview]
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

# 水印所在矩形（相对比例）
RX0, RY0, RX1, RY1 = 0.873, 0.928, 1.0, 1.0


def erase(a, x0, y0, x1, y1, sigma=4.0, feather=12):
    H, W, _ = a.shape
    out = a.copy()

    mask = np.zeros((H, W), bool)
    mask[y0:y1, x0:x1] = True
    # 最近邻延展：矩形内每个像素取最近的矩形外像素
    _, (iy, ix) = ndimage.distance_transform_edt(mask, return_indices=True)
    ys, xs = np.where(mask)
    out[ys, xs] = a[iy[ys, xs], ix[ys, xs]]

    # 块内轻模糊
    patch = out[y0:y1, x0:x1]
    blurred = ndimage.gaussian_filter(patch, sigma=(sigma, sigma, 0), mode="nearest")

    # 边缘羽化：距离边缘越近越保留延展原值（与外侧完全连续）
    h, w = patch.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.minimum.reduce([yy, xx, h - 1 - yy, w - 1 - xx]).astype(float)
    wgt = np.clip(dist / max(feather, 1), 0, 1)[..., None]
    out[y0:y1, x0:x1] = patch * (1 - wgt) + blurred * wgt
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    preview = "--preview" in sys.argv

    im = Image.open(src).convert("RGB")
    a = np.array(im).astype(np.float64)
    H, W, _ = a.shape

    x0, y0 = int(W * RX0), int(H * RY0)
    x1, y1 = W, H
    print("擦除矩形 x %d-%d (%.3f-%.3f)  y %d-%d (%.3f-%.3f)"
          % (x0, x1, x0 / W, x1 / W, y0, y1, y0 / H, y1 / H))

    out = erase(a, x0, y0, x1, y1)
    res = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    res.save(dst, "JPEG", quality=90, optimize=True, progressive=True)

    if preview:
        pad = 18
        cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
        cx1, cy1 = min(W, x1 + pad), min(H, y1 + pad)
        s = 3
        b = im.crop((cx0, cy0, cx1, cy1)).resize(((cx1 - cx0) * s, (cy1 - cy0) * s), Image.LANCZOS)
        c = res.crop((cx0, cy0, cx1, cy1)).resize(((cx1 - cx0) * s, (cy1 - cy0) * s), Image.LANCZOS)
        cmp_ = Image.new("RGB", (b.width * 2 + 14, b.height), (16, 18, 22))
        cmp_.paste(b, (0, 0))
        cmp_.paste(c, (b.width + 14, 0))
        p = dst.replace(".jpg", "_wmcheck.jpg")
        cmp_.save(p, "JPEG", quality=94)
        print("对比图:", p)


if __name__ == "__main__":
    main()
