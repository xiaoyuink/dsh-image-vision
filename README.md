# @xiaoyuink/dsh-image-vision

<p align="center">
  <img src="https://github.com/xiaoyuink/dsh-image-vision/raw/main/assets/demo.gif" alt="dsh-image-vision 演示" width="800">
  <br>
  <em>📹 粘贴/拖拽图片 → 模型自动识图 → 4 件套工具精读</em>
</p>

核心思想：**让任意接入 DSH 的大模型都能识图**——无论当前模型本身是否支持视觉。模型能识图就直接交给它（并按专业预设提示词分析），不能识图就自动转给插件配置的视觉模型，对使用者透明。

## 功能总览

- 注册 **4 个识图工具**：`image_vision` / `image_vision_ocr` / `image_vision_ground` / `image_vision_crop`。
- 内置 **7 个专业预设**：病理 / 细胞 / 解剖 / 统计图 / 组合大图 / 临床 / 通用。
- **输入框原生图片**：粘贴 / 上传 / 拖拽图片，发送后自动识图。
- **文本模型直接发图**：粘贴/上传/拖拽图片后发送，图片自动写入 DSH 附件存储（永久），消息区渲染缩略图（点击看大图），模型自动调用识图工具识别；**无需切换模型、模型选择器保持简洁**。
- **可视化设置页**：多供应商管理、厂商模板、模型发现、模型实测、余额查询、总开关。
- 支持 OpenAI 兼容、Anthropic 兼容、Qwen-Omni Realtime、OVHcloud 匿名免费视觉层等协议。

## 快速上手（如何使用）

### 安装插件

```bash
# 建议在 ~/.dsh 下新建 plugin 目录，统一存放插件本体
mkdir -p ~/.dsh/plugin
cd ~/.dsh/plugin

# 克隆仓库
git clone https://github.com/xiaoyuink/dsh-image-vision.git
cd dsh-image-vision && pnpm install

# 添加到 DSH 配置
dsh plugin --profile web add "$(pwd)"

# 重启 DSH Web 生效
# （dsh plugin add 使用 link: 协议，代码改动后重启即可，无需重新安装）
```

> **💡 关于插件存放位置**：建议将插件本体放在 `~/.dsh/plugin/` 目录下统一管理，也可以根据你的喜好放在任意位置，`dsh plugin add` 时指向该路径即可。

安装完成后重启 `dsh web`，然后按以下步骤开始使用：

### 1️⃣ 开启插件

进入 DSH **设置 → 识图插件**，将顶部的**总开关**打开（✅ 绿色）。

开启后，输入框会出现「📎 添加图片」按钮，同时支持直接粘贴（Ctrl+V）和拖拽图片。

### 2️⃣ 配置视觉模型（二选一）

**方案 A：免费零配置（推荐新手）**

在设置页添加供应商，选择 **OVHcloud** 模板：
- 端点自动填入 `https://kepler.ai.cloud.ovh.net`
- API Key **留空**
- 选择一个视觉模型（如 `Mistral-7B-Instruct-v0.3`）
- 点击「检测」按钮验证，成功即可使用

> OVHcloud 免注册、免 Key，每 IP 每分钟 2 次，大陆直连，无需任何配置。

**方案 B：自有 API Key**

1. 点击「添加供应商」，选择你的厂商模板（OpenAI / Anthropic / 小米 MiMo / 硅基流动 / 智谱 / 通义千问等 20+ 厂商）
2. 填入 API Base URL 和 API Key（Key 建议用 `env:YOUR_ENV_VAR` 环境变量引用，更安全）
3. 点击「获取模型列表」自动发现识图模型，或手动输入模型 ID
4. 点击模型行的「检测」实测识图能力
5. 点击「使用」切换为当前激活模型

### 3️⃣ 开始识图

安装配置完成后，使用方式非常简单：

**方式一：拖拽图片**
```
从桌面或文件夹拖拽一张图片到 DSH 输入框 → 松开 → 发送
```

**方式二：粘贴图片**
```
截图后按 Ctrl+V 粘贴到输入框 → 发送
```

**方式三：点击上传**
```
点击输入框左侧的 📎 按钮 → 选择图片 → 发送
```

发送后，模型会自动调用 `image_vision` 工具识别图片内容并回复你。

### 4️⃣ 精读进阶（可选）

如果需要对图片做更精细的分析：

| 你想做什么 | 用哪个工具 | 怎么用 |
|-----------|-----------|--------|
| 读图片上的文字 | `image_vision_ocr` | 直接调用，逐字输出 |
| 找某个目标的位置 | `image_vision_ground` | 描述目标，返回坐标 |
| 放大看细节 | `image_vision_crop` | 输入坐标和放大倍数 |
| 完整链路 | ground → crop → ocr | 定位 → 裁剪放大 → 读字 |

