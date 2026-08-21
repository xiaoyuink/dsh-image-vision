/**
 * dsh-image-vision Host half.
 *
 * 职责：
 * 1. 注册 `image_vision` 工具 —— 自动判断当前接入的大模型是否识图：
 *    - 识图：不调用插件视觉模型，把图片作为 image block 交给当前模型，
 *      并按插件的预设提示词（preset）要求它分析；
 *    - 不识图：调用插件配置的视觉模型（OpenAI/Anthropic 兼容），返回识别文本。
 * 2. 注册 settings namespace `image-vision`（多供应商配置：providers + active）。
 * 3. 注册 HTTP 路由：
 *    - `GET  /api/dsh-image-vision/config`     —— 读配置（供设置页回显）
 *    - `POST /api/dsh-image-vision/config`     —— 写配置（全量保存 providers + active）
 *    - `POST /api/dsh-image-vision/activate`   —— 切换当前使用的供应商/模型
 *    - `POST /api/dsh-image-vision/models`     —— 模型发现（识图/非识图判定）
 *    - `POST /api/dsh-image-vision/test-model` —— 用内置测试图片实测模型识图能力
 *
 * 说明：插件自定义的 settings namespace 不在 dsh-host-apiproxy 的
 * `exposedNamespaces()` 白名单中，Web 设置界面无法通过 settings wire 读写它，
 * 因此配置读写走插件自己的 HTTP 路由（host 侧直接操作 settings 服务，无白名单限制）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { PRESET_CONFIGS, PRESET_PROMPTS } from "./presets.js";
import WebSocket from "ws";
import { spawn } from "node:child_process";

const name = "dsh-image-vision";
const inject = ["tools", "timer", "llm", "agentDefaultModel", "attachments", "fs", "webServer", "systemPrompt"];

// ===== 在线更新：GitHub Release 发现 + 显式、用户触发的插件更新 =====
// 版本号与 package.json 同步，每次发布 Release 时更新此处。
const PLUGIN_VERSION = "2.5.0";
const PACKAGE_NAME = "@xiaoyuink/dsh-image-vision";
const RELEASES_URL = "https://api.github.com/repos/xiaoyuink/dsh-image-vision/releases/latest";

const SETTINGS_NS = settingsNamespace("image-vision");

// 输入框粘贴/上传的图片草稿落盘目录（存放在插件安装目录本体内：~/.dsh/plugin/dsh-image-vision/drafts/）。
const DRAFTS_DIR = join(homedir(), ".dsh", "plugin", name, "drafts");
// attachmentId -> 草稿文件名（避免同一附件重复落盘）
const attachmentDraftCache = new Map();

/** 动态加载 sharp（失败不影响插件本体，工具调用时再报错）。 */
let sharpPromise = null;
function loadSharp() {
  if (sharpPromise === null) {
    sharpPromise = import("sharp")
      .then((m) => m.default ?? m)
      .catch((e) => {
        sharpPromise = null;
        throw new Error(`sharp 图像库不可用: ${String(e?.message ?? e)}`);
      });
  }
  return sharpPromise;
}

/** 解析 "x1,y1,x2,y2" 裁剪框。 */
function parseRegion(text) {
  const m = String(text ?? "").match(/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
  if (m === null) return void 0;
  const x1 = Number(m[1]), y1 = Number(m[2]), x2 = Number(m[3]), y2 = Number(m[4]);
  if (x2 <= x1 || y2 <= y1) return void 0;
  return { x1, y1, x2, y2 };
}
const DRAFT_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
// 图片文件头 magic bytes 校验（防伪冒/损坏文件）。
const DRAFT_MAGIC = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
};
const DRAFT_MAX_BYTES = 20 * 1024 * 1024;
const DRAFT_MAX_AGE_MS = 20 * 60 * 1000; // 草稿保存 20 分钟后删除（临时文件，不长期留存）

/** 校验图片字节的文件头是否与声明的 mediaType 一致（webp 走 RIFF....WEBP 布局）。 */
function verifyImageMagic(bytes, mediaType) {
  if (mediaType === "image/webp") {
    return bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  const sigs = DRAFT_MAGIC[mediaType];
  if (!sigs) return false;
  return sigs.some((sig) => sig.every((b, i) => bytes[i] === b));
}

/** 尽力清理超过 DRAFT_MAX_AGE_MS 的草稿文件（失败静默，不阻塞上传）。 */
async function cleanupDrafts() {
  try {
    const entries = await readdir(DRAFTS_DIR, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(entries
      .filter((e) => e.isFile() && e.name.startsWith("iv-"))
      .map(async (e) => {
        try {
          const info = await stat(join(DRAFTS_DIR, e.name));
          if (now - info.mtimeMs > DRAFT_MAX_AGE_MS) await unlink(join(DRAFTS_DIR, e.name));
        } catch { /* 单个文件失败忽略 */ }
      }));
  } catch { /* 目录不存在等忽略 */ }
}

/** 草稿过期定时器表（文件名 -> timer）：保证草稿在保存 DRAFT_MAX_AGE_MS 后被删除。 */
const draftExpiryTimers = new Map();
function scheduleDraftExpiry(file) {
  if (draftExpiryTimers.has(file)) return;
  const timer = setTimeout(() => {
    draftExpiryTimers.delete(file);
    unlink(join(DRAFTS_DIR, file)).catch(() => {});
  }, DRAFT_MAX_AGE_MS);
  if (typeof timer.unref === "function") timer.unref(); // 不阻塞进程退出
  draftExpiryTimers.set(file, timer);
}

/** 保存一张草稿图片，返回 { path }（正斜杠绝对路径，可直接作为图片引用标记）。 */
async function saveDraftImage(mediaType, bytes) {
  await mkdir(DRAFTS_DIR, { recursive: true });
  const ext = DRAFT_EXT[mediaType];
  const file = `iv-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}.${ext}`;
  const abs = join(DRAFTS_DIR, file);
  await writeFile(abs, bytes);
  scheduleDraftExpiry(file);
  return { path: abs.replace(/\\/g, "/") };
}

/**
 * 把一个 image block 的附件字节落盘到草稿目录，返回短名标记 `![图片](i/iv-att-xxx.jpg)`。
 * 按 attachmentId 缓存：同一图片多轮出现只写一次。
 */
async function imageBlockToMarker(ctx, ref, signal) {
  const id = String(ref?.attachmentId ?? ref?.id ?? "unknown");
  let name = attachmentDraftCache.get(id);
  if (name !== void 0) {
    // 草稿 20 分钟即过期：缓存命中时校验文件仍在，若已被清理则重新落盘。
    try {
      await stat(join(DRAFTS_DIR, name));
    } catch {
      attachmentDraftCache.delete(id);
      name = void 0;
    }
  }
  if (name === void 0) {
    const stored = await ctx.attachments.readImage(ref, signal);
    const ext = DRAFT_EXT[ref?.mediaType] ?? "png";
    // attachmentId 形如 "sha256:765d0..."，冒号在 Windows 文件名非法（会被当作 NTFS 数据流），
    // 统一清洗为字母数字下划线后截断。
    const safe = id.replace(/[^A-Za-z0-9]/g, "_").slice(0, 16) || "unknown";
    name = `iv-att-${safe}.${ext}`;
    await mkdir(DRAFTS_DIR, { recursive: true });
    await writeFile(join(DRAFTS_DIR, name), Buffer.from(stored.data));
    attachmentDraftCache.set(id, name);
    scheduleDraftExpiry(name);
    cleanupDrafts().catch(() => {});
  }
  return `![图片](i/${name})`;
}

/** 总开关是否开启 + 配置中是否存在视觉模型。 */
function configHasVisionModel(config) {
  const cfg = normalizeConfig(config);
  return cfg.enabled === true && cfg.providers.some((p) => p.models.some((m) => m.vision));
}

// 内置测试图片（设置页「检测」按钮用它实测模型识图能力）。
const TEST_IMAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "test-image.jpg");
const TEST_PROMPT = "请用一句话描述这张图片的内容。";

const ModelSchema = z.object({
  id: z.string().description("模型名称"),
  vision: z.boolean().default(false).description("是否具备视觉能力（自动判断，可手动纠正）"),
});
const ProviderSchema = z.object({
  id: z.string().description("供应商唯一标识"),
  name: z.string().description("供应商显示名称"),
  apiBaseUrl: z.string().description("视觉模型 API 端点（OpenAI 或 Anthropic 兼容）"),
  apiKey: z.string().description("API Key；推荐填引用避免明文落盘：`cred:REF`（DSH 凭据服务，环境变量或 ~/.dsh/.credentials.yaml）或 `env:VAR`（进程环境变量）"),
  models: z.array(ModelSchema).default([]).description("该供应商下的模型列表"),
});
const SettingsSchema = z.object({
  enabled: z.boolean().default(false).description("总开关：开启后注册识图工具、系统规则与输入框图片入口；关闭后插件完全不参与"),
  providers: z.array(ProviderSchema).default([]).description("视觉供应商列表"),
  active: z.string().default("").description('当前激活的模型，格式 "供应商id:模型id"'),
  // 兼容旧版单配置字段（读取时迁移为 providers[0]）
  apiBaseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default(""),
});

const MIME_MAP = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** 判断当前默认模型是否有识图能力（inputModalities 含 'image'）。 */
async function currentModelHasVision(ctx, signal) {
  const sel = ctx.agentDefaultModel.currentSelection();
  if (sel === void 0) return false;
  try {
    const info = await ctx.llm.resolveModelInfo(sel.provider, sel.model, signal);
    const mods = info.inputModalities ?? [];
    return mods.includes("image");
  } catch {
    return false;
  }
}

/** 从文件扩展名推断媒体类型；不支持的格式返回 undefined。 */
function mediaTypeOf(path) {
  const ext = String(path).split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext];
}

/** 从草稿引用中提取文件名（支持 `i/iv-xxx.jpg`、`iv-xxx.jpg`、URL、本地绝对路径）。 */
function draftNameFrom(imageRef) {
  const ref = String(imageRef ?? "").trim();
  if (ref === "") return null;
  // 完整 URL：http(s)://host/i/<name> 或 http(s)://host/api/dsh-image-vision/draft-image?name=<name>
  if (/^https?:\/\//i.test(ref)) {
    try {
      const url = new URL(ref);
      const m = url.pathname.match(/^\/i\/([^/]+)$/);
      if (m) return m[1];
      if (url.pathname === "/api/dsh-image-vision/draft-image") return url.searchParams.get("name");
    } catch { /* 解析失败按普通引用处理 */ }
    return null;
  }
  // 相对路径/短名：取最后一段（兼容 i/xxx、C:/.../xxx、xxx）
  const base = ref.split(/[\\/]/).pop() ?? ref;
  return base;
}

