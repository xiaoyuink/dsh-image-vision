/**
 * dsh-image-vision Client half —— 设置页 UI（仿 DSH「设置-模型」界面）。
 * 手写 window.__ModuleLoader__.load bundle（持久化插件形态），
 * 用 React.createElement（无 JSX），在 settings.section 注册"识图插件"页。
 *
 * 功能：
 * - 显示当前使用的供应商及模型；
 * - 支持添加/编辑/删除多个供应商，每个供应商下多个模型；
 * - 点击「使用」切换当前激活的供应商/模型，后续识图调用即用该模型；
 * - 模型发现时，非识图模型禁用勾选并提示"该模型不具有视觉能力，不可选择"。
 *
 * 配置读写说明：插件自定义的 settings namespace 不在 DSH 的 settings wire
 * 白名单（api-proxy exposedNamespaces）中，settingsScope 无法读写它，
 * 因此这里直接 fetch 插件自己的 HTTP 路由：
 *   GET  /api/dsh-image-vision/config    —— 读配置（回显）
 *   POST /api/dsh-image-vision/config    —— 写配置（保存 providers + active）
 *   POST /api/dsh-image-vision/activate  —— 切换当前使用的供应商/模型
 *   POST /api/dsh-image-vision/models    —— 模型发现（识图/非识图判定）
 */