> 模型会自动遵循「先整图识别，再按需精读」的策略，你只需要发图，剩下的交给模型。

### 5️⃣ 常用场景示例

| 场景 | 操作 |
|------|------|
| 🧪 识别病理切片 | 发图 → 模型自动用 `histopathology` 预设分析 |
| 🔬 看 Western blot | 发图 → 模型自动用 `cell_biology` 预设分析 |
| 🩻 解读 CT/MRI | 发图 → 模型自动用 `anatomy` 预设分析 |
| 📊 分析统计图表 | 发图 → 模型自动用 `scientific_figure` 预设分析 |
| 📄 读截图文字 | 发图 → 调用 `image_vision_ocr` 逐字输出 |
| 🔍 看组合大图 | 发图 → 模型自动用 `composite_figure` 逐 panel 分析 |

---

## 一、工具集

### `image_vision` — 识别 / 分析图片

接收一张或多张图片引用，**自动判断当前模型是否识图**：

- **当前模型可识图**：不调用插件视觉模型，把图片作为 image block 直接交给当前模型，并按预设提示词分析。
- **当前模型不可识图**：调用插件设置中当前激活的视觉供应商/模型（带失败降级），返回识别文本。

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `images` | 是 | 图片引用列表；支持本地绝对路径（`C:/.../x.jpg`）、草稿短名（`i/iv-xxx.jpg`）、草稿 URL、附件存储引用（`/api/dsh-image-vision/raw/<sha256>?m=..&b=..&w=..&h=..`，整段 URL 传入，永久有效） |
| `preset` | 否 | 预设名，见下表；缺省 `general` |
| `prompt` | 否 | 自定义提示词；提供后替换预设提示词（仍保留预设的参数默认值） |

### `image_vision_ocr` — 逐字读文字

识别图片中的全部可见文字（小字、标语、截图文字、手写体尽量），按阅读顺序逐行输出，不确定的字标「？」。配合 `image_vision_crop` 先放大局部再识别效果更好。

### `image_vision_ground` — 定位目标

在图片中定位某个目标（物体/文字/按钮/标牌等）的像素坐标范围，返回 bbox `"x1,y1,x2,y2"`。可配合 `image_vision_crop` 裁剪放大，或配合 `image_vision_ocr` 读局部文字。

### `image_vision_crop` — 裁剪放大

按像素坐标裁剪局部并按倍数放大（1–8 倍，默认 2），返回新的图片引用。适合放大核对细节、小字。返回的引用可继续传给 `image_vision` / `image_vision_ocr` / `image_vision_ground`，形成「**定位 → 裁剪 → 放大 → 再识别**」闭环。

> 模型侧系统规则：遇到图片引用标记时，**第一步先整图识别**（`image_vision` + 默认预设），**第二步再按需精读**（`image_vision_ocr` 读字，或 `image_vision_ground` 定位 + `image_vision_crop` 放大迭代）。

## 二、预设提示词

| 预设 `preset` | 用途 | temperature |
| --- | --- | --- |
| `histopathology` | 组织病理切片（标本类型、染色、组织结构、细胞形态、病理发现与结论） | 0.3 |
| `cell_biology` | 细胞/实验图（显微镜、Western blot、FACS、免疫荧光等） | 0.3 |
| `anatomy` | 解剖/医学影像（CT、MRI、X 线、超声、造影等） | 0.3 |
| `scientific_figure` | 科研统计图（图表类型、坐标轴、关键数值、趋势与解读） | 0.2 |
| `composite_figure` | 组合大图（整体布局 + 逐 panel 分析 + 整图综合总结） | 0.3 |
| `clinical` | 临床医学图（体表/内镜/眼底等，含鉴别诊断与临床建议） | 0.3 |
| `general` | 通用整图描述（默认） | 0.5 |

所有预设均要求用中文回答，并对不确定内容明确说明、不编造。`maxTokens` 默认 120000。

## 三、输入框原生图片输入

- 安装并开启插件后，对话框输入框工具行会出现「📎 添加图片」按钮；也可直接在输入框**粘贴**（Ctrl+V）或**拖拽**图片文件。
- 支持 `png` / `jpeg` / `webp` / `gif`，单张 ≤ 20MB（附件存储默认单张 5MB，可在 settings `attachment-local.maxImageBytes` 调大）。
- 发送时图片经 `POST /api/dsh-image-vision/attach` 写入 **DSH 附件存储**（`attachments.saveImage`，内容寻址、永久保留、无自动清理），消息里只留下引用 `![图片](/api/dsh-image-vision/raw/<sha256>?m=..&b=..&w=..&h=..)`（元数据编进 URL，重启后旧引用仍可渲染与精读）。
- 发送后，模型按注入的系统规则自动调用 `image_vision` 识别并回复；`image_vision_ground → image_vision_crop → image_vision_ocr` 像素精读链路直接解析附件引用（经 attachment→草稿物化桥，物化缓存 20 分钟后自动重建，引用本身永不过期）。
- 无论当前模型是否识图都可用：识图则主模型直接分析，不识图则走插件视觉模型。
- 图片字节不进会话记录；附件对象位于 `~/.dsh/attachments/v1/objects/`（磁盘只增不减，如需清理需手动删目录；`_preview` 子目录可放带扩展名的预览副本）。