const DRAFT_NAME_RE = /^iv-[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/;

/**
 * 解析图片引用（本地绝对路径 / 草稿短名 / 草稿 URL），返回 { path, bytes }。
 * 支持 image_vision 工具在「输入框短标记」场景下按文件名读取草稿图片。
 */
async function resolveImageRef(ctx, imageRef, signal) {
  const ref = String(imageRef ?? "").trim();
  if (ref === "") throw new Error("图片引用为空");
  // 附件存储引用（发送 hook 新格式）：/api/dsh-image-vision/raw/<sha256>?m=..&b=..&w=..&h=..
  // 从附件存储读字节并复用 attachment→草稿 物化桥（缓存 + 过期重建），供精读工具直接使用。
  if (/\/api\/dsh-image-vision\/raw\//i.test(ref)) {
    const aref = attachRefFromUrl(ref);
    if (aref !== null) {
      const marker = await imageBlockToMarker(ctx, aref, signal);
      const name = marker.match(/i\/(iv-att-[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif))/i)?.[1];
      if (name === void 0) throw new Error(`无法从附件引用物化草稿: ${ref}`);
      const target = join(DRAFTS_DIR, name);
      try {
        const bytes = await readFile(target);
        if (bytes.length === 0) throw new Error("empty file");
        return { path: target.replace(/\\/g, "/"), bytes };
      } catch {
        throw new Error(`附件图片物化后读取失败: ${name}`);
      }
    }
    throw new Error(`无法解析附件存储图片引用: ${ref}`);
  }
  // 完整 URL：http(s)://host/i/<name> 或 http(s)://host/api/dsh-image-vision/draft-image?name=<name>
  if (/^https?:\/\//i.test(ref)) {
    const name = draftNameFrom(ref);
    if (name !== null && DRAFT_NAME_RE.test(name)) {
      const target = join(DRAFTS_DIR, name);
      try {
        const bytes = await readFile(target);
        if (bytes.length === 0) throw new Error("empty file");
        return { path: target.replace(/\\/g, "/"), bytes };
      } catch {
        throw new Error(`草稿图片不存在或已清理: ${name}（草稿保留 20 分钟）`);
      }
    }
    throw new Error(`无法解析图片 URL: ${ref}`);
  }
  // 草稿短名：i/iv-xxx.jpg 或 iv-xxx.jpg（无路径分隔符，避免与本地绝对路径混淆）
  if (/^i\/[^/]+$/.test(ref) || /^iv-[A-Za-z0-9_-]+\.[a-z0-9]+$/i.test(ref)) {
    const name = ref.split("/").pop() ?? ref;
    if (DRAFT_NAME_RE.test(name)) {
      const target = join(DRAFTS_DIR, name);
      try {
        const bytes = await readFile(target);
        if (bytes.length === 0) throw new Error("empty file");
        return { path: target.replace(/\\/g, "/"), bytes };
      } catch {
        throw new Error(`草稿图片不存在或已清理: ${name}（草稿保留 20 分钟）`);
      }
    }
  }
  if (!isAbsolute(ref)) {
    throw new Error(
      `仅支持本地绝对路径或草稿图片引用（i/文件名），请传入完整路径（例如 C:\\Users\\...\\image.jpg）；收到的引用: ${ref}`,
    );
  }
  const target = await ctx.fs.resolve(ref);
  // 约 20MB 上限，足够覆盖视觉模型的 base64 限制。
  const bytes = await ctx.fs.readBytes(target, signal, 20 * 1024 * 1024);
  return { path: target.displayPath ?? ref, bytes };
}

/** 读取图片文件字节。 */
async function readImageBytes(ctx, path, signal) {
  if (!isAbsolute(path)) {
    throw new Error(
      `仅支持本地绝对路径，请传入完整路径（例如 C:\\Users\\...\\image.jpg）；不支持相对路径，收到的路径: ${path}`,
    );
  }
  const target = await ctx.fs.resolve(path);
  // 约 20MB 上限，足够覆盖视觉模型的 base64 限制。
  return ctx.fs.readBytes(target, signal, 20 * 1024 * 1024);
}

/** 把一张图片保存为 attachment，供当前模型直接查看。 */
async function saveAsAttachment(ctx, path, signal) {
  const { path: resolved, bytes } = await resolveImageRef(ctx, path, signal);
  const mediaType = mediaTypeOf(resolved);
  if (mediaType === void 0) {
    throw new Error(`不支持的图片格式: ${resolved}（支持 jpg/jpeg/png/gif/webp/bmp）`);
  }
  return ctx.attachments.saveImage({
    data: bytes,
    mediaType,
    name: String(resolved).split(/[\\/]/).pop(),
  });
}

/** 将 Uint8Array 编码为 base64（宿主为 Node 环境，Buffer 全局可用）。 */
function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** 从 bytes 推断 data URL 的 mime；先用文件名，再退回 image/png。 */
function dataUrlFor(path, bytes) {
  const mime = mediaTypeOf(path) ?? "image/png";
  return `data:${mime};base64,${toBase64(bytes)}`;
}

/**
 * 解析 API 错误响应体，提取可读的错误信息。
 * 兼容 OpenAI（{"error":{"message":"..."}}）、DashScope（{"message":"...","code":"..."}）、
 * one-api（{"error":{"message":"..."}}）及纯文本等格式。
 */
async function parseApiErrorMessage(resp) {
  const status = resp.status;
  let body = "";
  try { body = await resp.text(); } catch { /* 读取失败忽略 */ }
  if (body === "") return `HTTP ${status}`;
  try {
    const data = JSON.parse(body);
    if (data?.error?.message) return String(data.error.message);
    if (data?.message) return String(data.message);
    if (typeof data?.error === "string") return data.error;
    if (typeof data === "string") return data;
  } catch { /* 非 JSON，用原始文本 */ }
  return body.slice(0, 200);
}

/**
 * 调用插件配置的视觉模型（OpenAI 兼容 / Anthropic 兼容），返回识别文本。
 * 协议选择：baseUrl 含 "anthropic" 用 Anthropic Messages API，否则用 OpenAI chat.completions。
 */
async function callVisionModel(ctx, provider, modelId, imagePaths, prompt, signal) {
  const baseUrl = String(provider.apiBaseUrl ?? "").replace(/\/+$/, "");
  const apiKey = await resolveApiKey(ctx, provider);
  const model = String(modelId ?? "");
  if (!baseUrl || !model) {
    throw new Error("视觉模型未配置：请在插件设置中添加供应商和模型，并选择使用");
  }
  // OVHcloud AI Endpoints 匿名层免 Key（每 IP/模型 2 次/分钟）；其它端点缺 Key 时给出明确提示。
  const keyless = /kepler\.ai\.cloud\.ovh\.net/i.test(baseUrl);
  if (!apiKey && !keyless) {
    throw new Error("视觉模型未配置 API Key：请在插件设置中填写（OVHcloud 免费层可留空）");
  }

  const images = [];
  for (const p of imagePaths) {
    const { path, bytes } = await resolveImageRef(ctx, p, signal);
    images.push({ path, bytes });
  }

  if (shouldUseRealtime(baseUrl, model)) {
    // realtime 网关有 256KB 帧限制：图片 base64 超限会被服务端断开（code=1009）。
    // 图片较大时自动改用同模型的 OpenAI 兼容接口（fetch 无帧限制），模型 id 去掉 -realtime 后缀。
    const totalBytes = images.reduce((sum, img) => sum + img.bytes.length, 0);
    if (totalBytes > 180 * 1024) {
      const altModel = String(model).replace(/-realtime$/i, "") || model;
      return callOpenAI(baseUrl, apiKey, altModel, images, prompt, signal);
    }
    return callRealtimeVisionModel(baseUrl, apiKey, model, images, prompt, signal);
  }
  if (baseUrl.toLowerCase().includes("anthropic")) {
    return callAnthropic(baseUrl, apiKey, model, images, prompt, signal);
  }
  return callOpenAI(baseUrl, apiKey, model, images, prompt, signal);
}

/**
 * 带降级的视觉模型调用：先尝试 active 模型，失败时自动尝试其他已配置的视觉模型。
 * 所有候选都失败时抛出最后一个错误（附带失败摘要）。
 */
async function callVisionWithFallback(ctx, config, imagePaths, prompt, signal) {
  const target = resolveTarget(config.providers, config.active);
  if (!target) {
    throw new Error("视觉模型未配置：请在 DSH 设置 → 识图插件中添加供应商和模型，并选择使用");
  }

  // 收集所有已配置的视觉模型候选，active 排最前
  const candidates = [{ provider: target.provider, model: target.model, is_active: true }];
  for (const p of config.providers) {
    for (const m of p.models) {
      if (!m.vision) continue;
      if (p.id === target.provider.id && m.id === target.model.id) continue;
      candidates.push({ provider: p, model: m, is_active: false });
    }
  }

  const errors = [];
  for (const c of candidates) {
    try {
      return await callVisionModel(ctx, c.provider, c.model.id, imagePaths, prompt, signal);
    } catch (err) {
      const msg = String(err?.message ?? err);
      errors.push(`${c.provider.name ?? c.provider.id}:${c.model.id} → ${msg}`);
      // 余额不足类错误继续尝试下一个候选；其他错误也继续（降级优于直接失败）
    }
  }
  throw new Error(`所有视觉模型均调用失败：\n${errors.join("\n")}`);
}

/** Anthropic Messages API。 */
async function callAnthropic(baseUrl, apiKey, model, images, prompt, signal) {
  const content = [];
  for (const img of images) {
    const data = toBase64(img.bytes);
    const mime = mediaTypeOf(img.path) ?? "image/png";
    content.push({
      type: "image",
      source: { type: "base64", media_type: mime, data },
    });
  }
  content.push({ type: "text", text: prompt });

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      // 匿名端点（OVH 免费层）无 Key 时不发送 x-api-key 头
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      // 识图输出通常很短；4096 兼容所有模型（部分厂商 max_tokens 上限仅 65536/8192）
      max_tokens: 4096,
      messages: [{ role: "user", content }],
    }),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`视觉模型调用失败 (${resp.status}): ${await parseApiErrorMessage(resp)}`);
  }
  const data = await resp.json();
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** OpenAI 兼容 chat.completions。 */
async function callOpenAI(baseUrl, apiKey, model, images, prompt, signal) {
  const content = [];
  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: dataUrlFor(img.path, img.bytes) },
    });
  }
  content.push({ type: "text", text: prompt });

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      // 匿名端点（OVH 免费层）无 Key 时不发送 Authorization 头
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      // 识图输出通常很短；4096 兼容所有模型（部分厂商 max_tokens 上限仅 65536/8192）
      max_tokens: 4096,
      messages: [{ role: "user", content }],
    }),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`视觉模型调用失败 (${resp.status}): ${await parseApiErrorMessage(resp)}`);
  }
  const data = await resp.json();
  // 部分网关返回 200 但 body 含 error（如 one-api 余额不足）
  if (data?.error?.message) {
    throw new Error(`视觉模型返回错误: ${data.error.message}`);
  }
  if (data?.message && !data.choices) {
    throw new Error(`视觉模型返回错误: ${data.message}`);
  }
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * 判断是否应走 Qwen-Omni Realtime WebSocket 协议。
 * realtime 模型在 OpenAI 兼容 HTTP 接口会返回 "current user api does not support http call"，
 * 必须走 wss://.../api-ws/v1/realtime。
 */
