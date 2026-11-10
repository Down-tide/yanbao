/**
 * dsh-photo-skin（言宝）—— 与「滑动变祖」的互斥。
 *
 * 为什么需要这一层
 * ────────────────
 * 两个插件都改同一批 --dsw-* 主题变量、都注册 conversation.input.right，
 * 同时开启会并排出现两个滑块、两套配色互相覆盖（实测：--ps-* 44 个
 * 与 --liang-* 21 个并存）。
 *
 * 关键坑（实测踩到的）
 * ──────────────────
 * 「滑动变祖」靠 window 的 storage 事件同步开关，但 **storage 事件只在
 * 其他文档里触发**。我们在同一个页面里写它的 localStorage 键，它收不到
 * 通知，仍然开着。
 *
 * 所以接管必须是两步：
 *   1. 写 localStorage 键（让它下次加载时不启用）；
 *   2. 手动派发一个 StorageEvent（让当前页面里的它立刻响应）。
 * 两步都做，才会当场撤掉。
 *
 * 反向保护
 * ────────
 * 如果用户先用言宝关掉了它、后来又在外面的窗口把它打开，本插件用
 * MutationObserver 盯着 body 的 data-liang-skin 属性，发现它又上线就
 * 再次接管。
 */

const LIANG_PACKAGE_ID = "dsh-client-liang-intensity-skin";
const LIANG_ENABLED_KEY = "dsh-liang-intensity-skin.enabled.v1";

/** 记录「这次是言宝关掉的它」，用来在言宝停用时恢复。 */
const TAKEOVER_MARK = "dsh-photo-skin.took-over-liang";

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 关掉「滑动变祖」。
 *
 * @param {{remember?: boolean}} [options]
 *   remember: 是否记下"原本是开着的"，供 restoreLiangSkin() 恢复。
 * @returns {boolean} 是否真的执行了关闭动作
 */
export function disableLiangSkin(options = {}) {
  const { remember = true } = options;
  const storage = safeStorage();

  // 先看当前页面里的它到底开着没有（键可能是 0，但页面里还没响应）
  const liveOn = document.body.getAttribute("data-liang-skin") === "on";
  const keyOn = storage?.getItem(LIANG_ENABLED_KEY) !== "0";

  if (!liveOn && !keyOn) return false;

  /*
   * 只要这次是言宝把它从「开」改成「关」，就记下来，停用言宝时才能还回去。
   * 之前只在它已经显示在页面上时才记：言宝比它先加载时，键被写成 0
   * 却没有标记，停用言宝后它就永远关着。
   */
  if (remember && (liveOn || keyOn) && storage !== null) {
    storage.setItem(TAKEOVER_MARK, "1");
  }

  try {
    storage?.setItem(LIANG_ENABLED_KEY, "0");
  } catch {
    // 隐私模式：键写不进去，下面的事件仍然能让它当场撤掉
  }

  /*
   * 手动派发 StorageEvent —— 这是同文档接管的关键。
   * 注意：这是"伪造"的事件，但它与浏览器真实派发的事件结构一致，
   * 对方只看 key / newValue / storageArea，所以能正确响应。
   * 派发失败（旧浏览器不支持 StorageEvent 构造）时退化为只写键，
   * 效果是刷新后才生效。
   */
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LIANG_ENABLED_KEY,
        oldValue: "1",
        newValue: "0",
        storageArea: storage ?? undefined,
        url: location.href,
      }),
    );
  } catch {
    // 忽略：刷新后仍然生效
  }

  return true;
}

/**
 * 恢复「滑动变祖」原来的状态。
 * 只在"是言宝关掉的"情况下恢复，绝不擅自打开用户自己关掉的皮肤。
 */
export function restoreLiangSkin() {
  const storage = safeStorage();
  if (storage === null) return;
  if (storage.getItem(TAKEOVER_MARK) !== "1") return;

  try {
    storage.setItem(LIANG_ENABLED_KEY, "1");
  } catch {
    return;
  }
  storage.removeItem(TAKEOVER_MARK);

  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LIANG_ENABLED_KEY,
        oldValue: "0",
        newValue: "1",
        storageArea: storage,
        url: location.href,
      }),
    );
  } catch {
    // 忽略
  }
}

/** 「滑动变祖」当前是否在页面上活着。 */
export function liangSkinLive() {
  return (
    document.body.getAttribute("data-liang-skin") === "on" ||
    document.querySelector(".liang-skin-backdrop") !== null
  );
}

/**
 * 安装互斥。
 *
 * 三个触发点，缺一个就会出现"开关点了没反应"：
 *   1. 安装时评估一次（插件启动就接管）；
 *   2. **设置变化时重新评估**（用户在设置页拨开关）—— 之前漏了这一步，
 *      所以关掉再打开「与滑动变祖互斥」不会有任何效果；
 *   3. DOM 变化时兜底（对方被别处重新打开）。
 *
 * @param {() => object} getSettings 读取当前设置快照
 * @param {object} scope 偏好存储，用来订阅设置变化
 * @returns {() => void} 卸载函数
 */
export function installExclusivity(getSettings, scope) {
  /** 当前是否处于「言宝接管」状态。 */
  const shouldTakeOver = () => {
    const settings = getSettings();
    return settings.enabled && settings.takeoverLiang;
  };

  /** 设置驱动的评估：开启则接管。 */
  const evaluate = () => {
    if (!shouldTakeOver()) return;
    // remember 只在本轮尚未接管过时才记，避免反复覆盖原始状态
    const storage = safeStorage();
    const already = storage?.getItem(TAKEOVER_MARK) === "1";
    disableLiangSkin({ remember: !already });
  };

  const observer = new MutationObserver(() => {
    if (!shouldTakeOver()) return;
    // 它又上线了 → 立刻再接管一次（不重复记标记）
    if (liangSkinLive()) {
      disableLiangSkin({ remember: false });
    }
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-liang-skin"],
  });

  // 订阅设置：用户拨动「与滑动变祖互斥」或「启用言宝」时立刻生效
  const unsubscribe = scope?.subscribe?.(evaluate) ?? (() => {});

  // 首次评估
  evaluate();

  return () => {
    observer.disconnect();
    unsubscribe();
  };
}

export { LIANG_ENABLED_KEY, LIANG_PACKAGE_ID };