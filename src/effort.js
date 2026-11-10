/**
 * dsh-photo-skin（言宝）—— 推理等级绑定。
 *
 * 完全对标「滑动变祖」的档位模型：
 *   - 档位**不写死**，直接读当前模型的 `reasoning.efforts`；
 *   - N 个档位均匀落在 0..MAX_FRAME 的强度轴上；
 *   - 拖动期间只做视觉预览，松手 / 键盘操作完成 / 失焦时才提交最近档位；
 *   - 提交走官方 ModelDirectory，失败时回退到上一次真实档位。
 *
 * 与「言宝」视觉轴的关系：
 *   视觉轴有 9 个锚点，模型可能只有 4 个档位（例如 off/low/high/max）。
 *   所以「细分」开关决定滑块停在哪套格点上：
 *     细分开（默认）→ 停在 9 个锚点，提交最近档位（外观细腻，模型档位仍准）
 *     细分关        → 只停在模型档位上（严格一档对一档）
 */
import { MAX_FRAME, clampFrame } from "./logic.js";
import { IMAGES } from "./frames.js";

/**
 * 九张图 → 四个推理档位的**分组权重**。
 *
 * 需求：off 管 1 张、low 管 2 张、high 管 3 张、max 管 3 张，
 * 图片顺序不动。这样「月下花影」正好落在 high（第 4 个锚点）。
 *
 * 为什么不用「N 档均匀铺满」：模型可能是 2/3/4/5 档，
 * 均匀铺会让每档覆盖的图片数量一样，无法表达"高档管更宽的区间"。
 * 所以改成按权重划分锚点归属。
 */
export const EFFORT_WEIGHTS = Object.freeze({
  off: 1,
  low: 2,
  high: 3,
  max: 3,
});

/** 锚点总数从图片清单推导，改图数量时不用同步改这里。 */
const TOTAL_ANCHORS = IMAGES.length;

/**
 * 把锚点按权重分给各档位。
 *
 * @param {number} count 档位数量（模型实际给了几档）
 * @returns {Array<{start:number, end:number}>} 每个档位覆盖的锚点区间 [start, end]
 */
export function anchorRanges(count) {
  if (count <= 0) return [];
  if (count === 1) return [{ start: 0, end: TOTAL_ANCHORS - 1 }];

  /*
   * 标准四档用 EFFORT_WEIGHTS 的权重（1/2/3/3），这是产品要求。
   * 非四档时按比例缩放权重，保持"高档管更宽"的形状。
   */
  const standard = [EFFORT_WEIGHTS.off, EFFORT_WEIGHTS.low, EFFORT_WEIGHTS.high, EFFORT_WEIGHTS.max];
  // 把 4 份权重映射到 count 份：少于 4 档就合并，多于 4 档就再切分
  const weights = [];
  if (count === 4) {
    weights.push(...standard);
  } else if (count < 4) {
    // 例：2 档 → off+low / high+max 合并
    const per = 4 / count;
    for (let i = 0; i < count; i += 1) {
      let w = 0;
      for (let k = Math.floor(i * per); k < Math.floor((i + 1) * per); k += 1) w += standard[k];
      weights.push(w);
    }
  } else {
    // 多于 4 档：标准权重基础上，把每档再按锚点数均分
    const extra = count - 4;
    for (let i = 0; i < 4; i += 1) {
      const split = i < extra ? 2 : 1;
      const each = standard[i] / split;
      for (let k = 0; k < split; k += 1) weights.push(each);
    }
  }

  /*
   * 档位数可能**多于锚点数**（某些模型给 10+ 档）。这时候必然有档位分不到
   * 独立的图，只能共享同一个锚点 —— 否则循环越界会算出 NaN，整个分组崩掉。
   * 处理：先把 9 个锚点铺满，剩下的档位复用最后一个锚点。
   */
  const slots = Math.min(count, TOTAL_ANCHORS);
  const ranges = [];
  let cursor = 0;
  for (let i = 0; i < slots; i += 1) {
    const remaining = slots - i;
    const left = TOTAL_ANCHORS - cursor;
    const ideal = (weights[i] / (weights.slice(0, slots).reduce((a, b) => a + b, 0) || 1)) * TOTAL_ANCHORS;
    let take = i === slots - 1 ? left : Math.round(ideal);
    // 每档至少 1 个锚点，且要留够后面的档位
    take = Math.max(1, Math.min(take, left - (remaining - 1)));
    ranges.push({ start: cursor, end: cursor + take - 1 });
    cursor += take;
  }
  // 档位多于锚点：剩余档位共享最后一个锚点
  for (let i = slots; i < count; i += 1) {
    ranges.push({ start: TOTAL_ANCHORS - 1, end: TOTAL_ANCHORS - 1 });
  }
  return ranges;
}

/**
 * 模型档位在强度轴上的位置（该档位区间的**中心**）。
 *
 * 刻度线画在这里，滑块吸到这里，两者用同一个函数算，天然对齐。
 */
export function frameForEffort(index, count, ranges) {
  if (count <= 1 || !Number.isFinite(index)) return 0;
  const safe = Math.min(count - 1, Math.max(0, Math.round(index)));
  const r = (ranges ?? anchorRanges(count))[safe];
  if (r === undefined) return 0;
  // 区间的中点（以锚点格为单位）
  const mid = (r.start + r.end) / 2;
  return Math.round((mid / (TOTAL_ANCHORS - 1)) * MAX_FRAME);
}