function shouldUseRealtime(baseUrl, model) {
  const url = String(baseUrl ?? "").toLowerCase();
  const id = String(model ?? "").toLowerCase();
  return id.includes("realtime") || url.includes("/api-ws/") || url.startsWith("wss://");
}

/** 把用户填写的 HTTP/HTTPS 端点转换为 Qwen-Omni Realtime WebSocket 地址。 */
function buildRealtimeUrl(baseUrl, model) {
  const raw = String(baseUrl ?? "").trim();
  let wsBase = raw;
  if (/^https?:\/\//i.test(raw)) {
    const host = raw.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if (host.includes("dashscope-intl.aliyuncs.com")) {
      wsBase = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";
    } else if (host.includes("dashscope.aliyuncs.com")) {
      wsBase = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
    } else if (host.includes("maas.aliyuncs.com")) {
      wsBase = `wss://${host}/api-ws/v1/realtime`;
    } else {
      wsBase = raw.replace(/^http/i, "ws").replace(/\/+$/, "");
    }
  } else if (!/^wss?:\/\//i.test(wsBase)) {
    wsBase = `wss://${wsBase}`;
  }
  wsBase = wsBase.replace(/\/+$/, "");
  if (!/model=/.test(wsBase)) {
    wsBase += `${wsBase.includes("?") ? "&" : "?"}model=${encodeURIComponent(String(model ?? ""))}`;
  }
  return wsBase;
}

/**
 * 调用 Qwen-Omni Realtime WebSocket 协议（Manual 模式，纯文本输出）。
 * 流程：连接 → session.update(modalities=["text"], turn_detection=null, instructions=prompt)
 *      → 先发一段静音 PCM 音频 → 逐张发送图片 → commit → response.create
 *      → 收集 response.text.delta / response.text.done 返回文本。
 */
function callRealtimeVisionModel(baseUrl, apiKey, model, images, prompt, signal) {
  return new Promise((resolve, reject) => {
    const url = buildRealtimeUrl(baseUrl, model);
    let settled = false;
    let text = "";
    let ws;
    const timeoutMs = 60000;
    const timer = setTimeout(() => {
      fail(new Error(`实时模型调用超时（${timeoutMs}ms）`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      } catch {}
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function done(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    try {
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        perMessageDeflate: false,
        handshakeTimeout: 15000,
      });
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text"],
          turn_detection: null,
          instructions: String(prompt ?? ""),
          input_audio_format: "pcm",
          output_audio_format: "pcm",
        },
      }));
    });

    ws.on("message", (data) => {
      let evt;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (evt.type === "error") {
        fail(new Error(`实时模型错误: ${JSON.stringify(evt.error ?? evt)}`));
        return;
      }
      if (evt.type === "session.updated") {
        // 协议要求：发图片前至少先发一次音频；这里发送一段静音 PCM。
        ws.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.alloc(3200).toString("base64"),
        }));
        for (const img of images) {
          ws.send(JSON.stringify({
            type: "input_image_buffer.append",
            image: Buffer.from(img.bytes).toString("base64"),
          }));
        }
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (evt.type === "response.text.delta") {
        text += evt.delta ?? "";
      }
      if (evt.type === "response.text.done") {
        done(evt.text ?? text);
      }
      if (evt.type === "response.done" && !settled) {
        done(text);
      }
    });

    ws.on("error", (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      if (text) {
        done(text);
      } else {
        fail(new Error(`实时连接关闭 code=${code} reason=${reason?.toString() ?? ""}`));
      }
    });

    if (signal) {
      if (signal.aborted) {
        fail(new Error("aborted"));
      } else {
        signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
      }
    }
  });
}

/**
 * 用内置测试图片实测模型的识图能力（设置页「检测」按钮调用）。
 * 协议选择与识别一致：baseUrl 含 "anthropic" 走 Anthropic Messages API，否则走 OpenAI chat.completions。
 * 返回结构化结果（不抛异常）：
 *   { ok: true, reply, latencyMs }
 *   { ok: false, error, imageSupport: false | "unknown", latencyMs }
 */
let cachedTestImage = null;
async function getTestImage() {
  if (cachedTestImage === null) {
    cachedTestImage = await readFile(TEST_IMAGE_PATH);
  }
  return cachedTestImage;
}

async function testVisionModel(baseUrlRaw, apiKey, model, signal) {
  const baseUrl = String(baseUrlRaw ?? "").replace(/\/+$/, "");
  const start = Date.now();
  const latency = () => Date.now() - start;
  try {
    if (!baseUrl || !model) {
      return { ok: false, error: "缺少 baseUrl / model", imageSupport: "unknown", latencyMs: latency() };
    }
    // OVHcloud 匿名层免 Key；其它端点空 Key 时给出明确提示
    if (!apiKey && !/kepler\.ai\.cloud\.ovh\.net/i.test(baseUrl)) {
      return { ok: false, error: "缺少 apiKey（OVHcloud 免费层可留空）", imageSupport: "unknown", latencyMs: latency() };
    }
    const bytes = await getTestImage();
    const images = [{ path: TEST_IMAGE_PATH, bytes }];
    const reply = shouldUseRealtime(baseUrl, model)
      ? await callRealtimeVisionModel(baseUrl, apiKey, model, images, TEST_PROMPT, signal)
      : baseUrl.toLowerCase().includes("anthropic")
        ? await callAnthropic(baseUrl, apiKey, model, images, TEST_PROMPT, signal)
        : await callOpenAI(baseUrl, apiKey, model, images, TEST_PROMPT, signal);
    return { ok: true, reply: String(reply ?? ""), latencyMs: latency() };
  } catch (error) {
    const message = String(error?.message ?? error);
    // 端点拒绝图片输入的特征性错误 → 判定为不支持识图
    const looksNoImage = /image input|no endpoints|does not support images|not support.*image|unsupported.*image|invalid.*image|image.*not supported|not a multimodal model|multimodal model|vision.*not|does not support vision|text-only/i.test(message);
    return { ok: false, error: message.slice(0, 400), imageSupport: looksNoImage ? false : "unknown", latencyMs: latency() };
  }
}

/** 检测路由：给定 baseUrl + apiKey + model，用内置测试图实测识图能力。 */
function registerTestModelRoute(ctx, getConfig) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/test-model",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await testVisionModel(
          String(body.apiBaseUrl ?? ""),
          await fallbackApiKey(ctx, getConfig, String(body.apiBaseUrl ?? ""), String(body.apiKey ?? "")),
          String(body.model ?? ""),
        );
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error), imageSupport: "unknown" });
      }
    },
  });
}

/**
 * 模型发现路由：给定 baseUrl + apiKey，列出该端点 /models 的模型，
 * 并用模型名关键词判断是否具备识图能力。
 */
const VISION_HINTS = [
  /vision/i, /vl/i, /4o/i, /omni/i, /gpt-4/i, /claude/i, /gemini/i,
  /glm-4v/i, /glm-4\.5v/i, /internvl/i, /llava/i, /pixtral/i,
  /minicpm-v/i, /mimo/i, /kimi/i, /moonshot/i, /step-1v/i, /yi-vl/i,
  /cogvlm/i, /deepseek-vl/i, /hunyuan.*vision/i,
  // qwen 系列只有 VL/Omni/Image/OCR 子型号支持视觉；裸 qwen（plus/max/coder 等）是文本模型
  /qwen.*(vl|omni|image|vision|ocr)/i,
];

/**
 * 显式视觉能力覆盖表（优先于正则）。
 * 依据 models.dev 的 opencode / opencode-go provider 元数据（attachment=True 且
 * input 模态含 image）逐条核实；裸 ID 不含 vl/omni 等后缀时正则会漏判，故显式登记。
 * 以后遇到类似误判，直接在此表加条目即可（true=支持视觉，false=仅文本）。
 */
const KNOWN_VISION_OVERRIDES = Object.freeze({
  // GPT-5 全系为多模态（text/image，部分含 pdf），正则需要 gpt-4/4o，全部漏判
  "gpt-5": true,
  "gpt-5-codex": true,
  "gpt-5-nano": true,
  "gpt-5.1": true,
  "gpt-5.1-codex": true,
  "gpt-5.1-codex-max": true,
  "gpt-5.1-codex-mini": true,
  "gpt-5.2": true,
  "gpt-5.2-codex": true,
  "gpt-5.3-codex": true,
  "gpt-5.4": true,
  "gpt-5.4-mini": true,
  "gpt-5.4-nano": true,
  "gpt-5.4-pro": true,
  "gpt-5.5": true,
  "gpt-5.5-pro": true,
  "gpt-5.6-luna": true,
  "gpt-5.6-sol": true,
  "gpt-5.6-terra": true,
  // Grok / MiniMax / Muse：均支持 image 输入
  "grok-4.5": true,
  "grok-4.6": true,
  "grok-build-0.1": true,
  "minimax-m3": true,
  "muse-spark-1.2": true,
  // Qwen plus 系列为多模态（text/image/video），qwen3.7-max 为纯文本
  "qwen3.5-plus": true,
  "qwen3.6-plus": true,
  "qwen3.6-plus-free": true,
  "qwen3.7-plus": true,
  "qwen3.7-max": false,
  "qwen3.8-max": true,
});

