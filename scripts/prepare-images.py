#!/usr/bin/env python3
"""言宝皮肤 —— 图片处理器。

把任意格式的图片批量转换成皮肤能用的 WebP，算好亮度，并重写
`src/frames.js` 的 IMAGES 数组。

支持格式（靠 macOS 自带的 sips 解码）：
    HEIC / HEIF / TIFF / BMP / JPEG / PNG / WebP / AVIF

用法
────
    # 最简：把图放进 raw/，直接跑
    python3 scripts/prepare-images.py

    # 指定输入目录
    python3 scripts/prepare-images.py --input ~/Pictures/skin

    # 只替换某几张（按 raw/ 里的文件名匹配已有的 file 名）
    python3 scripts/prepare-images.py --replace

    # 预览会做什么，但不写任何文件
    python3 scripts/prepare-images.py --dry-run

输出
────
    assets/<slug>.webp      每张图一个文件
    src/frames.js           重写 IMAGES 数组（保留数组外的所有代码与注释）

命名规则
────────
    raw/ 里的文件名会被 slug 化成 `<序号>-<名字>`，例如
        raw/月光下的她.jpg  →  assets/01-月光下的她.webp
    序号按亮度排序后重新编号，所以改名不影响最终顺序。

    `--replace` 模式下不重新编号：file 名沿用清单里已有的名字，
    只把新图内容替换进去，顺序保持不变。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ModuleNotFoundError:
    sys.exit("缺少 Pillow。请运行： python3 -m pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FRAMES = ROOT / "src" / "frames.js"
RAW = ROOT / "raw"

# ── 可调参数 ────────────────────────────────────────────────────────────────
# 输出尺寸：缩到「刚好能铺满 1600×1000 窗口的 2 倍屏」为止，不放大原图。
#
# 照片用 background-size: cover 铺满横向窗口，竖图是按**宽度**放大的。
# 之前按「长边 2400」压，竖图只剩 1600 宽，在 Retina 屏上被放大 2 倍，
# 这是照片发糊的主要原因。所以限制的是宽和高的下限，而不是长边上限。
TARGET_WIDTH = 3200
TARGET_HEIGHT = 2000
QUALITY = 82             # WebP 质量
MIN_IMAGES = 2           # 少于一档没法分组
MAX_IMAGES = 24          # 多于这个数预加载压力大，且滑块的档位会过密

# 允许的输入扩展名（sips 能读的）
INPUT_EXTS = {
    ".heic", ".heif", ".tif", ".tiff", ".bmp", ".jpg", ".jpeg",
    ".png", ".webp", ".avif", ".gif",
}


@dataclass
class Entry:
    """一张图在清单里的完整描述。"""
    file: str                     # assets/ 下的文件名（不含扩展名）
    label: str                    # 显示名
    lum: float                    # 平均亮度 0..255
    base: list[int]
    accent: list[int]
    veil: float
    focus: str
    # 未替换项保留的原始 JS 片段（不为 None 时原样写回）
    raw_js: str | None = None

    def as_js(self) -> str:
        """渲染成 frames.js 里的一项；有原始片段时原样返回。"""
        if self.raw_js is not None:
            return self.raw_js
        base = ", ".join(str(v) for v in self.base)
        accent = ", ".join(str(v) for v in self.accent)
        return (
            "  {\n"
            f'    file: "{self.file}",\n'
            f"    lum: {self.lum},\n"
            f'    label: "{self.label}",\n'
            f"    base: [{base}],\n"
            f"    accent: [{accent}],\n"
            f"    veil: {self.veil},\n"
            f'    focus: "{self.focus}",\n'
            "  },"
        )


# ── 颜色与亮度 ──────────────────────────────────────────────────────────────
def luminance(rgb: tuple[int, int, int]) -> float:
    """感知亮度 0..255。"""
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def dominant_colors(img: Image.Image, count: int) -> list[tuple[int, int, int]]:
    """取图片的主色，按占比从高到低返回。"""
    small = img.convert("RGB").copy()
    small.thumbnail((120, 120), Image.LANCZOS)
    quantized = small.quantize(colors=max(2, count), method=Image.MEDIANCUT).convert("RGB")
    counted = quantized.getcolors(small.width * small.height) or []
    counted.sort(reverse=True)
    return [rgb for _, rgb in counted[:count]]


def derive_entry(slug: str, label: str, img: Image.Image) -> Entry:
    """由图片本身推导配色参数。

    规则（与皮肤运行时的 deriveTone 保持一致的思路）：
      - base  取最暗的主色，作为面板底色基调
      - accent 取饱和度最高的那块，作强调色
      - veil  由亮度决定：越亮的图需要越强的遮罩
    """
    colors = dominant_colors(img, 8)
    if not colors:
        colors = [(20, 20, 24)]

    def saturation(c: tuple[int, int, int]) -> float:
        mx, mn = max(c), min(c)
        return (mx - mn) / mx if mx else 0.0

    # base：面板底色基调。不能取"最暗主色"—— 纯黑面板会让深色模式的
    # 文字失去层次（实测对比度掉到 2.3）。抬到 18..52 的亮度区间。
    candidates = [c for c in colors if luminance(c) < 150] or colors
    base = max(candidates, key=lambda c: saturation(c) * 0.5 + (1 - luminance(c) / 255) * 0.5)
    base_lum = luminance(base)
    if base_lum < 18:
        base = tuple(min(255, round(v + (18 - base_lum))) for v in base)
    elif base_lum > 52:
        scale = 52 / base_lum
        base = tuple(round(v * scale) for v in base)

    accent = max(colors, key=saturation)
    # 强调色太暗时提亮一点，否则浅色主题下看不见
    if luminance(accent) < 90:
        accent = tuple(min(255, int(v * 1.45 + 25)) for v in accent)

    # 全图亮度决定遮罩浓度
    small = img.convert("RGB").copy()
    small.thumbnail((160, 160), Image.LANCZOS)
    arr = np.asarray(small, dtype=np.float32)
    avg = float(
        (0.2126 * arr[:, :, 0] + 0.7152 * arr[:, :, 1] + 0.0722 * arr[:, :, 2]).mean()
    )

    # 亮图遮罩淡一些（本来就是浅色背景），暗图稍强
    veil = round(max(0.14, min(0.46, 0.46 - (avg - 40) * 0.0022)), 2)

    return Entry(
        file=slug,
        label=label,
        lum=round(avg, 1),
        base=list(base),
        accent=list(accent),
        veil=veil,
        focus="center 30%",
    )


# ── 图片转换 ────────────────────────────────────────────────────────────────
def slugify(name: str) -> str:
    """把文件名变成安全的 slug（保留中文，去掉特殊字符）。"""
    stem = Path(name).stem
    # 只保留字母数字、中文、连字符和下划线
    cleaned = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", stem, flags=re.UNICODE)
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-_")
    return cleaned or "image"


def convert(src: Path, dest: Path) -> Image.Image:
    """用 sips 把任意格式转成临时 PNG，再用 Pillow 存成 WebP。

    为什么两步走：浏览器和 Pillow 都不能直接解 HEIC，
    而 macOS 的 sips 可以。中转一次 PNG 是无损的。
    """
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "converted.png"
        # sips 也能读 jpeg/png，统一走一遍保证色彩空间一致
        result = subprocess.run(
            ["sips", "-s", "format", "png", str(src), "--out", str(png)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not png.exists():
            raise RuntimeError(f"sips 转换失败：{src.name}\n{result.stderr.strip()}")
        img = Image.open(png).convert("RGB")

    # 缩到宽 ≥ TARGET_WIDTH 且高 ≥ TARGET_HEIGHT 的最小尺寸；原图更小就不动
    scale = max(TARGET_WIDTH / img.width, TARGET_HEIGHT / img.height)
    if scale < 1:
        img = img.resize(
            (round(img.width * scale), round(img.height * scale)), Image.LANCZOS
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, "WEBP", quality=QUALITY, method=6)
    return img


# ── frames.js 读写 ─────────────────────────────────────────────────────────
ARRAY_START = "export const IMAGES = ["
ARRAY_END = "\n];"


def read_existing_entries() -> list[dict]:
    """从 frames.js 里读出当前的 IMAGES（只取 file / label 够用）。"""
    if not FRAMES.exists():
        return []
    src = FRAMES.read_text(encoding="utf-8")
    start = src.find(ARRAY_START)
    end = src.find(ARRAY_END, start)
    if start < 0 or end < 0:
        return []
    body = src[start + len(ARRAY_START): end]

    entries = []
    # 每个对象块：{ ... }。保留原始片段，--replace 时未改动的项原样写回。
    for block in re.finditer(r"\{([^{}]*)\}", body):
        inner = block.group(1)
        file_m = re.search(r'file:\s*"([^"]+)"', inner)
        label_m = re.search(r'label:\s*"([^"]+)"', inner)
        if not file_m:
            continue
        entries.append({
            "file": file_m.group(1),
            "label": label_m.group(1) if label_m else file_m.group(1),
            "raw": "  {\n" + "\n".join(
                "    " + line.strip() for line in inner.strip().splitlines()
            ) + "\n  },",
            # 保留原有字段，便于提示
            "lum": float(m.group(1)) if (m := re.search(r"lum:\s*([\d.]+)", inner)) else 0.0,
        })
    return entries


def write_entries(entries: list[Entry]) -> None:
    """只替换 IMAGES 数组，保留文件里其余所有内容。"""
    src = FRAMES.read_text(encoding="utf-8")
    start = src.find(ARRAY_START)
    end = src.find(ARRAY_END, start)
    if start < 0 or end < 0:
        raise SystemExit(
            f"在 {FRAMES} 里找不到 IMAGES 数组。\n"
            f'期望以 `{ARRAY_START}` 开头、以 `];` 结尾。'
        )

    body = "\n" + "\n".join(e.as_js() for e in entries) + "\n"
    updated = src[:start + len(ARRAY_START)] + body + src[end:]
    FRAMES.write_text(updated, encoding="utf-8")


# ── 主流程 ─────────────────────────────────────────────────────────────────
def collect_inputs(folder: Path) -> list[Path]:
    if not folder.is_dir():
        raise SystemExit(f"输入目录不存在：{folder}")
    files = [
        p for p in sorted(folder.iterdir())
        if p.is_file() and p.suffix.lower() in INPUT_EXTS and not p.name.startswith(".")
    ]
    if not files:
        raise SystemExit(
            f"{folder} 里没有可用的图片。\n"
            f"支持的格式：{', '.join(sorted(INPUT_EXTS))}"
        )
    return files


def main() -> None:
    parser = argparse.ArgumentParser(
        description="把图片转换成言宝皮肤可用的 WebP，并重写 IMAGES 清单。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--input", type=Path, default=RAW, help="原图目录（默认 raw/）")
    parser.add_argument("--assets", type=Path, default=ASSETS, help="输出目录（默认 assets/）")
    parser.add_argument(
        "--replace", action="store_true",
        help="按文件名匹配现有清单，只替换对应的图，不重新编号",
    )
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不写文件")
    parser.add_argument(
        "--keep-extra", action="store_true",
        help="保留 assets/ 里未被清单引用的旧图（默认会清掉本次未生成的 webp）",
    )
    args = parser.parse_args()

    sources = collect_inputs(args.input)
    floor = 1 if args.replace else MIN_IMAGES
    if len(sources) < floor:
        raise SystemExit(f"至少需要 {floor} 张图，当前只有 {len(sources)} 张。")
    if not args.replace and len(sources) > MAX_IMAGES:
        raise SystemExit(
            f"最多支持 {MAX_IMAGES} 张图，当前有 {len(sources)} 张。\n"
            f"多于 {MAX_IMAGES} 张会让滑块的档位过密，也会拖慢首屏。"
        )

    existing = read_existing_entries()
    print(f"输入：{args.input}  （{len(sources)} 张）")
    print(f"现有清单：{len(existing)} 项")
    if args.replace:
        print("模式：替换（按文件名匹配，保持原有顺序与编号）")
    print()

    # 转换 + 推导
    prepared: list[tuple[Path, Image.Image, str]] = []
    for src in sources:
        print(f"  处理 {src.name} ...", end=" ", flush=True)
        slug = slugify(src.name)
        with tempfile.TemporaryDirectory() as tmp:
            probe = Path(tmp) / "probe.webp"
            img = convert(src, probe)
        print(f"{img.size[0]}×{img.size[1]}", flush=True)
        prepared.append((src, img, slug))

    # 按亮度排序（暗 → 亮）
    prepared.sort(key=lambda item: derive_entry(item[2], item[2], item[1]).lum)

    # 组装条目
    if args.replace and existing:
        # 按 slug 匹配；**未匹配的项原样保留**，只更新匹配到的
        by_slug = {slug: img for _, img, slug in prepared}
        entries = []
        updated, kept = [], []
        for old in existing:
            img = by_slug.get(old["file"])
            if img is not None:
                # 用新图重新推导，但沿用原来的 file / label
                entries.append(derive_entry(old["file"], old["label"], img))
                updated.append(old["file"])
            else:
                # 没有新图 → 原样保留（raw_js 让它按原片段写回）
                entries.append(Entry(
                    file=old["file"], label=old["label"], lum=old["lum"],
                    base=[0, 0, 0], accent=[0, 0, 0], veil=0.0, focus="center 30%",
                    raw_js=old["raw"],
                ))
                kept.append(old["file"])

        if not updated:
            raise SystemExit(
                "--replace 没有匹配到任何图。\n"
                f"清单里的名字：{', '.join(e['file'] for e in existing)}\n"
                f"raw/ 里的名字：{', '.join(s for _, _, s in prepared)}\n"
                "提示：把原图改名成与清单相同的名字（如 05-denim-night.jpg）。"
            )
        print(f"\n替换 {len(updated)} 张：{', '.join(updated)}")
        if kept:
            print(f"保留未改动 {len(kept)} 张：{', '.join(kept)}")

    else:
        entries = [
            derive_entry(f"{i:02d}-{slug}", slug, img)
            for i, (src, img, slug) in enumerate(prepared, start=1)
        ]

    # 打印计划
    print("\n生成的清单（按亮度升序）：")
    print(f"  {'#':>2}  {'file':<28} {'亮度':>6}  label")
    for i, e in enumerate(entries, start=1):
        print(f"  {i:>2}  {e.file:<28} {e.lum:>6}  {e.label}")

    if args.dry_run:
        print("\n--dry-run：未写入任何文件。")
        return

    # 写文件
    written = []
    if args.replace and existing:
        by_slug = {slug: img for _, img, slug in prepared}
        for e in entries:
            img = by_slug.get(e.file)
            if img is None:
                continue          # 未替换的图保留原文件，不重写
            dest = args.assets / f"{e.file}.webp"
            dest.parent.mkdir(parents=True, exist_ok=True)
            img.save(dest, "WEBP", quality=QUALITY, method=6)
            written.append(dest)
    else:
        for (src, img, slug), e in zip(
            sorted(prepared, key=lambda x: derive_entry(x[2], x[2], x[1]).lum), entries
        ):
            dest = args.assets / f"{e.file}.webp"
            dest.parent.mkdir(parents=True, exist_ok=True)
            img.save(dest, "WEBP", quality=QUALITY, method=6)
            written.append(dest)

    # 清理未引用的旧图
    if not args.keep_extra:
        keep = {f"{e.file}.webp" for e in entries}
        removed = 0
        for old in args.assets.glob("*.webp"):
            if old.name not in keep:
                old.unlink()
                removed += 1
        if removed:
            print(f"\n清理了 {removed} 张不再引用的旧图。")

    write_entries(entries)

    print(f"\n✓ 写入 {len(written)} 张 WebP 到 {args.assets}")
    print(f"✓ 更新 {FRAMES.relative_to(ROOT)}")
    print("\n下一步：")
    print("  node scripts/build.mjs")
    print("  然后在 DSH 里硬刷新（Ctrl+Shift+R / Cmd+Shift+R）")


if __name__ == "__main__":
    main()