## 四、识图能力判断（三层）

1. **当前模型**：通过 `agentDefaultModel.currentSelection()` 取当前 provider/model，再用 `llm.resolveModelInfo()` 判断 `inputModalities` 是否含 `image`。
2. **模型发现**：调用端点 `/models`（OpenAI）或 `/v1/models`（Anthropic），按模型名关键词（vision / vl / 4o / omni / claude / gemini / qwen-vl / glm-4v / internvl / llava / pixtral / minicpm-v / mimo 等）+ 显式覆盖表猜测是否识图；明确的非视觉模型（tts / asr / whisper / embedding / rerank 等）直接排除。
3. **模型实测（最可靠）**：设置页「检测」按钮 → 用内置测试图真实调用一次，成功则返回识别文本，失败则判断是否「不支持图片输入」并明确提示。

## 五、设置页面（DSH 设置 → 识图插件）

仿 DSH「设置-模型」界面，功能包括：

- **总开关**：开启后注册识图工具、系统规则与输入框图片入口（📎 按钮 + 粘贴/拖拽）；关闭后插件完全不参与（工具、系统提示、输入框按钮、发送 hook 全部注销/不渲染）。
- **当前供应商/模型**：顶部状态条显示，卡片高亮当前激活项。
- **多供应商管理**：添加 / 编辑 / 删除多个供应商，每个供应商下挂多个模型，支持拖拽排序。
- **切换激活**：点击模型行的「使用」切换当前 `供应商id:模型id`，后续识图即用该模型。
- **厂商模板**：内置 OpenAI、Anthropic、DeepSeek、小米 MiMo、硅基流动、智谱 GLM、阿里百炼 Qwen、月之暗面 Kimi、火山方舟、百度千帆、腾讯混元、MiniMax、Groq、OpenRouter、Mistral、xAI、零一万物、阶跃星辰等常见厂商，选择后自动填入名称与端点。
- **模型发现**：填端点 + Key 后点「获取模型列表」，自动区分识图/非识图模型；非识图模型禁止勾选并提示；列表接口不支持时可手动输入。
- **模型实测**：每个模型行的「检测」按钮用内置测试图（`assets/test-image.jpg`）实测识图，返回结果/耗时；失败（含不支持图片输入）明确提示。
- **余额查询**：供应商卡片端点行的「余额」框，挂载时及端点/Key 变化后自动查询，点击刷新；默认按厂商判断货币（国内 ¥ / 美元 $ / one-api「额度」）。
- **内嵌添加模型**：供应商卡片内「+ 添加模型」就地展开面板（获取列表/勾选/手动输入）。

## 六、视觉模型协议

- **OpenAI 兼容**：`chat.completions`（图片以 data URL 传入）。
- **Anthropic 兼容**：Messages API（图片以 base64 image block 传入；按端点自动选择协议）。
- **Qwen-Omni Realtime**：模型含 `realtime` 或端点含 `/api-ws/` 时，自动把 HTTP 端点转成 `wss://.../api-ws/v1/realtime`，走 WebSocket 实时纯文本输出。
- **OVHcloud AI Endpoints 匿名层**：`kepler.ai.cloud.ovh.net` 免注册、免 Key（每 IP/模型 2 次/分钟，大陆可直连），可直接添加使用。
- 调用失败时不打断整轮对话：工具返回可读错误信息，提示检查余额与配置。

## 安装

### 从 GitHub 安装

```bash
git clone https://github.com/xiaoyuink/dsh-image-vision.git
cd dsh-image-vision && pnpm install   # 安装插件自身依赖
dsh plugin --profile web add <插件目录绝对路径>
```

安装后重启 `dsh web` 生效（host 半在启动时加载）。

> 说明：`dsh plugin add` 使用 `link:` 协议，插件代码改动后重启即可生效，无需重新安装。

### 从 GitHub Release 安装