/** 明确的非视觉模型特征（语音合成/识别/嵌入/重排等），命中即判为非视觉。 */
const NON_VISION_HINTS = /(^|[-_])(tts|asr|voiceclone|voicedesign|voice|whisper|embedding|rerank)([-_]|$)/i;

function guessVision(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  // 显式覆盖表优先：权威判定（含手动纠错），先于启发式
  if (Object.prototype.hasOwnProperty.call(KNOWN_VISION_OVERRIDES, id)) {
    return KNOWN_VISION_OVERRIDES[id];
  }
  // mimo 系列只有基础多模态版（mimo-v2.5）支持视觉，asr/tts/voice 等子型号排除
  if (NON_VISION_HINTS.test(id)) return false;
  return VISION_HINTS.some((re) => re.test(id));
}

/** apiKey 脱敏占位：GET /config 回显用；POST 保存遇到该值表示"未修改，保留原值"。 */
const MASKED_KEY = "********";

/** 明文 Key 的自动凭据引用名：由供应商 id 派生，保证合法且稳定（删除/排序不影响）。 */
function credentialRefFor(providerId) {
  const cleaned = String(providerId ?? "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1");
  return `IMAGE_VISION_${cleaned || "PROVIDER"}`;
}

/** 解析一条 Key 引用（`cred:REF` / `env:VAR`）；非引用原样返回。 */
async function resolveKeyRef(ctx, raw) {
  const s = String(raw ?? "");
  if (s.startsWith("cred:")) {
    const ref = s.slice(5).trim();
    if (ref === "" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return "";
    const credentials = ctx?.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      return hit?.value ?? "";
    }
    return String(process.env[ref] ?? "");
  }
  if (s.startsWith("env:")) {
    const name = s.slice(4).trim();
    return name === "" ? "" : String(process.env[name] ?? "");
  }
  return s;
}

/**
 * 解析供应商 API Key，settings.yaml 只存引用、不落明文：
 * - `cred:REF`：走 DSH 凭据服务（环境变量 → ~/.dsh/.credentials.yaml → .env 分层解析）；
 *   凭据服务不可用时回落 process.env[REF]。
 * - `env:VAR`：直接读进程环境变量（兼容旧版）。
 * - 其它：原样返回（历史明文值，迁移到引用后不再出现）。
 */
async function resolveApiKey(ctx, provider) {
  return resolveKeyRef(ctx, String(provider?.apiKey ?? ""));
}

/** 是否"未填/脱敏"的提交值（测试/发现/余额路由用：脱敏则回落当前配置中的真实 Key）。 */
function isMaskedOrEmpty(key) {
  const k = String(key ?? "");
  return k === "" || k === MASKED_KEY;
}

/** 测试/发现/余额路由的 Key 回落：提交值为引用时直接解析；脱敏或为空时从当前配置按 baseUrl 匹配供应商取真实 Key。 */
async function fallbackApiKey(ctx, getConfig, baseUrl, submitted) {
  const sub = String(submitted ?? "");
  if (/^(env|cred):/.test(sub)) return resolveKeyRef(ctx, sub);
  if (!isMaskedOrEmpty(sub)) return sub;
  try {
    const cfg = normalizeConfig(getConfig());
    const b = String(baseUrl ?? "").replace(/\/+$/, "");
    const p = cfg.providers.find((x) => String(x.apiBaseUrl ?? "").replace(/\/+$/, "") === b) ?? cfg.providers[0];
    return p ? await resolveApiKey(ctx, p) : "";
  } catch {
    return "";
  }
}

/**
 * 规范化配置：保证返回 { providers: [...], active: "providerId:modelId" }。
 * - 兼容旧版单配置（顶层 apiBaseUrl/apiKey/model）→ 迁移为一个"默认供应商"；
 * - active 缺失或失效时回退到第一个供应商的第一个模型。
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  let providers = Array.isArray(src.providers)
    ? src.providers
        .filter((p) => p && typeof p.id === "string" && p.id !== "")
        .map((p) => ({
          id: String(p.id),
          name: String(p.name ?? p.id),
          apiBaseUrl: String(p.apiBaseUrl ?? ""),
          apiKey: String(p.apiKey ?? ""),
          models: Array.isArray(p.models)
            ? p.models
                .filter((m) => m && typeof m.id === "string" && m.id !== "")
                .map((m) => ({ id: String(m.id), vision: Boolean(m.vision) }))
            : [],
        }))
    : [];

  if (providers.length === 0) {
    const legacy = {
      apiBaseUrl: String(src.apiBaseUrl ?? ""),
      apiKey: String(src.apiKey ?? ""),
      model: String(src.model ?? ""),
    };
    if (legacy.apiBaseUrl !== "" || legacy.model !== "") {
      providers = [{
        id: "legacy",
        name: "默认供应商",
        apiBaseUrl: legacy.apiBaseUrl,
        apiKey: legacy.apiKey,
        models: legacy.model !== ""
          ? [{ id: legacy.model, vision: guessVision(legacy.model) }]
          : [],
      }];
    }
  }

  let active = String(src.active ?? "");
  if (!resolveTarget(providers, active)) {
    const first = providers[0];
    active = first && first.models.length > 0 ? `${first.id}:${first.models[0].id}` : "";
  }
  return { providers, active, enabled: src.enabled === true };
}

/** 解析 "providerId:modelId"（active），返回 { provider, model } 或 null。 */
function resolveTarget(providers, active) {
  const sep = String(active ?? "").indexOf(":");
  if (sep <= 0) return null;
  const pid = String(active).slice(0, sep);
  const mid = String(active).slice(sep + 1);
  if (pid === "" || mid === "") return null;
  const provider = providers.find((p) => p.id === pid);
  if (!provider) return null;
  const model = provider.models.find((m) => m.id === mid);
  if (!model) return null;
  return { provider, model };
}

/** 读取请求体 JSON。 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

/**
 * 常见厂商内置模型候选：当端点拉不到实时列表（未填 Key / 不支持列表接口）时，
 * 按 baseUrl 匹配厂商，返回其常用模型供用户直接勾选（仍需 Key 才能实际使用）。
 * 模型可以是字符串（vision 用 guessVision 判断），也可以是 { id, vision } 显式指定。
 */
const PRESET_MODEL_CATALOG = [
  { match: "api.openai.com", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3", "o4-mini", "gpt-4-turbo"] },
  { match: "api.anthropic.com", models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"] },
  { match: "api.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"] },
  // 以下厂商的模型列表为实时 /models 接口实测确认（2026-08），避免展示已下线的旧 ID。
  { match: "xiaomimimo", models: [
    "mimo-v2.5",
    { id: "mimo-v2.5-pro", vision: false },
    "mimo-v2.5-asr",
    "mimo-v2.5-tts",
    "mimo-v2.5-tts-voiceclone",
    "mimo-v2.5-tts-voicedesign",
  ] },
  { match: "siliconflow", models: [
    "Qwen/Qwen3-VL-32B-Instruct",
    "Qwen/Qwen3-VL-8B-Instruct",
    "Qwen/Qwen3-Omni-30B-A3B-Instruct",
    "zai-org/GLM-4.5V",
    "moonshotai/Kimi-K2.7-Code",
    "Pro/moonshotai/Kimi-K2.6",
    "zai-org/GLM-5.2",
    "MiniMaxAI/MiniMax-M2.5",
    "deepseek-ai/DeepSeek-V4-Flash",
    "Tongyi-MAI/Z-Image-Turbo",
    "Qwen/Qwen3.6-35B-A3B",
  ] },
  { match: "bigmodel.cn", models: ["glm-4v-plus", "glm-4v-flash", "glm-4.5v", "glm-4.5", "glm-4-plus", "glm-4-flash", "glm-4.5-air"] },
  { match: "dashscope", models: [
    "qwen-vl-max",
    "qwen-vl-plus",
    "qwen3-vl-plus",
    "qwen3-vl-flash",
    "qwen3.5-omni-plus",
    "qwen3.5-omni-plus-realtime",
    "qwen3-omni-flash",
    "qwen-vl-ocr",
  ] },
  // OVHcloud AI Endpoints 匿名层：免注册、免 Key（每 IP/模型 2 次/分钟），大陆可直连。
  { match: "kepler.ai.cloud.ovh.net", models: [
    { id: "Qwen2.5-VL-72B-Instruct", vision: true },
    "Qwen3.5-397B-A17B",
    "Qwen3.6-27B",
    "Mistral-Small-3.2-24B-Instruct-2506",
    "Qwen3.5-9B",
  ] },
  { match: "moonshot.cn", models: ["moonshot-v1-8k-vision-preview", "moonshot-v1-32k-vision-preview", "kimi-latest"] },
  { match: "volces.com", models: ["doubao-1.5-vision-pro-32k-250115", "doubao-1.5-vision-lite-32k-250115", "doubao-1.5-pro-32k-250115", "doubao-seed-1-6-250615"] },
  { match: "qianfan", models: ["ernie-4.5-turbo-8k", "ernie-4.0-turbo-8k", "ernie-4.0-8k", "ernie-3.5-8k", "ernie-lite-8k"] },
  { match: "hunyuan", models: ["hunyuan-vision", "hunyuan-turbo-vision", "hunyuan-t1-latest", "hunyuan-standard"] },
  { match: "minimax", models: ["MiniMax-VL-01", "MiniMax-M2.5", "MiniMax-Text-01", "abab6.5s-chat"] },
  { match: "groq", models: ["llama-3.2-90b-vision-preview", "llama-3.2-11b-vision-preview", "llama-3.3-70b-versatile", "qwen-2.5-32b"] },
  { match: "openrouter", models: ["openai/gpt-4o", "anthropic/claude-3.5-sonnet", "qwen/qwen-2.5-vl-72b-instruct", "google/gemini-2.0-flash-exp", "meta-llama/llama-3.2-90b-vision"] },
  { match: "mistral", models: ["pixtral-large-latest", "pixtral-12b-2409", "mistral-large-latest"] },
  { match: "x.ai", models: ["grok-2-vision-1212", "grok-4", "grok-3", "grok-3-mini"] },
  { match: "lingyiwanwu", models: ["yi-vision-v3", "yi-vl-plus", "yi-large"] },
  { match: "stepfun", models: ["step-1v-8k", "step-1v-32k", "step-2-16k"] },
];

function findPreset(baseUrl) {
  const url = String(baseUrl ?? "").toLowerCase();
  for (const p of PRESET_MODEL_CATALOG) {
    if (url.includes(p.match)) return p;
  }
  return null;
}

/** 宽松解析模型列表：兼容 {data:[...]}、{models:[...]}、字符串数组等常见格式。 */
function extractModelIds(data) {
  if (!data || typeof data !== "object") return [];
  const pick = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map((m) => (typeof m === "string" ? m : m?.id)).filter((x) => typeof x === "string" && x !== "");
  };
  const fromData = pick(data.data);
  if (fromData.length > 0) return fromData;
  return pick(data.models);
}

