/**
 * dsh-photo-skin · 言宝 —— 帧清单。
 *
 * 顺序规则：**按图片亮度从暗到亮排**。
 *   低档（off / low）配最暗的舞台照，高档（max）配最亮的棚拍白底照。
 *   滑块往右拉，整个界面从暗夜走到天亮 —— 和 DSH 原生白底在最高档对齐。
 *
 * 强度轴上有两类帧：
 *   1. 锚点（anchor）：九张原始素材 —— **当前只用这一层**；
 *   2. 过渡帧（transition）：相邻锚点之间由图编辑模型生成的中间态（当前关闭）。
 *
 * 文件命名约定（assets/ 下）：
 *   anchor    : 见 IMAGES[].file
 *   transition: transitions/t00-1.webp … t07-3.webp
 *               （t00 = 第 0 与第 1 个锚点之间，以此类推）
 */

import { MAX_FRAME } from "./logic.js";

/**
 * 九个锚点，**按平均亮度升序**。
 *
 * ⚠ 这个数组由 `scripts/prepare-images.py` 自动生成。
 *   手动修改会在下次运行脚本时被「合并」逻辑覆盖（同 file 名的项会被替换）。
 *   想换图请把原图放进 raw/，然后重新运行脚本 —— 见 README「换图」一节。
 */
export const IMAGES = [
  {
    file: "05-denim-night",
    lum: 42.4,
    label: "暮色初见",
    base: [42, 39, 30],
    accent: [113, 114, 83],
    veil: 0.45,
    focus: "center 30%",
  },
  {
    file: "03-stage-amber",
    lum: 52.2,
    label: "暖灯低语",
    // 均 52.2 · P50 34.7
    base: [22, 18, 28],
    accent: [214, 168, 108],
    veil: 0.32,
    focus: "center 26%",
  },
  {
    file: "09-sequin-violet",
    lum: 52.2,
    label: "碎光夜行",
    // 均 52.2 · P50 30.4 · P90 140.5
    base: [18, 18, 28],
    accent: [170, 176, 226],
    veil: 0.32,
    focus: "center 24%",
  },
  {
    file: "02-moon-blossom",
    lum: 90.4,
    label: "月下花影",
    // 均 90.4 · 中间调
    base: [14, 22, 38],
    accent: [186, 206, 236],
    veil: 0.34,
    focus: "center 30%",
  },
  {
    file: "08-camel-day",
    lum: 102.2,
    label: "沙白之昼",
    // 均 102.2 · 开始转亮
    base: [24, 24, 30],
    accent: [214, 196, 168],
    veil: 0.28,
    focus: "center 40%",
  },
  {
    file: "01-park-sage",
    lum: 109.9,
    label: "松荫素裙",
    // 均 109.9 · 明亮
    base: [22, 30, 22],
    accent: [168, 190, 138],
    veil: 0.24,
    focus: "center 22%",
  },
  {
    file: "04-studio-rose",
    lum: 117.2,
    label: "静室玫瑰",
    // 均 117.2 · P50 154.1 已偏亮
    base: [34, 24, 24],
    accent: [226, 172, 152],
    veil: 0.18,
    focus: "center 24%",
  },
  {
    file: "06-butterfly-mauve",
    lum: 127.7,
    label: "蝶与薄雾",
    // 均 127.7 · P50 147.5
    base: [32, 26, 30],
    accent: [212, 186, 196],
    veil: 0.14,
    focus: "center 22%",
  },
  {
    file: "10-new-singer",
    lum: 158.7,
    label: "晨光初上",
    // 均 158.7 · P50 167.5 —— 全场最亮（户外明亮场景）
    base: [30, 28, 26],
    accent: [214, 170, 176],
    veil: 0.10,
    focus: "center 26%",
  },

];

/**
 * 每对相邻锚点之间几张过渡帧。
 * 目前设为 0：只用九张原图，档位之间直接切换。
 * 想启用过渡帧时改成 3，并自行准备 assets/transitions/ 下的中间态图片。
 */
