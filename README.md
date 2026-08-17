# dsh-image-vision

图片识别插件（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，简称 DSH）。将 `image-vision` skill 移植为可安装的 DSH 插件。

核心思想：**让任意接入 DSH 的大模型都能识图**——无论当前模型本身是否支持视觉。模型能识图就直接交给它（并按专业预设提示词分析），不能识图就自动转给插件配置的视觉模型，对使用者透明。

## 功能总览

- 注册 **4 个识图工具**：`image_vision` / `image_vision_ocr` / `image_vision_ground` / `image_vision_crop`。
- 内置 **7 个专业预设**：病理 / 细胞 / 解剖 / 统计图 / 组合大图 / 临床 / 通用。
- **输入框原生图片**：粘贴 / 上传 / 拖拽图片，发送后自动识图。
- **文本模型直接发图**：粘贴/上传/拖拽图片后发送，图片自动写入 DSH 附件存储（永久），消息区渲染缩略图（点击看大图），模型自动调用识图工具识别；**无需切换模型、模型选择器保持简洁**（「+ 自动识图」👁 视觉组默认关闭）。
- **可视化设置页**：多供应商管理、厂商模板、模型发现、模型实测、余额查询、总开关。
- 支持 OpenAI 兼容、Anthropic 兼容、Qwen-Omni Realtime、OVHcloud 匿名免费视觉层等协议。

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

## 四、「+ 自动识图」视觉组（默认关闭）

> ⚠️ **v2.3+ 默认不再注册视觉组**：模型选择器保持简洁（不出现带 👁 的选项）。
> 图片发送改由 **client 发送层 hook** 承担——带图发送时把图片写入 DSH 附件存储，把消息
> 改写为附件引用 `![图片](/api/dsh-image-vision/raw/<sha256>?m=..&b=..&w=..&h=..)` 纯文本再发出
> （文本模型同样可用，图片字节不进会话、引用永久有效；`image_vision_ground → image_vision_crop →
> image_vision_ocr` 像素精读链路不受影响）。
> 若仍需要原生"选模型即带图"的旧体验，可在配置里把 `visionGroup: true` 开启。

- 插件为 DSH 装配的**每个文本厂商**自动注册一个视觉组「X + 视觉」（排在对应厂商组后面），模型条目名带 👁（如 `deepseek-v4-flash👁`），并声明支持图片输入。
- 在模型选择器选中该视觉组后，粘贴/上传的图片可通过 DSH 发送准入：**可预览、可发送、可点开大图**。
- 发送时图片 block 被落盘改写为 `![图片](i/xxx)` 标记，再委托原文本模型；模型按系统规则调用 `image_vision` 识别。
- 仅当插件配置了视觉模型（且总开关开启）且 `visionGroup: true` 时才注册；未配置时选择器保持干净，不出现 👁 模型。
- 视觉组跟随 llm provider 注册表**热增/热减**（增删厂商即时反映）。

## 五、识图能力判断（三层）

1. **当前模型**：通过 `agentDefaultModel.currentSelection()` 取当前 provider/model，再用 `llm.resolveModelInfo()` 判断 `inputModalities` 是否含 `image`。
2. **模型发现**：调用端点 `/models`（OpenAI）或 `/v1/models`（Anthropic），按模型名关键词（vision / vl / 4o / omni / claude / gemini / qwen-vl / glm-4v / internvl / llava / pixtral / minicpm-v / mimo 等）+ 显式覆盖表猜测是否识图；明确的非视觉模型（tts / asr / whisper / embedding / rerank 等）直接排除。
3. **模型实测（最可靠）**：设置页「检测」按钮 → 用内置测试图真实调用一次，成功则返回识别文本，失败则判断是否「不支持图片输入」并明确提示。

## 六、设置页面（DSH 设置 → 识图插件）

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

## 七、视觉模型协议

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

在 [Releases](https://github.com/xiaoyuink/dsh-image-vision/releases) 下载 `dsh-image-vision-<版本>.tgz`，解压后按上述方式 `add` 解压得到的 `package/` 目录。

## 配置数据结构（settings 的 `image-vision` 段）

```yaml
image-vision:
  enabled: true               # 总开关
  visionGroup: false          # 是否在模型选择器注册「+ 自动识图」👁 视觉组（默认 false，保持简洁）
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

## 目录结构

```
dsh-image-vision/
├── package.json          # 声明 dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert 插件行（挂载 bundle）
├── assets/
│   └── test-image.jpg    # 内置测试图（「检测」按钮实测识图用）
├── drafts/               # 运行时物化缓存目录（附件引用解析时临时落盘，20 分钟过期重建；已 gitignore）
└── lib/
    ├── index.js          # host 半：工具 + settings namespace + 路由 + 附件存储 + 视觉组（可选）+ 草稿缓存
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

- **v2.3.0**：发送链路重构——图片改存 DSH 附件存储（永久、内容寻址），消息改写为附件引用并渲染缩略图；新增 `attach` / `raw` / `current-model-vision` 路由与附件引用解析（精读链路 ground/crop/ocr 直接可用）；「+ 自动识图」视觉组默认关闭（`visionGroup` 配置，模型选择器保持简洁）；总开关关闭时拦截粘贴图片；修复拖拽浮层卡死与预览渲染等若干问题。
- **v2.2.1**：草稿图片临时目录迁移至插件目录本体（`dsh-image-vision/drafts`）。
- **v2.2.0**：新增总开关与草稿 20 分钟过期清理，完善视觉模型覆盖与设置页 UI。
- **v2.1.0**：新增像素级工具（`image_vision_ocr` / `image_vision_ground` / `image_vision_crop`）+ OVH 免费视觉层。
- **v2.0.0**：基于 twin 路由的原生图片输入链路 + UI 全面升级。

## License

[MIT](./package.json)