/** 模型列表失败原因 → 用户可读提示。 */
function reasonMessage(reason) {
  switch (reason) {
    case "auth": return "未获取到实时模型列表：该端点需要有效的 API Key（当前 Key 缺失或无效）";
    case "not-found": return "该端点不支持模型列表接口，请手动输入模型名称添加";
    case "timeout": return "获取模型列表超时，请检查网络后重试";
    case "network": return "无法连接该端点，请检查地址与网络";
    case "shape": return "该端点返回的模型列表格式无法解析";
    case "http": return "该端点返回错误，无法获取模型列表";
    default: return "无法获取模型列表，请检查端点地址与 API Key";
  }
}

/** 尝试 OpenAI 兼容 /models。返回 { list, reason }。 */
async function tryListOpenAIModels(baseUrl, apiKey) {
  let resp;
  try {
    resp = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    return { list: null, reason: error?.name === "TimeoutError" ? "timeout" : "network" };
  }
  if (resp.status === 401 || resp.status === 403) return { list: null, reason: "auth" };
  if (resp.status === 404) return { list: null, reason: "not-found" };
  if (!resp.ok) return { list: null, reason: "http" };
  let data;
  try { data = await resp.json(); } catch { return { list: null, reason: "shape" }; }
  const list = extractModelIds(data);
  if (list.length === 0) return { list: null, reason: "shape" };
  return { list, reason: null };
}

/** 尝试 Anthropic 兼容 /v1/models。返回 { list, reason }。 */
async function tryListAnthropicModels(baseUrl, apiKey) {
  let resp;
  try {
    resp = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    return { list: null, reason: error?.name === "TimeoutError" ? "timeout" : "network" };
  }
  if (resp.status === 401 || resp.status === 403) return { list: null, reason: "auth" };
  if (resp.status === 404) return { list: null, reason: "not-found" };
  if (!resp.ok) return { list: null, reason: "http" };
  let data;
  try { data = await resp.json(); } catch { return { list: null, reason: "shape" }; }
  const list = extractModelIds(data);
  if (list.length === 0) return { list: null, reason: "shape" };
  return { list, reason: null };
}

function registerDiscoveryRoute(ctx, getConfig) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/models",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const baseUrl = String(body.baseUrl ?? "").replace(/\/+$/, "");
        const apiKey = await fallbackApiKey(ctx, getConfig, baseUrl, String(body.apiKey ?? ""));
        if (!baseUrl) {
          sendJson(res, 400, { error: "缺少 baseUrl" });
          return;
        }
        const first = await tryListOpenAIModels(baseUrl, apiKey);
        let second = null;
        if (first.list === null) second = await tryListAnthropicModels(baseUrl, apiKey);
        const found = first.list !== null ? first : second;

        if (found !== null && found.list !== null) {
          sendJson(res, 200, {
            models: found.list.map((m) => ({ id: m, vision: guessVision(m) })),
            source: "live",
          });
          return;
        }

        // 实时列表失败：分类原因；若命中内置厂商候选则返回候选（source: preset）
        const reason = first.reason === "auth" || (second !== null && second.reason === "auth")
          ? "auth"
          : (first.reason ?? second?.reason ?? "unknown");
        const preset = findPreset(baseUrl);
        if (preset !== null) {
          sendJson(res, 200, {
            models: preset.models.map((m) => (
              typeof m === "string"
                ? { id: m, vision: guessVision(m) }
                : { id: String(m.id), vision: m.vision ?? guessVision(m.id) }
            )),
            source: "preset",
            reason,
            warning: reasonMessage(reason),
          });
          return;
        }
        sendJson(res, 502, { error: reasonMessage(reason) });
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    },
  });
}

/** 配置读取/保存路由（供设置页回显与保存，绕过 settings wire 白名单）。 */
function registerConfigRoutes(ctx, getConfig, onSaved) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/config",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") {
          // 回显脱敏：明文 Key 不返回浏览器（env:/cred: 引用不是密钥本身，原样显示便于查看）
          const cfg = normalizeConfig(getConfig());
          for (const p of cfg.providers) {
            if (p.apiKey !== "" && !/^(env|cred):/.test(p.apiKey)) p.apiKey = MASKED_KEY;
          }
          sendJson(res, 200, { config: cfg });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          // 以当前配置为基础，叠加请求中的字段（client 可只发改动的部分）。
          const merged = normalizeConfig({ ...getConfig(), ...body });
          // 脱敏占位 → 保留原 Key（设置页"留空 = 不修改"）；env:/cred: 引用原样保留
          const prev = normalizeConfig(getConfig());
          for (const p of merged.providers) {
            if (p.apiKey === MASKED_KEY) {
              const old = prev.providers.find((x) => x.id === p.id);
              p.apiKey = old ? old.apiKey : "";
            }
          }
          // 明文 Key → 自动写入 DSH 凭据存储（~/.dsh/.credentials.yaml），settings 只留 cred:REF 引用，
          // 保证任何写入路径都不会把密钥明文落进 settings.yaml。
          for (const p of merged.providers) {
            const key = String(p.apiKey ?? "");
            if (key === "" || key === MASKED_KEY || /^(env|cred):/.test(key)) continue;
            const ref = credentialRefFor(p.id);
            const credentials = ctx.get("credentials");
            if (credentials === void 0) {
              sendJson(res, 500, { error: "凭据服务不可用：已拒绝保存明文 API Key，请改用 cred:REF 或 env:VAR 引用" });
              return;
            }
            try {
              await credentials.set(ref, key);
            } catch (error) {
              sendJson(res, 500, { error: `保存 API Key 到凭据存储失败（已拒绝写入 settings）：${String(error?.message ?? error)}` });
              return;
            }
            p.apiKey = `cred:${ref}`;
          }
          const settings = ctx.get("settings");
          if (settings === void 0) {
            sendJson(res, 500, { error: "settings 服务不可用" });
            return;
          }
          await settings.update(SETTINGS_NS, {
            enabled: merged.enabled,
            providers: merged.providers,
            active: merged.active,
            // 清空旧版单配置字段，防止供应商删空后 normalizeConfig 用它们把 legacy 复活
            apiBaseUrl: "",
            apiKey: "",
            model: "",
          });
          try { onSaved?.(); } catch { /* 同步失败忽略 */ }
          sendJson(res, 200, { ok: true, config: merged });
          return;
        }
        sendJson(res, 405, { error: "method not allowed" });
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    },
  });
}

/** 激活路由：切换当前使用的供应商/模型。 */
function registerActivateRoute(ctx, getConfig, onSaved) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/activate",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const providerId = String(body.providerId ?? "");
        const modelId = String(body.modelId ?? "");
        const merged = normalizeConfig(getConfig());
        const provider = merged.providers.find((p) => p.id === providerId);
        if (!provider) {
          sendJson(res, 400, { error: `供应商不存在: ${providerId}` });
          return;
        }
        const model = provider.models.find((m) => m.id === modelId);
        if (!model) {
          sendJson(res, 400, { error: `模型不存在于该供应商: ${modelId}` });
          return;
        }
        merged.active = `${providerId}:${modelId}`;
        const settings = ctx.get("settings");
        if (settings === void 0) {
          sendJson(res, 500, { error: "settings 服务不可用" });
          return;
        }
        await settings.update(SETTINGS_NS, {
          enabled: merged.enabled,
          providers: merged.providers,
          active: merged.active,
          // 与 config 路由保持一致：清空旧版单配置字段
          apiBaseUrl: "",
          apiKey: "",
          model: "",
        });
        try { onSaved?.(); } catch { /* 同步失败忽略 */ }
        sendJson(res, 200, { ok: true, config: merged });
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    },
  });
}

/**
 * 余额查询：各厂商余额接口路径与响应格式差异很大，这里按常见路径逐一探测，
 * 并在响应 JSON 中宽松查找余额字段（balance / total_available / quota / credit …）。
 */
const BALANCE_KEYS = ["balance", "total_available", "available_balance", "remaining", "remain_quota", "quota", "credit", "total_remaining"];

/** 部分厂商余额字段含义不同：硅基流动的 balance 可能是赠送余额，优先展示 totalBalance/chargeBalance。 */
function balanceKeysFor(baseUrl) {
  const url = String(baseUrl ?? "").toLowerCase();
  if (url.includes("siliconflow")) {
    return ["totalBalance", "chargeBalance", "total_balance", "charge_balance", "balance", ...BALANCE_KEYS];
  }
  return BALANCE_KEYS;
}

function pickBalance(data, depth, keys = BALANCE_KEYS) {
  if (!data || typeof data !== "object" || depth > 4) return null;
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v)) return { value: v, key };
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return { value: Number(v), key };
  }
  for (const key of Object.keys(data)) {
    const found = pickBalance(data[key], depth + 1, keys);
    if (found !== null) return found;
  }
  return null;
}

