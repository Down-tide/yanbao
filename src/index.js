/**
 * dsh-photo-skin —— host 半边。
 *
 * 只做两件事：
 *   1. 把 assets/ 下的图片通过 /plugins/dsh-photo-skin/assets/* 暴露给浏览器；
 *   2. 提供一个 assets.json 清单，方便排错时确认读到了哪些文件。
 *
 * 为什么必须由 host 提供而不是客户端直接引用文件路径：
 * 客户端 bundle 跑在浏览器里，拿不到本地文件系统。图片必须经 webServer
 * 的 HTTP 路由发送，CSS 的 url() 才能加载。
 *
 * 路由前缀 /plugins/<PACKAGE_ID>/assets 是 DSH 客户端资源系统的既定约定，
 * 但要注意：webServer.match() 的匹配规则是
 *   pathname === prefix || pathname.startsWith(`${prefix}/`)
 * 所以注册时**不能带结尾斜杠**，否则匹配串会变成 ".../assets//"，
 * 永远命中不了（这是踩过的坑）。
 */
import { createReadStream, statSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PACKAGE_ID = "dsh-photo-skin";

/** 注册用前缀 —— 不带结尾斜杠。 */
export const ROUTE_PREFIX = `/plugins/${PACKAGE_ID}/assets`;

/** 浏览器侧引用的前缀 —— 带结尾斜杠。 */
export const ASSET_PREFIX = `${ROUTE_PREFIX}/`;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
};

/**
 * 递归扫描 assets/（含 transitions/ 子目录），返回 { 路由路径 -> 文件元信息 }。
 * 每次请求都重新扫描，换图不用重启服务。
 */
function scanAssets() {
  const directory = fileURLToPath(new URL("../assets/", import.meta.url));
  const assets = new Map();
  if (!existsSync(directory)) return assets;

  /**
   * 递归扫描。
   *
   * depth 上限 + 不跟随符号链接目录是必须的：
   * 用户如果把 assets/ 里的某个子目录换成指向上级的软链，
   * 无上限的递归会一直走下去直到栈溢出或文件描述符耗尽。
   */
  const walk = (relative, depth = 0) => {
    if (depth > 4) return;
    const absolute = `${directory}${relative}`;
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const next = relative === "" ? entry.name : `${relative}${entry.name}`;
      // isDirectory() 对符号链接返回 false，天然不跟随；这里显式跳过链接
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(`${next}/`, depth + 1);
        continue;
      }
      const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      try {
        const info = statSync(`${directory}${next}`);
        if (!info.isFile()) continue;
        assets.set(`${ASSET_PREFIX}${next}`, {
          path: `${directory}${next}`,
          type: CONTENT_TYPES[ext] ?? "application/octet-stream",
          size: info.size,
          etag: `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
        });
      } catch {
        // 文件在扫描与读取之间消失 —— 跳过，下次请求会重新扫描。
      }
    }
  };

  walk("");
  return assets;
}

/**
 * 解析单个字节区间。
 * 拖动滑块会快速切换几十张图，浏览器有时会带 Range 头做局部请求；
 * 不支持的话部分场景会拿到整图或直接失败，所以照「滑动变祖」的做法实现。
 *
 * @returns {null} 无 Range 头；{false} 非法；{start,end} 合法区间
 */
export function parseSingleRange(value, size) {
  if (value === undefined) return null;
  // 空文件上的任何区间都无法满足
  if (size === 0) return false;
  if (!value.startsWith("bytes=") || value.includes(",")) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === "" && match[2] === "")) return false;

  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
    if (start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/**
 * 判断 If-None-Match 是否命中当前 ETag。
 * 支持 `*`、逗号分隔列表、以及 W/ 弱前缀。
 */
function etagMatches(header, etag) {
  if (typeof header !== "string") return false;
  if (header.trim() === "*") return true;
  const strip = (value) => value.trim().replace(/^W\//, "");
  const target = strip(etag);
  return header.split(",").some((candidate) => strip(candidate) === target);
}

function send(res, status, headers = {}) {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", ...headers });
  res.end();
}

function createAssetHandler(activeStreams) {
  return (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      send(res, 405, { Allow: "GET, HEAD" });
      return;
    }

    let pathname;
    try {
      /*
       * 要解码：浏览器会把中文、空格编码成 %E6%9C%88 / %20，
       * 而清单里的键是原始文件名。prepare-images.py 生成的文件名保留中文，
       * 不解码的话这些图全部 404。查找是对扫描结果精确匹配，解码后的
       * ../ 之类也匹配不到任何文件，不会越出 assets/。
       */
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://dsh.local").pathname);
    } catch {
      send(res, 404);
      return;
    }

    const asset = scanAssets().get(pathname);
    if (asset === undefined) {
      send(res, 404);
      return;
    }

    /*
     * If-None-Match 可能是逗号分隔的列表，也可能带 W/ 弱前缀；
     * 严格全等会漏掉合法命中（只影响缓存效率，不影响正确性）。
     */
    if (etagMatches(req.headers["if-none-match"], asset.etag)) {
      send(res, 304, { ETag: asset.etag });
      return;
    }

    const ifRange = req.headers["if-range"];
    const rangeHeader = ifRange !== undefined && ifRange !== asset.etag
      ? undefined
      : req.headers.range;
    const range = parseSingleRange(rangeHeader, asset.size);
    if (range === false) {
      send(res, 416, { "Content-Range": `bytes */${asset.size}` });
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? asset.size - 1;
    const status = range === null ? 200 : 206;
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600, must-revalidate",
      "Content-Length": String(end - start + 1),
      "Content-Type": asset.type,
      ETag: asset.etag,
      ...(range === null ? {} : { "Content-Range": `bytes ${start}-${end}/${asset.size}` }),
    };

    // 空文件没有内容可读：createReadStream 的 end 会是 -1，直接报错断开连接
    if (method === "HEAD" || asset.size === 0) {
      send(res, status, headers);
      return;
    }

    res.writeHead(status, { "X-Content-Type-Options": "nosniff", ...headers });
    const stream = createReadStream(asset.path, { start, end });
    activeStreams.add(stream);
    const release = () => activeStreams.delete(stream);
    stream.once("close", release);
    stream.once("end", release);
    stream.once("error", () => {
      release();
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    });
    res.once("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  };
}

function createManifestHandler() {
  return (_req, res) => {
    const assets = scanAssets();
    const list = [...assets.keys()].map((p) => p.slice(ASSET_PREFIX.length)).sort();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ package: PACKAGE_ID, count: list.length, assets: list }, null, 2));
  };
}

export const inject = ["webServer"];

export function apply(ctx) {
  const activeStreams = new Set();

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        handler: createAssetHandler(activeStreams),
      }),
      ctx.webServer.register({
        kind: "exact",
        path: `/plugins/${PACKAGE_ID}/assets.json`,
        handler: createManifestHandler(),
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
      for (const stream of activeStreams) stream.destroy();
      activeStreams.clear();
    };
  }, `${PACKAGE_ID}: photo assets`);
}