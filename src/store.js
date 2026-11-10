/**
 * dsh-photo-skin —— 偏好存储。
 *
 * 参照「滑动变祖」的做法：一个带版本号的 localStorage 记录 + 订阅通知，
 * 设置页和滑块都从同一个快照渲染，跨标签页时靠 storage 事件同步。
 *
 * 与它不同的是：本插件的设置只影响外观，不涉及任何模型状态。
 */

import { MAX_FRAME } from "./logic.js";

const STORAGE_KEY = "dsh-photo-skin.settings.v1";

/** 所有可持久化的布尔开关。 */
const PERSISTENT_KEYS = [
  "enabled", // 总开关
  "bindEffort", // 滑块同时改模型思考档位
  "fineStops", // 细分：停在 9 个锚点而不是模型档位
  "hideSlider", // 隐藏输入框旁的滑块
  "grain", // 颗粒质感
  "particles", // 星尘粒子
  "motion", // 空闲淡化
  "mask", // 背景遮罩（对标滑动变祖）
  "takeoverLiang", // 与滑动变祖互斥
];

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  bindEffort: true,
  fineStops: true,
  hideSlider: false,
  grain: true,
  particles: true,
  motion: true,
  mask: true,
  takeoverLiang: true,
  /** 上次的强度（0..240）；null = 还没设过，跟随模型档位。 */
  frame: null,
  /**
   * 每个推理档位上次停在哪张图：{ [档位 id]: 帧号 }。
   * 从模型菜单换档时回到那一档上次选的图，而不是区间中点。
   */
  tierFrames: Object.freeze({}),
});

/** 校验 tierFrames；不合法的项丢掉，整体不是对象时返回 null。 */
function cleanTierFrames(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [id, frame] of Object.entries(value)) {
    if (typeof frame === "number" && Number.isFinite(frame) && frame >= 0 && frame <= MAX_FRAME) {
      out[id] = Math.round(frame);
    }
  }
  return out;
}

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 解析持久化记录；任何异常都退化成 null（用默认值）。 */
function parse(raw) {
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw);
    if (
      record === null ||
      typeof record !== "object" ||
      record.version !== 1 ||
      record.values === null ||
      typeof record.values !== "object"
    ) {
      return null;
    }
    const result = { ...DEFAULT_SETTINGS };
    for (const key of PERSISTENT_KEYS) {
      if (typeof record.values[key] === "boolean") result[key] = record.values[key];
    }
    /*
     * frame 是当前强度（0..240），单独校验：必须是有限数字且落在合法范围。
     * 它不是布尔开关，所以不在 PERSISTENT_KEYS 里。
     * 传 null 表示"用户还没手动设过"，由滑块按当前模型档位推导。
     */
    const storedFrame = record.values.frame;
    if (
      typeof storedFrame === "number" &&
      Number.isFinite(storedFrame) &&
      storedFrame >= 0 &&
      storedFrame <= MAX_FRAME
    ) {
      result.frame = Math.round(storedFrame);
    }
    const tierFrames = cleanTierFrames(record.values.tierFrames);
    if (tierFrames !== null) result.tierFrames = tierFrames;
    return result;
  } catch {
    return null;
  }
}

/**
 * 创建偏好存储。返回值与 React 的 useSyncExternalStore 直接兼容。
 *
 * @param {{storage?: Storage|null}} [options]
 */
export function createPreferenceStore(options = {}) {
  const storage = options.storage === undefined ? getStorage() : options.storage;
  let snapshot = parse(read(storage, STORAGE_KEY)) ?? { ...DEFAULT_SETTINGS };
  let disposed = false;
  const listeners = new Set();

  const emit = (patch) => {
    if (disposed) return;
    const changed = Object.entries(patch).some(([key, value]) => snapshot[key] !== value);
    if (!changed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const onStorage = (event) => {
    if (disposed) return;
    if (event.storageArea != null && event.storageArea !== storage) return;
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const next = parse(event.key === null ? read(storage, STORAGE_KEY) : event.newValue);
    emit(next ?? { ...DEFAULT_SETTINGS });
  };

  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

  const persist = (values) => {
    if (storage === null) throw new Error("Local settings storage is unavailable");
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, values }));
  };

  /**
   * 写设置。布尔开关必须在白名单里；frame 单独按数字校验。
   * 提到 return 外面，这样 setFrame 也能直接调。
   */
  const update = async (patch) => {
    if (disposed) return;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "frame") {
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
          throw new TypeError("Invalid photo-skin frame");
        }
        continue;
      }
      if (key === "tierFrames") {
        if (cleanTierFrames(value) === null) throw new TypeError("Invalid photo-skin tierFrames");
        continue;
      }
      if (!PERSISTENT_KEYS.includes(key) || typeof value !== "boolean") {
        throw new TypeError(`Invalid photo-skin setting: ${key}`);
      }
    }
    const changed = Object.entries(patch).some(([k, v]) => snapshot[k] !== v);
    if (!changed) return;
    const values = { ...snapshot, ...patch };
    persist(values);
    emit(patch);
  };

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    update,

    /** 只写强度（写 localStorage，不改动其它开关）。 */
    async setFrame(frame) {
      return update({ frame: frame === null ? null : Math.round(frame) });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    },
  };
}