function pickCurrency(data, depth) {
  if (!data || typeof data !== "object" || depth > 4) return null;
  if (typeof data.currency === "string" && data.currency !== "") return data.currency;
  if (Array.isArray(data.balanceInfos) && data.balanceInfos[0]?.currency) return data.balanceInfos[0].currency;
  for (const key of Object.keys(data)) {
    if (key === "currency") continue;
    const found = pickCurrency(data[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** 国内厂商默认人民币计价（接口未返回 currency 时使用）。 */
function guessCurrency(baseUrl) {
  const url = String(baseUrl ?? "").toLowerCase();
  const cnyHosts = [
    "siliconflow", "xiaomimimo", "bigmodel", "dashscope", "moonshot",
    "volces", "qianfan", "hunyuan", "lingyiwanwu", "stepfun", "deepseek", "minimax",
  ];
  return cnyHosts.some((h) => url.includes(h)) ? "CNY" : "USD";
}

/** 已知无法查询余额的厂商 → 给出明确指引（平台本身不提供余额接口）。 */
function balanceHint(baseUrl) {
  const url = String(baseUrl ?? "").toLowerCase();
  if (url.includes("dashscope")) {
    return "阿里百炼（DashScope）的 API Key 不提供余额查询接口，请登录阿里云百炼控制台查看账户余额";
  }
  if (url.includes("xiaomimimo")) {
    return "小米 MiMo 网关未提供余额查询接口，请在小米开放平台控制台查看";
  }
  if (url.includes("volces")) {
    return "火山方舟的 API Key 不提供余额查询接口，请在火山引擎控制台查看";
  }
  if (url.includes("qianfan")) {
    return "百度千帆的 API Key 不提供余额查询接口，请在百度智能云控制台查看";
  }
  return null;
}

/** 探测多个常见余额接口路径，返回第一个能解析出余额的结果。 */
async function queryBalance(baseUrl, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const paths = [
    "/v1/user/balance",
    "/user/balance",
    "/dashboard/billing/credit_grants",
    "/v1/dashboard/billing/credit_grants",
    "/user/info",
    "/v1/user/info",
    "/api/user/self",
  ];
  const tried = [];
  for (const p of paths) {
    tried.push(p);
    try {
      const resp = await fetch(`${baseUrl}${p}`, { headers, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const balance = pickBalance(data, 0, balanceKeysFor(baseUrl));
      if (balance !== null) {
        return {
          ok: true,
          balance: balance.value,
          unit: balance.key === "quota" ? "quota" : "currency",
          currency: pickCurrency(data) ?? guessCurrency(baseUrl),
          source: p,
        };
      }
    } catch {
      // 该路径失败，继续下一个
    }
  }
  return { ok: false, error: `该端点未提供余额查询接口（已尝试 ${tried.length} 个路径）`, hint: balanceHint(baseUrl), tried };
}

/**
 * 附件存储引用 URL 解析：/api/dsh-image-vision/raw/<encodedId>?m=..&b=..&w=..&h=..
 * 支持相对路径与完整 URL 两种形态。返回完整 ref（含校验元数据），无法解析返回 null。
 * 元数据编进 URL 而非依赖内存注册表：重启后旧消息里的引用仍可渲染与精读。
 */
function attachRefFromUrl(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const m = s.match(/\/api\/dsh-image-vision\/raw\/([^?]+)(?:\?(.*))?$/i);
  if (m === null) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return null; }
  if (!/^sha256:[a-f0-9]{64}$/i.test(id)) return null;
  const q = new URLSearchParams(m[2] ?? "");
  const mediaType = q.get("m") ?? "";
  const bytes = Number(q.get("b"));
  const width = Number(q.get("w"));
  const height = Number(q.get("h"));
  if (!(mediaType in DRAFT_EXT)) return null;
  if (!Number.isFinite(bytes) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (bytes <= 0 || width <= 0 || height <= 0) return null;
  return { attachmentId: id, mediaType, bytes, width, height };
}

/**
 * 输入框图片上传路由（附件存储版）：POST /api/dsh-image-vision/attach
 * 接收 base64 图片，校验后写入 DSH 附件存储（attachments.saveImage，permanent），
 * 返回 { note, markdown }：note 为 `[image attachment <JSON>]`（工具可解析完整引用），
 * markdown 为 `![图片](/api/dsh-image-vision/raw/<id>?m=..&b=..&w=..&h=..)`（渲染/精读用）。
 * 图片字节永不进会话记录；引用永久有效（附件存储无自动清理）。
 */
function registerAttachRoute(ctx) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/attach",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const mediaType = String(body.mediaType ?? "");
        const data = String(body.data ?? "");
        if (!(mediaType in DRAFT_EXT)) {
          sendJson(res, 400, { error: `不支持的图片类型: ${mediaType || "(空)"}（支持 png/jpeg/webp/gif）` });
          return;
        }
        if (data === "") {
          sendJson(res, 400, { error: "缺少图片数据（data 应为 base64 字符串）" });
          return;
        }
        let bytes;
        try {
          bytes = Buffer.from(data, "base64");
        } catch {
          sendJson(res, 400, { error: "图片数据不是合法的 base64" });
          return;
        }
        if (bytes.length === 0) {
          sendJson(res, 400, { error: "图片数据为空" });
          return;
        }
        if (bytes.length > DRAFT_MAX_BYTES) {
          sendJson(res, 400, { error: `图片过大（${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 20MB，且受附件存储 ${attachmentMaxBytesHint(ctx)} 限制）` });
          return;
        }
        if (!verifyImageMagic(bytes, mediaType)) {
          sendJson(res, 400, { error: "图片文件头校验失败：文件内容与声明的类型不符" });
          return;
        }
        const attachments = ctx.get("attachments");
        if (attachments === void 0) {
          sendJson(res, 500, { ok: false, error: "attachment 服务未装配，无法存储图片" });
          return;
        }
        const name = typeof body.name === "string" && body.name !== "" ? body.name : void 0;
        // saveImage 内部做完整解码校验（类型/像素/字节上限，默认单张 5MB），失败抛 AttachmentError。
        const ref = await attachments.saveImage({
          data: bytes,
          mediaType,
          ...(name !== void 0 ? { name } : {}),
        });
        const q = `m=${encodeURIComponent(ref.mediaType)}&b=${ref.bytes}&w=${ref.width}&h=${ref.height}`;
        const rawPath = `/api/dsh-image-vision/raw/${encodeURIComponent(ref.attachmentId)}?${q}`;
        sendJson(res, 200, {
          ok: true,
          note: `[image attachment ${JSON.stringify(ref)}]`,
          markdown: `![图片](${rawPath})`,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });
}

/** 附件存储单张字节上限提示（读 store 配置，读取失败给宽松值）。 */
function attachmentMaxBytesHint(ctx) {
  try {
    const cfg = ctx.get("attachment-local")?.config ?? null;
    if (cfg !== null && Number.isFinite(cfg.maxImageBytes)) return `${(cfg.maxImageBytes / 1024 / 1024).toFixed(1)}MB`;
  } catch { /* 忽略 */ }
  return "5MB";
}

/**
 * 附件图片回读路由：GET /api/dsh-image-vision/raw/<encodedId>?m=..&b=..&w=..&h=..
 * 从 DSH 附件存储读取字节（digest + 类型 + 尺寸三重校验），供消息渲染与浏览器预览。
 * 引用元数据来自 URL query，进程重启后旧引用依然可读。
 */
function registerRawRoute(ctx) {
  return ctx.webServer.register({
    kind: "prefix",
    path: "/api/dsh-image-vision/raw",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const ref = attachRefFromUrl(url.pathname + url.search);
        if (ref === null) {
          sendJson(res, 400, { error: "invalid attachment reference" });
          return;
        }
        const attachments = ctx.get("attachments");
        if (attachments === void 0) {
          sendJson(res, 500, { error: "attachment 服务未装配" });
          return;
        }
        const stored = await attachments.readImage(ref, AbortSignal.timeout(15000));
        res.statusCode = 200;
        res.setHeader("content-type", ref.mediaType);
        res.setHeader("content-length", String(stored.data.byteLength));
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
        res.end(Buffer.from(stored.data));
      } catch {
        sendJson(res, 404, { error: "attachment not found or corrupt" });
      }
    },
  });
}

/**
 * 草稿图片短路由：GET /i/<name>（prefix）。
 * 浏览器无法直接访问本地磁盘路径，输入框预览条与消息中的图片引用经此路由加载。
 * 文件名白名单校验（iv- 前缀 + 图片扩展名），杜绝路径穿越。
 */
function registerDraftImageShortRoute(ctx) {
  return ctx.webServer.register({
    kind: "prefix",
    path: "/i",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const rawPath = new URL(req.url ?? "/", "http://x").pathname;
        const name = rawPath.slice("/i/".length);
        if (!/^iv-[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/.test(name)) {
          sendJson(res, 400, { error: "invalid draft image name" });
          return;
        }
        const bytes = await readFile(join(DRAFTS_DIR, name));
        const ext = name.split(".").pop() ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", MIME_MAP[ext] ?? "application/octet-stream");
        res.setHeader("cache-control", "private, max-age=3600");
        res.end(bytes);
      } catch {
        sendJson(res, 404, { error: "draft image not found" });
      }
    },
  });
}

/** 草稿图片服务路由：GET /api/dsh-image-vision/draft-image?name=iv-xxx.jpg
 * 浏览器无法直接访问本地磁盘路径，输入框图片预览条经此路由加载缩略图。
 * 文件名白名单校验（iv- 前缀 + 图片扩展名），杜绝路径穿越。
 */
function registerDraftImageRoute(ctx) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/draft-image",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const name = url.searchParams.get("name") ?? "";
        if (!/^iv-[A-Za-z0-9-]+\.(png|jpe?g|webp|gif)$/.test(name)) {
          sendJson(res, 400, { error: "invalid draft image name" });
          return;
        }
        const bytes = await readFile(join(DRAFTS_DIR, name));
        const ext = name.split(".").pop() ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", MIME_MAP[ext] ?? "application/octet-stream");
        res.setHeader("cache-control", "private, max-age=3600");
        res.end(bytes);
      } catch {
        sendJson(res, 404, { error: "draft image not found" });
      }
    },
  });
}

/** 余额查询路由：给定 baseUrl + apiKey，探测该端点的余额接口。 */
function registerBalanceRoute(ctx, getConfig) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/balance",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const baseUrl = String(body.apiBaseUrl ?? "").replace(/\/+$/, "");
        const apiKey = await fallbackApiKey(ctx, getConfig, baseUrl, String(body.apiKey ?? ""));
        if (!baseUrl) {
          sendJson(res, 400, { error: "缺少 apiBaseUrl" });
          return;
        }
        const result = await queryBalance(baseUrl, apiKey);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });
}

/**
 * 在线更新工具：比较语义化版本（返回正数表示 left 更新）。
 */
function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
    if (match === null) return [0, 0, 0];
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function normalizedReleaseVersion(tag) {
  if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag.trim())) return void 0;
  return tag.trim().replace(/^v/, "");
}

const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const UPDATE_CACHE_TTL_MS = 15 * 60_000;
let updateCache = void 0;