export const TRANSITIONS_PER_GAP = 0;

/** 资源地址前缀，安装时由 client.js 注入实际值。 */
let assetPrefix = "/plugins/dsh-photo-skin/assets/";

export function setAssetPrefix(prefix) {
  assetPrefix = prefix;
}

const anchorUrl = (name) => `${assetPrefix}${name}.webp`;
const transitionUrl = (gap, step) =>
  `${assetPrefix}transitions/${`t${String(gap).padStart(2, "0")}-${step}`}.webp`;

/**
 * 展开成完整的帧序列。
 *
 * @param {boolean} progressive 是否插入过渡帧
 */
export function buildFrames(progressive) {
  const frames = [];
  IMAGES.forEach((image, index) => {
    frames.push({
      url: anchorUrl(image.file),
      focus: image.focus,
      anchorIndex: index,
      tone: { base: image.base, accent: image.accent, veil: image.veil, lum: image.lum },
    });

    if (!progressive || index === IMAGES.length - 1) return;
    const next = IMAGES[index + 1];
    for (let step = 1; step <= TRANSITIONS_PER_GAP; step += 1) {
      const t = step / (TRANSITIONS_PER_GAP + 1);
      frames.push({
        url: transitionUrl(index, step),
        focus: lerpFocus(image.focus, next.focus, t),
        anchorIndex: index,
        tone: {
          base: mixRgb(image.base, next.base, t),
          accent: mixRgb(image.accent, next.accent, t),
          veil: image.veil + (next.veil - image.veil) * t,
          lum: image.lum + (next.lum - image.lum) * t,
        },
      });
    }
  });
  return frames;
}

const mixRgb = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** background-position 的百分比插值：只处理 "center NN%" 这种形式。 */
function lerpFocus(from, to, t) {
  const pattern = /^center\s+(\d+(?:\.\d+)?)%$/;
  const a = pattern.exec(from);
  const b = pattern.exec(to);
  if (a === null || b === null) return from;
  const y = Number(a[1]) + (Number(b[1]) - Number(a[1])) * t;
  return `center ${y.toFixed(1)}%`;
}

/** 当前生效的帧序列。presenter 与 slider 共用同一份。 */
let activeFrames = buildFrames(true);

/** 重新计算帧序列（切换「过渡帧」开关时调用）。 */
export function useProgressive(progressive) {
  activeFrames = buildFrames(progressive);
  return activeFrames;
}

/** 帧号(0..MAX_FRAME) -> 具体的帧。 */
export function frameSpec(frame) {
  if (activeFrames.length === 0) return null;
  const index = Math.min(
    activeFrames.length - 1,
    Math.max(0, Math.round((frame / MAX_FRAME) * (activeFrames.length - 1))),
  );
  return activeFrames[index];
}

/** 帧号 -> 插值后的情绪参数（配色用，比 frameSpec 更连续）。 */
export function toneAt(frame) {
  const frames = activeFrames;
  if (frames.length === 0) return { base: [20, 20, 26], accent: [200, 200, 220], veil: 0.4, lum: 60 };
  const scaled = (frame / MAX_FRAME) * (frames.length - 1);
  const from = Math.min(frames.length - 1, Math.floor(scaled));
  const to = Math.min(frames.length - 1, from + 1);
  const t = scaled - from;
  const a = frames[from].tone;
  const b = frames[to].tone;
  return {
    base: mixRgb(a.base, b.base, t),
    accent: mixRgb(a.accent, b.accent, t),
    veil: a.veil + (b.veil - a.veil) * t,
    lum: (a.lum ?? 60) + ((b.lum ?? 60) - (a.lum ?? 60)) * t,
  };
}

/** 方便 presenter 预加载：所有会出现的文件地址。 */
export function activeFrameUrls() {
  return activeFrames.map((frame) => frame.url);
}