在 [Releases](https://github.com/xiaoyuink/dsh-image-vision/releases) 下载 `xiaoyuink-dsh-image-vision-<版本>.tgz`，解压后按上述方式 `add` 解压得到的 `package/` 目录。

## 配置数据结构（settings 的 `image-vision` 段）

```yaml
image-vision:
  enabled: true               # 总开关
  providers:
    - id: legacy              # 供应商唯一 id（自动生成）
      name: 默认供应商
      apiBaseUrl: https://api.xiaomimimo.com/anthropic
      apiKey: sk-...
      models:
        - id: mimo-v2.5
          vision: true        # 是否识图（自动判断，可手动纠正）
  active: "legacy:mimo-v2.5"  # 当前激活的 "供应商id:模型id"
```

旧版单配置（顶层 `apiBaseUrl` / `apiKey` / `model`）读取时自动迁移为 `providers[0]`；设置页每次保存都会持久化到该文件。

### API Key 安全（v2.3.1）

- 设置页 API Key 输入框为**密码框**，保存后**不再回显**（`GET /api/dsh-image-vision/config` 返回 `********` 占位）；**留空保存 = 保留原 Key**，不覆盖。
- 推荐用 **环境变量引用** 替代明文：把 `apiKey` 写成 `env:VISION_API_KEY`，插件调用时从进程环境变量读取，`settings.yaml` 与配置文件里**不落明文**。
- 历史明文 Key 已写在 `~/.dsh/settings.yaml`；如需更安全可改为 `env:...` 引用后删除原明文。

## 目录结构

```
dsh-image-vision/
├── package.json          # 声明 dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert 插件行（挂载 bundle）
├── assets/
│   └── test-image.jpg    # 内置测试图（「检测」按钮实测识图用）
├── drafts/               # 运行时物化缓存目录（附件引用解析时临时落盘，20 分钟过期重建；已 gitignore）
└── lib/
    ├── index.js          # host 半：工具 + settings namespace + 路由 + 附件存储 + 草稿缓存
    ├── client.js         # client 半：设置页 UI + 输入框按钮/视觉模型选择器 + 发送 hook + 消息区图片渲染
    └── presets.js        # 7 个预设提示词（移植自 image-vision skill）
```

## HTTP 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/i/<name>` | 草稿图片短路由（输入框预览/消息渲染，兼容旧消息） |
| GET | `/api/dsh-image-vision/draft-image?name=` | 草稿图片服务 |
| POST | `/api/dsh-image-vision/upload` | 草稿图片上传（兼容旧流程） |
| POST | `/api/dsh-image-vision/attach` | 图片写入 DSH 附件存储（发送 hook 主路径，永久保留） |
| GET | `/api/dsh-image-vision/raw/<id>?m=..&b=..&w=..&h=..` | 附件图片回读（消息渲染/精读引用，元数据编进 URL，重启后可读） |
| GET | `/api/dsh-image-vision/current-model-vision` | 当前默认模型识图能力查询（发送 hook 决策） |
| GET/POST | `/api/dsh-image-vision/config` | 读/写配置（设置页回显与保存） |
| POST | `/api/dsh-image-vision/activate` | 切换当前激活的供应商/模型 |
| POST | `/api/dsh-image-vision/models` | 模型发现（识图/非识图判定） |
| POST | `/api/dsh-image-vision/test-model` | 用内置测试图实测模型识图 |
| POST | `/api/dsh-image-vision/balance` | 余额查询 |

## 更新记录

- **v2.3.1**：API Key 安全增强（回显脱敏 + `env:` 环境变量引用 + 留空不改）；彻底移除「+ 自动识图」视觉组（不再在模型选择器注册 👁 模型条目，模型选择器保持简洁，由发送层 hook 独立承担图片发送）。
- **v2.3.0**：发送链路重构——图片改存 DSH 附件存储（永久、内容寻址），消息改写为附件引用并渲染缩略图；新增 `attach` / `raw` / `current-model-vision` 路由与附件引用解析（精读链路 ground/crop/ocr 直接可用）；总开关关闭时拦截粘贴图片；修复拖拽浮层卡死与预览渲染等若干问题。
- **v2.2.1**：草稿图片临时目录迁移至插件目录本体（`dsh-image-vision/drafts`）。
- **v2.2.0**：新增总开关与草稿 20 分钟过期清理，完善视觉模型覆盖与设置页 UI。
- **v2.1.0**：新增像素级工具（`image_vision_ocr` / `image_vision_ground` / `image_vision_crop`）+ OVH 免费视觉层。
- **v2.0.0**：基于 twin 路由的原生图片输入链路 + UI 全面升级。

## 致谢

- **[ysr666/dsh-vision-router](https://github.com/ysr666/dsh-vision-router)** — 本插件的视觉工具链（`image_vision` / `image_vision_ocr` / `image_vision_ground` / `image_vision_crop` 四件套）参考了其设计思路，在此表示感谢。

## License

[MIT](./package.json)