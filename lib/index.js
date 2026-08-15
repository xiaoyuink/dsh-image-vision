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
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { PRESET_CONFIGS, PRESET_PROMPTS } from "./presets.js";

const name = "dsh-image-vision";
const inject = ["tools", "llm", "agentDefaultModel", "attachments", "fs", "webServer"];

const SETTINGS_NS = settingsNamespace("image-vision");

// 内置测试图片（设置页「检测」按钮用它实测模型识图能力）。
const TEST_IMAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "test-image.jpg");
const TEST_PROMPT = "请用一句话描述这张图片的内容。";

const ModelSchema = z.object({
  id: z.string().description("模型名称"),
  vision: z.boolean().default(false).description("是否具备识图能力（自动判断，可手动纠正）"),
});
const ProviderSchema = z.object({
  id: z.string().description("供应商唯一标识"),
  name: z.string().description("供应商显示名称"),
  apiBaseUrl: z.string().description("视觉模型 API 端点（OpenAI 或 Anthropic 兼容）"),
  apiKey: z.string().description("API Key"),
  models: z.array(ModelSchema).default([]).description("该供应商下的模型列表"),
});
const SettingsSchema = z.object({
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
  const bytes = await readImageBytes(ctx, path, signal);
  const mediaType = mediaTypeOf(path);
  if (mediaType === void 0) {
    throw new Error(`不支持的图片格式: ${path}（支持 jpg/jpeg/png/gif/webp/bmp）`);
  }
  return ctx.attachments.saveImage({
    data: bytes,
    mediaType,
    name: String(path).split(/[\\/]/).pop(),
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
 * 调用插件配置的视觉模型（OpenAI 兼容 / Anthropic 兼容），返回识别文本。
 * 协议选择：baseUrl 含 "anthropic" 用 Anthropic Messages API，否则用 OpenAI chat.completions。
 */
async function callVisionModel(ctx, provider, modelId, imagePaths, prompt, signal) {
  const baseUrl = String(provider.apiBaseUrl ?? "").replace(/\/+$/, "");
  const apiKey = String(provider.apiKey ?? "");
  const model = String(modelId ?? "");
  if (!baseUrl || !apiKey || !model) {
    throw new Error("视觉模型未配置：请在插件设置中添加供应商和模型，并选择使用");
  }

  const images = [];
  for (const p of imagePaths) {
    const bytes = await readImageBytes(ctx, p, signal);
    images.push({ path: p, bytes });
  }

  if (baseUrl.toLowerCase().includes("anthropic")) {
    return callAnthropic(baseUrl, apiKey, model, images, prompt, signal);
  }
  return callOpenAI(baseUrl, apiKey, model, images, prompt, signal);
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
      "x-api-key": apiKey,
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
    throw new Error(`Anthropic 视觉模型调用失败 ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
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
      Authorization: `Bearer ${apiKey}`,
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
    throw new Error(`OpenAI 视觉模型调用失败 ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
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
    if (!baseUrl || !apiKey || !model) {
      return { ok: false, error: "缺少 baseUrl / apiKey / model", imageSupport: "unknown", latencyMs: latency() };
    }
    const bytes = await getTestImage();
    const images = [{ path: TEST_IMAGE_PATH, bytes }];
    const reply = baseUrl.toLowerCase().includes("anthropic")
      ? await callAnthropic(baseUrl, apiKey, model, images, TEST_PROMPT, signal)
      : await callOpenAI(baseUrl, apiKey, model, images, TEST_PROMPT, signal);
    return { ok: true, reply: String(reply ?? ""), latencyMs: latency() };
  } catch (error) {
    const message = String(error?.message ?? error);
    // 端点拒绝图片输入的特征性错误 → 判定为不支持识图
    const looksNoImage = /image input|no endpoints|does not support images|not support.*image|unsupported.*image|invalid.*image|image.*not supported/i.test(message);
    return { ok: false, error: message.slice(0, 400), imageSupport: looksNoImage ? false : "unknown", latencyMs: latency() };
  }
}

/** 检测路由：给定 baseUrl + apiKey + model，用内置测试图实测识图能力。 */
function registerTestModelRoute(ctx) {
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
          String(body.apiKey ?? ""),
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
  /qwen/i, /glm-4v/i, /glm-4\.5v/i, /internvl/i, /llava/i, /pixtral/i,
  /minicpm-v/i, /mimo/i, /kimi/i, /moonshot/i, /step-1v/i, /yi-vl/i,
  /cogvlm/i, /deepseek-vl/i, /hunyuan.*vision/i,
];

function guessVision(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  return VISION_HINTS.some((re) => re.test(id));
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
  return { providers, active };
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
  { match: "xiaomimimo", models: [
    "mimo-v2.5",
    { id: "mimo-v2.5-pro", vision: false },
    "mimo-v2.5-ultraspeed",
    { id: "mimo-v2.5-pro-ultraspeed", vision: false },
  ] },
  { match: "siliconflow", models: [
    "Qwen/Qwen2.5-VL-72B-Instruct",
    "Qwen/Qwen2.5-VL-7B-Instruct",
    "Pro/Qwen/Qwen2.5-VL-72B-Instruct",
    "Pro/Qwen/Qwen2.5-VL-7B-Instruct",
    "moonshotai/Kimi-K2.7-Code",
    "Pro/moonshotai/Kimi-K2.6",
    "zai-org/GLM-5.2",
    "MiniMaxAI/MiniMax-M2.5",
    "deepseek-ai/DeepSeek-V4-Flash",
    "Tongyi-MAI/Z-Image-Turbo",
  ] },
  { match: "bigmodel.cn", models: ["glm-4v-plus", "glm-4v-flash", "glm-4.5v", "glm-4.5", "glm-4-plus", "glm-4-flash", "glm-4.5-air"] },
  { match: "dashscope", models: ["qwen-vl-max", "qwen-vl-plus", "qwen-vl-max-latest", "qwen2.5-vl-72b-instruct", "qwen2.5-vl-7b-instruct"] },
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

function registerDiscoveryRoute(ctx) {
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
        const apiKey = String(body.apiKey ?? "");
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
function registerConfigRoutes(ctx, getConfig) {
  return ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-image-vision/config",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") {
          sendJson(res, 200, { config: normalizeConfig(getConfig()) });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          // 以当前配置为基础，叠加请求中的字段（client 可只发改动的部分）。
          const merged = normalizeConfig({ ...getConfig(), ...body });
          const settings = ctx.get("settings");
          if (settings === void 0) {
            sendJson(res, 500, { error: "settings 服务不可用" });
            return;
          }
          await settings.update(SETTINGS_NS, {
            providers: merged.providers,
            active: merged.active,
            // 清空旧版单配置字段，防止供应商删空后 normalizeConfig 用它们把 legacy 复活
            apiBaseUrl: "",
            apiKey: "",
            model: "",
          });
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
function registerActivateRoute(ctx, getConfig) {
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
          providers: merged.providers,
          active: merged.active,
          // 与 config 路由保持一致：清空旧版单配置字段
          apiBaseUrl: "",
          apiKey: "",
          model: "",
        });
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

function pickBalance(data, depth) {
  if (!data || typeof data !== "object" || depth > 4) return null;
  for (const key of BALANCE_KEYS) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v)) return { value: v, key };
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return { value: Number(v), key };
  }
  for (const key of Object.keys(data)) {
    const found = pickBalance(data[key], depth + 1);
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
      const balance = pickBalance(data);
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

/** 余额查询路由：给定 baseUrl + apiKey，探测该端点的余额接口。 */
function registerBalanceRoute(ctx) {
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
        const apiKey = String(body.apiKey ?? "");
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

function apply(ctx) {
  // settings 是可选服务：有则注册并读取，无则用空配置兜底。
  let configSource = () => ({ providers: [], active: "" });
  ctx.inject(["settings"], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NS, SettingsSchema);
    configSource = () => scope.get();
  });

  const disposers = [
    registerDiscoveryRoute(ctx),
    // 传 () => configSource() 间接层，确保路由始终读到最新的 configSource 闭包。
    registerConfigRoutes(ctx, () => configSource()),
    registerActivateRoute(ctx, () => configSource()),
    registerTestModelRoute(ctx),
    registerBalanceRoute(ctx),
  ];

  // execute 阶段保存的图片附件引用，按 callId 索引，供 finalizeContent 组装 image blocks。
  const pendingNative = new Map();

  ctx.tools.register(
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
          description: "图片文件路径列表（仅支持本地绝对路径，不支持相对路径）",
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

        // 当前模型不识图：调用插件设置中当前使用的视觉模型。
        const config = normalizeConfig(configSource());
        const target = resolveTarget(config.providers, config.active);
        if (!target) {
          throw new Error("视觉模型未配置：请在 DSH 设置 → 识图插件中添加供应商和模型，并选择使用");
        }
        return callVisionModel(ctx, target.provider, target.model.id, args.images, prompt, exec.signal);
      },
      finalizeContent(exec) {
        const state = pendingNative.get(exec.callId);
        if (state === void 0) return undefined;
        pendingNative.delete(exec.callId);
        const blocks = state.refs.map((ref) => ({ type: "image", attachment: ref }));
        blocks.push({ type: "text", text: state.prompt });
        return blocks;
      },
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { apply, inject, name };
