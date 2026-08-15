# dsh-image-vision

图片识别插件（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）。将 `image-vision` skill 移植为可安装的 DSH 插件。

## 功能

- 注册 `image_vision` 工具，接收一张或多张图片路径（**仅支持本地绝对路径**，相对路径会直接报错），自动判断**当前接入的大模型**是否具备识图能力：
  - **当前模型可识图**：不调用插件视觉模型，把图片直接提交给当前模型，并按插件的预设提示词（病理 / 细胞 / 解剖 / 统计图 / 组合大图 / 临床 / 通用）要求它分析。
  - **当前模型不可识图**：调用插件配置的视觉模型（OpenAI 兼容或 Anthropic 兼容），返回识别文本。
- 设置界面（DSH 设置 → 「识图插件」页，仿「设置-模型」界面）：
  - 显示**当前使用的供应商及模型**（顶部状态条 + 卡片高亮）；
  - 支持**添加 / 编辑 / 删除多个供应商**，每个供应商下可挂多个模型；
  - 点击任意模型的「使用」即可**切换**当前激活的供应商/模型，后续识图调用即用该模型。
- 模型发现：填入 API 端点 + Key 后，点「获取模型列表」可列出该端点下的模型，**自动区分识图 / 非识图模型**；非识图模型不可勾选并提示「该模型不具有识图能力，不可选择」；端点不支持模型列表接口时可手动输入模型名添加。
  - 获取失败时按原因提示（Key 缺失/无效、端点不支持列表、网络超时/不通等），并**按厂商返回内置常用模型候选**（source: preset，标注"仍需填写有效 API Key 才能使用"），无需 Key 也能先选模型。
- **厂商模板**：添加/编辑供应商时顶部有「厂商模板」下拉，内置 OpenAI、Anthropic、DeepSeek、小米 MiMo、硅基流动、智谱 GLM、阿里百炼 Qwen、月之暗面 Kimi、火山方舟、百度千帆、腾讯混元、MiniMax、Groq、OpenRouter、Mistral、xAI、零一万物、阶跃星辰等常见厂商——选择后自动填入名称与 API 端点，只需再填 API Key 并点「获取模型列表」。
- **模型实测**：每个模型行（供应商卡片和编辑卡片中）都有「检测」按钮，与「识图」标记、「使用」按钮并列——用内置测试图（`assets/test-image.jpg`）**实测该模型是否真的能识图**，返回识别结果并告知检测成功/失败；不支持图片输入的模型会明确提示。每次点击都会重新检测，随时可点。
- **余额查询**：每个供应商卡片端点行右侧有「余额」框——添加供应商后自动查询并显示（挂载时及端点/Key 变化后自动查），**点击余额框随时刷新最新余额**。自动探测常见余额接口（`/v1/user/balance`、`/dashboard/billing/credit_grants`、`/user/info`、`/api/user/self` 等 7 个路径），兼容余额/额度/配额等字段；端点不支持时明确提示。人民币显示 ¥、美元显示 $、one-api 类显示"额度"。
- **内嵌添加模型**：每个供应商卡片模型列表下方有「+ 添加模型」按钮，直接展开面板（获取模型列表 / 勾选 / 手动输入），无需进入编辑卡片。

## 安装

### 从 GitHub 安装

```bash
git clone https://github.com/xiaoyuink/dsh-image-vision.git
cd dsh-image-vision && pnpm install   # 安装插件自身的依赖
dsh plugin --profile web add <插件目录绝对路径>
```

安装后重启 `dsh web` 生效（host 半在启动时加载）。

> 说明：`dsh plugin add` 使用 `link:` 协议，插件代码改动后重启即可生效，无需重新安装。

## 目录结构

```
dsh-image-vision/
├── package.json          # 声明 dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert 插件行
├── assets/
│   └── test-image.jpg    # 内置测试图（「检测」按钮实测识图能力用）
└── lib/
    ├── index.js          # host 半：工具 + settings namespace + 配置/发现/检测路由
    ├── client.js         # client 半：设置页 UI（window.__ModuleLoader__ bundle）
    └── presets.js        # 7 个预设提示词（移植自 image-vision skill）
```

## 设置数据（settings.yaml `image-vision` 段）

```yaml
image-vision:
  providers:
    - id: legacy                 # 供应商唯一 id（自动生成）
      name: 默认供应商            # 显示名称
      apiBaseUrl: https://api.xiaomimimo.com/anthropic
      apiKey: sk-...
      models:
        - id: mimo-v2.5
          vision: true           # 是否识图（自动判断）
  active: "legacy:mimo-v2.5"     # 当前激活的 "供应商id:模型id"
```

旧版单配置（顶层 `apiBaseUrl` / `apiKey` / `model`）读取时自动迁移为 `providers[0]`；设置页每次保存都会把配置持久化到该文件。

## 识图能力判断

- **当前模型**：通过 `agentDefaultModel.currentSelection()` 取当前 provider/model，再用 `llm.resolveModelInfo()` 判断 `inputModalities` 是否含 `image`。
- **模型发现**：调用端点 `/models`（OpenAI）或 `/v1/models`（Anthropic），按模型名关键词（vision / vl / 4o / omni / claude / gemini / qwen-vl / glm-4v / internvl / llava / pixtral / minicpm-v / mimo 等）猜测是否识图。
- **模型实测（最可靠）**：设置页「检测」按钮 → `POST /api/dsh-image-vision/test-model`，用内置测试图真实调用一次（Anthropic/OpenAI 协议按端点自动选择），成功返回识别文本；失败时从错误信息判断是否「不支持图片输入」并明确提示。
