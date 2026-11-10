/**
 * 极简构建：把 src/client.js 及其依赖包成 DSH 客户端加载器认识的形状。
 *
 * DSH 的客户端 bundle 不是普通 ESM —— 加载器要求每个插件文件以
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 * 注册自己，factory 内部是 CommonJS 语义，`require` 由宿主提供。
 *
 * 本仓库保持零依赖：不引 esbuild，只按依赖顺序把 src/ 下这几个模块
 * 拼进同一个 factory 作用域，并删掉 import/export 语法。
 * 因为都在同一作用域，模块之间的同名符号会冲突 —— 所以下面用
 * `checkCollisions()` 在构建期就报错，而不是等到运行时白屏。
 *
 * 用法：node scripts/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));

/** 依赖在前，入口最后。 */
const MODULES = [
  "logic.js",
  "frames.js",
  "store.js",
  "effort.js",
  "exclusive.js",
  "stardust.js",
  "motion.js",
  "presenter.js",
  "slider.js",
  "settings.js",
  "client.js",
];

/** 宿主提供的模块，运行时由 require() 拿到，不需要打包。 */
const EXTERNALS = new Set(["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"]);

const read = (name) => readFileSync(`${root}src/${name}`, "utf8");

/**
 * 去掉 ESM 语法，变成可拼进同一作用域的普通语句。
 *
 * 处理的形态（本仓库只写这几种，超出就在构建期报错）：
 *   import x from "y"              整行删掉
 *   import { a, b } from "y"       整行删掉
 *   export const/let/var/function  去掉 export
 *   export { ... }                 整块删掉（跨模块靠共享作用域）
 */
function stripModuleSyntax(source, file) {
  let out = source.replace(
    /^\s*import\s+(?:[\s\S]*?)\s+from\s+["'][^"']+["'];?[ \t]*$/gm,
    "",
  );
  out = out.replace(/^\s*import\s+["'][^"']+["'];?[ \t]*$/gm, "");
  out = out.replace(
    /^export\s+(const|let|var|function|async\s+function|class)\s/gm,
    "$1 ",
  );
  out = out.replace(/^\s*export\s*\{[\s\S]*?\};?[ \t]*$/gm, "");

  if (/^\s*(import|export)\s/m.test(out)) {
    throw new Error(
      `${file}: 还有没处理的 import/export。build.mjs 只支持本仓库的写法，` +
        `新写法请先扩展 stripModuleSyntax()。`,
    );
  }
  return out.trim();
}

/**
 * 顶层的 const/let/var/function/class 名字。
 * 同一作用域里重名会直接 SyntaxError，所以在构建期就抓出来。
 */
function topLevelNames(source) {
  const names = new Set();
  const patterns = [
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

function checkCollisions(parts) {
  const owners = new Map();
  const collisions = [];
  for (const { file, code } of parts) {
    for (const name of topLevelNames(code)) {
      const previous = owners.get(name);
      if (previous !== undefined && previous !== file) {
        collisions.push(`${name}: ${previous} ↔ ${file}`);
      } else {
        owners.set(name, file);
      }
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      "跨模块符号冲突（都在同一个 factory 作用域里，必须改名）：\n  " +
        collisions.join("\n  "),
    );
  }
}

const parts = MODULES.map((file) => ({
  file,
  code: stripModuleSyntax(read(file), file),
}));

checkCollisions(parts);

/** 样式单独处理：整段文本变成 SKIN_CSS 常量。 */
const css = readFileSync(`${root}src/skin.css`, "utf8");
const cssPart = {
  file: "skin.css",
  code: `const SKIN_CSS = ${JSON.stringify(css)};`,
};

const body = parts
  .map(({ file, code }) => `/* ── src/${file} ── */\n${code}`)
  .concat(`/* ── src/skin.css ── */\n${cssPart.code}`)
  .join("\n\n");

const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

${body}

    exports.name = name;
    exports.apply = apply;
    exports.inject = inject;
    exports.IMAGES = IMAGES;
    return module.exports;
  },
});
`;

mkdirSync(`${root}lib`, { recursive: true });
writeFileSync(`${root}lib/client.js`, bundle);
console.log(
  `built lib/client.js  ${(bundle.length / 1024).toFixed(1)} KB  ` +
    `modules: ${MODULES.join(", ")} + skin.css`,
);