window.__ModuleLoader__.load({
  id: "dsh-image-vision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var createElement = React.createElement;

    var inject = ["slots"];

    // ===== 样式：复用 DSH「设置-模型」页面的 CSS module，另加少量自定义类 =====
    var CSS_TEXT = ".zGbnIq_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.zGbnIq_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}.zGbnIq_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}.zGbnIq_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}.zGbnIq_savedNotice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}.zGbnIq_rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}.zGbnIq_rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}.zGbnIq_rowHead{align-items:center;gap:10px;display:flex}.zGbnIq_rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}.zGbnIq_rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.zGbnIq_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}.zGbnIq_credentialDot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}.zGbnIq_credentialDotConfigured{background:var(--dsw-alias-state-success-primary)}.zGbnIq_credentialDotMissing{background:var(--dsw-alias-state-error-primary)}.zGbnIq_rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}.zGbnIq_primaryButton,.zGbnIq_secondaryButton,.zGbnIq_addButton{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.zGbnIq_primaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.zGbnIq_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.zGbnIq_secondaryButton,.zGbnIq_addButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}.zGbnIq_secondaryButton:hover:not(:disabled),.zGbnIq_addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.zGbnIq_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.zGbnIq_dangerButton{box-sizing:border-box;height:36px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:18px;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.zGbnIq_dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.zGbnIq_rowActions .zGbnIq_secondaryButton,.zGbnIq_rowActions .zGbnIq_dangerButton{border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px}.zGbnIq_primaryButton:disabled,.zGbnIq_secondaryButton:disabled,.zGbnIq_dangerButton:disabled,.zGbnIq_addButton:disabled,.zGbnIq_linkButton:disabled,.zGbnIq_addModelButton:disabled{opacity:.4;cursor:default}.zGbnIq_primaryButton:focus-visible,.zGbnIq_secondaryButton:focus-visible,.zGbnIq_dangerButton:focus-visible,.zGbnIq_addButton:focus-visible,.zGbnIq_linkButton:focus-visible,.zGbnIq_addModelButton:focus-visible,.zGbnIq_iconButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.zGbnIq_editor{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}.zGbnIq_editorHeader{align-items:baseline;gap:8px;display:flex}.zGbnIq_editorTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.zGbnIq_editorRoute{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.zGbnIq_field{flex-direction:column;gap:6px;display:flex}.zGbnIq_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}.zGbnIq_linkButton{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:14px;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.zGbnIq_linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.zGbnIq_editorActions{justify-content:flex-end;gap:8px;display:flex}.zGbnIq_addBlock{flex-direction:column;gap:12px;display:flex}.zGbnIq_addActions{flex-wrap:wrap;gap:10px;display:flex}.zGbnIq_addButton{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;flex:1 1 0;gap:6px;min-width:180px;height:44px}.zGbnIq_addCard,.zGbnIq_setupCard{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;list-style:none;display:flex}.zGbnIq_addCard .zGbnIq_editor,.zGbnIq_setupCard .zGbnIq_editor{background:0 0;padding:0}.zGbnIq_modelCatalog{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex}.zGbnIq_modelCatalogHeading{flex-direction:column;gap:2px;display:flex}.zGbnIq_modelCatalogTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}.zGbnIq_modelCatalogMeta,.zGbnIq_modelEmpty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.zGbnIq_modelList{flex-direction:column;gap:8px;display:flex}.zGbnIq_modelListHead{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.zGbnIq_modelEntry{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px}.zGbnIq_modelRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;align-items:center;gap:6px;display:grid}.zGbnIq_iconButton{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;display:inline-flex}.zGbnIq_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.zGbnIq_iconButton:disabled{cursor:default;opacity:.4}.zGbnIq_iconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}.zGbnIq_modelEmpty{border:1px dashed var(--dsw-alias-border-l3);text-align:center;border-radius:8px;padding:12px}.zGbnIq_addModelButton{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:14px;align-self:flex-start;align-items:center;gap:4px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.zGbnIq_addModelButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.zGbnIq_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}select.zGbnIq_input{cursor:pointer;max-width:240px}.zGbnIq_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}.zGbnIq_input::placeholder{color:var(--dsw-alias-label-dimmed)}.zGbnIq_input:disabled{opacity:.6;cursor:default}.zGbnIq_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}.zGbnIq_hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.iv_activeCard{border-color:var(--dsw-alias-brand-primary)}.iv_dotIdle{background:var(--dsw-alias-border-l3)}.iv_metaText{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.iv_modelRow{grid-template-columns:minmax(0,1fr) auto auto auto auto auto;align-items:center;gap:6px;display:grid}.iv_modelRow .iv_candidateId{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.iv_visionYes{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.iv_visionNo{color:var(--dsw-alias-label-tertiary)}.iv_activeModel{background:var(--dsw-alias-interactive-bg-hover)}.iv_currentBar{align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:12px;padding:10px 14px;font-size:14px;line-height:22px;display:flex}.iv_currentBar strong{font-weight:500}.iv_currentEmpty{color:var(--dsw-alias-label-tertiary)}.iv_inlineRow{align-items:center;gap:8px;display:flex}.iv_candidateList{flex-direction:column;gap:2px;max-height:260px;margin:4px 0 0;padding:0;list-style:none;display:flex;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.iv_candidateLabel{cursor:pointer;align-items:center;gap:8px;padding:6px 8px;display:flex}.iv_candidateLabel:hover{background:var(--dsw-alias-interactive-bg-hover)}.iv_candidateId{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;flex:auto;font-size:13px}.iv_manualRow{align-items:center;gap:8px;display:flex;margin-top:8px}.iv_manualRow .zGbnIq_input{flex:1}.iv_addPanel{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:10px;display:flex}.iv_balanceChip{box-sizing:border-box;height:26px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border-radius:13px;align-items:center;padding:0 10px;font-size:12px;line-height:24px;display:inline-flex;flex:none}.iv_balanceChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.iv_balanceChip:disabled{opacity:.6;cursor:default}.iv_balanceOk{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}";
    var CSS_TAG = "dsh-image-vision/settings.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + CSS_TAG + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-image-vision";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }

    // ===== 输入框「添加图片」按钮 + 「视觉模型」选择器样式（独立 CSS 块）=====
    var INPUT_CSS_TEXT = ".zGbnIq_iconButton:disabled{opacity:.4;cursor:default}.iv_editingCard{background:rgba(128,128,128,0.24);border-color:var(--dsw-alias-brand-primary)}.iv_providerCard{transition:transform .18s ease,opacity .15s ease;will-change:transform}[data-iv-model-index]{transition:transform .18s ease}.iv_dragHandle{color:var(--dsw-alias-label-tertiary);cursor:grab;touch-action:none;user-select:none;background:0 0;border:none;border-radius:6px;flex:none;place-items:center;width:24px;height:24px;padding:0;font-size:14px;line-height:1;display:grid}.iv_dragHandle:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.iv_dragHandle:active{cursor:grabbing}.iv_dragHandle:disabled{opacity:.35;cursor:default}.iv_dragging{opacity:.55;border-color:var(--dsw-alias-state-business-primary)!important}.iv_pickWrap{display:inline-flex;align-items:center;position:relative}.iv_pickButton{background:var(--dsw-specific-selector);width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;display:grid}.iv_pickButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.iv_pickButton:disabled{opacity:.5;cursor:default}.iv_vs_root{min-width:0;position:relative}.iv_vs_trigger{min-width:0;max-width:180px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}.iv_vs_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.iv_vs_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.iv_vs_icon{color:var(--dsw-alias-label-caption);flex:none}.iv_vs_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.iv_vs_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.iv_vs_chevronOpen{transform:rotate(180deg)}.iv_vs_menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(260px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}.iv_vs_status{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}.iv_vs_error{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px}.iv_vs_groups{min-height:0;overflow-y:auto}.iv_vs_group+.iv_vs_group{margin-top:4px}.iv_vs_groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}.iv_vs_option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}.iv_vs_option:hover:not(:disabled),.iv_vs_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.iv_vs_selected{background:var(--dsw-alias-interactive-bg-hover)}.iv_vs_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.iv_vs_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}.iv_vs_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.iv_vs_desc{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}.iv_vs_check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}";
    var INPUT_CSS_TAG = "dsh-image-vision/input.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + INPUT_CSS_TAG + "\"]") === null) {
      var inputTag = document.createElement("style");
      inputTag.dataset.plugin = "dsh-image-vision";
      inputTag.dataset.pluginCss = INPUT_CSS_TAG;
      inputTag.textContent = INPUT_CSS_TEXT;
      document.head.appendChild(inputTag);
    }

    // ===== 模型视觉能力启发式判断（与 host 侧保持一致）=====
    var VISION_HINTS = [
      /vision/i, /vl/i, /4o/i, /omni/i, /gpt-4/i, /claude/i, /gemini/i,
      /glm-4v/i, /glm-4\.5v/i, /internvl/i, /llava/i, /pixtral/i,
      /minicpm-v/i, /mimo/i, /kimi/i, /moonshot/i, /step-1v/i, /yi-vl/i,
      /cogvlm/i, /deepseek-vl/i, /hunyuan.*vision/i,
      // qwen 系列只有 VL/Omni/Image/OCR 子型号支持视觉；裸 qwen（plus/max/coder 等）是文本模型
      /qwen.*(vl|omni|image|vision|ocr)/i,
    ];
    /** 显式视觉能力覆盖表（优先于正则，与 host 侧 KNOWN_VISION_OVERRIDES 保持一致）。 */
    var KNOWN_VISION_OVERRIDES = Object.freeze({
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
      "grok-4.5": true,
      "grok-4.6": true,
      "grok-build-0.1": true,
      "minimax-m3": true,
      "muse-spark-1.2": true,
      "qwen3.5-plus": true,
      "qwen3.6-plus": true,
      "qwen3.6-plus-free": true,
      "qwen3.7-plus": true,
      "qwen3.7-max": false,
      "qwen3.8-max": true,
    });
    /** 明确的非视觉模型特征（语音合成/识别/嵌入/重排等），命中即判为非视觉。 */
    var NON_VISION_HINTS = /(^|[-_])(tts|asr|voiceclone|voicedesign|voice|whisper|embedding|rerank)([-_]|$)/i;
    function guessVision(modelId) {
      var id = String(modelId ?? "").toLowerCase();
      // 显式覆盖表优先：权威判定（含手动纠错），先于启发式
      if (Object.prototype.hasOwnProperty.call(KNOWN_VISION_OVERRIDES, id)) {
        return KNOWN_VISION_OVERRIDES[id];
      }
      // mimo 系列只有基础多模态版（mimo-v2.5）支持视觉，asr/tts/voice 等子型号排除
      if (NON_VISION_HINTS.test(id)) return false;
      return VISION_HINTS.some(function (re) { return re.test(id); });
    }

    /** 解析 "providerId:modelId" → { provider, model } | null。 */
    function resolveActive(providers, active) {
      var sep = String(active ?? "").indexOf(":");
      if (sep <= 0) return null;
      var pid = String(active).slice(0, sep);
      var mid = String(active).slice(sep + 1);
      if (pid === "" || mid === "") return null;
      for (var i = 0; i < providers.length; i++) {
        if (providers[i].id !== pid) continue;
        for (var j = 0; j < providers[i].models.length; j++) {
          if (providers[i].models[j].id === mid) {
            return { provider: providers[i], model: providers[i].models[j] };
          }
        }
        return null;
      }
      return null;
    }

    /** 常见大模型厂商预设（添加供应商时选厂商自动填入名称与端点）。 */
    var PROVIDER_PRESETS = [
      { name: "OpenAI", apiBaseUrl: "https://api.openai.com/v1" },
      { name: "Anthropic", apiBaseUrl: "https://api.anthropic.com" },
      { name: "DeepSeek", apiBaseUrl: "https://api.deepseek.com/v1" },
      { name: "小米 MiMo", apiBaseUrl: "https://api.xiaomimimo.com/anthropic" },
      { name: "硅基流动 SiliconFlow", apiBaseUrl: "https://api.siliconflow.cn/v1" },
      { name: "智谱 GLM", apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      { name: "阿里百炼 Qwen", apiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { name: "月之暗面 Kimi", apiBaseUrl: "https://api.moonshot.cn/v1" },
      { name: "火山方舟 豆包", apiBaseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
      { name: "百度千帆", apiBaseUrl: "https://qianfan.baidubce.com/v2" },
      { name: "腾讯混元", apiBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1" },
      { name: "MiniMax", apiBaseUrl: "https://api.minimax.chat/v1" },
      { name: "Groq", apiBaseUrl: "https://api.groq.com/openai/v1" },
      { name: "OpenRouter", apiBaseUrl: "https://openrouter.ai/api/v1" },
      { name: "Mistral", apiBaseUrl: "https://api.mistral.ai/v1" },
      { name: "xAI", apiBaseUrl: "https://api.x.ai/v1" },
      { name: "零一万物 Yi", apiBaseUrl: "https://api.lingyiwanwu.com/v1" },
      { name: "阶跃星辰 StepFun", apiBaseUrl: "https://api.stepfun.com/v1" },
      { name: "OVHcloud 免费（免 Key，2 次/分钟）", apiBaseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1" },
      { name: "OpenCode Zen Go", apiBaseUrl: "https://opencode.ai/zen/go/v1" },
    ];

    /**
     * 模型检测状态 → 检测按钮显示（ProviderCard / ProviderEditor 共用）。
     * testState: { busy: boolean, result: {ok, reply?, error?, imageSupport?, latencyMs?} } | null
     * 结果折叠进「检测」按钮本身（不另起一行、不撑高卡片），完整内容放悬停 title。
     * 返回 { label, title, color } | null。
     */
    function testResultProps(testState) {
      if (!testState) return null;
      if (testState.busy) {
        return { label: "检测中…", title: "用内置测试图实测该模型的视觉能力", color: null };
      }
      var result = testState.result;
      if (!result) return null;
      if (result.ok) {
        return {
          label: "✓ " + (result.latencyMs ?? "?") + "ms",
          title: "检测成功（" + (result.latencyMs ?? "?") + "ms）：" + String(result.reply ?? ""),
          color: "var(--dsw-alias-state-success-primary)",
        };
      }
      var errText = String(result.error ?? "未知错误");
      return {
        label: "✗ 失败",
        title: "检测失败：" + errText + (result.imageSupport === false ? "（该模型不支持图片输入，不具备视觉能力）" : ""),
        color: result.imageSupport === false ? "var(--dsw-alias-state-warn-label)" : "var(--dsw-alias-state-error-primary)",
      };
    }

    /** 余额格式化：美元/人民币符号，one-api 类额度接口显示"额度"。 */
    function formatBalance(b) {
      var v = Number(b.balance);
      var num = Number.isFinite(v) ? (Math.round(v * 100) / 100).toString() : String(b.balance ?? "?");
      if (b.unit === "quota") return num + "（额度）";
      var sym = "$";
      if (b.currency === "CNY" || b.currency === "RMB") sym = "¥";
      else if (b.currency && b.currency !== "USD") sym = b.currency + " ";
      return sym + num;
    }

    // ===== 基础元素 =====
    function Field(props) {
      return createElement("div", { className: "zGbnIq_field" },
        createElement("label", { className: "zGbnIq_fieldLabel" }, props.label),
        props.children
      );
    }

    function TextInput(props) {
      return createElement("input", {
        className: "zGbnIq_input",
        value: props.value,
        type: props.type ?? "text",
        placeholder: props.placeholder ?? "",
        disabled: props.disabled ?? false,
        onChange: function (e) { props.onChange(e.target.value); },
      });
    }

    /** 状态点：绿色=当前使用中，灰色=未使用。 */
    function Dot(props) {
      var cls = "zGbnIq_credentialDot " + (props.active ? "zGbnIq_credentialDotConfigured" : "iv_dotIdle");
      return createElement("span", { className: cls, title: props.active ? "当前使用中" : "未使用" });
    }

    /** 供应商卡片头部（厂商名/编辑/删除行）浅灰底色。 */
    var PROVIDER_HEADER_BG = "rgba(128,128,128,0.10)";

    // ===== 供应商卡片（行）=====
    function ProviderCard(props) {
      var p = props.provider;
      var activeKey = String(props.active ?? "");
      var isActiveProvider = activeKey.indexOf(p.id + ":") === 0;
      var target = resolveActive(props.providers, props.active);

      // ===== 模型行指针拖拽排序：按住手柄上下移动，其他模型行实时让位，松手保存 =====
      var _md = useState(null);   // { index } 拖拽中的模型行索引
      var modelDrag = _md[0]; var setModelDrag = _md[1];
      var _mp = useState(null);   // 拖拽中的实时预览顺序
      var previewModels = _mp[0]; var setPreviewModels = _mp[1];

      var beginModelDrag = function (idx, e) {
        e.preventDefault();
        if (props.dragDisabled) return;
        var cur = idx;
        var order = (previewModels ?? p.models).slice();
        var grabOffset = 0;
        var dragEl = null;
        var lastY = e.clientY;
        var flipBefore = new Map();   // modelId -> 布局位置
        var flipScheduled = false;
        var followScheduled = false;
        var ended = false;        // 松手后失效待执行的 FLIP
        // 布局位置（视口坐标，不含 transform）：rect 减去自身 translateY，滚动安全
        var layoutTop = function (el) {
          var r = el.getBoundingClientRect();
          var t = el.style.transform;
          if (typeof t === "string" && t !== "" && t !== "none") {
            var m = t.match(/translateY\((-?[\d.]+)px\)/);
            if (m !== null) return r.top - parseFloat(m[1]);
          }
          return r.top;
        };
        // FLIP：交换前按模型 id 记录位置（索引会随重排错位，必须用稳定 id）
        var snap = function () {
          var root = document.querySelector('[data-iv-provider-id="' + p.id + '"]');
          if (root === null) return;
          var nodes = Array.from(root.querySelectorAll("[data-iv-model-id]"));
          flipBefore.clear();
          nodes.forEach(function (el) { flipBefore.set(el.getAttribute("data-iv-model-id"), layoutTop(el)); });
        };
        var flip = function () {
          if (flipScheduled || ended) return;
          flipScheduled = true;
          requestAnimationFrame(function () {
            flipScheduled = false;
            if (ended) return;   // 已松手：顺序已回退，不能再按旧快照计算
            var root = document.querySelector('[data-iv-provider-id="' + p.id + '"]');
            if (root === null) return;
            var els = Array.from(root.querySelectorAll("[data-iv-model-id]"));
            els.forEach(function (el) {
              if (el === dragEl) return;   // 被拖行由跟手 transform 控制
              var from = flipBefore.get(el.getAttribute("data-iv-model-id"));
              if (from === void 0) return;
              var to = layoutTop(el);
              var delta = from - to;
              if (Math.abs(delta) < 0.5) return;
              el.style.transition = "none";
              el.style.transform = "translateY(" + delta + "px)";
              void el.getBoundingClientRect();
              el.style.transition = "transform 180ms ease";
              el.style.transform = "";
            });
          });
        };
        // 跟手：始终记录最新 Y，合并到 rAF 执行；视觉位置夹在模型列表范围内，不飞出卡片
        var follow = function (ev) {
          lastY = ev.clientY;
          if (dragEl === null || followScheduled) return;
          followScheduled = true;
          requestAnimationFrame(function () {
            followScheduled = false;
            if (dragEl === null || ended) return;
            var ty = lastY - grabOffset - layoutTop(dragEl);
            var listEl = dragEl.parentElement;   // ul.zGbnIq_modelList
            if (listEl !== null) {
              var lr = listEl.getBoundingClientRect();
              var visual = layoutTop(dragEl) + ty;
              var minV = lr.top + 2;
              var maxV = lr.bottom - dragEl.offsetHeight - 2;
              if (visual < minV) ty = minV - layoutTop(dragEl);
              if (visual > maxV) ty = maxV - layoutTop(dragEl);
            }
            if (Math.abs(ty) < 0.5) ty = 0;
            dragEl.style.transition = "none";
            dragEl.style.transform = "translateY(" + ty + "px)";
          });
        };
        setModelDrag({ index: idx });
        setPreviewModels(order);
        var rootEl = document.querySelector('[data-iv-provider-id="' + p.id + '"]');
        if (rootEl !== null) {
          var initEl = rootEl.querySelector('[data-iv-model-index="' + idx + '"]');
          if (initEl !== null) {
            dragEl = initEl;
            grabOffset = e.clientY - layoutTop(initEl);
            initEl.style.position = "relative";
            initEl.style.zIndex = "5";
            follow(e);
          }
        }
        var onMove = function (ev) {
          var root = document.querySelector('[data-iv-provider-id="' + p.id + '"]');
          if (root === null) return;
          var nodes = Array.from(root.querySelectorAll("[data-iv-model-id]"));
          var target = -1;
          for (var i = 0; i < nodes.length; i++) {
            var top = layoutTop(nodes[i]);
            if (ev.clientY >= top && ev.clientY <= top + nodes[i].offsetHeight) { target = i; break; }
          }
          if (target < 0 || target === cur) {
            follow(ev);
            return;
          }
          snap();
          var next = order.slice();
          var t = next.splice(cur, 1)[0];
          next.splice(target, 0, t);
          order = next;
          cur = target;
          setPreviewModels(next);
          setModelDrag({ index: cur });
          flip();
          follow(ev);
        };
        var onUp = function () {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          ended = true;
          if (dragEl !== null) {
            dragEl.style.transform = "";
            dragEl.style.position = "";
            dragEl.style.zIndex = "";
          }
          setModelDrag(null);
          setPreviewModels(null);
          if (cur !== idx && typeof props.onReorderModels === "function") {
            props.onReorderModels(p.id, order);
          }
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      };

      // 模型列表收纳状态：true = 收起（隐藏全部模型）
      var _cl = useState(false);
      var collapsed = _cl[0]; var setCollapsed = _cl[1];

      // 每个模型的检测状态：{ [modelId]: { busy, result } }
      var _t = useState({});
      var tests = _t[0]; var setTests = _t[1];

      /** 用内置测试图实测该供应商下模型的识图能力（每次点击都重新检测）。 */
      var runTest = async function (modelId) {
        setTests(function (prev) {
          var next = Object.assign({}, prev);
          next[modelId] = { busy: true, result: null };
          return next;
        });
        try {
          var resp = await fetch("/api/dsh-image-vision/test-model", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiBaseUrl: p.apiBaseUrl, apiKey: p.apiKey, model: modelId }),
          });
          var data = await resp.json();
          setTests(function (prev) {
            var next = Object.assign({}, prev);
            next[modelId] = { busy: false, result: data };
            return next;
          });
        } catch (e) {
          setTests(function (prev) {
            var next = Object.assign({}, prev);
            next[modelId] = { busy: false, result: { ok: false, error: String(e?.message ?? e), imageSupport: "unknown" } };
            return next;
          });
        }
      };

      // ===== 余额查询 =====
      var _bal = useState({ busy: false, data: null });
      var bal = _bal[0]; var setBal = _bal[1];

      var queryBalance = async function () {
        setBal({ busy: true, data: bal.data });
        try {
          var resp = await fetch("/api/dsh-image-vision/balance", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiBaseUrl: p.apiBaseUrl, apiKey: p.apiKey }),
          });
          var data = await resp.json();
          setBal({ busy: false, data: data });
        } catch (e) {
          setBal({ busy: false, data: { ok: false, error: String(e?.message ?? e) } });
        }
      };

      // 挂载时自动查询一次；端点/Key 变化（编辑保存后）也重新查询。
      useEffect(function () {
        if (p.apiBaseUrl && p.apiKey) queryBalance();
        // 仅依赖端点与 Key：查询函数只读当前 props
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [p.apiBaseUrl, p.apiKey]);

      // ===== 内嵌「添加模型」面板 =====
      var _adding = useState(false);
      var panelOpen = _adding[0]; var setPanelOpen = _adding[1];
      var _ad = useState(null);
      var addDiscovered = _ad[0]; var setAddDiscovered = _ad[1];
      var _adb = useState(false);
      var addDiscovering = _adb[0]; var setAddDiscovering = _adb[1];
      var _am = useState("");
      var addManual = _am[0]; var setAddManual = _am[1];
      var _pk = useState({});
      var picked = _pk[0]; var setPicked = _pk[1];

      var addDiscover = async function () {
        setAddDiscovering(true);
        try {
          var resp = await fetch("/api/dsh-image-vision/models", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseUrl: p.apiBaseUrl, apiKey: p.apiKey }),
          });
          var data = await resp.json();
          if (!resp.ok) throw new Error(data.error ?? ("HTTP " + resp.status));
          setAddDiscovered(data.models ?? []);
        } catch (e) {
          setAddDiscovered([]);
        } finally {
          setAddDiscovering(false);
        }
      };

      var togglePick = function (m) {
        setPicked(function (prev) {
          var next = Object.assign({}, prev);
          if (next[m.id]) delete next[m.id];
          else next[m.id] = m.vision;
          return next;
        });
      };

      var addManualModel = function () {
        var id = addManual.trim();
        if (id === "") return;
        setAddManual("");
        props.onAddModels(p.id, [{ id: id, vision: guessVision(id) }]);
      };

      var confirmAdd = function () {
        var ids = Object.keys(picked);
        if (ids.length === 0) return;
        var newModels = ids.map(function (id) { return { id: id, vision: picked[id] }; });
        props.onAddModels(p.id, newModels);
        setPicked({});
        setAddDiscovered(null);
        setPanelOpen(false);
      };

      var shownModels = previewModels ?? p.models;
      var modelRows = [];
      for (var i = 0; i < shownModels.length; i++) {
        (function (m, mi) {
          var isActiveModel = isActiveProvider && target !== null && target.model.id === m.id;
          var isUsing = isActiveModel;
          var testState = tests[m.id] ?? null;
          modelRows.push(createElement("li", {
            className: "zGbnIq_modelEntry" + (modelDrag !== null && modelDrag.index === mi ? " iv_dragging" : ""),
            key: m.id,
            "data-iv-model-index": mi,
            "data-iv-model-id": m.id,
            style: isUsing ? { background: "var(--dsw-alias-interactive-bg-hover)" } : null,
          },
            createElement("div", { className: "zGbnIq_modelRow iv_modelRow" },
              createElement("button", {
                type: "button",
                className: "iv_dragHandle",
                title: "按住拖动排序",
                disabled: props.dragDisabled,
                onPointerDown: function (e) { beginModelDrag(mi, e); },
              }, "≡"),
              createElement("span", { className: "iv_candidateId" }, m.id),
              createElement("span", { className: "zGbnIq_rowTag " + (m.vision ? "iv_visionYes" : "iv_visionNo") },
                m.vision ? "视觉" : "非视觉"),
              (function () {
                var tp = testResultProps(testState);
                return createElement("button", {
                  type: "button",
                  className: "zGbnIq_linkButton",
                  disabled: testState !== null && testState.busy,
                  style: tp && tp.color ? { color: tp.color } : undefined,
                  title: tp ? tp.title : "用内置测试图实测该模型的视觉能力",
                  onClick: function () { runTest(m.id); },
                }, tp ? tp.label : "检测");
              })(),
              createElement("button", {
                type: "button",
                className: "zGbnIq_secondaryButton",
                style: { height: 28, padding: "0 10px", fontSize: 12, borderRadius: 14 },
                disabled: isUsing || !m.vision,
                title: isUsing ? "当前使用中" : (m.vision ? "" : "该模型不具有视觉能力，不可选择"),
                onClick: function () { props.onUse(p.id, m.id); },
              }, isUsing ? "使用中" : "使用"),
              createElement("button", {
                type: "button",
                className: "zGbnIq_iconButton zGbnIq_iconButtonDanger",
                title: "删除该模型",
                onClick: function () { props.onRemoveModel(p.id, m.id); },
              }, "×")
            )
          ));
        })(shownModels[i], i);
      }

      // 内嵌「添加模型」面板：候选勾选节点
      var pickNodes = [];
      if (addDiscovered !== null) {
        for (var k = 0; k < addDiscovered.length; k++) {
          (function (dm) {
            var checked = Object.prototype.hasOwnProperty.call(picked, dm.id);
            pickNodes.push(createElement("li", { className: "zGbnIq_candidate", key: dm.id },
              createElement("label", { className: "iv_candidateLabel", style: dm.vision ? null : { opacity: 0.55 } },
                createElement("input", {
                  type: "checkbox",
                  checked: checked,
                  disabled: !dm.vision,
                  title: dm.vision ? "" : "该模型不具有视觉能力，不可选择",
                  onChange: function () { togglePick(dm); },
                }),
                createElement("span", { className: "iv_candidateId" }, dm.id),
                createElement("span", { className: "zGbnIq_rowTag " + (dm.vision ? "iv_visionYes" : "iv_visionNo") },
                  dm.vision ? "视觉" : "非视觉")
              )
            ));
          })(addDiscovered[k]);
        }
      }

      var addPanel = panelOpen
        ? createElement("div", { className: "iv_addPanel" },
            createElement("div", { className: "iv_inlineRow" },
              createElement(primitives.Button, {
                variant: "outline",
                size: "sm",
                disabled: addDiscovering,
                onClick: addDiscover,
              }, addDiscovering ? "获取中…" : "获取模型列表"),
              createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } },
                "勾选视觉模型（非视觉不可选）")
            ),
            addDiscovered !== null && addDiscovered.length > 0
              ? createElement("ul", { className: "iv_candidateList", style: { marginTop: 8 } }, pickNodes)
              : null,
            addDiscovered !== null && addDiscovered.length === 0
              ? createElement("p", { className: "zGbnIq_modelEmpty" }, "该端点未返回模型，可手动输入添加")
              : null,
            createElement("div", { className: "iv_manualRow" },
              createElement(TextInput, { value: addManual, placeholder: "手动输入模型名称（例如 gpt-4o）", onChange: setAddManual }),
              createElement(primitives.Button, { variant: "outline", size: "sm", onClick: addManualModel }, "添加")
            ),
            createElement("div", { className: "zGbnIq_editorActions" },
              createElement("button", {
                type: "button",
                className: "zGbnIq_secondaryButton",
                onClick: function () { setPanelOpen(false); },
              }, "取消"),
              createElement("button", {
                type: "button",
                className: "zGbnIq_primaryButton",
                disabled: Object.keys(picked).length === 0,
                onClick: confirmAdd,
              }, "添加选中（" + Object.keys(picked).length + "）")
            )
          )
        : null;

      return createElement("li", {
        className: "zGbnIq_rowCard iv_providerCard" + (isActiveProvider ? " iv_activeCard" : "") + (props.dragging ? " iv_dragging" : ""),
        "data-iv-provider-id": p.id,
      },
        createElement("div", {
          className: "zGbnIq_rowHead",
          style: { background: PROVIDER_HEADER_BG, borderRadius: 8, padding: "6px 8px", margin: "-6px -8px" },
        },
          createElement("button", {
            type: "button",
            className: "iv_dragHandle",
            title: "按住拖动排序供应商",
            disabled: props.dragDisabled,
            onPointerDown: function (e) { if (typeof props.onDragStart === "function") props.onDragStart(e); },
          }, "≡"),
          createElement(Dot, { active: isActiveProvider }),
          createElement("span", { className: "zGbnIq_rowIdentity" },
            createElement("span", { className: "zGbnIq_rowName" }, p.name),
            createElement("span", { className: "zGbnIq_rowTag" }, p.models.length + " 个模型"),
            isActiveProvider
              ? createElement("span", { className: "zGbnIq_rowTag iv_visionYes" }, "使用中")
              : null
          ),
          createElement("span", { className: "zGbnIq_rowActions" },
            createElement("button", {
              type: "button",
              className: "zGbnIq_iconButton",
              title: collapsed ? "展开模型" : "收起模型",
              onClick: function () { setCollapsed(!collapsed); },
            }, createElement(primitives.IconChevronDownOutline14, {
              style: collapsed ? { transform: "rotate(-90deg)" } : null,
            })),
            createElement("button", {
              type: "button",
              className: "zGbnIq_secondaryButton",
              onClick: props.onEdit,
            }, "编辑"),
            createElement("button", {
              type: "button",
              className: "zGbnIq_dangerButton",
              onClick: props.onDelete,
            }, "删除")
          )
        ),
        createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
          createElement("p", { className: "iv_metaText", style: { flex: 1 }, title: p.apiBaseUrl }, p.apiBaseUrl),
          createElement("button", {
            type: "button",
            className: "iv_balanceChip" + (bal.data && bal.data.ok ? " iv_balanceOk" : ""),
            disabled: bal.busy,
            title: bal.data && !bal.data.ok && bal.data.error
              ? "点击重新查询：" + bal.data.error + (bal.data.hint ? "；" + bal.data.hint : "")
              : "点击查询最新余额",
            onClick: queryBalance,
          },
            bal.busy
              ? "余额查询中…"
              : (bal.data && bal.data.ok ? "余额：" + formatBalance(bal.data) : "余额：--")
          )
        ),
        !collapsed && p.models.length > 0
          ? createElement("ul", { className: "zGbnIq_modelList", style: { margin: 0 } }, modelRows)
          : !collapsed
            ? createElement("p", { className: "zGbnIq_modelEmpty" }, "该供应商还没有模型，点击下方「+ 添加模型」添加")
            : null,
        !collapsed && (panelOpen
          ? addPanel
          : createElement("button", {
              type: "button",
              className: "zGbnIq_addModelButton",
              style: { marginTop: 8 },
              onClick: function () { setPanelOpen(true); },
            }, "+ 添加模型"))
      );
    }

    // ===== 供应商编辑器（添加/编辑共用）=====
    function ProviderEditor(props) {
      var initial = props.initial;
      var _n = useState(initial ? (initial.name ?? "") : "");
      var name = _n[0]; var setName = _n[1];
      var _b = useState(initial ? (initial.apiBaseUrl ?? "") : "");
      var baseUrl = _b[0]; var setBaseUrl = _b[1];
      var _k = useState(initial ? (initial.apiKey ?? "") : "");
      var apiKey = _k[0]; var setApiKey = _k[1];
      var _m = useState(initial ? (initial.models ?? []) : []);
      var models = _m[0]; var setModels = _m[1];
      var _d = useState(null);
      var discovered = _d[0]; var setDiscovered = _d[1];
      var _ds = useState("live");
      var discoveredSource = _ds[0]; var setDiscoveredSource = _ds[1];
      var _dw = useState("");
      var discoveredWarning = _dw[0]; var setDiscoveredWarning = _dw[1];
      var _discovering = useState(false);
      var discovering = _discovering[0]; var setDiscovering = _discovering[1];
      var _manual = useState("");
      var manualId = _manual[0]; var setManualId = _manual[1];
      var _err = useState("");
      var error = _err[0]; var setError = _err[1];
      var _busy = useState(false);
      var busy = _busy[0]; var setBusy = _busy[1];

      // 厂商模板选中态：端点与某预设一致时回显该预设，否则自定义
      var _p = useState((function () {
        var url = initial ? (initial.apiBaseUrl ?? "") : "";
        for (var x = 0; x < PROVIDER_PRESETS.length; x++) {
          if (PROVIDER_PRESETS[x].apiBaseUrl === url) return url;
        }
        return "";
      })());
      var presetKey = _p[0]; var setPresetKey = _p[1];

      /** 选择厂商模板：自动填入名称与 API 端点（不覆盖已填的 Key 和模型）。 */
      var applyPreset = function (value) {
        setPresetKey(value);
        if (value === "") return;
        for (var x = 0; x < PROVIDER_PRESETS.length; x++) {
          if (PROVIDER_PRESETS[x].apiBaseUrl === value) {
            setName(PROVIDER_PRESETS[x].name);
            setBaseUrl(PROVIDER_PRESETS[x].apiBaseUrl);
            return;
          }
        }
      };

      var hasModel = function (id) {
        return models.some(function (m) { return m.id === id; });
      };

      var discover = async function () {
        setDiscovering(true);
        setError("");
        setDiscoveredWarning("");
        try {
          var resp = await fetch("/api/dsh-image-vision/models", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseUrl: baseUrl, apiKey: apiKey }),
          });
          var data = await resp.json();
          if (!resp.ok) throw new Error(data.error ?? ("HTTP " + resp.status));
          setDiscovered(data.models ?? []);
          setDiscoveredSource(data.source === "preset" ? "preset" : "live");
          setDiscoveredWarning(data.warning ?? "");
        } catch (e) {
          setError("获取模型列表失败: " + String(e?.message ?? e));
        } finally {
          setDiscovering(false);
        }
      };

      var toggleModel = function (m) {
        if (hasModel(m.id)) {
          setModels(models.filter(function (x) { return x.id !== m.id; }));
        } else {
          setModels(models.concat([{ id: m.id, vision: m.vision }]));
        }
      };

      var addManual = function () {
        var id = manualId.trim();
        if (id === "") return;
        if (hasModel(id)) { setManualId(""); return; }
        setModels(models.concat([{ id: id, vision: guessVision(id) }]));
        setManualId("");
      };

      var removeModel = function (id) {
        setModels(models.filter(function (m) { return m.id !== id; }));
      };

      // 每个模型的检测状态：{ [modelId]: { busy, result } }
      var _t = useState({});
      var tests = _t[0]; var setTests = _t[1];

      /** 用内置测试图实测当前表单端点/Key/模型 的识图能力（每次点击都重新检测）。 */
      var runTest = async function (modelId) {
        setTests(function (prev) {
          var next = Object.assign({}, prev);
          next[modelId] = { busy: true, result: null };
          return next;
        });
        setError("");
        try {
          var resp = await fetch("/api/dsh-image-vision/test-model", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiBaseUrl: baseUrl, apiKey: apiKey, model: modelId }),
          });
          var data = await resp.json();
          setTests(function (prev) {
            var next = Object.assign({}, prev);
            next[modelId] = { busy: false, result: data };
            return next;
          });
        } catch (e) {
          setTests(function (prev) {
            var next = Object.assign({}, prev);
            next[modelId] = { busy: false, result: { ok: false, error: String(e?.message ?? e), imageSupport: "unknown" } };
            return next;
          });
        }
      };

      var canSave = name.trim() !== "" && baseUrl.trim() !== "" && apiKey.trim() !== "" && models.length > 0;

      var save = async function () {
        if (!canSave) return;
        setBusy(true);
        setError("");
        try {
          await props.onSave({ name: name.trim(), apiBaseUrl: baseUrl.trim(), apiKey: apiKey.trim(), models: models });
        } catch (e) {
          setError("保存失败: " + String(e?.message ?? e));
          setBusy(false);
        }
      };

      // 候选模型列表（勾选添加；非识图模型禁用并提示）
      var candidateNodes = [];
      if (discovered !== null) {
        for (var i = 0; i < discovered.length; i++) {
          (function (dm) {
            var checked = hasModel(dm.id);
            candidateNodes.push(createElement("li", { className: "zGbnIq_candidate", key: dm.id },
              createElement("label", { className: "iv_candidateLabel", style: dm.vision ? null : { opacity: 0.55 } },
                createElement("input", {
                  type: "checkbox",
                  checked: checked,
                  disabled: !dm.vision,
                  title: dm.vision ? "" : "该模型不具有视觉能力，不可选择",
                  onChange: function () { toggleModel(dm); },
                }),
                createElement("span", { className: "iv_candidateId" }, dm.id),
                createElement("span", { className: "zGbnIq_rowTag " + (dm.vision ? "iv_visionYes" : "iv_visionNo") },
                  dm.vision ? "视觉" : "非视觉")
              )
            ));
          })(discovered[i]);
        }
      }

      // 已选模型列表（每行：模型 id + 识图标记 + 检测按钮 + 删除按钮；行下显示检测结果）
      var selectedNodes = [];
      for (var j = 0; j < models.length; j++) {
        (function (sm) {
          var testState = tests[sm.id] ?? null;
          selectedNodes.push(createElement("li", { className: "zGbnIq_modelEntry", key: sm.id },
            createElement("div", { className: "zGbnIq_modelRow iv_modelRow" },
              createElement("span", { className: "iv_candidateId" }, sm.id),
              createElement("span", { className: "zGbnIq_rowTag " + (sm.vision ? "iv_visionYes" : "iv_visionNo") },
                sm.vision ? "视觉" : "非视觉"),
              (function () {
                var tp = testResultProps(testState);
                return createElement("button", {
                  type: "button",
                  className: "zGbnIq_linkButton",
                  disabled: testState !== null && testState.busy,
                  style: tp && tp.color ? { color: tp.color } : undefined,
                  title: tp ? tp.title : "用内置测试图实测该模型的视觉能力",
                  onClick: function () { runTest(sm.id); },
                }, tp ? tp.label : "检测");
              })(),
              createElement("button", {
                type: "button",
                className: "zGbnIq_iconButton zGbnIq_iconButtonDanger",
                title: "移除该模型",
                onClick: function () { removeModel(sm.id); },
              }, "×")
            )
          ));
        })(models[j]);
      }

      // 厂商模板下拉选项
      var presetOptions = [
        createElement("option", { key: "__custom", value: "" }, "自定义（手动填写端点）"),
      ];
      for (var x = 0; x < PROVIDER_PRESETS.length; x++) {
        presetOptions.push(createElement("option", {
          key: PROVIDER_PRESETS[x].apiBaseUrl,
          value: PROVIDER_PRESETS[x].apiBaseUrl,
        }, PROVIDER_PRESETS[x].name + "（" + PROVIDER_PRESETS[x].apiBaseUrl + "）"));
      }

      return createElement("li", { id: props.id, className: "zGbnIq_addCard iv_editingCard" },
        createElement("div", { className: "zGbnIq_editorHeader" },
          createElement("span", { className: "zGbnIq_editorTitle" }, initial ? "编辑供应商：" + (initial.name ?? "") : "添加供应商"),
          initial
            ? createElement("span", { className: "zGbnIq_editorRoute" }, initial.id)
            : null
        ),
        createElement(Field, { label: "厂商模板（选择后自动填入名称与端点）" },
          createElement("select", {
            className: "zGbnIq_input",
            style: { maxWidth: "100%" },
            value: presetKey,
            onChange: function (e) { applyPreset(e.target.value); },
          }, presetOptions),
          createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 4 } },
            "选择厂商后只需填写 API Key，再点「获取模型列表」")
        ),
        createElement(Field, { label: "供应商名称" },
          createElement(TextInput, { value: name, placeholder: "例如：小米 MiMo", onChange: setName })
        ),
        createElement(Field, { label: "API 端点（baseUrl）" },
          createElement(TextInput, {
            value: baseUrl,
            placeholder: "https://api.example.com/v1 （含 anthropic 的端点走 Anthropic 协议）",
            onChange: setBaseUrl,
          })
        ),
        createElement(Field, { label: "API Key" },
          createElement(TextInput, { value: apiKey, type: "password", placeholder: "sk-...", onChange: setApiKey })
        ),
        createElement(Field, { label: "模型" },
          createElement("div", { className: "iv_inlineRow" },
            createElement(primitives.Button, {
              variant: "outline",
              size: "sm",
              disabled: discovering || baseUrl.trim() === "",
              onClick: discover,
            }, discovering ? "获取中…" : "获取模型列表"),
            createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } },
              apiKey.trim() === "" ? "未填 API Key，仅获取内置候选" : "非视觉模型不可勾选")
          ),
          discovered !== null && discovered.length > 0
            ? createElement("div", { className: "zGbnIq_addBlock" },
                discoveredSource === "preset"
                  ? createElement("p", { className: "zGbnIq_notice" },
                    "当前仅显示 " + discovered.length + " 个内置候选模型（" + (discoveredWarning || "未获取到实时列表") + "）。" +
                    "填写有效的 API Key 后重新点击「获取模型列表」，可显示该厂商全部模型")
                  : null,
                createElement("ul", { className: "iv_candidateList" }, candidateNodes)
              )
            : null,
          discovered !== null && discovered.length === 0
            ? createElement("p", { className: "zGbnIq_modelEmpty" }, "该端点未返回任何模型")
            : null,
          models.length > 0
            ? createElement("ul", { className: "zGbnIq_modelList", style: { marginTop: 8 } }, selectedNodes)
            : null,
          createElement("div", { className: "iv_manualRow" },
            createElement(TextInput, {
              value: manualId,
              placeholder: "手动输入模型名称（例如 gpt-4o）",
              onChange: setManualId,
            }),
            createElement(primitives.Button, { variant: "outline", size: "sm", onClick: addManual }, "添加")
          )
        ),
        error !== "" ? createElement("p", { className: "zGbnIq_error" }, error) : null,
        createElement("div", { className: "zGbnIq_editorActions" },
          createElement("button", { type: "button", className: "zGbnIq_secondaryButton", disabled: busy, onClick: props.onCancel }, "取消"),
          createElement("button", { type: "button", className: "zGbnIq_primaryButton", disabled: busy || !canSave, onClick: save }, busy ? "保存中…" : "保存")
        )
      );
    }

    // ===== 设置页主体 =====
    function SettingsSection() {
      var _d = useState({ providers: [], active: "", enabled: false });
      var data = _d[0]; var setData = _d[1];
      var _loaded = useState(false);
      var loaded = _loaded[0]; var setLoaded = _loaded[1];
      var _err = useState("");
      var error = _err[0]; var setError = _err[1];
      var _editing = useState(null);   // { index } | null —— 编辑第几个供应商
      var editing = _editing[0]; var setEditing = _editing[1];
      var _adding = useState(false);   // 是否显示"添加供应商"卡片
      var adding = _adding[0]; var setAdding = _adding[1];
      var _saved = useState(false);
      var saved = _saved[0]; var setSaved = _saved[1];

      var reload = async function () {
        try {
          var resp = await fetch("/api/dsh-image-vision/config");
          var json = await resp.json();
          if (!resp.ok) throw new Error(json.error ?? ("HTTP " + resp.status));
          setData(json.config ?? { providers: [], active: "" });
        } catch (e) {
          setError("读取配置失败: " + String(e?.message ?? e));
        } finally {
          setLoaded(true);
        }
      };
      useEffect(function () { reload(); }, []);

      var saveConfig = async function (next) {
        var resp = await fetch("/api/dsh-image-vision/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        var json = await resp.json();
        if (!resp.ok) throw new Error(json.error ?? ("HTTP " + resp.status));
        setData(json.config ?? next);
        setSaved(true);
        // 通知对话页的视觉模型选择器 / 添加图片按钮重新读取配置（含总开关状态）
        try { window.dispatchEvent(new CustomEvent("iv-config-changed")); } catch { /* 忽略 */ }
      };

      var activate = async function (providerId, modelId) {
        setError("");
        try {
          var resp = await fetch("/api/dsh-image-vision/activate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providerId: providerId, modelId: modelId }),
          });
          var json = await resp.json();
          if (!resp.ok) throw new Error(json.error ?? ("HTTP " + resp.status));
          setData(json.config ?? data);
          setSaved(true);
        } catch (e) {
          setError("切换失败: " + String(e?.message ?? e));
        }
      };

      var removeProvider = async function (providerId, providerName) {
        if (!window.confirm("确定删除供应商「" + providerName + "」及其全部模型吗？")) return;
        setError("");
        try {
          var providers = data.providers.filter(function (p) { return p.id !== providerId; });
          await saveConfig({ providers: providers });
        } catch (e) {
          setError("删除失败: " + String(e?.message ?? e));
        }
      };

      /** 删除某个供应商下的单个模型（实时保存；若删除的是当前使用模型，active 会自动回退）。 */
      var removeModel = async function (providerId, modelId) {
        if (!window.confirm("确定删除模型「" + modelId + "」吗？")) return;
        setError("");
        try {
          var providers = data.providers.map(function (p) {
            if (p.id !== providerId) return p;
            var models = p.models.filter(function (m) { return m.id !== modelId; });
            return Object.assign({}, p, { models: models });
          });
          await saveConfig({ providers: providers });
        } catch (e) {
          setError("删除失败: " + String(e?.message ?? e));
        }
      };

      /** 向某个供应商追加模型（去重后实时保存）。 */
      var addModels = async function (providerId, newModels) {
        setError("");
        try {
          var providers = data.providers.map(function (p) {
            if (p.id !== providerId) return p;
            var ids = {};
            p.models.forEach(function (m) { ids[m.id] = true; });
            var merged = p.models.slice();
            for (var i = 0; i < newModels.length; i++) {
              if (!ids[newModels[i].id]) merged.push(newModels[i]);
            }
            return Object.assign({}, p, { models: merged });
          });
          await saveConfig({ providers: providers });
        } catch (e) {
          setError("添加模型失败: " + String(e?.message ?? e));
        }
      };

      var finishEdit = async function (draft) {
        var providers = data.providers.slice();
        if (editing !== null && editing.index >= 0 && editing.index < providers.length) {
          // 编辑：保留原 id
          var id = providers[editing.index].id;
          providers[editing.index] = { id: id, name: draft.name, apiBaseUrl: draft.apiBaseUrl, apiKey: draft.apiKey, models: draft.models };
        } else {
          // 添加：生成唯一 id
          var nid = "provider-" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
          providers.push({ id: nid, name: draft.name, apiBaseUrl: draft.apiBaseUrl, apiKey: draft.apiKey, models: draft.models });
        }
        await saveConfig({ providers: providers });
        setEditing(null);
        setAdding(false);
      };

      var providers = data ? data.providers : [];
      var active = data ? data.active : "";
      var target = resolveActive(providers, active);

      /** 模型重排序（供应商卡片内部拖拽松手后保存）。 */
      var reorderModels = async function (providerId, newModels) {
        setError("");
        try {
          var providers = data.providers.map(function (pr) {
            if (pr.id !== providerId) return pr;
            return Object.assign({}, pr, { models: newModels });
          });
          await saveConfig({ providers: providers });
        } catch (e) {
          setError("模型排序保存失败: " + String(e?.message ?? e));
        }
      };

      /** 一键添加 OVHcloud 免费视觉层（免注册、免 Key）。 */
      var addOvhProvider = async function () {
        setError("");
        try {
          var providers = data.providers.slice();
          if (providers.some(function (p) { return String(p.apiBaseUrl ?? "").indexOf("kepler.ai.cloud.ovh.net") >= 0; })) {
            setError("OVH 免费视觉层已添加过");
            return;
          }
          providers.push({
            id: "provider-ovh-" + Date.now().toString(36),
            name: "OVHcloud 免费",
            apiBaseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
            apiKey: "",
            models: [{ id: "Qwen2.5-VL-72B-Instruct", vision: true }],
          });
          await saveConfig({ providers: providers });
          setSaved(true);
        } catch (e) {
          setError("添加 OVH 失败: " + String(e?.message ?? e));
        }
      };

      // ===== 供应商卡片指针拖拽排序：按住手柄上下移动，其他卡片实时让位，松手保存 =====
      var _drag = useState(null);          // { index } 拖拽中的卡片索引
      var drag = _drag[0]; var setDrag = _drag[1];
      var _po = useState(null);            // 拖拽中的实时预览顺序
      var previewOrder = _po[0]; var setPreviewOrder = _po[1];

      var beginProviderDrag = function (idx, e) {
        e.preventDefault();
        if (editing !== null || adding) return;
        var cur = idx;
        var order = (previewOrder ?? data.providers).slice();
        var grabOffset = 0;       // 抓取点相对被拖卡片顶部的偏移
        var dragEl = null;        // 被拖卡片元素（React 按 key 复用节点，引用全程有效）
        var lastY = e.clientY;    // 最新指针 Y（不丢帧）
        var flipBefore = new Map();   // providerId -> 布局位置
        var flipScheduled = false;
        var followScheduled = false;
        var ended = false;        // 松手后失效待执行的 FLIP（避免用回退顺序算错位移）
        // 布局位置（视口坐标，不含 transform）：rect 减去自身 translateY，
        // 不依赖 offsetParent（滚动后 offsetTop 体系会全错，导致命中判断失败）
        var layoutTop = function (el) {
          var r = el.getBoundingClientRect();
          var t = el.style.transform;
          if (typeof t === "string" && t !== "" && t !== "none") {
            var m = t.match(/translateY\((-?[\d.]+)px\)/);
            if (m !== null) return r.top - parseFloat(m[1]);
          }
          return r.top;
        };
        // FLIP：交换前按 id 记录位置（索引会随重排错位，必须用稳定 id）
        var snap = function () {
          var nodes = Array.from(document.querySelectorAll("[data-iv-provider-id]"));
          flipBefore.clear();
          nodes.forEach(function (el) { flipBefore.set(el.getAttribute("data-iv-provider-id"), layoutTop(el)); });
        };
        var flip = function () {
          if (flipScheduled || ended) return;
          flipScheduled = true;
          requestAnimationFrame(function () {
            flipScheduled = false;
            if (ended) return;   // 已松手：顺序已回退，不能再按旧快照计算
            var els = Array.from(document.querySelectorAll("[data-iv-provider-id]"));
            els.forEach(function (el) {
              if (el === dragEl) return;   // 被拖卡片由跟手 transform 控制
              var from = flipBefore.get(el.getAttribute("data-iv-provider-id"));
              if (from === void 0) return;
              var to = layoutTop(el);
              var delta = from - to;
              if (Math.abs(delta) < 0.5) return;
              el.style.transition = "none";
              el.style.transform = "translateY(" + delta + "px)";
              void el.getBoundingClientRect();
              el.style.transition = "transform 180ms ease";
              el.style.transform = "";
            });
          });
        };
        // 跟手：始终记录最新 Y，合并到 rAF 执行，避免丢帧滞后
        var follow = function (ev) {
          lastY = ev.clientY;
          if (dragEl === null || followScheduled) return;
          followScheduled = true;
          requestAnimationFrame(function () {
            followScheduled = false;
            if (dragEl === null) return;
            var ty = lastY - grabOffset - layoutTop(dragEl);
            if (Math.abs(ty) < 0.5) ty = 0;
            dragEl.style.transition = "none";
            dragEl.style.transform = "translateY(" + ty + "px)";
          });
        };
        setDrag({ index: idx });
        setPreviewOrder(order);
        var initEl = document.querySelector('[data-iv-provider-id="' + order[cur].id + '"]');
        if (initEl !== null) {
          dragEl = initEl;
          grabOffset = e.clientY - layoutTop(initEl);
          initEl.style.position = "relative";
          initEl.style.zIndex = "5";
          follow(e);
        }
        var onMove = function (ev) {
          // 按指针 Y 命中卡片求目标索引（布局位置，不受过渡 transform 干扰）
          var nodes = Array.from(document.querySelectorAll("[data-iv-provider-id]"));
          var target = -1;
          for (var i = 0; i < nodes.length; i++) {
            var top = layoutTop(nodes[i]);
            if (ev.clientY >= top && ev.clientY <= top + nodes[i].offsetHeight) { target = i; break; }
          }
          if (target < 0 || target === cur) {
            follow(ev);
            return;
          }
          snap();
          var next = order.slice();
          var t = next.splice(cur, 1)[0];
          next.splice(target, 0, t);
          order = next;
          cur = target;
          setPreviewOrder(next);
          setDrag({ index: cur });
          flip();
          follow(ev);
        };
        var onUp = function () {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          ended = true;
          if (dragEl !== null) {
            dragEl.style.transform = "";
            dragEl.style.position = "";
            dragEl.style.zIndex = "";
          }
          setDrag(null);
          if (cur !== idx) {
            // 保留 previewOrder 直到保存完成，避免闪回旧顺序
            saveConfig({ providers: order })
              .then(function () { setPreviewOrder(null); })
              .catch(function (err) {
                setPreviewOrder(null);
                setError("排序保存失败: " + String(err?.message ?? err));
              });
          } else {
            setPreviewOrder(null);
          }
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      };

      var shownProviders = previewOrder ?? (data ? data.providers : []);
      var providerCards = [];
      for (var i = 0; i < shownProviders.length; i++) {
        (function (idx) {
          var prov = shownProviders[idx];
          // 就地编辑：编辑界面直接渲染在原卡片位置，不收起、不跳转，下方卡片自然下移。
          if (editing !== null && editing.index === idx) {
            providerCards.push(createElement(ProviderEditor, {
              key: "edit-" + prov.id,
              id: "iv-editor-edit",
              initial: prov,
              onSave: finishEdit,
              onCancel: function () { setEditing(null); },
            }));
            return;
          }
          providerCards.push(createElement(ProviderCard, {
            key: prov.id,
            provider: prov,
            providers: shownProviders,
            active: active,
            onUse: activate,
            onRemoveModel: removeModel,
            onAddModels: addModels,
            onEdit: function () { setEditing({ index: idx }); setAdding(false); },
            onDelete: function () { removeProvider(prov.id, prov.name); },
            onReorderModels: reorderModels,
            onDragStart: function (e) { beginProviderDrag(idx, e); },
            dragging: drag !== null && drag.index === idx,
            dragDisabled: editing !== null || adding,
          }));
        })(i);
      }

      return createElement("div", { className: "zGbnIq_section" },
        createElement("h2", { className: "zGbnIq_title" }, "视觉插件"),
        createElement("p", { className: "zGbnIq_intro" },
          "插件会自动判断当前接入的模型是否具备视觉能力：能看图片则用当前模型并按预设提示词分析；" +
          "否则调用下方「使用中」的供应商/模型进行识别。点击任意模型的「使用」即可切换。\n" +
          "📌 在对话框粘贴/拖拽/添加图片时，插件会先检查本页是否已配置视觉模型：已配置则图片以原生附件进入草稿（可缩略图预览、发送、点开看大图），发送时请在模型选择器选对应的「+ 自动识图」模型组（图片输入路由，模型仍由原厂商提供）；未配置则无法添加图片，并提示「请使用视觉模型或在插件中添加视觉模型」。"),
        createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "10px 14px", margin: "0 0 4px" } },
          createElement("div", { style: { minWidth: 0 } },
            createElement("div", { style: { fontSize: 14, fontWeight: 500 } }, "启用视觉插件"),
            createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
              "关闭后插件不参与：对话框不出现视觉模型选择器、DSH 模型选择不显示带 👁 的视觉组、不执行图片识别")
          ),
          createElement("button", {
            type: "button",
            role: "switch",
            "aria-checked": data.enabled === true,
            title: data.enabled === true ? "点击关闭" : "点击开启",
            style: {
              width: 44, height: 24, borderRadius: 12, flex: "none", cursor: "pointer",
              border: "none", position: "relative",
              background: data.enabled === true ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-border-l3)",
              transition: "background .15s",
            },
            onClick: function () {
              saveConfig(Object.assign({}, data, { enabled: data.enabled !== true }));
            },
          },
            createElement("span", { style: {
              position: "absolute", top: 2, left: data.enabled === true ? 22 : 2, width: 20, height: 20,
              borderRadius: 10, background: "#fff", transition: "left .15s",
            } })
          )
        ),
        createElement("div", { className: "iv_currentBar" },
          target !== null
            ? createElement("span", null,
                createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "当前使用："),
                createElement("strong", null, target.provider.name),
                createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, " · "),
                createElement("strong", null, target.model.id)
              )
            : createElement("span", { className: "iv_currentEmpty" },
                "尚未配置视觉模型，点击下方「添加供应商」开始配置"),
          saved ? createElement("span", { className: "zGbnIq_savedNotice", style: { marginLeft: "auto" } }, "已保存") : null
        ),
        !loaded
          ? createElement("p", { className: "zGbnIq_intro" }, "加载中…")
          : null,
        error !== "" ? createElement("p", { className: "zGbnIq_error" }, error) : null,
        createElement("ul", { className: "zGbnIq_rows" },
          providerCards,
          adding
            ? createElement(ProviderEditor, {
                key: "add",
                id: "iv-editor-add",
                initial: null,
                onSave: finishEdit,
                onCancel: function () { setAdding(false); },
              })
            : null
        ),
        editing === null && !adding
          ? createElement("div", { className: "zGbnIq_addActions", style: { marginTop: 12, gap: 8, display: "flex" } },
              createElement("button", {
                type: "button",
                className: "zGbnIq_addButton",
                onClick: function () { setAdding(true); },
              }, "+ 添加供应商"),
              createElement("button", {
                type: "button",
                className: "zGbnIq_secondaryButton",
                title: "免注册、免 Key，每 IP/模型 2 次/分钟",
                onClick: addOvhProvider,
              }, "⚡ 一键添加 OVH 免费视觉层（免 Key）")
            )
          : null
      );
    }


    /**
     * 输入框工具行「添加图片」按钮（conversation.input.left）。
     * 点击选图 / 直接粘贴 / 拖拽图片 → 先检查插件是否已配置视觉模型：
     * - 已配置：以原生粘贴事件交给 DSH 草稿（缩略图预览、发送、消息区渲染、点开预览全走
     *   原生流程；发送准入由插件注册的「X + 自动识图」模型组声明 image 输入通过，twin
     *   stream 把图片改写为引用标记交给文本模型，模型再调用 image_vision 识别）；
     * - 未配置：拦截并提示「请使用视觉模型或在插件中添加视觉模型」。
     */
    function ImagePickButton(props) {
      var input = props.input;
      var inputActions = props.inputActions;
      var fileRef = React.useRef(null);
      var buttonRef = React.useRef(null);
      var injecting = React.useRef(false);
      var _e = useState(null);
      var error = _e[0]; var setError = _e[1];
      var toastSeq = React.useRef(0);
      // 总开关：关闭时整个输入框图片侧不参与（按钮不渲染、粘贴/拖拽不拦截）
      var _en = useState(null);
      var enabledFlag = _en[0]; var setEnabledFlag = _en[1];
      var enabledRef = React.useRef(false);

      var reloadEnabled = function () {
        fetch("/api/dsh-image-vision/config", { method: "GET" })
          .then(function (r) { return r.json(); })
          .then(function (json) {
            var cfg = json && json.config;
            var en = !!(cfg && cfg.enabled === true);
            enabledRef.current = en;
            setEnabledFlag(en);
          })
          .catch(function () {
            enabledRef.current = false;
            setEnabledFlag(false);
          });
      };

      React.useEffect(function () {
        reloadEnabled();
        // 插件配置变化（如设置页开关总开关）时重新读取，即时响应启用/停用。
        window.addEventListener("iv-config-changed", reloadEnabled);
        return function () { window.removeEventListener("iv-config-changed", reloadEnabled); };
      }, []);

      /** 检查插件配置中是否存在视觉模型（任一供应商下有 vision=true 的模型）。 */
      var ensureVisionReady = function () {
        return fetch("/api/dsh-image-vision/config", { method: "GET" })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (json) {
            var providers = (json && json.config && json.config.providers) || [];
            return providers.some(function (p) { return (p.models || []).some(function (m) { return m.vision; }); });
          });
      };

      /** 当前焦点所在的输入框（无则回退对话页 composer 输入框）。 */
      var findTextarea = function () {
        var ae = document.activeElement;
        if (ae !== null && ae.tagName === "TEXTAREA") return ae;
        return document.querySelector("[data-composer-card] textarea");
      };

      /** 模拟一次原生粘贴事件（DataTransfer + ClipboardEvent）→ 图片进 DSH 原生草稿。 */
      var pasteNative = function (images, ta) {
        var dt = new DataTransfer();
        for (var i = 0; i < images.length; i++) dt.items.add(images[i]);
        var ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        ta.dispatchEvent(ev);
      };

      /** 三路统一入口：检查配置 → 未配置提示；已配置 → 原生粘贴（预览/发送原生流程）。 */
      var maybeAddImages = function (images) {
        if (images.length === 0) return;
        ensureVisionReady()
          .then(function (ready) {
            if (!ready) {
              toastSeq.current += 1;
              setError("请使用视觉模型或在插件中添加视觉模型");
              return;
            }
            var ta = findTextarea();
            if (ta === null) throw new Error("未找到输入框");
            // 防重入：合成的 paste 事件会再次经过 document 捕获阶段，
            // 标记 injecting 让 intercept 放行，确保 DSH 原生处理器能收到。
            injecting.current = true;
            try {
              pasteNative(images, ta);
            } finally {
              injecting.current = false;
            }
          })
          .catch(function (err) {
            toastSeq.current += 1;
            setError(String(err && err.message ? err.message : err));
          });
      };

      // 拦截全局粘贴/拖拽图片：先做配置检查——未配置则拦截提示；已配置则转入原生流程。
      useEffect(function () {
        var intercept = function (e) {
          // 总开关关闭：不参与，放行 DSH 原生行为（相当于插件不存在）
          if (!enabledRef.current) return;
          // 合成 paste（maybeAddImages 内派发）不拦截，放行给 DSH 原生处理器
          if (injecting.current) return;
          var dt = e.clipboardData || e.dataTransfer;
          if (!dt) return;
          var images = Array.from(dt.files || []).filter(function (f) { return f && /^image\//.test(f.type); });
          if (images.length === 0) return;
          // 找不到输入框时不拦截（放行原生行为）
          if (findTextarea() === null) return;
          e.preventDefault();
          e.stopPropagation();
          maybeAddImages(images);
        };
        document.addEventListener("paste", intercept, true);
        document.addEventListener("drop", intercept, true);
        return function () {
          document.removeEventListener("paste", intercept, true);
          document.removeEventListener("drop", intercept, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      var pickFiles = function (files) {
        var images = Array.from(files || []).filter(function (f) { return f && /^image\//.test(f.type); });
        maybeAddImages(images);
      };

      var onPickChange = function (e) {
        var files = Array.from(e.target.files ?? []);
        e.target.value = "";
        pickFiles(files);
      };

      var disabled = input === void 0 || inputActions === void 0;

      // 总开关关闭 / 尚未加载：不渲染「添加图片」按钮（相当于插件未启用）
      if (enabledFlag !== true) return null;

      return createElement("div", { className: "iv_pickWrap" },
        createElement(primitives.Tooltip, {
          label: "添加图片（也可直接粘贴/拖拽；需先到 设置 → 视觉插件 添加并启用视觉模型）",
          side: "top",
          delayMs: 500,
        },
          createElement("button", {
            ref: buttonRef,
            type: "button",
            className: "iv_pickButton",
            disabled: disabled,
            "aria-label": "添加图片",
            title: "添加图片",
            onClick: function () { if (fileRef.current !== null) fileRef.current.click(); },
          },
            createElement(primitives.IconPaperclipOutline16, { size: 14 })
          )
        ),
        createElement("input", {
          ref: fileRef,
          type: "file",
          accept: "image/png,image/jpeg,image/webp,image/gif",
          multiple: true,
          style: { display: "none" },
          onChange: onPickChange,
        }),
        error !== null
          ? createElement(primitives.Toast, {
              key: "iv-pick-toast-" + toastSeq.current,
              text: error,
              icon: createElement(primitives.IconWarningOutline16, {}),
              anchor: buttonRef.current,
              onDone: function () { setError(null); },
            })
          : null
      );
    }

    /**
     * 输入框工具行「视觉模型」选择器（conversation.input.right）。
     * 显示插件当前使用的视觉模型，点击弹出下拉：按供应商分组列出插件已添加的全部模型，
     * 当前使用项高亮勾选，点击任意识图模型即切换（写入插件配置，后续识图调用即用该模型）。
     */
    function VisionModelSelect() {
      var _o = useState(false);
      var open = _o[0]; var setOpen = _o[1];
      var _c = useState(null);
      var config = _c[0]; var setConfig = _c[1];
      var _b = useState(false);
      var busy = _b[0]; var setBusy = _b[1];
      var _e = useState("");
      var error = _e[0]; var setError = _e[1];
      var rootRef = React.useRef(null);

      var load = async function () {
        setBusy(true);
        setError("");
        try {
          var resp = await fetch("/api/dsh-image-vision/config");
          var json = await resp.json();
          if (!resp.ok) throw new Error(json.error ?? ("HTTP " + resp.status));
          setConfig(json.config ?? { providers: [], active: "" });
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      };

      var activate = async function (providerId, modelId) {
        setBusy(true);
        setError("");
        try {
          var resp = await fetch("/api/dsh-image-vision/activate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providerId: providerId, modelId: modelId }),
          });
          var json = await resp.json();
          if (!resp.ok || !json.ok) throw new Error(json.error ?? ("HTTP " + resp.status));
          setConfig(json.config ?? config);
          setOpen(false);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      };

      var toggle = function () {
        if (open) {
          setOpen(false);
          return;
        }
        setOpen(true);
        load();
      };

      // 挂载时自动读取插件配置：设置页已选择的视觉模型立即显示，无需手动点击。
      React.useEffect(function () {
        load();
      }, []);

      // 插件配置变化（如设置页开关总开关）时重新加载，即时响应启用/停用。
      React.useEffect(function () {
        var onChange = function () { load(); };
        window.addEventListener("iv-config-changed", onChange);
        return function () { window.removeEventListener("iv-config-changed", onChange); };
      }, []);

      // 点击外部关闭下拉
      React.useEffect(function () {
        if (!open) return;
        var closeOutside = function (event) {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("mousedown", closeOutside);
        return function () { document.removeEventListener("mousedown", closeOutside); };
      }, [open]);

      var providers = config ? config.providers : [];
      var active = config ? config.active : "";
      var target = resolveActive(providers, active);
      var label = target !== null ? target.model.id : "未配置";

      var groups = [];
      for (var i = 0; i < providers.length; i++) {
        (function (p) {
          var options = [];
          for (var j = 0; j < p.models.length; j++) {
            (function (m) {
              var selected = target !== null && target.provider.id === p.id && target.model.id === m.id;
              options.push(createElement("button", {
                key: m.id,
                type: "button",
                role: "menuitemradio",
                "aria-checked": selected,
                className: "iv_vs_option" + (selected ? " iv_vs_selected" : ""),
                title: m.vision ? "" : "该模型不具有视觉能力，不可选择",
                disabled: busy || !m.vision,
                onClick: function () { activate(p.id, m.id); },
              },
                createElement("span", { className: "iv_vs_modelName" }, m.id),
                selected
                  ? createElement("span", { className: "iv_vs_check" },
                      createElement(primitives.IconCheckOutline16, { size: 16 }))
                  : null
              ));
            })(p.models[j]);
          }
          groups.push(
            createElement("section", { key: p.id, role: "group", className: "iv_vs_group" },
              createElement("div", { className: "iv_vs_groupTitle" }, p.name + "（" + p.models.length + " 个模型）"),
              options
            )
          );
        })(providers[i]);
      }

      // 总开关关闭 / 配置尚未加载：不渲染（相当于插件未启用，输入框不出现视觉模型选择）
      if (config === null || config.enabled !== true) return null;

      return createElement("div", { ref: rootRef, className: "iv_vs_root" },
        createElement("button", {
          type: "button",
          className: "iv_vs_trigger",
          "aria-haspopup": "menu",
          "aria-expanded": open,
          title: target !== null
            ? "视觉模型：" + target.provider.name + " · " + target.model.id + "（点击切换）"
            : "尚未配置视觉模型，点击查看（设置 → 视觉插件）",
          onClick: toggle,
        },
          createElement(primitives.IconInspectOutline12, { className: "iv_vs_icon" }),
          createElement("span", { className: "iv_vs_triggerLabel" }, "视觉 " + label),
          createElement(primitives.IconChevronDownOutline14, {
            className: "iv_vs_chevron" + (open ? " iv_vs_chevronOpen" : ""),
          })
        ),
        open
          ? createElement("div", { role: "menu", className: "iv_vs_menu" },
              busy && config === null
                ? createElement("div", { className: "iv_vs_status" }, "加载中…")
                : null,
              error !== ""
                ? createElement("div", { className: "iv_vs_error" }, error)
                : null,
              providers.length === 0 && !busy && error === ""
                ? createElement("div", { className: "iv_vs_status" },
                    "尚未配置视觉模型，请到 设置 → 视觉插件 添加供应商和模型")
                : null,
              providers.length > 0
                ? createElement("div", { className: "iv_vs_groups" }, groups)
                : null
            )
          : null
      );
    }


    /**
     * 把模型选择器等原生 UI 里模型名尾缀的 👁 渲染为「绿色小眼睛」SVG。
     * emoji glyph 不受 CSS color 控制，只能用 SVG（fill=currentColor + 主题成功绿）替换。
     * 用 MutationObserver 监听 DOM 持续处理新渲染的节点；全局守卫防 HMR 重复挂载。
     */
    function installGreenEyes() {
      if (window.__ivGreenEyesInstalled) return;
      window.__ivGreenEyesInstalled = true;
      var raf = null;
      function makeEye() {
        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "13");
        svg.setAttribute("height", "13");
        svg.setAttribute("style", "vertical-align:-2px;display:inline-block;color:var(--dsw-alias-state-success-primary)");
        var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("fill", "currentColor");
        p.setAttribute("d", "M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12c-2.5 0-4.5-2-4.5-4.5S9.5 7.5 12 7.5s4.5 2 4.5 4.5-2 4.5-4.5 4.5zm0-7.2c-1.5 0-2.7 1.2-2.7 2.7s1.2 2.7 2.7 2.7 2.7-1.2 2.7-2.7-1.2-2.7-2.7-2.7z");
        svg.appendChild(p);
        return svg;
      }
      function walk() {
        var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var hits = [];
        while (w.nextNode()) {
          var t = w.currentNode;
          if (t.nodeValue && t.nodeValue.indexOf("👁") >= 0) hits.push(t);
        }
        for (var i = 0; i < hits.length; i++) {
          var text = hits[i];
          if (!text.parentNode || text.nodeValue.indexOf("👁") < 0) continue;
          var parts = text.nodeValue.split("👁");
          var frag = document.createDocumentFragment();
          for (var k = 0; k < parts.length; k++) {
            if (parts[k]) frag.appendChild(document.createTextNode(parts[k]));
            if (k < parts.length - 1) frag.appendChild(makeEye());
          }
          text.parentNode.replaceChild(frag, text);
        }
      }
      var observer = new MutationObserver(function () {
        if (raf !== null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(walk);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      walk();
    }

    function apply(ctx) {
      installGreenEyes();
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "image-vision",
        order: 30,
        label: () => "视觉插件",
      }, SettingsSection));

      // 输入框工具行左侧：先「视觉模型」选择器（order 10），后「添加图片」按钮（order 20）。
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-image-vision.vision-model",
        order: 10,
        label: () => "视觉模型",
      }, VisionModelSelect));

      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-image-vision.pick",
        order: 20,
        label: () => "添加图片",
      }, ImagePickButton));

    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
