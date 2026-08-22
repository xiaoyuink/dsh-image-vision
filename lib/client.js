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
  id: "@xiaoyuink/dsh-image-vision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var createElement = React.createElement;

    var inject = ["slots", "conversation"];

    // ===== 发送层 hook：把带图发送改写为附件存储引用（让纯文本模型直接发图）=====
    // 文本模型（如 DeepSeek V4 Flash）无法通过发送准入接收 image block；此 hook 包一层
    // conversation.sendSession：带图且当前模型不识图时，把草稿图片以 base64 上传到 DSH
    // 附件存储（attachments.saveImage，永久保留），把消息改写为纯文本（含
    // ![图片](/api/dsh-image-vision/raw/<sha256>?m=..&b=..&w=..&h=..) 引用），再以
    // session.prompt 发出——图片字节不进会话，模型按系统规则调用 image_vision 系列工具
    // 识别，image_vision_ground → image_vision_crop → image_vision_ocr 像素精读链路不受影响。
    var SEND_HOOK_MARKER = "__dshImageVisionSendHooked";
    var UPLOAD_ENDPOINT = "/api/dsh-image-vision/attach";
    var PLUGIN_VERSION = "2.6.1"; // 与 package.json / host 侧 PLUGIN_VERSION 同步
    var pluginEnabledRef = { current: false };

    function readDraftAsBase64(file) {
      return new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onerror = function () { resolve(null); };
        reader.onload = function () {
          var result = typeof reader.result === "string" ? reader.result : "";
          var comma = result.indexOf(",");
          resolve(comma < 0 ? null : result.slice(comma + 1));
        };
        reader.readAsDataURL(file);
      });
    }

    /** 浏览器/主模型可直接识别的安全图片格式。 */
    function isWebSafeImageFile(file) {
      var t = file && file.type;
      return typeof t === "string" && /^(image\/png|image\/jpeg|image\/webp|image\/gif)$/i.test(t);
    }

    /** 把浏览器可渲染的非 web-safe 图（如 SVG）光栅化为 PNG 文件（失败返回 null）。 */
    function rasterizeFileToPng(file) {
      return new Promise(function (resolve) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          try {
            var canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            canvas.getContext("2d").drawImage(img, 0, 0);
            canvas.toBlob(function (blob) {
              if (blob) resolve(new File([blob], "iv-rasterized.png", { type: "image/png" }));
              else resolve(null);
            }, "image/png");
          } catch (err) {
            resolve(null);
          }
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      });
    }

    /** 上传 base64 图片到 DSH 附件存储，成功返回整段 markdown 引用 `![图片](/api/dsh-image-vision/raw/…)`（否则 null）。 */
    function uploadDraftImage(base64, mediaType) {
      return fetch(UPLOAD_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: base64, mediaType: mediaType || "image/png" }),
      }).then(function (resp) { return resp.json().catch(function () { return null; }); })
        .then(function (json) {
          if (!json || json.ok !== true || typeof json.markdown !== "string" || json.markdown === "") return null;
          return json.markdown;
        });
    }

    /** 读取插件配置总开关（供 hook 实时判断；与 ImagePickButton 内 reloadEnabled 同源）。 */
    function refreshPluginEnabled() {
      return fetch("/api/dsh-image-vision/config")
        .then(function (r) { return r.json(); })
        .then(function (json) {
          pluginEnabledRef.current = !!(json && json.config && json.config.enabled === true);
        })
        .catch(function () { pluginEnabledRef.current = false; });
    }

    /** 当前默认模型是否真有识图能力（host 侧与 image_vision 同一判断）。 */
    function currentModelCanSee() {
      return fetch("/api/dsh-image-vision/current-model-vision")
        .then(function (r) { return r.json(); })
        .then(function (json) { return !!(json && json.vision === true); })
        .catch(function () { return false; });
    }

    /**
     * 包装 conversation.sendSession：带图 + 总开关开启 + 当前模型不识图 → 改写为草稿引用后
     * 纯文本发送（成功即释放 DSH 草稿）。其余情况（无图 / 插件关闭 / 模型可识图 / 上传失败）
     * 全部原样放行。幂等：SEND_HOOK_MARKER 防重复包装。
     */
    function installSendHook(conversation, isEnabled) {
      var face = conversation;
      if (face === null || typeof face !== "object") return;
      if (typeof face.sendSession !== "function") return;
      if (typeof face.draftImages !== "function" || typeof face.releaseDraftImage !== "function") return;
      if (face[SEND_HOOK_MARKER] === true) return;
      var original = face.sendSession;
      face.sendSession = async function (session, text, imageIds, mode) {
        if (typeof isEnabled === "function" && !isEnabled()) return original.call(face, session, text, imageIds, mode);
        if (!Array.isArray(imageIds) || imageIds.length === 0) return original.call(face, session, text, imageIds, mode);
        // 当前模型真能识图：放行原生 image block 链路（视觉模型直接看图，无需改写）。
        var vision = false;
        try { vision = await currentModelCanSee(); } catch { vision = false; }
        if (vision) {
          // 主模型本身能看图：原生 image block 直接给主模型。按发送文本中的预设关键词自动拼进对应提示词；
          // 消息未激活任何预设时用通用模式（general）。不走慢速的 image_vision 工具链路。
          var presetName = detectVisionPreset(text);
          var presetInfo = null;
          try {
            var presetResp = await fetch("/api/dsh-image-vision/preset?name=" + encodeURIComponent(presetName));
            var presetJson = await presetResp.json();
            if (presetJson && typeof presetJson.prompt === "string") presetInfo = presetJson;
          } catch { /* 获取预设失败则原样发送 */ }
          var enriched = text;
          if (presetInfo && typeof presetInfo.prompt === "string" && presetInfo.prompt !== "") {
            var trimmed = String(text ?? "").trim();
            enriched = trimmed === "" ? presetInfo.prompt : trimmed + "\n\n" + presetInfo.prompt;
          }
          return original.call(face, session, enriched, imageIds, mode);
        }
        var attachments = face.draftImages(imageIds);
        if (!Array.isArray(attachments) || attachments.length !== imageIds.length) return original.call(face, session, text, imageIds, mode);
        var refs = [];
        for (var i = 0; i < attachments.length; i++) {
          var file = attachments[i] && attachments[i].file;
          if (!file) break;
          var base64 = await readDraftAsBase64(file);
          if (base64 === null) break;
          var ref = await uploadDraftImage(base64, file.type);
          if (ref === null) break;
          refs.push(ref); // 已是完整 markdown 引用 ![图片](/api/dsh-image-vision/raw/…)
        }
        if (refs.length !== attachments.length) return original.call(face, session, text, imageIds, mode);
        var parts = [String(text ?? "").trim()];
        for (var k = 0; k < refs.length; k++) if (refs[k] !== "") parts.push(refs[k]);
        var fullText = parts.filter(function (p) { return p !== ""; }).join("\n");
        var result = await session.prompt([{ type: "text", text: fullText }], mode);
        if (!result || !result.ok) {
          var code = result && result.error ? (result.error.code ?? result.error.message) : "unknown";
          throw new Error("image-vision 发送失败: " + (code ?? "unknown"));
        }
        for (var j = 0; j < imageIds.length; j++) face.releaseDraftImage(imageIds[j]);
        // 必须返回与原 sendSession 相同的 { kind: "success" }；否则发送层
        // settleSubmit / commitSend 拿到 undefined 会解析失败，无法清空输入框草稿。
        return { kind: "success" };
      };
      face[SEND_HOOK_MARKER] = true;
    }

    // ===== 样式：复用 DSH「设置-模型」页面的 CSS module，另加少量自定义类 =====
    var CSS_TEXT = ".zGbnIq_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.zGbnIq_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}.zGbnIq_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}.zGbnIq_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}.zGbnIq_savedNotice{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}.zGbnIq_rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}.zGbnIq_rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}.zGbnIq_rowHead{align-items:center;gap:10px;display:flex}.zGbnIq_rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}.zGbnIq_rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.zGbnIq_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}.zGbnIq_credentialDot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}.zGbnIq_credentialDotConfigured{background:var(--dsw-alias-state-success-primary)}.zGbnIq_credentialDotMissing{background:var(--dsw-alias-state-error-primary)}.zGbnIq_rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}.zGbnIq_primaryButton,.zGbnIq_secondaryButton,.zGbnIq_addButton{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.zGbnIq_primaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.zGbnIq_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.zGbnIq_secondaryButton,.zGbnIq_addButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}.zGbnIq_secondaryButton:hover:not(:disabled),.zGbnIq_addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.zGbnIq_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.zGbnIq_dangerButton{box-sizing:border-box;height:36px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:18px;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.zGbnIq_dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.zGbnIq_rowActions .zGbnIq_secondaryButton,.zGbnIq_rowActions .zGbnIq_dangerButton{border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px}.zGbnIq_primaryButton:disabled,.zGbnIq_secondaryButton:disabled,.zGbnIq_dangerButton:disabled,.zGbnIq_addButton:disabled,.zGbnIq_linkButton:disabled,.zGbnIq_addModelButton:disabled{opacity:.4;cursor:default}.zGbnIq_primaryButton:focus-visible,.zGbnIq_secondaryButton:focus-visible,.zGbnIq_dangerButton:focus-visible,.zGbnIq_addButton:focus-visible,.zGbnIq_linkButton:focus-visible,.zGbnIq_addModelButton:focus-visible,.zGbnIq_iconButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.zGbnIq_editor{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}.zGbnIq_editorHeader{align-items:baseline;gap:8px;display:flex}.zGbnIq_editorTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}.zGbnIq_editorRoute{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.zGbnIq_field{flex-direction:column;gap:6px;display:flex}.zGbnIq_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}.zGbnIq_linkButton{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:14px;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.zGbnIq_linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.zGbnIq_editorActions{justify-content:flex-end;gap:8px;display:flex}.zGbnIq_addBlock{flex-direction:column;gap:12px;display:flex}.zGbnIq_addActions{flex-wrap:wrap;gap:10px;display:flex}.zGbnIq_addButton{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;flex:1 1 0;gap:6px;min-width:180px;height:44px}.zGbnIq_addCard,.zGbnIq_setupCard{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;list-style:none;display:flex}.zGbnIq_addCard .zGbnIq_editor,.zGbnIq_setupCard .zGbnIq_editor{background:0 0;padding:0}.zGbnIq_modelCatalog{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:12px;display:flex}.zGbnIq_modelCatalogHeading{flex-direction:column;gap:2px;display:flex}.zGbnIq_modelCatalogTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}.zGbnIq_modelCatalogMeta,.zGbnIq_modelEmpty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.zGbnIq_modelList{flex-direction:column;gap:8px;display:flex}.zGbnIq_modelListHead{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.zGbnIq_modelEntry{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px}.zGbnIq_modelRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;align-items:center;gap:6px;display:grid}.zGbnIq_iconButton{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;display:inline-flex}.zGbnIq_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.zGbnIq_iconButton:disabled{cursor:default;opacity:.4}.zGbnIq_iconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}.zGbnIq_modelEmpty{border:1px dashed var(--dsw-alias-border-l3);text-align:center;border-radius:8px;padding:12px}.zGbnIq_addModelButton{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:14px;align-self:flex-start;align-items:center;gap:4px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}.zGbnIq_addModelButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.zGbnIq_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}select.zGbnIq_input{cursor:pointer;max-width:240px}.zGbnIq_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}.zGbnIq_input::placeholder{color:var(--dsw-alias-label-dimmed)}.zGbnIq_input:disabled{opacity:.6;cursor:default}.zGbnIq_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}.zGbnIq_hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.iv_activeCard{border-color:var(--dsw-alias-brand-primary)}.iv_dotIdle{background:var(--dsw-alias-border-l3)}.iv_metaText{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.iv_modelRow{grid-template-columns:minmax(0,1fr) auto auto auto auto auto;align-items:center;gap:6px;display:grid}.iv_modelRow .iv_candidateId{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.iv_visionYes{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.iv_visionNo{color:var(--dsw-alias-label-tertiary)}.iv_activeModel{background:var(--dsw-alias-interactive-bg-hover)}.iv_currentBar{align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:12px;padding:10px 14px;font-size:14px;line-height:22px;display:flex}.iv_currentBar strong{font-weight:500}.iv_currentEmpty{color:var(--dsw-alias-label-tertiary)}.iv_inlineRow{align-items:center;gap:8px;display:flex}.iv_candidateList{flex-direction:column;gap:2px;max-height:260px;margin:4px 0 0;padding:0;list-style:none;display:flex;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.iv_candidateLabel{cursor:pointer;align-items:center;gap:8px;padding:6px 8px;display:flex;width:100%;box-sizing:border-box}.iv_candidateLabel .iv_candidateId{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.iv_candidateLabel .zGbnIq_rowTag{margin-left:auto}.iv_candidateLabel:hover{background:var(--dsw-alias-interactive-bg-hover)}.iv_candidateId{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;flex:auto;font-size:13px}.iv_manualRow{align-items:center;gap:8px;display:flex;margin-top:8px}.iv_manualRow .zGbnIq_input{flex:1}.iv_addPanel{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:10px;display:flex}.iv_balanceChip{box-sizing:border-box;height:26px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border-radius:13px;align-items:center;padding:0 10px;font-size:12px;line-height:24px;display:inline-flex;flex:none}.iv_balanceChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.iv_balanceChip:disabled{opacity:.6;cursor:default}.iv_balanceOk{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}";
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
      inputTag.textContent = INPUT_CSS_TEXT + ".zGbnIq_input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}.zGbnIq_sortSelect{max-width:150px;flex:none;height:32px;font-size:13px;padding:0 8px}.zGbnIq_searchInput{max-width:200px;flex:1 1 120px;min-width:120px;height:32px;font-size:13px}";
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
    /** 发送文本中的预设关键词 → 预设名（无匹配则用通用模式）。 */
    var VISION_PRESET_KEYWORDS = [
      { name: "histopathology", re: /病理|病理学|病理切片|切片|h&e|免疫组化|ihc|组织病理|histopath/i },
      { name: "cell_biology", re: /细胞|流式|facs|western|wb|blot|免疫荧光|荧光|电镜|显微镜|条带|共定位|microscop/i },
      { name: "anatomy", re: /\bct\b|mri|核磁|超声|x线|x-ray|放射|影像|解剖|平片|造影|anatomy|radiology/i },
      { name: "clinical", re: /临床|内镜|胃镜|肠镜|支气管镜|膀胱镜|眼底|裂隙灯|皮肤镜|手术视野|鉴别诊断|clinical|endoscopy|dermoscopy/i },
      { name: "composite_figure", re: /组合图|组合大图|整体布局|多子图|multi-panel|composite/i },
      { name: "scientific_figure", re: /柱状图|折线图|散点图|箱线图|小提琴图|热图|统计图|图表|坐标轴|直方图|显著性|p值|plot|graph|figure/i },
    ];
    function detectVisionPreset(text) {
      var t = String(text ?? "");
      for (var vi = 0; vi < VISION_PRESET_KEYWORDS.length; vi++) {
        if (VISION_PRESET_KEYWORDS[vi].re.test(t)) return VISION_PRESET_KEYWORDS[vi].name;
      }
      return "general";
    }
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
      var existingBaseUrls = props.existingBaseUrls ?? [];
      var _n = useState(initial ? (initial.name ?? "") : "");
      var name = _n[0]; var setName = _n[1];
      var _b = useState(initial ? (initial.apiBaseUrl ?? "") : "");
      var baseUrl = _b[0]; var setBaseUrl = _b[1];
      // apiKey 不回显（GET 已脱敏为占位）：输入框初始为空；留空保存 = 保留原 Key。
      var _k = useState("");
      var apiKey = _k[0]; var setApiKey = _k[1];
      var hasExistingKey = !!(initial && initial.apiKey && initial.apiKey !== "");
      var _m = useState(initial ? (initial.models ?? []) : []);
      var models = _m[0]; var setModels = _m[1];
      var _d = useState(null);
      var discovered = _d[0]; var setDiscovered = _d[1];
      var _ds = useState("live");
      var discoveredSource = _ds[0]; var setDiscoveredSource = _ds[1];
      var _dw = useState("");
      var discoveredWarning = _dw[0]; var setDiscoveredWarning = _dw[1];
      var _dr = useState("");
      var discoveredReason = _dr[0]; var setDiscoveredReason = _dr[1];
      var _sch = useState("");
      var search = _sch[0]; var setSearch = _sch[1];
      // 人工纠错：模型 id → 是否视觉（覆盖后端 guessVision 判定）
      var _vo = useState({});
      var visionOverrides = _vo[0]; var setVisionOverrides = _vo[1];
      // 候选列表排序：名称（主）、视觉（次），各 none/asc/desc
      var _ns = useState("none");
      var nameSort = _ns[0]; var setNameSort = _ns[1];
      var _vs = useState("none");
      var visionSort = _vs[0]; var setVisionSort = _vs[1];
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

      // 模型是否视觉：人工纠错覆盖表优先，否则用后端 guessVision 判定（dm.vision）
      var effectiveVision = function (dm) {
        var k = String(dm.id);
        return Object.prototype.hasOwnProperty.call(visionOverrides, k)
          ? visionOverrides[k]
          : (dm.vision !== false);
      };

      // 切换某模型的人工视觉判定
      var toggleOverride = function (id) {
        setVisionOverrides(function (prev) {
          var next = Object.assign({}, prev);
          var base = next[id] ?? (discovered != null && discovered.find(function (m) { return m.id === id; }) || { vision: false }).vision;
          next[id] = !base;
          return next;
        });
      };

      // 已获取候选模型：排序（名称为主、视觉为次）+ 按搜索词（不区分大小写）过滤
      var _q = search.trim().toLowerCase();
      var sortedDiscovered = discovered == null
        ? null
        : discovered.slice().sort(function (a, b) {
            // 主排序：按名称
            if (nameSort !== "none") {
              var cmp = a.id.localeCompare(b.id);
              if (cmp !== 0) return nameSort === "asc" ? cmp : -cmp;
            }
            // 次排序：按是否视觉（asc=视觉优先 true 在前，desc=非视觉优先 false 在前）
            if (visionSort !== "none") {
              var diff = Number(effectiveVision(b)) - Number(effectiveVision(a));
              var sign = visionSort === "asc" ? 1 : -1;
              if (diff !== 0) return diff * sign;
            }
            return 0;
          }).filter(function (m) { return _q === "" || m.id.toLowerCase().indexOf(_q) !== -1; });

      var discover = async function () {
        setDiscovering(true);
        setError("");
        setDiscoveredWarning("");
        try {
          var resp = await fetch("/api/dsh-image-vision/models", {
            method: "POST",
            headers: { "content-type": "application/json" },
            // 本地为空但已存 key 时传脱敏占位符，让后端走「按 baseUrl 回查真实 Key」分支
            // （fallbackApiKey 对 "" / "********" / cred: / env: 都会回查并解析引用）。
            body: JSON.stringify({ baseUrl: baseUrl, apiKey: apiKey.trim() !== "" ? apiKey : (hasExistingKey ? "********" : "") }),
          });
          var data = await resp.json();
          if (!resp.ok) throw new Error(data.error ?? ("HTTP " + resp.status));
          setDiscovered(data.models ?? []);
          setDiscoveredSource(data.source === "preset" ? "preset" : "live");
          setDiscoveredWarning(data.warning ?? "");
          setDiscoveredReason(data.source === "preset" ? (data.reason ?? "unknown") : "");
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

      var canSave = name.trim() !== "" && baseUrl.trim() !== "" && (apiKey.trim() !== "" || hasExistingKey) && models.length > 0;

      var save = async function () {
        if (!canSave) return;
        setBusy(true);
        setError("");
        try {
          // 留空 = 不修改：回传原值（host 遇到脱敏占位会保留真实 Key）
          var submitKey = apiKey.trim() !== "" ? apiKey.trim() : (initial ? (initial.apiKey ?? "") : "");
          await props.onSave({ name: name.trim(), apiBaseUrl: baseUrl.trim(), apiKey: submitKey, models: models });
        } catch (e) {
          setError("保存失败: " + String(e?.message ?? e));
          setBusy(false);
        }
      };

      // 候选模型列表（勾选添加；非识图模型禁用并提示；可人工纠错；按搜索词不区分大小写过滤）
      var candidateNodes = [];
      if (sortedDiscovered !== null) {
        for (var i = 0; i < sortedDiscovered.length; i++) {
          (function (dm) {
            var isVision = effectiveVision(dm);
            var checked = hasModel(dm.id);
            candidateNodes.push(createElement("li", { className: "zGbnIq_candidate", key: dm.id },
              createElement("label", { className: "iv_candidateLabel", style: isVision ? null : { opacity: 0.55 } },
                createElement("input", {
                  type: "checkbox",
                  checked: checked,
                  disabled: !isVision,
                  title: isVision ? "" : "该模型不具有视觉能力，不可选择（可点纠错按钮切换）",
                  onChange: function () { toggleModel(dm); },
                }),
                createElement("span", { className: "iv_candidateId" }, dm.id),
                createElement("button", {
                  type: "button",
                  className: "zGbnIq_iconButton",
                  title: "纠错：切换视觉/非视觉判定",
                  onClick: function () { toggleOverride(dm.id); },
                }, "⇄"),
                createElement("span", { className: "zGbnIq_rowTag " + (isVision ? "iv_visionYes" : "iv_visionNo") },
                  isVision ? "视觉" : "非视觉")
              )
            ));
          })(sortedDiscovered[i]);
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

      // 厂商模板下拉选项（已存在的供应商预设禁用并标注「已添加」）
      var existingSet = {};
      for (var e = 0; e < existingBaseUrls.length; e++) {
        existingSet[String(existingBaseUrls[e] ?? "").replace(/\/+$/, "").toLowerCase()] = true;
      }
      var presetOptions = [
        createElement("option", { key: "__custom", value: "" }, "自定义（手动填写端点）"),
      ];
      for (var x = 0; x < PROVIDER_PRESETS.length; x++) {
        var _purl = PROVIDER_PRESETS[x].apiBaseUrl.replace(/\/+$/, "").toLowerCase();
        var _pexists = Object.prototype.hasOwnProperty.call(existingSet, _purl);
        presetOptions.push(createElement("option", {
          key: PROVIDER_PRESETS[x].apiBaseUrl,
          value: PROVIDER_PRESETS[x].apiBaseUrl,
          disabled: _pexists,
        }, PROVIDER_PRESETS[x].name + "（" + PROVIDER_PRESETS[x].apiBaseUrl + "）" + (_pexists ? " · 已添加" : "")));
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
          createElement(TextInput, { value: apiKey, type: "password", placeholder: hasExistingKey ? "已配置-输入新值可替换" : "未配置", onChange: setApiKey })
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
              apiKey.trim() === ""
                ? (hasExistingKey ? "将使用已保存的密钥获取" : "未填 API Key，仅获取内置候选")
                : "非视觉模型不可勾选"),
            discovered !== null && discovered.length > 0
              ? createElement("select", {
                  className: "zGbnIq_input zGbnIq_sortSelect",
                  value: nameSort,
                  onChange: function (e) { setNameSort(e.target.value); },
                  title: "按模型名称排序",
                },
                createElement("option", { value: "none" }, "名称：不排序"),
                createElement("option", { value: "asc" }, "名称：升序 A→Z"),
                createElement("option", { value: "desc" }, "名称：降序 Z→A"))
              : null,
            discovered !== null && discovered.length > 0
              ? createElement("select", {
                  className: "zGbnIq_input zGbnIq_sortSelect",
                  value: visionSort,
                  onChange: function (e) { setVisionSort(e.target.value); },
                  title: "按是否视觉排序",
                },
                createElement("option", { value: "none" }, "视觉：不排序"),
                createElement("option", { value: "asc" }, "视觉：视觉优先"),
                createElement("option", { value: "desc" }, "视觉：非视觉优先"))
              : null,
            discovered !== null && discovered.length > 0
              ? createElement("input", {
                  className: "zGbnIq_input zGbnIq_searchInput",
                  type: "search",
                  value: search,
                  placeholder: "搜索模型（不区分大小写）",
                  onChange: function (e) { setSearch(e.target.value); },
                })
              : null
          ),
          discovered !== null && discovered.length > 0
            ? createElement("div", { className: "zGbnIq_addBlock" },
                discoveredSource === "preset"
                  ? createElement("p", { className: "zGbnIq_notice" },
                    "当前仅显示 " + discovered.length + " 个内置候选模型（" + (discoveredWarning || "未获取到实时列表") + "）。" +
                    (discoveredReason === "auth"
                      ? "填写有效的 API Key 后重新点击「获取模型列表」，可显示该厂商全部模型"
                      : "如需其他模型，可手动输入模型名称添加"))
                  : null,
                createElement("ul", { className: "iv_candidateList" }, candidateNodes),
                candidateNodes.length === 0
                  ? createElement("p", { className: "zGbnIq_modelEmpty" }, "无匹配的模型")
                  : null
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
      var _d = useState({ providers: [], active: "", enabled: false, allowAutoInstallPythonDeps: false });
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
      // ===== 在线更新相关状态 =====
      var _upd = useState(null);           // 更新检查结果（null=未检查；{currentVersion, latestVersion, updateAvailable, releaseUrl}）
      var update = _upd[0]; var setUpdate = _upd[1];
      var _upg = useState(false);          // 正在安装更新
      var updating = _upg[0]; var setUpdating = _upg[1];
      var _upmsg = useState(null);         // 更新操作提示（安装成功/失败）
      var updateMessage = _upmsg[0]; var setUpdateMessage = _upmsg[1];

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

      // 打开设置页即检查一次 GitHub Release 更新（可选功能，失败静默不打扰）。
      useEffect(function () {
        var disposed = false;
        fetch("/api/dsh-image-vision/update/check", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (json) {
            if (disposed || !json || !json.ok || !json.update) return;
            setUpdate(json.update);
          })
          .catch(function () { /* 更新发现是可选功能 */ });
        return function () { disposed = true; };
      }, []);

      // 一键安装最新 Release（与 image-create 同款：宿主校验版本后执行 dsh plugin add）。
      var applyUpdate = async function () {
        if (update === null || updating) return;
        setUpdating(true);
        setUpdateMessage(null);
        try {
          var resp = await fetch("/api/dsh-image-vision/update/apply", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: update.latestVersion }),
          });
          var json = await resp.json();
          if (!json.ok) throw new Error(json.message ?? ("HTTP " + resp.status));
          setUpdateMessage("已更新到 " + json.updatedVersion + "，请重启 DSH 生效");
        } catch (e) {
          setUpdateMessage("更新失败: " + String(e?.message ?? e));
        } finally {
          setUpdating(false);
        }
      };

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
            var _existUrls = shownProviders.filter(function (_, i) { return i !== idx; }).map(function (p) { return p.apiBaseUrl; });
            providerCards.push(createElement(ProviderEditor, {
              key: "edit-" + prov.id,
              id: "iv-editor-edit",
              initial: prov,
              existingBaseUrls: _existUrls,
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
        createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
          createElement("h2", { className: "zGbnIq_title" }, "视觉插件"),
          createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" } },
            createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontWeight: 400 } }, "v" + PLUGIN_VERSION),
            update !== null && update.updateAvailable
              ? createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-warn-label)" } }, "有新版本 v" + update.latestVersion)
              : null,
            update !== null && update.updateAvailable
              ? createElement("button", {
                  type: "button",
                  className: "zGbnIq_addButton",
                  disabled: updating,
                  onClick: applyUpdate,
                  style: { height: 26, padding: "0 10px", fontSize: 12 },
                }, updating ? "更新中…" : "更新")
              : null,
            update !== null && update.updateAvailable
              ? createElement("a", {
                  href: update.releaseUrl,
                  target: "_blank",
                  rel: "noreferrer",
                  style: { fontSize: 12, color: "var(--dsw-alias-link, var(--dsw-alias-primary))", textDecoration: "none" },
                }, "查看 Release")
              : null,
            updateMessage !== null ? createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)" } }, updateMessage) : null
          )
        ),
        createElement("p", { className: "zGbnIq_intro" },
          "自动判断当前模型是否识图：能看则直接分析，否则调用下方「使用中」的视觉模型识别（点「使用」切换）。\n" +
          "粘贴/拖拽/添加图片并发送后，模型自动调用 image_vision 系列工具识别。"),
        createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "10px 14px", margin: "0 0 4px" } },
          createElement("div", { style: { minWidth: 0 } },
            createElement("div", { style: { fontSize: 14, fontWeight: 500 } }, "启用视觉插件"),
            createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
              "关闭后插件完全退出：不允许粘贴/拖拽/添加图片、不执行图片识别、不显示视觉模型选择器")
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
        // 遇到模型无法直接读取的格式（AI/EPS 矢量图）需用 Python 转换时的依赖安装授权。
        createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "10px 14px", margin: "0 0 4px" } },
          createElement("div", { style: { minWidth: 0 } },
            createElement("div", { style: { fontSize: 14, fontWeight: 500 } }, "允许自动安装 Python 依赖"),
            createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 } },
              "遇到 AI/EPS/PS格式等模型不能接受的图片格式时，自动安装缺失的python依赖（PyMuPDF / Ghostscript）。勾选即表示同意；未勾选时请将要识别的上述图片导出为 PNG/JPEG")
          ),
          createElement("button", {
            type: "button",
            role: "switch",
            "aria-checked": data.allowAutoInstallPythonDeps === true,
            title: data.allowAutoInstallPythonDeps === true ? "点击关闭" : "点击开启",
            style: {
              width: 44, height: 24, borderRadius: 12, flex: "none", cursor: "pointer",
              border: "none", position: "relative",
              background: data.allowAutoInstallPythonDeps === true ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-border-l3)",
              transition: "background .15s",
            },
            onClick: function () {
              saveConfig(Object.assign({}, data, { allowAutoInstallPythonDeps: data.allowAutoInstallPythonDeps !== true }));
            },
          },
            createElement("span", { style: {
              position: "absolute", top: 2, left: data.allowAutoInstallPythonDeps === true ? 22 : 2, width: 20, height: 20,
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
                existingBaseUrls: shownProviders.map(function (p) { return p.apiBaseUrl; }),
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
     * - 已配置：以原生粘贴事件交给 DSH 草稿（输入框缩略图预览）；发送时由发送层 hook
     *   把图片改写为附件存储引用交给文本模型，模型再调用 image_vision 识别。
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

      /** 三路统一入口：检查配置 → 未配置提示；已配置 → 预处理（非 web-safe 转 PNG）→ 原生粘贴。 */
      var maybeAddImages = async function (images) {
        if (images.length === 0) return;
        try {
          var ready = await ensureVisionReady();
          if (!ready) {
            toastSeq.current += 1;
            setError("请使用视觉模型或在插件中添加视觉模型");
            return;
          }
          // 预先处理：把主模型不能直接读的格式（如 SVG 矢量图）光栅化为 PNG，再进草稿；
          // 转换失败则用原文件（交由后续明确的格式错误提示）。
          var normalized = [];
          for (var pi = 0; pi < images.length; pi++) {
            var f = images[pi];
            if (f && !isWebSafeImageFile(f)) {
              var png = await rasterizeFileToPng(f);
              normalized.push(png ?? f);
            } else {
              normalized.push(f);
            }
          }
          var ta = findTextarea();
          if (ta === null) throw new Error("未找到输入框");
          // 防重入：合成的 paste 事件会再次经过 document 捕获阶段，
          // 标记 injecting 让 intercept 放行，确保 DSH 原生处理器能收到。
          injecting.current = true;
          try {
            pasteNative(normalized, ta);
          } finally {
            injecting.current = false;
          }
        } catch (err) {
          toastSeq.current += 1;
          setError(String(err && err.message ? err.message : err));
        }
      };

      // 拦截全局粘贴图片（paste）；拖拽（drop）放行给 DSH 原生流程——
      // 原生 drop 负责加入草稿并关闭"图片拖动到此处即可添加"浮层；我们若 preventDefault 掉
      // drop，浮层永远收不到关闭信号会卡在最外层，图片却已进草稿、无法操作对话框。
      useEffect(function () {
        var intercept = function (e) {
          // 总开关关闭：插件完全透明，不再监听/拦截图片，全部交给 DSH 原生处理。
          if (!enabledRef.current) return;
          // 拖拽：一律放行 DSH 原生处理（加草稿 + 关浮层），插件不拦截
          if (e.type === "drop") return;
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


    // ===== 会话内图片渲染：把消息里的 ![图片](i/iv-xxx.jpg) 引用升格为缩略图 =====
    // 发送 hook 把图片改写为文本引用后，Web shell 以纯文本渲染用户消息；此增强监听
    // 会话消息容器（官方 slot [data-slot=conversation.session]），把引用替换为 <img>
    // 缩略图（点击全屏查看大图），图片字节仍由插件 /i/<name> 草稿路由提供；引用过期
    // （草稿 20 分钟清理）加载失败时自动恢复为原始文本标记。
    var PREVIEW_CSS_TEXT = ".iv_preview{display:inline-block;vertical-align:middle;margin:2px 4px}.iv_previewBtn{background:none;border:0;padding:0;cursor:pointer;border-radius:6px;overflow:hidden;display:inline-flex}.iv_previewImg{display:block;max-width:180px;max-height:180px;border-radius:6px;object-fit:contain}.iv_lightbox{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;cursor:zoom-out}.iv_lightbox img{max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5)}";
    var PREVIEW_CSS_TAG = "dsh-image-vision/preview.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + PREVIEW_CSS_TAG + "\"]") === null) {
      var previewTag = document.createElement("style");
      previewTag.dataset.plugin = "dsh-image-vision";
      previewTag.dataset.pluginCss = PREVIEW_CSS_TAG;
      previewTag.textContent = PREVIEW_CSS_TEXT;
      document.head.appendChild(previewTag);
    }

    var PREVIEW_ATTR = "data-dsh-iv-preview";
    var CONVERSATION_ROOT_SELECTOR = "[data-slot=\"conversation.session\"]";
    var MAX_FAILED_PATHS = 200;

    /** 在文本中定位插件图片引用：草稿短名（i/iv-xxx.ext）或附件存储引用（/api/dsh-image-vision/raw/…）。 */
    function findIvReferences(text) {
      var re = /!\[([^\]]*)]\(([^)\s]+)\)/g;
      var out = [];
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text)) !== null) {
        var path = m[2];
        var name = path;
        // 附件存储引用（含元数据 query）：整段作为渲染路径
        if (/\/api\/dsh-image-vision\/raw\//.test(path)) {
          out.push({ alt: m[1] || "", path: path, start: m.index, end: m.index + m[0].length });
          continue;
        }
        if (/^https?:\/\//i.test(path)) {
          try {
            var u = new URL(path);
            if (u.pathname.indexOf("/i/iv-") === 0) name = u.pathname.slice(3);
            else continue;
          } catch { continue; }
        }
        if (!/^i\/iv-[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
        out.push({ alt: m[1] || "", path: "/" + name, start: m.index, end: m.index + m[0].length });
      }
      return out;
    }

    /**
     * 安装会话图片渲染增强。幂等：已处理的引用变成元素而非文本，重扫无新命中；
     * dispose 时把所有预览恢复为原始文本标记。
     */
    function installConversationImagePreview() {
      var failedPaths = new Set();
      var lightboxCleanup = null;
      var contentObserver = null;
      var mountObserver = null;
      var observedRoot = null;
      var disposed = false;

      var isExcluded = function (node) {
        var parent = node.parentElement;
        if (parent === null) return true;
        return parent.closest("input, textarea, script, style, [contenteditable], [" + PREVIEW_ATTR + "]") !== null;
      };

      var closeLightbox = function () {
        if (lightboxCleanup !== null) { lightboxCleanup(); lightboxCleanup = null; }
      };

      var openLightbox = function (src, alt, trigger) {
        closeLightbox();
        var overlay = document.createElement("div");
        overlay.className = "iv_lightbox";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "查看大图");
        overlay.tabIndex = -1;
        var image = document.createElement("img");
        image.src = src;
        image.alt = alt;
        overlay.appendChild(image);
        overlay.addEventListener("click", closeLightbox);
        var onKeydown = function (event) { if (event.key === "Escape") closeLightbox(); };
        overlay.addEventListener("keydown", onKeydown);
        lightboxCleanup = function () {
          overlay.remove();
          if (trigger.isConnected) trigger.focus({ preventScroll: true });
        };
        document.body.appendChild(overlay);
        overlay.focus();
      };

      var restorePreview = function (preview) {
        var source = preview.getAttribute(PREVIEW_ATTR);
        if (source === null) return;
        preview.replaceWith(document.createTextNode(source));
      };

      var restoreAll = function () {
        if (observedRoot === null) return;
        var list = observedRoot.querySelectorAll("[" + PREVIEW_ATTR + "]");
        for (var i = 0; i < list.length; i++) restorePreview(list[i]);
      };

      var buildPreview = function (match, source) {
        var preview = document.createElement("span");
        preview.className = "iv_preview";
        preview.setAttribute(PREVIEW_ATTR, source);
        var button = document.createElement("button");
        button.type = "button";
        button.className = "iv_previewBtn";
        button.title = "查看大图";
        button.setAttribute("aria-label", "查看大图");
        var image = document.createElement("img");
        image.className = "iv_previewImg";
        image.src = /^https?:\/\//i.test(match.path) ? match.path : window.location.origin + match.path;
        image.alt = match.alt;
        image.addEventListener("error", function () {
          failedPaths.add(match.path);
          if (failedPaths.size > MAX_FAILED_PATHS) failedPaths.delete(failedPaths.values().next().value);
          restorePreview(preview);
        }, { once: true });
        button.addEventListener("click", function () { openLightbox(image.src, match.alt, button); });
        button.appendChild(image);
        preview.appendChild(button);
        return preview;
      };

      var enhanceNode = function (node) {
        var matches = [];
        var found = findIvReferences(node.data);
        for (var i = 0; i < found.length; i++) if (!failedPaths.has(found[i].path)) matches.push(found[i]);
        if (matches.length === 0) return;
        var text = node.data;
        var fragment = document.createDocumentFragment();
        var cursor = 0;
        for (var k = 0; k < matches.length; k++) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, matches[k].start)));
          fragment.appendChild(buildPreview(matches[k], text.slice(matches[k].start, matches[k].end)));
          cursor = matches[k].end;
        }
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
        node.replaceWith(fragment);
      };

      // 快速过滤：旧草稿短名（iv-…）或附件存储引用（/api/dsh-image-vision/raw/…）
      var hasImageHint = function (text) {
        return text.indexOf("iv-") >= 0 || text.indexOf("/api/dsh-image-vision/raw/") >= 0;
      };

      var scanNode = function (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (hasImageHint(node.data) && !isExcluded(node)) enhanceNode(node);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
        var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode: function (candidate) {
            if (!hasImageHint(candidate.data)) return NodeFilter.FILTER_REJECT;
            return isExcluded(candidate) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
          },
        });
        var targets = [];
        while (walker.nextNode()) targets.push(walker.currentNode);
        for (var i = 0; i < targets.length; i++) enhanceNode(targets[i]);
      };

      var enhanceAll = function () { if (observedRoot !== null) scanNode(observedRoot); };

      var onContentRecords = function (records) {
        if (disposed) return;
        for (var i = 0; i < records.length; i++) {
          var record = records[i];
          if (record.type === "characterData") scanNode(record.target);
          else {
            var added = record.addedNodes;
            for (var j = 0; j < added.length; j++) scanNode(added[j]);
          }
        }
      };

      var attach = function () {
        var next = document.querySelector(CONVERSATION_ROOT_SELECTOR) || null;
        if (next === observedRoot) return;
        if (contentObserver !== null) contentObserver.disconnect();
        observedRoot = next;
        if (observedRoot !== null) {
          contentObserver = new MutationObserver(onContentRecords);
          contentObserver.observe(observedRoot, { childList: true, subtree: true, characterData: true });
          enhanceAll();
        }
      };

      mountObserver = new MutationObserver(function () { attach(); });
      mountObserver.observe(document.body, { childList: true, subtree: true });
      attach();

      return {
        dispose: function () {
          if (disposed) return;
          disposed = true;
          closeLightbox();
          if (contentObserver !== null) contentObserver.disconnect();
          if (mountObserver !== null) mountObserver.disconnect();
          restoreAll();
        },
      };
    }

    function apply(ctx) {

      // 会话内图片渲染：发送 hook 改写后的 ![图片](i/iv-xxx.jpg) 在消息中升格为缩略图。
      ctx.effect(function () {
        var handle = installConversationImagePreview();
        return function () { handle.dispose(); };
      }, "dsh-image-vision: conversation image preview");

      // 发送层 hook：需要 conversation 服务；总开关状态实时维护（配置变更即时生效）。
      ctx.inject(["conversation"], function (scope) {
        var conversation = scope.conversation;
        installSendHook(conversation, function () { return pluginEnabledRef.current === true; });
        ctx.effect(function () {
          refreshPluginEnabled();
          window.addEventListener("iv-config-changed", refreshPluginEnabled);
          return function () { window.removeEventListener("iv-config-changed", refreshPluginEnabled); };
        }, "dsh-image-vision: send hook enabled");
      });

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