/**
 * 档位区间最后一张图的帧号。
 * 细分模式下从模型菜单换到一个还没选过图的档位时停在这里（每档最亮的那张）。
 */
export function lastFrameForEffort(index, count, ranges) {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  const safe = Math.min(count - 1, Math.max(0, Math.round(index)));
  const r = (ranges ?? anchorRanges(count))[safe];
  if (r === undefined) return 0;
  return Math.round((r.end / (TOTAL_ANCHORS - 1)) * MAX_FRAME);
}

/** 帧号落在哪个档位区间里。 */
export function effortIndexAt(frame, count, ranges) {
  const rs = ranges ?? anchorRanges(count);
  if (rs.length === 0) return -1;
  // 换算成锚点格
  const anchor = (clampFrame(frame) / MAX_FRAME) * (TOTAL_ANCHORS - 1);
  for (let i = 0; i < rs.length; i += 1) {
    // 相邻区间共享分界线：用中点判断归属
    const mid = (rs[i].start + rs[i].end) / 2;
    const next = i + 1 < rs.length ? (rs[i + 1].start + rs[i + 1].end) / 2 : Infinity;
    if (anchor < (mid + next) / 2) return i;
  }
  return rs.length - 1;
}

/**
 * 当前帧属于第几档。
 *
 * 注意：这里用**区间归属**而不是「离哪个刻度最近」。
 * 因为一个档位可能覆盖 3 张图（比如 max 管 6/7/8 三个锚点），
 * 用最近刻度的话滑到第 6 个锚点就会误判成 low。
 */
export function nearestEffortIndex(frame, efforts) {
  if (efforts.length === 0) return -1;
  return effortIndexAt(frame, efforts.length);
}

/** 从模型状态里找出当前选中的是第几档。 */
export function selectedEffortIndex(efforts, selectedId, defaultId) {
  const id = selectedId ?? defaultId;
  return id === undefined ? -1 : efforts.findIndex((effort) => effort.id === id);
}

/**
 * 从 ModelDirectory 的快照里读出当前模型与它的档位。
 *
 * 结构来自 @deepseek-ai/dsh-client-ui-model-selection：
 *   { current: {provider, model, reasoningEffort}, groups: [{id, models:[{id, reasoning:{efforts, defaultEffort}}]}] }
 *
 * @returns {null | {selection: object, efforts: Array<{id,name}>, defaultEffort?: string}}
 */
export function modelReasoning(state) {
  const current = state?.current;
  if (current === null || current === undefined) return null;
  const group = state.groups?.find((item) => item.id === current.provider);
  const model = group?.models?.find((item) => item.id === current.model);
  const reasoning = model?.reasoning;
  if (reasoning === undefined || !Array.isArray(reasoning.efforts)) return null;
  return {
    selection: current,
    efforts: reasoning.efforts,
    defaultEffort: reasoning.defaultEffort,
  };
}

/**
 * 提交意图的去重器。
 *
 * 起因：提交后 ModelDirectory 的 store 会先进入 selecting、再给出新快照。
 * 如果不等提交落地就跟着外部快照走，滑块会在「用户拖到的位置」和
 * 「服务端还没确认的旧档位」之间来回弹一下。
 *
 * 所以记住最近一次提交的目标 key，等它真的出现在快照里再恢复同步。
 */
export function createEffortSync() {
  let observedKey = null;
  let submitted = null;

  return {
    /** 记下这次要提交到哪个档位。 */
    submit(key) {
      submitted = key;
    },

    reset() {
      submitted = null;
    },

    /**
     * 看到一个外部快照。
     * @returns {number|null} 需要把滑块挪到的帧号；null 表示不用动
     */
    observe({ key, frame }) {
      if (submitted !== null) {
        if (submitted === key) {
          // 提交落地的快照回来了，恢复跟踪
          submitted = null;
          observedKey = key;
        }
        return null;
      }
      if (observedKey === key) return null;
      observedKey = key;
      return frame;
    },
  };
}

/** 滑块该吸到哪个帧：细分模式吸锚点，否则吸模型档位。 */
export function snapTarget(frame, { efforts, fine }) {
  if (fine || efforts.length < 2) {
    // N 个锚点 = N-1 个间隔，均匀铺满 0..MAX_FRAME
    const gaps = TOTAL_ANCHORS - 1;
    return Math.round((clampFrame(frame) / MAX_FRAME) * gaps) * (MAX_FRAME / gaps);
  }
  return frameForEffort(nearestEffortIndex(frame, efforts), efforts.length);
}

/** tooltip 文案：档位名 + 模型档位名。 */
export function indicatorLabel(frame, efforts, { withLevel }) {
  const gaps = TOTAL_ANCHORS - 1;
  const anchorIndex = Math.min(gaps, Math.round((clampFrame(frame) / MAX_FRAME) * gaps));
  const level = `${anchorIndex + 1}/${TOTAL_ANCHORS}`;
  const effort = efforts[nearestEffortIndex(frame, efforts)];
  const head = withLevel ? level : level;
  return effort === undefined ? head : `${head} · ${effort.name}`;
}