/** 读取最新稳定 GitHub Release，带短时缓存；失败抛错（可选功能，调用方自行兜底）。 */
async function checkForUpdate() {
  const now = Date.now();
  if (updateCache !== void 0 && updateCache.expiresAt > now) return updateCache.value;
  const response = await fetch(RELEASES_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "dsh-image-vision-update-check",
    },
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload === null || typeof payload !== "object") throw new Error("GitHub Releases returned malformed JSON");
  const release = payload;
  if (release.draft === true || release.prerelease === true) throw new Error("latest GitHub Release is not stable");
  const latestVersion = normalizedReleaseVersion(release.tag_name);
  if (latestVersion === void 0) throw new Error("latest GitHub Release has an invalid version tag");
  const releaseUrl = typeof release.html_url === "string" ? release.html_url : "https://github.com/xiaoyuink/dsh-image-vision/releases";
  const value = {
    currentVersion: PLUGIN_VERSION,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, PLUGIN_VERSION) > 0,
    releaseUrl,
    ...(typeof release.published_at === "string" ? { publishedAt: release.published_at } : {}),
  };
  updateCache = { expiresAt: now + UPDATE_CACHE_TTL_MS, value };
  return value;
}

/** 解析启动当前 DSH 进程的 profile（默认 web）。 */
function profileFromProcess() {
  const envProfile = String(process.env.DSH_PROFILE ?? "").trim();
  if (/^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile;
  const index = process.argv.indexOf("--profile");
  const explicit = index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
  if (/^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit;
  return "web";
}

/**
 * 运行官方文档记载的安装命令：dsh plugin --profile <profile> add <name>@<version>。
 * version 必须是 stable semver（预发布标签用 - 分隔），防止注入。
 */
function installUpdate(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    return Promise.reject(new Error("invalid update version"));
  }
  const profile = profileFromProcess();
  const command = process.platform === "win32" ? "dsh.cmd" : "dsh";
  const child = spawn(command, ["plugin", "--profile", profile, "add", `${PACKAGE_NAME}@${version}`], {
    shell: process.platform === "win32",
    stdio: "ignore",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal === null ? `plugin update exited with code ${code ?? "unknown"}` : `plugin update terminated by ${signal}`));
    });
  });
}

/** 更新检查 + 应用更新路由（与 image-create 的同名接口保持一致的响应结构）。 */
function registerUpdateRoutes(ctx) {
  const disposers = [
    ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-image-vision/update/check",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, update: await checkForUpdate() });
        } catch (error) {
          sendJson(res, 200, { ok: false, code: "update-check-failed", message: String(error?.message ?? error) });
        }
      },
    }),
    ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-image-vision/update/apply",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const version = String(body.version ?? "");
          if (version === "") {
            sendJson(res, 200, { ok: false, code: "bad-request", message: "update version is required" });
            return;
          }
          const latest = await checkForUpdate();
          if (!latest.updateAvailable || latest.latestVersion !== version) {
            sendJson(res, 200, { ok: false, code: "update-not-available", message: `version ${version} is not the latest available release` });
            return;
          }
          await installUpdate(version);
          sendJson(res, 200, { ok: true, currentVersion: PLUGIN_VERSION, updatedVersion: version, restartRequired: true });
        } catch (error) {
          sendJson(res, 200, { ok: false, code: "update-failed", message: String(error?.message ?? error) });
        }
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * 输入框图片上传路由：接收 base64 图片，校验后落盘到 ~/.dsh/plugin/dsh-image-vision/drafts/，
 * 返回本地绝对路径（正斜杠）。输入框粘贴/上传的图片经此保存，随后以
 * `![图片](路径)` 引用标记插入草稿，模型收到后调用 image_vision 工具识别。
 */
function registerUploadRoute(ctx) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/upload",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const mediaType = String(body.mediaType ?? "");
        const data = String(body.data ?? "");
        if (!(mediaType in DRAFT_EXT)) {
          sendJson(res, 400, { error: `不支持的图片类型: ${mediaType || "(空)"}（支持 png/jpeg/webp/gif）` });
          return;
        }
        if (data === "") {
          sendJson(res, 400, { error: "缺少图片数据（data 应为 base64 字符串）" });
          return;
        }
        let bytes;
        try {
          bytes = Buffer.from(data, "base64");
        } catch {
          sendJson(res, 400, { error: "图片数据不是合法的 base64" });
          return;
        }
        if (bytes.length === 0) {
          sendJson(res, 400, { error: "图片数据为空" });
          return;
        }
        if (bytes.length > DRAFT_MAX_BYTES) {
          sendJson(res, 400, { error: `图片过大（${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 20MB）` });
          return;
        }
        if (!verifyImageMagic(bytes, mediaType)) {
          sendJson(res, 400, { error: "图片文件头校验失败：文件内容与声明的类型不符" });
          return;
        }
        const saved = await saveDraftImage(mediaType, bytes);
        cleanupDrafts().catch(() => {});
        sendJson(res, 200, { ok: true, ...saved });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });
}

/**
 * 当前默认模型识图能力查询路由：GET /api/dsh-image-vision/current-model-vision
 * client 发送层 hook 用它判断"带图发送是否需要改写为草稿引用"：
 * - 当前模型真能识图（inputModalities 含 image）→ 图片块走原生链路直接给模型看；
 * - 当前模型不识图（如 DeepSeek V4 Flash）→ hook 把图片改写为 `![图片](i/iv-xxx.jpg)`
 *   纯文本引用，模型按系统规则调用 image_vision 系列工具识别。
 * 与 image_vision 工具内部 shared 同一判断（agentDefaultModel + llm.resolveModelInfo）。
 */
function registerCurrentModelVisionRoute(ctx) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/current-model-vision",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const vision = await currentModelHasVision(ctx);
        sendJson(res, 200, { vision });
      } catch {
        sendJson(res, 200, { vision: false });
      }
    },
  });
}

function apply(ctx) {
  try {
    return applyInner(ctx);
  } catch (error) {
    // 诊断用：apply 失败时把真实错误 dump 到日志，便于排查加载失败原因。
    try {
      writeFileSync(join(homedir(), ".dsh", "super-injector", "apply-error.log"), String(error?.stack ?? error));
    } catch { /* 日志写入失败忽略 */ }
    throw error;
  }
}

function applyInner(ctx) {
  // settings 是可选服务：有则注册并读取，无则用空配置兜底。
  let configSource = () => ({ providers: [], active: "" });
  // 工具/系统提示 disposer 容器：由 refreshState 按总开关状态注册/注销。
  const toolDisposers = [];
  let sysPromptDisposer = null;
  function unregisterAllTools() {
    while (toolDisposers.length > 0) {
      try { toolDisposers.pop()(); } catch { /* 注销失败忽略 */ }
    }
  }

  ctx.inject(["settings"], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NS, SettingsSchema);
    configSource = () => scope.get();
    // settings 就绪后重算工具/系统提示（延迟到 apply 完成后再执行，
    // 避免同步回调阶段引用尚未初始化的 toolDisposers 等容器）。
    queueMicrotask(refreshState);
  });

  // 状态刷新：总开关开启时注册识图工具 + 系统提示；关闭时全部注销（等效插件不存在）。
  function refreshState() {
    const on = configHasVisionModel(configSource());
    if (on) {
      if (toolDisposers.length === 0) {
        try { registerAllTools(); } catch { /* 注册失败忽略 */ }
      }
      if (sysPromptDisposer === null) {
        try {
          sysPromptDisposer = ctx.systemPrompt.section({
            name: "dsh-image-vision:image-refs",
            order: 110,
            text:
              "## 图片识别\n" +
              "用户消息中可能出现图片引用标记，形如 `![图片](C:/完整/本地/路径/xxx.png)`、" +
              "`![图片](i/iv-xxx.jpg)`（输入框粘贴/上传的草稿图片，文件名以 iv- 开头）、" +
              "`![图片](/api/dsh-image-vision/raw/sha256…?m=..&b=..&w=..&h=..)`（附件存储引用，永久有效）或直接以「图片：」后跟图片引用。遇到这种标记时：\n" +
              "- **第一步：整图识别**。当用户询问「这是什么」或需要了解整张图片的内容时，直接调用 image_vision 工具，把标记中的图片引用（本地路径、i/文件名或附件存储 URL 整段）作为 images 参数传入，先用默认预设（general 整图描述）识别整张图片；不要在第一步就用 OCR 只读文字或拆分图片。\n" +
              "- **第二步：按需精读**。整图识别完成后再决定是否进一步处理：需要核对/读取图上文字时调用 image_vision_ocr；需要放大查看局部细节、小字或截图区域时，先调用 image_vision_ground 定位目标，再用 image_vision_crop 裁剪放大，裁剪结果可继续传给 image_vision / image_vision_ocr 迭代查看。\n" +
              "- 不要尝试用文件读取类工具直接读取该引用（二进制图片无法通过文本方式读取）；\n" +
              "- 分析完成后，把每张图片的内容整理成清晰的描述回复用户。",
          });
        } catch { /* 注册失败忽略 */ }
      }
    } else {
      unregisterAllTools();
      if (sysPromptDisposer !== null) {
        try { sysPromptDisposer(); } catch { /* 注销失败忽略 */ }
        sysPromptDisposer = null;
      }
    }
  }

  // 资源注册统一挂 ctx.effect：fiber dispose 时自动清理，热重载不残留
  // （此前手动收集 disposers 在 apply 返回函数里 dispose，实测重载时路由残留导致
  //  "webserver: duplicate exact route" 撞车失败）。
  ctx.effect(() => {
    const disposers = [
      registerDiscoveryRoute(ctx, () => configSource()),
      // 传 () => configSource() 间接层，确保路由始终读到最新的 configSource 闭包。
      // onSaved：配置保存/激活后立即重同步识图工具 + 系统提示（增删视觉模型即时生效）。
      registerConfigRoutes(ctx, () => configSource(), refreshState),
      registerActivateRoute(ctx, () => configSource(), refreshState),
      registerTestModelRoute(ctx, () => configSource()),
      registerBalanceRoute(ctx, () => configSource()),
      registerUploadRoute(ctx),
      registerCurrentModelVisionRoute(ctx),
      registerAttachRoute(ctx),
      registerRawRoute(ctx),
      registerDraftImageRoute(ctx),
      registerDraftImageShortRoute(ctx),
      registerUpdateRoutes(ctx),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  });

  // （系统提示 section 已由 refreshState 按总开关状态管理，见上方定义。）

  // 识图工具 + 系统提示 生命周期：跟随 llm provider 注册表变化 + 插件配置变化（refreshState）
  ctx.effect(() => {
    refreshState();
    const off = ctx.on("llm/adapters-updated", () => refreshState());
    return () => {
      off();
      unregisterAllTools();
      if (sysPromptDisposer !== null) {
        try { sysPromptDisposer(); } catch { /* 注销失败忽略 */ }
        sysPromptDisposer = null;
      }
    };
  });

  // execute 阶段保存的图片附件引用，按 callId 索引，供 finalizeContent 组装 image blocks。
  const pendingNative = new Map();

  /** 注册全部识图工具（总开关开启时调用；disposer 由 unregisterAllTools 统一注销）。 */
  function registerAllTools() {
    toolDisposers.push(ctx.tools.register(
    defineTool({
      name: "image_vision",
      description:
        "识别图片 / 分析图片内容。传入一张或多张图片的本地路径，插件会自动判断当前模型是否具备识图能力：" +
        "若当前模型可识图，则按预设的专业提示词让它直接分析图片；" +
        "否则调用插件设置中当前使用的视觉供应商/模型识别后返回结果。" +
        "支持预设：histopathology（病理）、cell_biology（细胞/实验）、anatomy（解剖/影像）、" +
        "scientific_figure（统计图）、composite_figure（组合大图）、clinical（临床）、general（通用）。",
      parameters: {
        images: {
          type: "array",
          required: true,
          description:
            "图片引用列表，支持四种形式：① 本地绝对路径（C:/.../image.jpg）；" +
            "② 草稿图片短名（i/iv-xxx.jpg，来自输入框粘贴的图片标记）；" +
            "③ 草稿图片 URL（http://.../i/iv-xxx.jpg）；" +
            "④ 附件存储引用 URL（/api/dsh-image-vision/raw/<sha256>?m=..&b=..&w=..&h=..，整段 URL 传入，永久有效）。",
          items: { type: "string" },
        },
        preset: {
          type: "string",
          description:
            "分析预设。按图片内容选择：病理→histopathology，细胞/WB/FACS→cell_biology，" +
            "CT/MRI/解剖→anatomy，统计图→scientific_figure，组合大图→composite_figure，" +
            "临床→clinical，其余→general（默认）",
        },
        prompt: {
          type: "string",
          description: "自定义分析提示词；提供后会替换预设提示词（仍保留预设的参数默认值）",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args, exec) {
        const presetName = typeof args.preset === "string" && args.preset in PRESET_PROMPTS
          ? args.preset
          : "general";
        const prompt = typeof args.prompt === "string" && args.prompt.trim() !== ""
          ? args.prompt
          : PRESET_PROMPTS[presetName];

        const hasVision = await currentModelHasVision(ctx, exec.signal);

        if (hasVision) {
          // 当前模型可识图：把图片存为 attachment，作为 image block 交给当前模型。
          const refs = [];
          for (const p of args.images) {
            refs.push(await saveAsAttachment(ctx, p, exec.signal));
          }
          pendingNative.set(exec.callId, { refs, prompt });
          return "图片已提交给当前视觉模型，请按下面的提示词逐张分析。";
        }

        // 当前模型不识图：调用插件设置中当前使用的视觉模型（带降级）。
        const config = normalizeConfig(configSource());
        try {
          return await callVisionWithFallback(ctx, config, args.images, prompt, exec.signal);
        } catch (err) {
          // 不让工具错误导致整轮对话崩溃；返回可读错误信息让模型告知用户
          return `视觉模型调用失败：${String(err?.message ?? err)}\n请检查 DSH 设置 → 识图插件中的供应商余额和配置。`;
        }
      },
      finalizeContent(exec) {
        const state = pendingNative.get(exec.callId);
        if (state === void 0) return undefined;
        pendingNative.delete(exec.callId);
        const blocks = state.refs.map((ref) => ({ type: "image", attachment: ref }));
        blocks.push({ type: "text", text: state.prompt });
        return blocks;
      },
    }),));
  // 工具输出的小图片（crop）会落盘到草稿目录并返回图片引用，模型可继续传给
  // image_vision / image_vision_ocr / image_vision_ground，形成「定位→裁剪→放大→再识别」闭环。

  /** 用 sharp 读取图片尺寸。 */
  async function imageSizeOf(bytes) {
    const sharp = await loadSharp();
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  }

  /** 用当前视觉模型对图片执行专用提示词（用于定位/OCR 等精细任务）。 */
  async function askVisionModel(images, prompt, signal) {
    const config = normalizeConfig(configSource());
    return callVisionWithFallback(ctx, config, images, prompt, signal);
  }

  toolDisposers.push(ctx.tools.register(defineTool({
    name: "image_vision_crop",
    description:
      "按像素坐标裁剪图片的局部区域并放大，返回新的图片引用。适合放大查看细节（核对小字、检查局部区域）。" +
      "返回的图片引用可继续传给 image_vision / image_vision_ocr / image_vision_ground 工具，实现多步迭代查看。",
    parameters: {
      image: {
        type: "string",
        required: true,
        description: "图片引用：本地绝对路径、草稿短名（i/iv-xxx.jpg）或 URL",
      },
      region: {
        type: "string",
        required: true,
        description: '裁剪区域 "x1,y1,x2,y2"（原图像素坐标，先可用 image_vision_ground 定位）',
      },
      scale: {
        type: "number",
        description: "放大倍数（1-8，默认 2）",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const { bytes } = await resolveImageRef(ctx, args.image, exec.signal);
      const box = parseRegion(args.region);
      if (box === void 0) {
        throw new Error(`image_vision_crop: 无效的 region "${args.region}"（应为 "x1,y1,x2,y2" 整数且 x2>x1、y2>y1）`);
      }
      const sharp = await loadSharp();
      const meta = await sharp(bytes, { failOn: "none" }).metadata();
      const iw = meta.width ?? 0;
      const ih = meta.height ?? 0;
      if (box.x2 > iw || box.y2 > ih) {
        throw new Error(`image_vision_crop: 裁剪范围超出图片边界（原图 ${iw}x${ih}，请求到 (${box.x2},${box.y2})）`);
      }
      const scale = Math.min(8, Math.max(1, Math.round(Number(args.scale) || 2)));
      const out = await sharp(bytes, { failOn: "none" })
        .extract({ left: box.x1, top: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 })
        .resize({ width: (box.x2 - box.x1) * scale, height: (box.y2 - box.y1) * scale })
        .png()
        .toBuffer();
      const saved = await saveDraftImage("image/png", out);
      const name = String(saved.path).split("/").pop();
      cleanupDrafts().catch(() => {});
      return (
        `已裁剪区域 (${box.x1},${box.y1})-(${box.x2},${box.y2})：原图 ${iw}x${ih} → 输出 ${(box.x2 - box.x1) * scale}x${(box.y2 - box.y1) * scale}（放大 ${scale}x）。\n` +
        `图片引用：![图片](i/${name})\n` +
        `需要继续查看时，把该引用传给 image_vision / image_vision_ocr / image_vision_ground 工具。`
      );
    },
  })));

  toolDisposers.push(ctx.tools.register(defineTool({
    name: "image_vision_ground",
    description:
      "在图片中定位某个目标（物体/文字/按钮/标牌等）的像素坐标范围，返回 bbox \"x1,y1,x2,y2\"。" +
      "可配合 image_vision_crop 裁剪放大局部，或配合 image_vision_ocr 读取局部文字。",
    parameters: {
      image: {
        type: "string",
        required: true,
        description: "图片引用：本地绝对路径、草稿短名（i/iv-xxx.jpg）或 URL",
      },
      target: {
        type: "string",
        required: true,
        description: "要定位的目标描述，例如：发送按钮、左上角的标语、红字第一行",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const { bytes, path } = await resolveImageRef(ctx, args.image, exec.signal);
      const { width, height } = await imageSizeOf(bytes);
      const prompt =
        `这张图片尺寸为 ${width}x${height} 像素。图中可能有多个相似目标，请只定位「${String(args.target)}」这一个目标，` +
        `返回单个矩形的四个整数：x1（左）、y1（上）、x2（右）、y2（下），` +
        `坐标为原图像素坐标，矩形需完整包围目标。只输出一行 JSON：{"x1":整数,"y1":整数,"x2":整数,"y2":整数}，不要输出数组或其他内容。`;
      const reply = String(await askVisionModel([path], prompt, exec.signal) ?? "").trim();
      // 解析容错：兼容 {x1:[...]} 等异常格式时取第一个数字；无法解析则原样返回并提示
      try {
        const parsed = JSON.parse(reply.replace(/```(json)?/g, "").trim());
        const pick = (v) => Array.isArray(v) ? v[0] : v;
        if (typeof pick(parsed.x1) === "number" && typeof pick(parsed.y1) === "number" &&
            typeof pick(parsed.x2) === "number" && typeof pick(parsed.y2) === "number") {
          return JSON.stringify({
            x1: Math.round(pick(parsed.x1)),
            y1: Math.round(pick(parsed.y1)),
            x2: Math.round(pick(parsed.x2)),
            y2: Math.round(pick(parsed.y2)),
          });
        }
      } catch { /* 非 JSON 则原样返回 */ }
      return `定位结果（原图 ${width}x${height}）：${reply}\n（若格式异常，请用 image_vision_crop 手动尝试不同区域，或用 image_vision 描述整图）`;
    },
  })));

  toolDisposers.push(ctx.tools.register(defineTool({
    name: "image_vision_ocr",
    description:
      "识别图片中的文字：逐字读出所有可见文字（包括小字、标语、截图文字、手写体尽量）。" +
      "适合核对具体文字内容；配合 image_vision_crop 先放大局部再识别效果更好。",
    parameters: {
      image: {
        type: "string",
        required: true,
        description: "图片引用：本地绝对路径、草稿短名（i/iv-xxx.jpg）或 URL",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const { path } = await resolveImageRef(ctx, args.image, exec.signal);
      const prompt =
        "请逐字、非常仔细地读出图片中的所有文字，包括小字和局部文字。按阅读顺序输出，每行文字占一行；" +
        "某个字无法确定时标注「？」；没有文字就只回答：无文字。";
      const reply = await askVisionModel([path], prompt, exec.signal);
      return String(reply ?? "").trim();
    },
  })));
  }
}

export { apply, inject, name };
