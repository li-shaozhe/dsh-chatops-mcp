/**
 * dsh-chatops-mcp — 浏览器半侧：钉钉 / 飞书 / 飞书项目 连接器面板。
 *
 * 左侧栏一个图标（sidebar.panellist）+ 主区域一个页面（main），两者 id/key 都是
 * `chatops-mcp`。数据全部走宿主 HTTP 接口 /chatops-mcp/*，本文件不直接碰 CLI。
 *
 * 面板只读：不会发出任何钉钉/飞书/飞书项目的写操作，唯一的副作用是刷新
 * CLI 自描述目录缓存（MCP 子进程本来也会写同一份缓存）。
 *
 * 视觉对齐宿主其他面板（参考 @xhzl/dsh-memory-panel）：hero 头 + 分段页签 +
 * 双栏卡片。静态样式走 ctx.effect 注入一张 <style>（hover / transition /
 * 焦点这些内联写不出来），动态值仍用内联。主题 token 全部取自
 * @deepseek-ai/dsh-client-ui-theme 实际定义的那套，不自己造色值。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chatops-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const BASE = '/chatops-mcp'

    /* ── 静态样式（注入一次） ─────────────────────────────────────────── */

    const PANEL_CSS = [
      /* 间距与层级令牌：本面板局部作用域，不污染宿主。4px 网格 + 1.25 字阶。 */
      '.co-root{--co-gap-1:4px;--co-gap-2:8px;--co-gap-3:12px;--co-gap-4:16px;--co-gap-5:20px;--co-gap-6:24px;'
        + '--co-r-sm:6px;--co-r-md:8px;--co-r-lg:12px;--co-r-xl:16px;'
        + '--co-ease:cubic-bezier(0,0,.2,1);'
        + 'display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);'
        + 'font-family:var(--dsh-font-family-text,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);-webkit-font-smoothing:antialiased;}',
      /* Hero：标题区与内容区之间用一条渐隐分隔线建立层级，而不是靠加粗大字。 */
      '.co-hero{display:flex;align-items:flex-start;gap:12px;padding:20px 24px 16px;flex-shrink:0;position:relative;}',
      '.co-hero::after{content:"";position:absolute;left:24px;right:24px;bottom:0;height:1px;background:linear-gradient(90deg,var(--dsw-alias-border-l1),transparent);}',
      '.co-logo{width:34px;height:34px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#6b8cff,#3f5efb);box-shadow:0 2px 8px rgba(63,94,251,.28),inset 0 1px 0 rgba(255,255,255,.24);}',
      '.co-hd{flex:1;min-width:0;}',
      '.co-title{font-size:19px;font-weight:650;letter-spacing:-.45px;line-height:1.25;}',
      '.co-sub{font-size:12px;color:var(--dsw-alias-label-caption);margin-top:3px;word-break:break-all;line-height:1.55;}',
      '.co-toolbar{display:flex;align-items:center;gap:8px;padding:12px 24px 12px;flex-shrink:0;}',
      '.co-seg{display:inline-flex;padding:3px;background:var(--dsw-alias-bg-layer-2);border-radius:10px;gap:2px;}',
      '.co-seg-btn{appearance:none;border:none;height:27px;padding:0 14px;font-size:12.5px;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;transition:background 160ms var(--co-ease),color 160ms var(--co-ease),box-shadow 160ms var(--co-ease);}',
      '.co-seg-btn:hover{color:var(--dsw-alias-label-secondary);}',
      '.co-seg-btn[data-on="1"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.08),0 2px 6px -2px rgba(16,24,40,.12);}',
      '.co-seg-btn:disabled{opacity:.4;cursor:default;}',
      '.co-seg-btn:disabled:hover{color:var(--dsw-alias-label-tertiary);}',
      '.co-body{flex:1;min-height:0;overflow:auto;padding:0 24px 24px;}',
      '.co-body-flat{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 24px 18px;}',
      '.co-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:12px;}',
      '.co-card{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px -12px rgba(16,24,40,.10);display:flex;flex-direction:column;min-height:0;}',
      '.co-card-hd{display:flex;align-items:center;gap:8px;padding:12px 14px 6px;}',
      '.co-card-bd{padding:0 14px 12px;}',
      '.co-card-ft{padding:0 14px 12px;display:flex;gap:6px;flex-wrap:wrap;}',
      '.co-dot{width:7px;height:7px;border-radius:999px;flex-shrink:0;}',
      '.co-row{display:flex;align-items:baseline;gap:8px;padding:3px 0;min-width:0;}',
      '.co-lb{font-size:11.5px;color:var(--dsw-alias-label-caption);min-width:58px;flex-shrink:0;}',
      '.co-val{font-size:12.5px;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);word-break:break-all;min-width:0;}',
      '.co-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-family:var(--dsh-font-family-code,ui-monospace,monospace);}',
      '.co-chip[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);}',
      '.co-chip[data-tone="bad"]{color:var(--dsw-alias-state-error-primary);}',
      '.co-chip[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
      '.co-chip[data-tone="brand"]{color:var(--dsw-alias-brand-primary);}',
      '.co-chip[data-solid="1"]{border-color:transparent;background:var(--dsw-alias-bg-layer-2);}',
      '.co-btn{appearance:none;height:28px;padding:0 12px;font-size:12.5px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;transition:background 120ms ease;white-space:nowrap;}',
      '.co-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.co-btn:disabled{opacity:.55;cursor:default;}',
      '.co-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.co-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
      '.co-btn[data-size="sm"]{height:24px;padding:0 9px;font-size:11.5px;border-radius:6px;}',
      '.co-input{height:30px;padding:0 9px;font-size:12.5px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid transparent;border-radius:8px;transition:background 120ms ease,border-color 120ms ease;}',
      '.co-input:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.co-input:focus{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l2);}',
      '.co-input::placeholder{color:var(--dsw-alias-label-caption);}',
      '.co-sel{appearance:none;padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary) 50%),linear-gradient(135deg,var(--dsw-alias-label-tertiary) 50%,transparent 50%);background-position:calc(100% - 13px) 13px,calc(100% - 9px) 13px;background-size:4px 4px,4px 4px;background-repeat:no-repeat;cursor:pointer;}',
      '.co-split{display:flex;gap:14px;flex:1;min-height:0;}',
      '.co-pane{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px -12px rgba(16,24,40,.10);display:flex;flex-direction:column;min-height:0;overflow:hidden;}',
      '.co-pane-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0;}',
      '.co-pane-bd{flex:1;min-height:0;overflow:auto;padding:6px;}',
      '.co-pane-bd-pad{flex:1;min-height:0;overflow:auto;padding:12px 14px;}',
      '.co-item{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;cursor:pointer;transition:background 120ms ease,box-shadow 120ms ease;min-width:0;}',
      '.co-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.co-item[data-on="1"]{background:var(--dsw-alias-interactive-bg-active);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);}',
      '.co-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:var(--dsw-focus-ring-width,2px) solid currentColor;outline-offset:-2px;}',
      '.co-split-left{flex:0 0 clamp(240px,32%,380px);min-width:0;}',
      '.co-item-cli{font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;max-width:62%;}',
      '.co-item-sum{font-size:11.5px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}',
      '.co-tbl-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);}',
      '.co-tbl{width:100%;border-collapse:collapse;font-size:12px;}',
      '.co-tbl th{text-align:left;font-size:10.5px;font-weight:700;color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.co-tbl td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;line-height:1.5;}',
      '.co-tbl tr:last-child td{border-bottom:none;}',
      '.co-mono{font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:11.5px;}',
      '.co-pre{margin:0;font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 11px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-word;}',
      '.co-empty{font-size:13px;color:var(--dsw-alias-label-caption);padding:28px 6px;text-align:center;}',
      '.co-err{font-size:12.5px;color:var(--dsw-alias-state-error-primary);padding:8px 0;}',
      '.co-sec{font-size:10.5px;font-weight:700;color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.7px;margin:14px 0 6px;}',
      '.co-sec:first-child{margin-top:0;}',
      '.co-p{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}',
      '.co-link{appearance:none;border:none;background:none;padding:0;font:inherit;color:var(--dsw-alias-brand-primary);cursor:pointer;}',
      '.co-link:hover{text-decoration:underline;}',
      '.co-scroll{overflow:auto;}',
      /* 连接器卡片墙 —— 对齐宿主「连接器」页的观感：正方 logo + 名称 + 摘要 + 右上角动作 */
      '.co-wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px;}',
      '.co-conn{position:relative;display:flex;gap:11px;padding:13px 14px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;cursor:pointer;transition:border-color 120ms ease,box-shadow 120ms ease,background 120ms ease;min-height:88px;}',
      '.co-conn:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 2px 6px rgba(16,24,40,.06),0 12px 28px -18px rgba(16,24,40,.28);}',
      '.co-conn[data-on="1"]{border-color:var(--dsw-alias-border-l2);}',
      '.co-conn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid currentColor;outline-offset:2px;}',
      '.co-conn-badge{width:38px;height:38px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:600;color:#fff;letter-spacing:-.5px;box-shadow:0 2px 6px rgba(16,24,40,.16);}',
      '.co-conn-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.co-conn-hd{display:flex;align-items:center;gap:6px;min-width:0;}',
      '.co-conn-name{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.co-conn-desc{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-caption);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.co-conn-ft{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:4px;flex-wrap:wrap;}',
      '.co-conn-act{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1;padding:0;transition:background 120ms ease,color 120ms ease;}',
      '.co-conn-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.co-conn-act[data-done="1"]{border-color:transparent;background:var(--dsw-alias-state-success-primary);color:#fff;}',
      '.co-live{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-success-primary);flex-shrink:0;box-shadow:0 0 0 2px var(--dsw-alias-bg-base);}',
      /* 弹层 */
      '.co-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(15,17,21,.42));display:flex;align-items:center;justify-content:center;padding:28px;z-index:60;}',
      '.co-modal{width:min(600px,100%);max-height:min(78vh,720px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;box-shadow:0 12px 40px -8px rgba(16,24,40,.32);overflow:hidden;}',
      '.co-modal-hd{display:flex;align-items:flex-start;gap:11px;padding:18px 20px 12px;flex-shrink:0;}',
      '.co-modal-bd{flex:1;min-height:0;overflow:auto;padding:0 20px 4px;}',
      '.co-modal-ft{display:flex;align-items:center;gap:8px;padding:12px 20px 16px;flex-shrink:0;border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}',
      '.co-close{appearance:none;border:none;background:none;color:var(--dsw-alias-label-caption);cursor:pointer;font-size:18px;line-height:1;padding:2px 4px;border-radius:6px;}',
      '.co-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.co-prompt{display:flex;align-items:flex-start;gap:8px;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.co-prompt + .co-prompt{margin-top:7px;}',
      '.co-field{display:flex;flex-direction:column;gap:5px;margin-bottom:11px;}',
      '.co-field-lb{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.co-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-caption);}',
      '.co-input-wide{width:100%;box-sizing:border-box;height:32px;}',
      '.co-textarea{width:100%;box-sizing:border-box;min-height:64px;padding:8px 9px;font-size:12px;font-family:var(--dsh-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid transparent;border-radius:8px;resize:vertical;line-height:1.5;}',
      '.co-textarea:focus{outline:none;background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l2);}',
      '.co-json{min-height:300px;tab-size:2;white-space:pre;overflow:auto;}',
      '.co-code{display:inline-block;font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:12px;padding:2px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);}',
      '.co-ok{font-size:12.5px;color:var(--dsw-alias-state-success-primary);}',
      '.co-warnbar{display:flex;align-items:center;gap:8px;padding:9px 11px;margin-bottom:12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;}',

      /* ── 统计条：把「已启用 / 注册工具 / MCP 行」做成一组带分隔的数字 ──
       * 之前是三个同权重的 chip，读起来没有主次。现在数字放大、标签缩小、竖线分隔；
       * 主指标（已启用）用品牌色，其余中性。 */
      '.co-stats{display:flex;align-items:stretch;gap:0;padding:12px 14px;margin-bottom:14px;'
        + 'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--co-r-lg);}',
      '.co-stat{display:flex;flex-direction:column;gap:1px;padding:0 18px;min-width:0;}',
      '.co-stat:first-child{padding-left:2px;}',
      '.co-stat + .co-stat{border-left:1px solid var(--dsw-alias-border-l1);}',
      '.co-stat-num{font-size:18px;font-weight:650;line-height:1.15;letter-spacing:-.4px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);}',
      '.co-stat-num[data-tone="brand"]{color:var(--dsw-alias-brand-primary);}',
      '.co-stat-num[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
      '.co-stat-lb{font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap;letter-spacing:.02em;}',
      '.co-stat-grow{flex:1;}',
      '.co-stat-act{display:flex;align-items:center;gap:8px;padding-left:14px;border-left:1px solid var(--dsw-alias-border-l1);}',

      /* ── 我的 MCP：分组容器 + 行分隔线 ──
       * 之前每条连接都是一张独立悬浮卡片（8 张卡片各自带阴影），视觉上互相竞争，
       * 没有「一个列表」的整体感，也没有视线落点。改成一张容器卡、行间 1px 分隔线：
       * 列表本身成为一个视觉单元，扫描路径变成一条竖线。 */
      '.co-svc-list{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--co-r-lg);'
        + 'box-shadow:0 1px 2px rgba(16,24,40,.04);overflow:hidden;}',
      '.co-svc{position:relative;transition:background 140ms var(--co-ease);}',
      '.co-svc + .co-svc{border-top:1px solid var(--dsw-alias-border-l1);}',
      '.co-svc:hover{background:var(--dsw-alias-bg-layer-1);}',
      '.co-svc[data-off="1"] .co-svc-badge{filter:grayscale(1);opacity:.55;}',
      '.co-svc[data-off="1"] .co-svc-name span:first-child{color:var(--dsw-alias-label-tertiary);}',
      '.co-svc[data-open="1"]{background:var(--dsw-alias-bg-layer-1);}',
      '.co-svc[data-open="1"]::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--dsw-alias-brand-primary);}',
      '.co-svc-hd{display:flex;align-items:center;gap:10px;padding:9px 14px;min-height:52px;}',
      '.co-svc-caret{appearance:none;border:none;background:none;color:var(--dsw-alias-label-caption);cursor:pointer;width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:0;border-radius:4px;transition:transform 160ms var(--co-ease),color 120ms var(--co-ease);}',
      '.co-svc-caret:hover:not(:disabled){color:var(--dsw-alias-label-primary);}',
      '.co-svc-caret[data-open="1"]{transform:rotate(90deg);color:var(--dsw-alias-label-secondary);}',
      '.co-svc-caret:disabled{opacity:.25;cursor:default;}',
      '.co-svc-badge{width:32px;height:32px;border-radius:var(--co-r-md);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:650;color:#fff;letter-spacing:-.3px;box-shadow:inset 0 1px 0 rgba(255,255,255,.18);transition:filter 160ms var(--co-ease),opacity 160ms var(--co-ease);}',
      '.co-svc-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.co-svc-name{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;min-width:0;line-height:1.3;}',
      '.co-svc-sub{font-size:11.5px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.45;font-family:var(--dsh-font-family-code,ui-monospace,monospace);}',
      '.co-svc-act{display:flex;align-items:center;gap:5px;flex-shrink:0;}',
      '.co-svc-tools{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 14px 47px;}',
      '.co-tool-tag{font-size:11px;line-height:15px;padding:2px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsh-font-family-code,ui-monospace,monospace);white-space:nowrap;cursor:default;transition:background 120ms var(--co-ease),color 120ms var(--co-ease);}',
      '.co-tool-tag:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}',
      '.co-switch{position:relative;width:34px;height:19px;border-radius:999px;border:none;padding:0;cursor:pointer;background:var(--dsw-alias-border-l2);transition:background 160ms var(--co-ease);flex-shrink:0;}',
      '.co-switch[data-on="1"]{background:var(--dsw-alias-state-success-primary);}',
      '.co-switch:disabled{opacity:.5;cursor:default;}',
      '.co-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.28);transition:transform 160ms var(--co-ease);}',
      '.co-switch[data-on="1"]::after{transform:translateX(15px);}',
      '.co-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.co-icon-btn{appearance:none;width:26px;height:26px;border-radius:var(--co-r-sm);border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;padding:0;transition:background 120ms var(--co-ease),color 120ms var(--co-ease);}',
      '.co-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.co-icon-btn:disabled{opacity:.25;cursor:default;}',
      '.co-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      /* ── MCP Hub：分类 + 卡片 ── */
      '.co-hub-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:14px;flex-shrink:0;}',
      '.co-hub-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:10px;align-items:start;}',
      /* 卡片高度由内容决定，不设 min-height：之前 98px 下限 + footer 的 margin-top:auto
       * 会把只有一两行描述的卡片撑出大片空洞（单卡分类尤其明显）。 */
      '.co-hub-card{display:flex;gap:10px;padding:12px 13px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--co-r-lg);cursor:pointer;'
        + 'transition:border-color 140ms var(--co-ease),box-shadow 140ms var(--co-ease),transform 140ms var(--co-ease);}',
      '.co-hub-card:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 2px 6px rgba(16,24,40,.05),0 12px 28px -18px rgba(16,24,40,.28);transform:translateY(-1px);}',
      '.co-hub-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.co-hub-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.co-hub-name{display:flex;align-items:baseline;gap:6px;font-size:13.5px;font-weight:600;min-width:0;line-height:1.3;}',
      '.co-hub-vendor{font-size:11px;color:var(--dsw-alias-label-caption);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.co-hub-desc{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-caption);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.co-hub-ft{display:flex;align-items:center;gap:5px;padding-top:4px;flex-wrap:wrap;}',
      '.co-tag{font-size:10.5px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-caption);white-space:nowrap;line-height:16px;}',
      /* 分类标题：Hub 的分组靠它切段，之前 11px 灰色几乎看不见。
       * 现在「标题 + 计数字 + 一条延伸到右侧的细线」，形成真实的分节感。 */
      '.co-grp{display:flex;align-items:center;gap:8px;margin:20px 0 10px;font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;}',
      '.co-grp:first-child{margin-top:2px;}',
      '.co-grp::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1);}',
      '.co-grp-n{font-size:11px;font-weight:500;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;}',
    ].join('')

    // ── 主题 token ────────────────────────────────────────────────────
    // 取自 @deepseek-ai/dsh-client-ui-theme 的 design-platform.css / base.css。
    // 名字写错不会报错，只会静默回落，所以每个都带 fallback。
    const T = {
      base: 'var(--dsw-alias-bg-base)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      caption: 'var(--dsw-alias-label-caption)',
      brand: 'var(--dsw-alias-brand-primary)',
      active: 'var(--dsw-alias-interactive-bg-active)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      mono: 'var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    }

    const SURFACES = [
      { id: 'dingtalk', label: '钉钉', hint: 'dws CLI' },
      { id: 'feishu', label: '飞书', hint: 'lark-cli' },
      { id: 'meego', label: '飞书项目', hint: '@lark-project/mcp' },
    ]

    // 已知产品的点色；未知产品用字符串哈希取一个稳定色。
    const PRODUCT_COLORS = {
      contact: '#3f5efb',
      chat: '#8b5cf6',
      calendar: '#10b981',
      todo: '#f59e0b',
      oa: '#06b6d4',
      drive: '#ec4899',
      doc: '#6366f1',
      docx: '#6366f1',
      aisearch: '#14b8a6',
      im: '#3f5efb',
      task: '#f59e0b',
      approval: '#06b6d4',
      wiki: '#8b5cf6',
      docs: '#6366f1',
      base: '#10b981',
      sheets: '#22c55e',
      minutes: '#ec4899',
      vc: '#0ea5e9',
    }
    const FALLBACK_COLORS = ['#3f5efb', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#ec4899', '#6366f1', '#14b8a6']

    function productColor(product) {
      if (!product) return T.caption
      if (PRODUCT_COLORS[product]) return PRODUCT_COLORS[product]
      let hash = 0
      const text = String(product)
      for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
      return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]
    }

    /* ── 数据访问 ───────────────────────────────────────────────────── */

    async function api(path, options) {
      const res = await fetch(BASE + path, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const text = await res.text()
      let data
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { error: text }
      }
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* 权限被拒时走下面的兜底 */
      }
      try {
        const box = document.createElement('textarea')
        box.value = text
        box.setAttribute('readonly', '')
        box.style.position = 'fixed'
        box.style.opacity = '0'
        document.body.appendChild(box)
        box.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(box)
        return ok
      } catch {
        return false
      }
    }

    /* ── 小组件 ─────────────────────────────────────────────────────── */

    /**
     * 输入防抖：目录一屏 200 行，服务端过滤是内存操作，但每敲一个字符都发一次
     * 请求仍会打断输入（连续请求互相覆盖）。180ms 静默后才真正查询。
     */
    function useDebounced(value, delay = 180) {
      const [settled, setSettled] = useState(value)
      useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delay)
        return () => clearTimeout(timer)
      }, [value, delay])
      return settled
    }

    function Chip({ tone, solid, children }) {
      return h('span', { className: 'co-chip', 'data-tone': tone, 'data-solid': solid ? '1' : undefined }, children)
    }

    function Dot({ color }) {
      return h('span', { className: 'co-dot', style: { background: color || T.caption } })
    }

    function Row({ label, children }) {
      return h('div', { className: 'co-row' }, h('span', { className: 'co-lb' }, label), h('span', { className: 'co-val' }, children))
    }

    function CopyButton({ text, label }) {
      const [done, setDone] = useState(false)
      const timer = useRef(null)
      useEffect(() => () => timer.current && clearTimeout(timer.current), [])
      return h(
        'button',
        {
          className: 'co-btn',
          'data-size': 'sm',
          onClick: async () => {
            const ok = await copyText(text)
            setDone(ok)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setDone(false), 1400)
          },
        },
        done ? '已复制' : label || '复制',
      )
    }

    function Segmented({ items, value, onChange }) {
      return h(
        'div',
        { className: 'co-seg', role: 'tablist' },
        ...items.map((item) =>
          h(
            'button',
            {
              key: item.id,
              className: 'co-seg-btn',
              'data-on': value === item.id ? '1' : '0',
              onClick: () => onChange(item.id),
              role: 'tab',
              'aria-selected': value === item.id,
            },
            item.label,
          ),
        ),
      )
    }

    function SurfaceSwitch({ value, onChange, disabledId }) {
      return h(
        'div',
        { className: 'co-seg', role: 'tablist' },
        ...SURFACES.map((item) =>
          h(
            'button',
            {
              key: item.id,
              className: 'co-seg-btn',
              'data-on': value === item.id ? '1' : '0',
              disabled: disabledId === item.id,
              title: disabledId === item.id ? `${item.hint}（目录不在本地，见概览页）` : item.hint,
              onClick: () => onChange(item.id),
              role: 'tab',
              'aria-selected': value === item.id,
            },
            item.label,
          ),
        ),
      )
    }

    /* ── 概览 ───────────────────────────────────────────────────────── */

    function SurfaceCard({ surface, health, state }) {
      const ready = Boolean(surface.ready)
      const isMeego = surface.id === 'meego'
      const info = isMeego ? surface.meego || {} : health[surface.id] || {}
      const mat = surface.materialised
      return h(
        'div',
        { className: 'co-card' },
        h(
          'div',
          { className: 'co-card-hd' },
          h(Dot, { color: ready ? T.success : T.error }),
          h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, surface.label),
          h('span', { style: { flex: 1 } }),
          h(Chip, { tone: ready ? 'ok' : 'bad' }, ready ? '已连接' : '未连接'),
          h(Chip, null, surface.hint || surface.cli),
        ),
        h(
          'div',
          { className: 'co-card-bd' },
          isMeego
            ? [
                h(Row, { key: 'srv', label: '官方服务' },
                  h('span', { style: { fontFamily: T.mono } }, info.serverFound ? info.serverPath : '未找到 @lark-project/mcp')),
                h(Row, { key: 'src', label: '凭据来源' }, info.tokenSource || '未配置'),
                h(Row, { key: 'tok', label: 'Token' }, info.tokenHint || '—'),
                h(Row, { key: 'cnt', label: '工具数' }, '48（官方固定）'),
              ]
            : [
                h(Row, { key: 'ver', label: '版本' }, info.version || '—'),
                h(Row, { key: 'usr', label: '账号' }, info.user || info.error || '未登录'),
                h(Row, { key: 'org', label: '组织/身份' }, info.org || info.brand || '—'),
                info.department ? h(Row, { key: 'dep', label: '部门' }, info.department) : null,
                h(Row, { key: 'cat', label: '目录' },
                  surface.catalogSize
                    ? `${surface.catalogSize} 条命令${surface.catalogStale ? '（缓存过期）' : ''}`
                    : '未缓存'),
                h(Row, { key: 'mat', label: '已启用' },
                  mat && mat.count
                    ? `${mat.count} 个工具`
                    : '未生成动态工具'),
              ],
        ),
        !isMeego && mat && mat.reason
          ? h('div', { className: 'co-card-ft' }, h('span', { className: 'co-item-sum', title: mat.reason }, mat.reason))
          : null,
      )
    }

    function Overview({ state, refreshing, onRefresh }) {
      const health = state?.health || {}
      const surfaces = state?.surfaces || []
      const config = state?.config || {}
      return h(
        'div',
        { className: 'co-body' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
          h(Chip, { tone: 'brand', solid: true }, 'MCP 三条连接'),
          h(Chip, null, `工具上限 ${config.max ?? 30}`),
          h(Chip, null, `effect=${config.effect ?? 'read'}`),
          h(Chip, null, `products=${config.products ?? 'auto'}`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { className: 'co-btn', onClick: () => onRefresh(true), disabled: refreshing },
            refreshing ? '探测中…' : '重新探测',
          ),
        ),
        h(
          'div',
          { className: 'co-grid' },
          ...surfaces.map((surface) =>
            h(SurfaceCard, { key: surface.id, surface, health, state }),
          ),
        ),
        h(
          'div',
          { style: { fontSize: 11.5, color: T.caption, marginTop: 14, lineHeight: '18px' } },
          '工具名带 mcp__ 前缀，例如 mcp__dingtalk__contact_user_get。面板只读，不会发出任何钉钉 / 飞书 / 飞书项目写操作。',
        ),
      )
    }

    /* ── CLI 目录：左列表 + 右详情 ──────────────────────────────────── */

    function ParamTable({ parameters }) {
      const rows = Array.isArray(parameters) ? parameters : []
      if (rows.length === 0) return h('div', { className: 'co-empty' }, '该命令没有参数')
      return h(
        'table',
        { className: 'co-tbl' },
        h('thead', null, h('tr', null, h('th', { style: { width: 150 } }, '参数'), h('th', { style: { width: 64 } }, '类型'), h('th', { style: { width: 46 } }, '必填'), h('th', null, '说明'))),
        h(
          'tbody',
          null,
          ...rows.map((param) =>
            h(
              'tr',
              { key: param.flag },
              h('td', null, h('span', { className: 'co-mono' }, '--' + param.flag)),
              h('td', null, h('span', { style: { fontSize: 11.5, color: T.text3 } }, param.type || '—')),
              h('td', null, param.required ? h(Chip, { tone: 'warn' }, '是') : h('span', { style: { fontSize: 11.5, color: T.caption } }, '否')),
              h('td', null, h('span', { style: { fontSize: 12, color: T.text2, lineHeight: 1.55 } }, param.description || '—')),
            ),
          ),
        ),
      )
    }

    function SchemaDetail({ surface, detail, loading, error, onClose }) {
      const [raw, setRaw] = useState(false)
      useEffect(() => {
        setRaw(false)
      }, [detail && detail.name])

      if (loading) return h('div', { className: 'co-empty' }, '正在读取命令详情…')
      if (error) return h('div', { className: 'co-err', style: { padding: 14 } }, error)
      if (!detail) {
        return h(
          'div',
          { className: 'co-empty' },
          '从左侧选一条命令，这里显示完整参数表、示例与原始 schema。',
        )
      }

      const cliLine = surface === 'feishu' ? 'lark-cli ' + detail.cli : 'dws ' + detail.cli
      const examples = Array.isArray(detail.examples) ? detail.examples.filter((item) => typeof item === 'string') : []

      return h(
        'div',
        { className: 'co-pane-bd-pad' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
          h('span', { style: { fontFamily: T.mono, fontSize: 13, fontWeight: 600, wordBreak: 'break-all' } }, detail.cli || detail.name),
          detail.effect ? h(Chip, { tone: detail.effect === 'read' ? 'ok' : 'warn' }, detail.effect) : null,
          detail.destructive ? h(Chip, { tone: 'bad' }, 'destructive') : null,
          detail.risk ? h(Chip, null, 'risk ' + detail.risk) : null,
          detail.idempotency ? h(Chip, null, detail.idempotency) : null,
          h('span', { style: { flex: 1 } }),
          h(CopyButton, { text: cliLine, label: '复制命令' }),
          h(
            'button',
            { className: 'co-btn', 'data-size': 'sm', onClick: () => setRaw((value) => !value) },
            raw ? '看参数表' : '看原始 JSON',
          ),
          onClose
            ? h('button', { className: 'co-btn', 'data-size': 'sm', onClick: onClose }, '收起')
            : null,
        ),
        detail.product
          ? h(
              'div',
              { className: 'co-row' },
              h('span', { className: 'co-lb' }, '产品'),
              h('span', { className: 'co-val', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                h(Dot, { color: productColor(detail.product) }),
                detail.product),
            )
          : null,
        detail.summary
          ? h('div', null, h('div', { className: 'co-sec' }, '摘要'), h('p', { className: 'co-p' }, detail.summary))
          : null,
        examples.length
          ? h(
              'div',
              null,
              h('div', { className: 'co-sec' }, '示例'),
              ...examples.slice(0, 4).map((item, index) =>
                h(
                  'div',
                  { key: index, style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 } },
                  h('pre', { className: 'co-pre', style: { flex: 1, maxHeight: 120 } }, item),
                  h(CopyButton, { text: item }),
                ),
              ),
            )
          : null,
        raw
          ? h('div', null, h('div', { className: 'co-sec' }, '原始 schema'), h('pre', { className: 'co-pre', style: { maxHeight: 420 } }, JSON.stringify(detail, null, 2)))
          : h(
              'div',
              null,
              h('div', { className: 'co-sec' }, `参数（${(detail.parameters || []).length}）`),
              h(ParamTable, { parameters: detail.parameters }),
            ),
        detail.description && detail.description !== detail.summary
          ? h('div', null, h('div', { className: 'co-sec' }, '完整说明'), h('p', { className: 'co-p' }, detail.description))
          : null,
      )
    }

    function Catalog({ initialSurface }) {
      const [surface, setSurface] = useState(initialSurface || 'dingtalk')
      const [query, setQuery] = useState('')
      const [product, setProduct] = useState('')
      const [effect, setEffect] = useState('')
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [detailError, setDetailError] = useState(null)
      const requestId = useRef(0)
      const settledQuery = useDebounced(query)

      const load = useCallback(
        async (opts = {}) => {
          setLoading(true)
          setError(null)
          try {
            const params = new URLSearchParams({ surface })
            if (settledQuery.trim()) params.set('query', settledQuery.trim())
            if (product) params.set('product', product)
            if (effect) params.set('effect', effect)
            if (opts.refresh) params.set('refresh', '1')
            params.set('limit', '200')
            setData(await api('/catalog?' + params.toString()))
          } catch (err) {
            setError(err.message)
            setData(null)
          } finally {
            setLoading(false)
          }
        },
        [surface, settledQuery, product, effect],
      )

      useEffect(() => {
        setSelected(null)
        setDetail(null)
        setDetailError(null)
        load()
      }, [load])

      const openDetail = useCallback(
        async (tool) => {
          setSelected(tool.name)
          setDetailError(null)
          setDetailLoading(true)
          const ticket = ++requestId.current
          try {
            const params = new URLSearchParams({ surface, command: tool.cli })
            const next = await api('/schema?' + params.toString())
            if (ticket === requestId.current) setDetail(next)
          } catch (err) {
            if (ticket === requestId.current) {
              setDetail(null)
              setDetailError(err.message)
            }
          } finally {
            if (ticket === requestId.current) setDetailLoading(false)
          }
        },
        [surface],
      )

      const products = data?.products || []
      const tools = data?.tools || []

      return h(
        'div',
        { className: 'co-body-flat' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingBottom: 10, flexShrink: 0 } },
          h(SurfaceSwitch, {
            value: surface,
            onChange: (next) => next !== 'meego' && setSurface(next),
            disabledId: 'meego',
          }),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { className: 'co-btn', onClick: () => load({ refresh: true }), disabled: loading },
            loading ? '读取中…' : '重读 CLI 目录',
          ),
        ),
        surface === 'meego'
          ? h(
              'div',
              { className: 'co-pane', style: { flex: 1 } },
              h('div', { className: 'co-empty' }, '飞书项目由官方 @lark-project/mcp 提供 48 个工具，目录不在本地缓存里；请在对话中直接调用 mcp__meego__* 工具。'),
            )
          : h(
              'div',
              { className: 'co-split' },
              h(
                'div',
                { className: 'co-pane co-split-left' },
                h(
                  'div',
                  { className: 'co-pane-hd', style: { flexDirection: 'column', alignItems: 'stretch', gap: 8 } },
                  h('input', {
                    className: 'co-input',
                    'aria-label': '搜索 CLI 命令',
                    placeholder: '搜索命令 / 摘要，如 contact、日程、message',
                    value: query,
                    onChange: (event) => setQuery(event.target.value),
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6 } },
                    h(
                      'select',
                      {
                        className: 'co-input co-sel',
                        'aria-label': '按产品筛选',
                        style: { flex: 1, minWidth: 0 },
                        value: product,
                        onChange: (event) => setProduct(event.target.value),
                      },
                      h('option', { value: '' }, '全部产品'),
                      ...products.map((item) =>
                        h('option', { key: item.product, value: item.product }, `${item.product} (${item.read}/${item.total})`),
                      ),
                    ),
                    h(
                      'select',
                      {
                        className: 'co-input co-sel',
                        'aria-label': '按 effect 筛选',
                        style: { flex: '0 0 96px' },
                        value: effect,
                        onChange: (event) => setEffect(event.target.value),
                      },
                      h('option', { value: '' }, '全部'),
                      h('option', { value: 'read' }, 'read'),
                      h('option', { value: 'write' }, 'write'),
                    ),
                  ),
                  h(
                    'div',
                    { style: { fontSize: 11.5, color: T.caption } },
                    data
                      ? `匹配 ${data.total} 条，显示 ${data.shown} 条 · 来源 ${data.source}${data.fetchedAt ? ' · ' + new Date(data.fetchedAt).toLocaleString() : ''}`
                      : '正在读取目录…',
                  ),
                ),
                h(
                  'div',
                  { className: 'co-pane-bd' },
                  error ? h('div', { className: 'co-err', style: { padding: 8 } }, error) : null,
                  ...tools.map((tool) =>
                    h(
                      'div',
                      {
                        key: tool.name,
                        className: 'co-item',
                        'data-on': selected === tool.name ? '1' : '0',
                        role: 'button',
                        tabIndex: 0,
                        'aria-pressed': selected === tool.name,
                        onClick: () => openDetail(tool),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            openDetail(tool)
                          }
                        },
                        title: tool.cli,
                      },
                      h(Dot, { color: productColor(tool.product) }),
                      h('span', { className: 'co-item-cli' }, tool.cli),
                      h('span', { className: 'co-item-sum' }, tool.summary || ''),
                      tool.destructive ? h(Chip, { tone: 'bad' }, '!') : null,
                    ),
                  ),
                  !loading && tools.length === 0
                    ? h('div', { className: 'co-empty' }, '没有匹配的命令')
                    : null,
                ),
              ),
              h(
                'div',
                { className: 'co-pane', style: { flex: 1, minWidth: 0 } },
                h(SchemaDetail, {
                  surface,
                  detail,
                  loading: detailLoading,
                  error: detailError,
                  onClose: () => {
                    setDetail(null)
                    setSelected(null)
                    setDetailError(null)
                  },
                }),
              ),
            ),
      )
    }

    /* ── 动态工具预览 ───────────────────────────────────────────────── */

    function ToolPreview({ initialSurface }) {
      const [surface, setSurface] = useState(initialSurface || 'dingtalk')
      const [products, setProducts] = useState('auto')
      // 内置连接器现在默认 effect=all（写工具启用），预览默认值跟它保持一致。
      const [effect, setEffect] = useState('all')
      const [max, setMax] = useState('30')
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)

      const load = useCallback(async () => {
        if (surface === 'meego') {
          setData(null)
          setError(null)
          return
        }
        setLoading(true)
        setError(null)
        try {
          const params = new URLSearchParams({ surface, products, effect, max })
          setData(await api('/tools?' + params.toString()))
        } catch (err) {
          setError(err.message)
          setData(null)
        } finally {
          setLoading(false)
        }
      }, [surface, products, effect, max])

      useEffect(() => {
        load()
      }, [load])

      return h(
        'div',
        { className: 'co-body-flat' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingBottom: 10, flexShrink: 0 } },
          h(SurfaceSwitch, { value: surface, onChange: setSurface }),
          h('span', { style: { flex: 1 } }),
          surface !== 'meego'
            ? h(
                React.Fragment,
                null,
                h('input', {
                  className: 'co-input',
                  style: { width: 220 },
                  value: products,
                  onChange: (event) => setProducts(event.target.value),
                  placeholder: 'products：auto 或 contact,chat',
                }),
                h(
                  'select',
                  { className: 'co-input', style: { width: 88 }, value: effect, onChange: (event) => setEffect(event.target.value) },
                  h('option', { value: 'read' }, 'read'),
                  h('option', { value: 'write' }, 'write'),
                  h('option', { value: 'all' }, 'all'),
                ),
                h('input', {
                  className: 'co-input',
                  style: { width: 68 },
                  value: max,
                  onChange: (event) => setMax(event.target.value),
                  placeholder: 'max',
                }),
                h('button', { className: 'co-btn', 'data-variant': 'primary', onClick: load, disabled: loading }, loading ? '计算中…' : '预览'),
              )
            : null,
        ),
        surface === 'meego'
          ? h(
              'div',
              { className: 'co-pane', style: { flex: 1 } },
              h('div', { className: 'co-empty' }, '飞书项目的 48 个工具由官方服务器固定提供，不受这里的配置影响。'),
            )
          : h(
              'div',
              { className: 'co-pane', style: { flex: 1 } },
              h(
                'div',
                { className: 'co-pane-hd', style: { flexWrap: 'wrap' } },
                data
                  ? h(
                      React.Fragment,
                      null,
                      h(Chip, { tone: 'brand', solid: true }, `命中 ${data.count}`),
                      h(Chip, null, `目录 ${data.total}`),
                      h(Chip, null, `上限 ${data.max}`),
                      h('span', { className: 'co-item-sum', style: { flex: 1 }, title: data.reason }, data.reason || ''),
                    )
                  : h('span', { className: 'co-item-sum' }, '正在计算…'),
              ),
              error ? h('div', { className: 'co-err', style: { padding: '8px 14px' } }, error) : null,
              h(
                'div',
                { className: 'co-pane-bd' },
                ...(data?.tools || []).map((tool) =>
                  h(
                    'div',
                    { key: tool.name, className: 'co-item' },
                    h(Dot, { color: productColor(tool.product) }),
                    h('span', { className: 'co-item-cli', style: { maxWidth: '34%' } }, tool.name),
                    h(Chip, null, tool.product),
                    h(Chip, { tone: tool.effect === 'read' ? 'ok' : 'warn' }, tool.effect),
                    h('span', { className: 'co-item-sum' }, tool.cli),
                  ),
                ),
                data && (data.tools || []).length === 0 ? h('div', { className: 'co-empty' }, '当前配置没有命中任何命令') : null,
              ),
              h(
                'div',
                { style: { padding: '8px 14px', borderTop: '1px solid ' + T.border, fontSize: 11.5, color: T.caption, lineHeight: '17px', flexShrink: 0 } },
                '这只是预览。真正生效要改 CHATOPS_TOOL_PRODUCTS / CHATOPS_TOOL_EFFECT / CHATOPS_MAX_TOOLS 后重启 dsh；写操作默认不 materialise，仍可经 dingtalk_cli / feishu_cli 调用。',
              ),
            ),
      )
    }

    /* ── 连接器：卡片墙 + 详情弹层 + 自定义连接 ─────────────────────── */

    function Badge({ color, text, size = 38, radius = 10, fontSize = 17 }) {
      return h(
        'span',
        {
          className: 'co-conn-badge',
          style: { background: color || T.brand, width: size, height: size, borderRadius: radius, fontSize },
          'aria-hidden': true,
        },
        text,
      )
    }

    function ConnectorCard({ item, busy, onOpen, onPlus }) {
      const isOn = item.connected && item.enabled
      // 点了就能连的才算「一键」：CLI 已装 / 令牌已配、只是还没连上。
      const oneClick = !item.connected && item.ready
      const plusTitle = isOn ? '查看 / 管理' : oneClick ? `一键连接 ${item.name}` : '查看连接步骤'
      return h(
        'div',
        {
          className: 'co-conn',
          'data-on': isOn ? '1' : '0',
          role: 'button',
          tabIndex: 0,
          'aria-label': `${item.name}：${isOn ? '已连接' : '未连接'}`,
          onClick: () => onOpen(item),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen(item)
            }
          },
        },
        h(Badge, { color: item.badgeColor, text: item.badge }),
        h(
          'div',
          { className: 'co-conn-main' },
          h(
            'div',
            { className: 'co-conn-hd' },
            h('span', { className: 'co-conn-name' }, item.name),
            isOn ? h('span', { className: 'co-live', title: '已连接' }) : null,
          ),
          h('div', { className: 'co-conn-desc' }, item.summary),
          h(
            'div',
            { className: 'co-conn-ft' },
            item.connected
              ? h(Chip, { tone: isOn ? 'ok' : 'warn' }, isOn ? `${item.toolCount || 0} 个工具` : '已停用')
              : h(Chip, null, item.cli ? (item.cli.installed ? 'CLI 已装' : '需装 CLI') : item.ready ? '待连接' : '需令牌'),
            item.connected ? h(Chip, null, item.serverName) : null,
          ),
        ),
        h(
          'button',
          {
            className: 'co-conn-act',
            'data-done': isOn ? '1' : '0',
            title: plusTitle,
            'aria-label': plusTitle,
            disabled: busy,
            onClick: (event) => {
              event.stopPropagation()
              if (oneClick) onPlus(item)
              else onOpen(item)
            },
          },
          isOn ? '·' : busy ? '…' : '+',
        ),
      )
    }

    /** 扫码用的二维码：不走外网图片服务，直接渲染 verification_url 让用户点开。 */
    function DeviceCodeBlock({ info, onFinish, busy, status }) {
      return h(
        'div',
        null,
        h('div', { className: 'co-sec' }, '授权方式：设备码'),
        h(
          'div',
          { className: 'co-field' },
          h('span', { className: 'co-field-lb' }, '1. 打开下面的链接'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('code', { className: 'co-code', style: { wordBreak: 'break-all' } }, info.url || '（未取到链接）'),
            info.url ? h(CopyButton, { text: info.url, label: '复制链接' }) : null,
          ),
        ),
        info.code
          ? h(
              'div',
              { className: 'co-field' },
              h('span', { className: 'co-field-lb' }, '2. 输入授权码'),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { className: 'co-code', style: { fontSize: 15, fontWeight: 600, letterSpacing: '1px' } }, info.code),
                h(CopyButton, { text: info.code, label: '复制授权码' }),
              ),
            )
          : null,
        h(
          'div',
          { className: 'co-field' },
          h('span', { className: 'co-field-lb' }, '3. 授权完成后回到这里'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'button',
              { className: 'co-btn', 'data-variant': 'primary', onClick: onFinish, disabled: busy },
              busy ? '检查中…' : '我已授权',
            ),
            info.expiresIn ? h('span', { className: 'co-hint' }, `${Math.round(info.expiresIn / 60)} 分钟内有效`) : null,
          ),
        ),
        status ? h('div', { className: status.ok ? 'co-ok' : 'co-err' }, status.text) : null,
      )
    }

    function ConnectModal({ item, onClose, onChanged, deviceSeed }) {
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const [device, setDevice] = useState(deviceSeed || null)
      const [loginStatus, setLoginStatus] = useState(null)
      const [tokenInput, setTokenInput] = useState('')
      const [detail, setDetail] = useState(item)

      useEffect(() => {
        setDetail(item)
      }, [item])

      const act = useCallback(
        async (key, fn) => {
          setBusy(key)
          setError(null)
          try {
            const result = await fn()
            return result
          } catch (err) {
            setError(err.message)
            return null
          } finally {
            setBusy(null)
          }
        },
        [],
      )

      const doInstall = () =>
        act('install', async () => {
          await api('/connectors/install', { method: 'POST', body: JSON.stringify({ id: detail.id }) })
          await onChanged()
        })

      const doLogin = () =>
        act('login', async () => {
          const info = await api('/connectors/login', { method: 'POST', body: JSON.stringify({ id: detail.id }) })
          if (info.mode === 'already') {
            setLoginStatus({ ok: true, text: `已经是登录状态：${info.user || info.status || ''}` })
            await onChanged()
            return
          }
          setDevice(info)
          setLoginStatus(null)
        })

      const doFinish = () =>
        act('finish', async () => {
          const result = await api('/connectors/login/finish', {
            method: 'POST',
            body: JSON.stringify({ id: detail.id, deviceCode: device?.deviceCode }),
          })
          if (result.ok) {
            setLoginStatus({ ok: true, text: `登录成功：${result.user || ''}` })
            setDevice(null)
            // 授权完成后顺手把连接也建上，省得用户再点一次。
            try {
              await api('/connectors/connect', { method: 'POST', body: JSON.stringify({ id: detail.id }) })
            } catch {
              // 连不上就把原因留给面板的主体状态显示，不覆盖「登录成功」这条信息。
            }
            await onChanged()
          } else {
            setLoginStatus({ ok: false, text: result.reason || '授权还没完成' })
          }
        })

      const doSaveToken = () =>
        act('token', async () => {
          await api('/connectors/token', {
            method: 'POST',
            body: JSON.stringify({ id: detail.id, token: tokenInput.trim() }),
          })
          setTokenInput('')
          setLoginStatus({ ok: true, text: '令牌已写入本机 env 文件' })
          await onChanged()
        })

      const doConnect = () =>
        act('connect', async () => {
          const result = await api('/connectors/connect', { method: 'POST', body: JSON.stringify({ id: detail.id }) })
          if (result.needsLogin) {
            // 一键连接走到授权这步：直接把设备码摆出来，不用再点一次「开始登录」。
            setDevice(result.device)
            setLoginStatus({ ok: false, text: result.message || '需要先授权登录' })
            await onChanged()
            return
          }
          setDevice(null)
          await onChanged()
        })

      const doDisconnect = () =>
        act('disconnect', async () => {
          await api('/connectors/disconnect', { method: 'POST', body: JSON.stringify({ id: detail.id }) })
          await onChanged()
        })

      const doToggle = () =>
        act('toggle', async () => {
          await api('/connectors/toggle', {
            method: 'POST',
            body: JSON.stringify({ id: detail.id, enabled: !detail.enabled }),
          })
          await onChanged()
        })

      const doLogout = () =>
        act('logout', async () => {
          const result = await api('/connectors/logout', { method: 'POST', body: JSON.stringify({ id: detail.id }) })
          setLoginStatus({ ok: result.ok, text: result.ok ? '已退出登录' : '退出失败：' + (result.output || '') })
          await onChanged()
        })

      const needsInstall = detail.kind === 'cli' && detail.cli && !detail.cli.installed
      const needsLogin = detail.kind === 'cli' && detail.cli && detail.cli.installed && !detail.ready
      const needsToken = detail.kind === 'token' && !detail.ready

      return h(
        'div',
        { className: 'co-mask', onClick: onClose, role: 'presentation' },
        h(
          'div',
          {
            className: 'co-modal',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': detail.name,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'co-modal-hd' },
            h(Badge, { color: detail.badgeColor, text: detail.badge, size: 40, fontSize: 18 }),
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 7 } },
                h('span', { style: { fontSize: 16, fontWeight: 650 } }, `连接 ${detail.name}`),
                detail.connected ? h(Chip, { tone: detail.enabled ? 'ok' : 'warn' }, detail.enabled ? '已连接' : '已停用') : null,
              ),
              h('div', { className: 'co-hint', style: { marginTop: 4 } }, detail.summary),
            ),
            h('button', { className: 'co-close', onClick: onClose, 'aria-label': '关闭' }, '×'),
          ),
          h(
            'div',
            { className: 'co-modal-bd' },
            error ? h('div', { className: 'co-err', style: { marginBottom: 10 } }, error) : null,

            detail.kind === 'cli'
              ? [
                  h('div', { key: 'cli', className: 'co-sec' }, '命令行'),
                  h(
                    'div',
                    { key: 'clif', className: 'co-field' },
                    h(Row, { label: 'CLI' }, detail.cli.bin),
                    h(Row, { label: '状态' }, detail.cli.installed ? '已安装' : '未安装'),
                    detail.cli.path ? h(Row, { label: '路径' }, detail.cli.path) : null,
                  ),
                  needsInstall
                    ? h(
                        'div',
                        { key: 'inst', style: { marginBottom: 11 } },
                        h(
                          'button',
                          { className: 'co-btn', 'data-variant': 'primary', onClick: doInstall, disabled: Boolean(busy) },
                          busy === 'install' ? '安装中…（首次约 30–60 秒）' : `安装 CLI（npm i -g ${detail.cli.package}）`,
                        ),
                        h(
                          'div',
                          { className: 'co-hint', style: { marginTop: 6 } },
                          '会装到本机全局 npm 目录；已装过则立即返回。',
                        ),
                      )
                    : null,
                  needsLogin
                    ? h(
                        'div',
                        { key: 'login' },
                        h('div', { className: 'co-sec' }, '登录'),
                        device
                          ? h(DeviceCodeBlock, { info: device, onFinish: doFinish, busy: busy === 'finish', status: loginStatus })
                          : h(
                              'div',
                              null,
                              h(
                                'button',
                                { className: 'co-btn', 'data-variant': 'primary', onClick: doLogin, disabled: Boolean(busy) },
                                busy === 'login' ? '正在申请验证码…' : '开始登录',
                              ),
                              h('div', { className: 'co-hint', style: { marginTop: 6 } }, '会打开一个设备码授权流程，不需要在面板里填密码。'),
                            ),
                        loginStatus && !device ? h('div', { className: loginStatus.ok ? 'co-ok' : 'co-err' }, loginStatus.text) : null,
                      )
                    : null,
                  detail.ready
                    ? h(
                        'div',
                        { key: 'ready', className: 'co-field' },
                        h('div', { className: 'co-ok' }, `已登录${detail.toolCount ? `，当前注册 ${detail.toolCount} 个工具` : ''}`),
                        h(
                          'div',
                          { style: { marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                          h('button', { className: 'co-btn', 'data-size': 'sm', onClick: doLogin, disabled: Boolean(busy) },
                            busy === 'login' ? '刷新中…' : '刷新登录状态'),
                          h('button', { className: 'co-btn', 'data-size': 'sm', onClick: doLogout, disabled: Boolean(busy) }, '退出登录'),
                        ),
                      )
                    : null,
                ]
              : [
                  h('div', { key: 'tok', className: 'co-sec' }, '凭据'),
                  h(
                    'div',
                    { key: 'tokf', className: 'co-field' },
                    h('span', { className: 'co-field-lb' }, detail.token.label),
                    h('input', {
                      className: 'co-input co-input-wide',
                      type: 'password',
                      placeholder: detail.token.placeholder,
                      value: tokenInput,
                      onChange: (event) => setTokenInput(event.target.value),
                      'aria-label': detail.token.label,
                    }),
                    h('span', { className: 'co-hint' }, detail.token.help),
                    detail.token.present
                      ? h('span', { className: 'co-ok' }, `当前已配置：${detail.token.hint}（来源 ${detail.token.source}）`)
                      : h('span', { className: 'co-hint' }, '当前未配置'),
                    h(
                      'div',
                      { style: { marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h(
                        'button',
                        { className: 'co-btn', 'data-variant': 'primary', onClick: doSaveToken, disabled: Boolean(busy) || !tokenInput.trim() },
                        busy === 'token' ? '保存中…' : '保存令牌',
                      ),
                    ),
                    h('div', { className: 'co-hint', style: { marginTop: 4, fontFamily: T.mono } }, detail.token.envFile),
                  ),
                ],

            loginStatus && detail.kind === 'token' ? h('div', { className: loginStatus.ok ? 'co-ok' : 'co-err' }, loginStatus.text) : null,

            (detail.prompts || []).length
              ? h(
                  'div',
                  null,
                  h('div', { className: 'co-sec' }, '试试这样用'),
                  ...detail.prompts.map((text, index) =>
                    h(
                      'div',
                      { key: index, className: 'co-prompt' },
                      h('span', { style: { flex: 1 } }, text),
                      h(CopyButton, { text, label: '复制' }),
                    ),
                  ),
                )
              : null,
          ),
          h(
            'div',
            { className: 'co-modal-ft' },
            detail.connected
              ? h(
                  'button',
                  { className: 'co-btn', onClick: doToggle, disabled: Boolean(busy) },
                  detail.enabled ? '停用' : '启用',
                )
              : null,
            detail.connected
              ? h('button', { className: 'co-btn', onClick: doDisconnect, disabled: Boolean(busy) }, busy === 'disconnect' ? '断开中…' : '断开连接')
              : h(
                  'button',
                  {
                    className: 'co-btn',
                    'data-variant': 'primary',
                    onClick: doConnect,
                    // CLI 没装 / 没登录都不拦着了：/connectors/connect 会自己装、自己发设备码。
                    disabled: Boolean(busy) || needsToken,
                    title: needsToken ? '先填上面的令牌' : '写入 MCP 配置并启动（会自动装 CLI、走一次授权）',
                  },
                  busy === 'connect' ? '连接中…' : '连接',
                ),
            h('span', { style: { flex: 1 } }),
            item.homepage
              ? h('button', { className: 'co-link', onClick: () => window.open(item.homepage, '_blank', 'noopener') }, '官网')
              : null,
          ),
        ),
      )
    }

    const EMPTY_CUSTOM = {
      serverName: '',
      transport: 'stdio',
      command: '',
      args: '',
      env: '',
      cwd: '',
      url: '',
      headers: '',
      toolCallTimeoutMs: '60000',
    }

    /** 把多行 KEY=VALUE / Header: value 解析成对象。 */
    function parsePairs(text, separator) {
      const out = {}
      for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const index = trimmed.indexOf(separator)
        if (index <= 0) continue
        const key = trimmed.slice(0, index).trim()
        const value = trimmed.slice(index + separator.length).trim()
        if (key) out[key] = value
      }
      return out
    }

    /** 贴一段 MCP JSON 就建连接；表单是兜底入口，默认不展示。 */
    const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "FeishuProjectMcp": {
      "command": "npx",
      "args": ["-y", "@lark-project/mcp", "--domain", "https://project.feishu.cn"],
      "env": { "MCP_USER_TOKEN": "m-xxxx" }
    },
    "lighthouse-ops": {
      "type": "streamableHttp",
      "url": "https://example.com/workbuddy/mcp",
      "timeout": 30000
    }
  }
}`

    /**
     * 添加 / 编辑一条 MCP 连接。
     *
     * 三个入口共用这一个弹层：
     *   1. 贴 mcpServers JSON（默认入口）
     *   2. 手填表单（stdio / streamable-http）
     *   3. 从 MCP Hub 选一项 → 表单被预填，用户只补凭据
     */
    function JsonModal({ onClose, onSubmit, busy, error, preset, title }) {
      const initial = preset
        ? {
            ...EMPTY_CUSTOM,
            serverName: preset.serverName || '',
            transport: preset.transport || 'stdio',
            command: preset.command || '',
            args: Array.isArray(preset.args) ? preset.args.join('\n') : '',
            cwd: preset.cwd || '',
            url: preset.url || '',
            env: Object.entries(preset.env || {})
              .map(([key, value]) => `${key}=${value}`)
              .join('\n'),
            headers: Object.entries(preset.headers || {})
              .map(([key, value]) => `${key}: ${value}`)
              .join('\n'),
            toolCallTimeoutMs: String(preset.toolCallTimeoutMs || 60000),
          }
        : EMPTY_CUSTOM
      const [text, setText] = useState('')
      const [manual, setManual] = useState(Boolean(preset))
      const [form, setForm] = useState(initial)
      // Hub 模板带声明的凭据字段：单独渲染成带标签的输入框，比让人在
      // 「env 每行 KEY=VALUE」里对着占位符猜要填哪个键清楚得多。
      const [creds, setCreds] = useState(() => {
        if (!preset) return []
        const list = []
        for (const field of preset.envKeys || []) {
          list.push({ kind: 'env', key: field.key, label: field.label || field.key, placeholder: field.placeholder || '', secret: field.secret !== false, value: '' })
        }
        for (const field of preset.headerKeys || []) {
          list.push({ kind: 'header', key: field.key, label: field.label || field.key, placeholder: field.placeholder || '', secret: true, value: '' })
        }
        return list
      })
      const setCred = (kind, key) => (event) =>
        setCreds((prev) => prev.map((item) => (item.kind === kind && item.key === key ? { ...item, value: event.target.value } : item)))
      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))
      const isHttp = form.transport === 'streamable-http'
      const jsonEmpty = !text.trim()
      // 从 Hub 进来的模板，env / headers 里的空值不参与提交（空占位留着让人看见要填什么）。
      const dropEmpty = (pairs) => {
        const out = {}
        for (const [key, value] of Object.entries(pairs)) if (String(value).trim()) out[key] = String(value).trim()
        return out
      }

      const submitForm = () => {
        const env = dropEmpty(parsePairs(form.env, '='))
        const headers = dropEmpty(parsePairs(form.headers, ':'))
        for (const item of creds) {
          if (!item.value.trim()) continue
          if (item.kind === 'env') env[item.key] = item.value.trim()
          else headers[item.key] = item.value.trim()
        }
        onSubmit({
          serverName: form.serverName.trim(),
          transport: form.transport,
          command: form.command.trim(),
          args: form.args,
          env,
          cwd: form.cwd.trim(),
          url: form.url.trim(),
          headers,
          toolCallTimeoutMs: Number(form.toolCallTimeoutMs) || 60000,
        })
      }
      const missingCred = creds.filter((item) => !item.value.trim())

      return h(
        'div',
        { className: 'co-mask', onClick: onClose, role: 'presentation' },
        h(
          'div',
          {
            className: 'co-modal',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': title || '添加 MCP',
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'co-modal-hd' },
            h(Badge, {
              color: preset?.badgeColor || '#64748b',
              text: preset?.badge || '+',
              size: 40,
              fontSize: 20,
            }),
            h(
              'div',
              { style: { flex: 1 } },
              h('div', { style: { fontSize: 16, fontWeight: 650 } }, title || (preset ? `安装 ${preset.name}` : '添加 MCP')),
              h(
                'div',
                { className: 'co-hint', style: { marginTop: 4 } },
                preset
                  ? preset.summary || '参数已按模板填好，补上凭据即可连接。'
                  : '把 ~/.workbuddy/mcp.json 或别人给你的 mcpServers 配置整段贴进来，一次可以加多个。',
              ),
            ),
            h('button', { className: 'co-close', onClick: onClose, 'aria-label': '关闭' }, '×'),
          ),
          h(
            'div',
            { className: 'co-modal-bd' },
            error ? h('div', { className: 'co-err', style: { marginBottom: 10 } }, error) : null,
            manual
              ? [
                  h(
                    'div',
                    { key: 'sn', className: 'co-field' },
                    h('span', { className: 'co-field-lb' }, 'serverName（工具前缀 mcp__<serverName>__*）'),
                    h('input', {
                      className: 'co-input co-input-wide',
                      value: form.serverName,
                      onChange: set('serverName'),
                      placeholder: 'my-server',
                      'aria-label': 'serverName',
                    }),
                  ),
                  h(
                    'div',
                    { key: 'tp', className: 'co-field' },
                    h('span', { className: 'co-field-lb' }, '传输方式'),
                    h(
                      'select',
                      {
                        className: 'co-input co-sel co-input-wide',
                        value: form.transport,
                        onChange: set('transport'),
                        'aria-label': '传输方式',
                      },
                      h('option', { value: 'stdio' }, 'stdio（本地进程）'),
                      h('option', { value: 'streamable-http' }, 'streamable-http（远程地址）'),
                    ),
                  ),
                  creds.length
                    ? h(
                        'div',
                        { key: 'creds', className: 'co-field' },
                        h('span', { className: 'co-field-lb' }, '凭据（只写本机，不随连接同步）'),
                        ...creds.map((item) =>
                          h(
                            'div',
                            { key: item.kind + ':' + item.key, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                            h('span', { style: { fontSize: 11.5, color: T.text3, width: 148, flexShrink: 0, fontFamily: T.mono } }, item.key),
                            h('input', {
                              className: 'co-input',
                              style: { flex: 1, minWidth: 0 },
                              type: item.secret ? 'password' : 'text',
                              value: item.value,
                              placeholder: item.placeholder || item.label,
                              'aria-label': item.key,
                              onChange: setCred(item.kind, item.key),
                            }),
                          ),
                        ),
                        h('span', { className: 'co-hint' }, '留空的字段不会写进配置；服务端需要它时会启动即报错。'),
                      )
                    : null,
                  isHttp
                    ? [
                        h(
                          'div',
                          { key: 'url', className: 'co-field' },
                          h('span', { className: 'co-field-lb' }, 'URL'),
                          h('input', {
                            className: 'co-input co-input-wide',
                            value: form.url,
                            onChange: set('url'),
                            placeholder: 'https://example.com/mcp',
                            'aria-label': 'URL',
                          }),
                        ),
                        h(
                          'div',
                          { key: 'hdr', className: 'co-field' },
                          h('span', { className: 'co-field-lb' }, '请求头（每行 Key: Value）'),
                          h('textarea', {
                            className: 'co-textarea',
                            value: form.headers,
                            onChange: set('headers'),
                            placeholder: 'Authorization: Bearer xxx',
                            'aria-label': '请求头',
                          }),
                        ),
                      ]
                    : [
                        h(
                          'div',
                          { key: 'cmd', className: 'co-field' },
                          h('span', { className: 'co-field-lb' }, 'command'),
                          h('input', {
                            className: 'co-input co-input-wide',
                            value: form.command,
                            onChange: set('command'),
                            placeholder: 'npx',
                            'aria-label': 'command',
                          }),
                        ),
                        h(
                          'div',
                          { key: 'args', className: 'co-field' },
                          h('span', { className: 'co-field-lb' }, 'args（每行一个）'),
                          h('textarea', {
                            className: 'co-textarea',
                            value: form.args,
                            onChange: set('args'),
                            placeholder: '-y\n@some/mcp-server',
                            'aria-label': 'args',
                          }),
                        ),
                        h(
                          'div',
                          { key: 'env', className: 'co-field' },
                          h('span', { className: 'co-field-lb' }, 'env（每行 KEY=VALUE）'),
                          h('textarea', {
                            className: 'co-textarea',
                            value: form.env,
                            onChange: set('env'),
                            placeholder: 'API_TOKEN=xxx',
                            'aria-label': 'env',
                          }),
                        ),
                        h(
                          'div',
                          { key: 'cwd', className: 'co-field' },
                          h('span', { className: 'co-field-lb' }, 'cwd（可选）'),
                          h('input', {
                            className: 'co-input co-input-wide',
                            value: form.cwd,
                            onChange: set('cwd'),
                            placeholder: '/path/to/project',
                            'aria-label': 'cwd',
                          }),
                        ),
                      ],
                  h(
                    'div',
                    { key: 'to', className: 'co-field' },
                    h('span', { className: 'co-field-lb' }, '工具调用超时（毫秒）'),
                    h('input', {
                      className: 'co-input co-input-wide',
                      value: form.toolCallTimeoutMs,
                      onChange: set('toolCallTimeoutMs'),
                      'aria-label': '超时',
                    }),
                  ),
                ]
              : h(
                  'div',
                  { className: 'co-field' },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                    h('span', { className: 'co-field-lb', style: { margin: 0 } }, 'MCP JSON'),
                    h('span', { style: { flex: 1 } }),
                    h(
                      'button',
                      {
                        className: 'co-link',
                        onClick: () => setText((prev) => prev || JSON_PLACEHOLDER),
                        type: 'button',
                      },
                      '填入示例',
                    ),
                  ),
                  h('textarea', {
                    className: 'co-textarea co-json',
                    value: text,
                    onChange: (event) => setText(event.target.value),
                    placeholder: JSON_PLACEHOLDER,
                    spellCheck: false,
                    'aria-label': 'MCP JSON',
                  }),
                  h(
                    'div',
                    { className: 'co-hint', style: { marginTop: 6 } },
                    '支持 mcpServers 外壳、单条对象、数组；type 写 streamableHttp / http / sse 都行，timeout 会转成 toolCallTimeoutMs。',
                  ),
                ),
          ),
          h(
            'div',
            { className: 'co-modal-ft' },
            h(
              'button',
              {
                className: 'co-link',
                type: 'button',
                onClick: () => setManual((prev) => !prev),
              },
              manual ? '← 改贴 JSON' : '手动填写',
            ),
            h('span', { style: { flex: 1 } }),
            // 模板要求凭据时给出明确提示，而不是让用户点下去吃一个启动错误。
            preset && missingCred.length
              ? h('span', { className: 'co-hint', style: { color: T.warn } }, `还差 ${missingCred.length} 项凭据：${missingCred.map((item) => item.key).join('、')}`)
              : null,
            h(
              'button',
              {
                className: 'co-btn',
                'data-variant': 'primary',
                disabled: busy || (manual ? !form.serverName.trim() : jsonEmpty),
                onClick: () => (manual ? submitForm() : onSubmit({ json: text })),
              },
              busy ? '连接中…' : manual ? (preset ? '安装并连接' : '连接') : '添加',
            ),
            h('button', { className: 'co-btn', onClick: onClose }, '取消'),
          ),
        ),
      )
    }

    /* ── 我的 MCP：一行一个服务，展开看工具墙 ───────────────────────── */

    /**
     * 一条已经写进 Loader 的 mcp-client 行。
     *
     * 以前自定义连接是表格行、内置是卡片，两种形态混在一页里；现在统一成
     * 这个组件（对齐宿主「MCP 服务管理」的列表观感）：左箭头展开工具、
     * 中间名字与目标、右侧开关 + 删除。builtin / custom / external 只有
     * 徽标颜色和「断开」语义不同。
     */
    function ServiceRow({ item, onToggle, onRemove, onOpenBuiltin, busy }) {
      const [expanded, setExpanded] = useState(false)
      const tools = item.tools || []
      const off = item.disabled
      const installed = tools.length > 0
      return h(
        'div',
        { className: 'co-svc', 'data-off': off ? '1' : '0', 'data-open': expanded ? '1' : '0' },
        h(
          'div',
          { className: 'co-svc-hd' },
          h(
            'button',
            {
              className: 'co-svc-caret',
              'data-open': expanded ? '1' : '0',
              'aria-label': expanded ? '收起工具' : '展开工具',
              'aria-expanded': expanded,
              onClick: () => setExpanded((value) => !value),
              disabled: !installed,
              title: installed ? `${tools.length} 个工具` : '连接成功但还没有注册工具：检查进程是否起来、凭据是否有效',
            },
            h(
              'svg',
              { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none', 'aria-hidden': true },
              h('path', { d: 'M3 1.5 L7 5 L3 8.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ),
          ),
          h('span', { className: 'co-svc-badge', style: { background: item.badgeColor } }, item.badge),
          h(
            'div',
            { className: 'co-svc-main' },
            h(
              'div',
              { className: 'co-svc-name' },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
              h('span', { className: 'co-live', style: { background: off ? T.caption : T.success } }),
              item.origin === 'builtin' ? null : h('span', { className: 'co-tag' }, item.origin === 'custom' ? '自定义' : '外部'),
            ),
            h('div', { className: 'co-svc-sub', title: item.target }, item.target || item.serverName),
          ),
          h(
            'div',
            { className: 'co-svc-act' },
            /* 工具数只作参考：面板的 tools 视角是宿主全局作用域，而 MCP 工具可能注册在
             * 具体会话作用域里，于是这里读到 0 并不等于连接坏了（旧面板一直显示 0 就是
             * 这个原因）。所以 0 用灰色中性文案，不用警告色，避免误判成故障。
             * 有数字时用 tabular-nums 对齐，扫一列时数字位不会跳。 */
            h(
              'span',
              {
                className: 'co-chip',
                'data-solid': '1',
                style: { fontVariantNumeric: 'tabular-nums' },
                title: item.toolCount
                  ? `已注册 ${item.toolCount} 个工具`
                  : '当前视角看不到已注册工具：可能是作用域可见性，也可能是子进程尚未就绪',
              },
              item.toolCount ? `${item.toolCount} 个工具` : '工具数不可见',
            ),
            item.origin === 'builtin'
              ? h(
                  'button',
                  { className: 'co-icon-btn', title: '连接详情 / 登录 / 令牌', 'aria-label': '连接详情', onClick: () => onOpenBuiltin?.(item) },
                  '⋯',
                )
              : null,
            h('button', {
              className: 'co-switch',
              'data-on': off ? '0' : '1',
              role: 'switch',
              'aria-checked': !off,
              'aria-label': off ? '启用' : '停用',
              title: off ? '启用' : '停用',
              disabled: busy,
              onClick: () => onToggle(item, off),
            }),
            // 外部行不归本插件管：删除按钮禁用，标题说明去哪儿删。
            h('button', {
              className: 'co-icon-btn',
              title: item.origin === 'external' ? '这条连接不是本插件建的，请在创建它的插件里删除' : '删除这条连接',
              'aria-label': '删除',
              disabled: busy || item.origin === 'external',
              onClick: () => onRemove(item),
            },
            h(
              'svg',
              { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              h('path', { d: 'M2.5 4h11M6 4V2.6h4V4M4 4l.7 9.1A1.2 1.2 0 0 0 5.9 14.3h4.2a1.2 1.2 0 0 0 1.2-1.2L12 4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            )),
          ),
        ),
        expanded
          ? h(
              'div',
              { className: 'co-svc-tools' },
              ...tools.slice(0, 120).map((tool) =>
                h('span', { key: tool.name, className: 'co-tool-tag', title: tool.description || tool.name }, tool.rawName),
              ),
              tools.length > 120 ? h('span', { className: 'co-tag' }, `+${tools.length - 120}`) : null,
            )
          : null,
      )
    }

    /* ── MCP Hub：预置模板目录 ─────────────────────────────────────── */

    function HubCard({ item, installed, onPick }) {
      return h(
        'div',
        {
          className: 'co-hub-card',
          role: 'button',
          tabIndex: 0,
          'aria-label': `安装 ${item.name}`,
          onClick: () => onPick(item),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onPick(item)
            }
          },
        },
        h(Badge, { color: item.badgeColor, text: item.badge, size: 36, radius: 9, fontSize: 13 }),
        h(
          'div',
          { className: 'co-hub-main' },
          h(
            'div',
            { className: 'co-hub-name' },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
            h('span', { className: 'co-hub-vendor' }, item.vendor),
          ),
          h('div', { className: 'co-hub-desc' }, item.summary),
          h(
            'div',
            { className: 'co-hub-ft' },
            installed ? h(Chip, { tone: 'ok' }, '已安装') : null,
            h(Chip, null, item.transport === 'streamable-http' ? 'http' : 'stdio'),
            (item.envKeys || []).length + (item.headerKeys || []).length > 0 ? h(Chip, { tone: 'warn' }, '需凭据') : null,
            ...(item.tags || []).slice(0, 2).map((tag) => h('span', { key: tag, className: 'co-tag' }, tag)),
          ),
        ),
      )
    }

    function Hub({ onPick }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      // 已安装集合由本页自己取一次：Panel 的 /state 不含服务列表，别为这个再加一路订阅。
      const [installed, setInstalled] = useState([])

      useEffect(() => {
        let alive = true
        api('/hub')
          .then((next) => alive && setData(next))
          .catch((err) => alive && setError(err.message))
        api('/connectors')
          .then((next) => alive && setInstalled((next.services || []).map((item) => item.serverName)))
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      const items = data?.items || []
      const categories = data?.categories || []
      const keyword = query.trim().toLowerCase()
      const filtered = items.filter((item) => {
        if (category && item.category !== category) return false
        if (!keyword) return true
        const hay = [item.name, item.vendor, item.summary, item.serverName, ...(item.tags || [])].join(' ').toLowerCase()
        return hay.includes(keyword)
      })
      const groups = new Map()
      for (const item of filtered) {
        if (!groups.has(item.category)) groups.set(item.category, [])
        groups.get(item.category).push(item)
      }
      const ordered = [...categories.filter((name) => groups.has(name)), ...[...groups.keys()].filter((name) => !categories.includes(name))]

      return h(
        'div',
        { className: 'co-body' },
        h(
          'div',
          { className: 'co-hub-bar' },
          h('input', {
            className: 'co-input',
            style: { width: 260 },
            placeholder: '搜索 MCP 服务，如 filesystem、搜索、数据库',
            'aria-label': '搜索 MCP 服务',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'select',
            {
              className: 'co-input co-sel',
              'aria-label': '按分类筛选',
              style: { width: 132 },
              value: category,
              onChange: (event) => setCategory(event.target.value),
            },
            h('option', { value: '' }, '全部分类'),
            ...categories.map((name) => h('option', { key: name, value: name }, name)),
          ),
          h('span', { style: { flex: 1 } }),
          h('span', { className: 'co-hint', style: { fontVariantNumeric: 'tabular-nums' } }, `${filtered.length} / ${items.length}`),
        ),
        error ? h('div', { className: 'co-err' }, error) : null,
        ...ordered.map((name) =>
          h(
            'div',
            { key: name },
            h(
              'div',
              { className: 'co-grp' },
              h('span', null, name),
              h('span', { className: 'co-grp-n' }, groups.get(name).length),
            ),
            h(
              'div',
              { className: 'co-hub-grid' },
              ...groups.get(name).map((item) =>
                h(HubCard, {
                  key: item.id,
                  item,
                  installed: installed.includes(item.serverName || item.id),
                  onPick: (picked) => onPick(picked),
                }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: { fontSize: 11.5, color: T.caption, marginTop: 18, lineHeight: '1.7' } },
          'Hub 只是可安装模板，不是「已核实的官方服务」清单。选中后参数会填进「添加 MCP」弹层，凭据只写本机；启动参数里的路径示例（D:/path/to/...）要自己改。',
        ),
      )
    }

    function Connectors({ presetSeed, onPresetConsumed }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [open, setOpen] = useState(null)
      const [seed, setSeed] = useState(null)
      const [customOpen, setCustomOpen] = useState(false)
      const [preset, setPreset] = useState(null)
      const [busy, setBusy] = useState(false)
      const [rowBusy, setRowBusy] = useState(null)
      const [customError, setCustomError] = useState(null)
      const mounted = useRef(true)

      const load = useCallback(async () => {
        try {
          const next = await api('/connectors')
          if (mounted.current) {
            setData(next)
            setError(null)
            // 弹层里的对象要保持最新（连接/停用后按钮状态要跟着变）
            setOpen((prev) => (prev ? next.builtins.find((item) => item.id === prev.id) || null : null))
          }
        } catch (err) {
          if (mounted.current) setError(err.message)
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        load()
        return () => {
          mounted.current = false
        }
      }, [load])

      // 从 Hub 点了一项：切到本页并直接把参数填进弹层，不用再点一次「手动填写」。
      useEffect(() => {
        if (!presetSeed) return
        setPreset(presetSeed)
        setCustomError(null)
        setCustomOpen(true)
        onPresetConsumed?.()
      }, [presetSeed, onPresetConsumed])

      const submitCustom = useCallback(
        async (payload) => {
          setBusy(true)
          setCustomError(null)
          try {
            if (payload.json !== undefined) {
              // 贴 JSON：后端会逐条建，失败的逐条回报，所以这里要看结果再决定关不关弹层。
              const result = await api('/custom/json', { method: 'POST', body: JSON.stringify({ json: payload.json }) })
              const failed = (result.results || []).filter((item) => !item.ok)
              await load()
              if (failed.length) {
                setCustomError(
                  failed.map((item) => `${item.serverName || '(未命名)'}：${item.error}`).join('；') +
                    `（成功 ${result.succeeded}/${result.total}）`,
                )
              } else {
                setCustomOpen(false)
                setPreset(null)
              }
              return
            }
            await api('/custom', { method: 'POST', body: JSON.stringify(payload) })
            setCustomOpen(false)
            setPreset(null)
            await load()
          } catch (err) {
            setCustomError(err.message)
          } finally {
            setBusy(false)
          }
        },
        [load],
      )

      /** 卡片上的 + ：能直接连就连；缺登录就带着设备码打开详情；缺 CLI 会自动装。 */
      const quickConnect = useCallback(
        async (item) => {
          setBusy(item.id)
          setError(null)
          try {
            const result = await api('/connectors/connect', { method: 'POST', body: JSON.stringify({ id: item.id }) })
            await load()
            if (result.needsLogin) {
              // 把设备码原样带进弹层，用户只需打开链接授权 + 点「我已授权」。
              setSeed({ id: item.id, device: result.device })
              setOpen(item)
            }
          } catch (err) {
            setError(`${item.name}：${err.message}`)
            setOpen(item)
          } finally {
            setBusy(null)
          }
        },
        [load],
      )

      const toggleService = useCallback(
        async (item, disabled) => {
          setRowBusy(item.entryId)
          try {
            await api('/services/toggle', { method: 'POST', body: JSON.stringify({ entryId: item.entryId, enabled: disabled }) })
            await load()
          } catch (err) {
            setError(err.message)
          } finally {
            setRowBusy(null)
          }
        },
        [load],
      )

      const removeService = useCallback(
        async (item) => {
          setRowBusy(item.entryId)
          try {
            const result = await api('/services/remove', { method: 'POST', body: JSON.stringify({ entryId: item.entryId }) })
            if (result.sticky) {
              setError(`${item.name}：已删除。这是内置连接器，标记会保留，重启不会再自动长回来；需要时到下方「可一键连接」重新连。`)
            }
            await load()
          } catch (err) {
            setError(err.message)
          } finally {
            setRowBusy(null)
          }
        },
        [load],
      )

      const openBuiltinDetail = useCallback(
        (service) => {
          // 按 serverName 找，不按 entryId 反推：内置行的 id 可能是
          // chatops-conn-<id>，也可能是 patch 里的 include:chatops-mcp-<id>。
          const item = (data?.builtins || []).find(
            (entry) => entry.serverName === service.serverName || entry.id === service.serverName,
          )
          if (item) setOpen(item)
        },
        [data],
      )

      const builtins = data?.builtins || []
      const services = data?.services || []
      const pending = builtins.filter((item) => !item.connected)
      const installedServers = services.map((item) => item.serverName)

      return h(
        'div',
        { className: 'co-body' },
        error ? h('div', { className: 'co-err' }, error) : null,
        data && data.warnOverload
          ? h(
              'div',
              { className: 'co-warnbar' },
              h('span', { style: { color: T.warn } }, '⚠'),
              h('span', null, `当前已启用 ${data.enabledToolTotal} 个 MCP 工具，超过 80 个可能影响回复质量。建议停用不常用的连接。`),
            )
          : null,
        /* node 体检：连接「全绿但工具恒为 0」最常见的根因是 PATH 上的 node 太老
         * （ESM + import.meta.url 需要 18+），这里直接把它摆出来。 */
        data && data.node && !data.node.ok
          ? h(
              'div',
              { className: 'co-warnbar', style: { borderColor: T.error } },
              h('span', { style: { color: T.error } }, '✕'),
              h(
                'span',
                null,
                `启动 MCP 子进程用的 node 版本过低：${data.node.command}${data.node.version ? '（' + data.node.version + '）' : ''}，需要 ≥ ${data.node.minMajor}。` +
                  (data.node.fromPath && data.node.fromPathVersion ? ` PATH 上的 node 是 ${data.node.fromPathVersion}。` : '') +
                  '用 CHATOPS_NODE_BIN 指到一个 18+ 的 node，或调整 PATH 顺序。',
              ),
            )
          : null,
        /* 统计条：三个数字 + 右侧动作。数字给权重、标签给语义，不再是一排同权重的 chip。 */
        h(
          'div',
          { className: 'co-stats' },
          h(
            'div',
            { className: 'co-stat' },
            h('span', { className: 'co-stat-num', 'data-tone': (data?.connectedCount ?? 0) > 0 ? 'brand' : undefined }, String(data?.connectedCount ?? 0)),
            h('span', { className: 'co-stat-lb' }, '已启用'),
          ),
          h(
            'div',
            { className: 'co-stat' },
            h('span', { className: 'co-stat-num', 'data-tone': data?.warnOverload ? 'warn' : undefined }, String(data?.enabledToolTotal ?? 0)),
            h('span', { className: 'co-stat-lb' }, '注册工具'),
          ),
          h(
            'div',
            { className: 'co-stat' },
            h('span', { className: 'co-stat-num' }, String(data?.totalMcpEntries ?? 0)),
            h('span', { className: 'co-stat-lb' }, 'MCP 行'),
          ),
          h('span', { className: 'co-stat-grow' }),
          h(
            'div',
            { className: 'co-stat-act' },
            h(
              'button',
              {
                className: 'co-btn',
                'data-variant': 'primary',
                onClick: () => {
                  setPreset(null)
                  setCustomError(null)
                  setCustomOpen(true)
                },
              },
              '+ 添加 MCP',
            ),
            h('button', { className: 'co-btn', onClick: load }, '刷新'),
          ),
        ),
        h(
          'div',
          { className: 'co-sec', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 0 } },
          h('span', null, `我的 MCP（${services.length}）`),
          data?.node && data.node.ok
            ? h('span', { className: 'co-hint', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, `node ${data.node.version}`)
            : null,
        ),
        services.length
          ? h(
              'div',
              { className: 'co-svc-list' },
              ...services.map((item) =>
                h(ServiceRow, {
                  key: item.entryId,
                  item,
                  busy: rowBusy === item.entryId,
                  onToggle: toggleService,
                  onRemove: removeService,
                  onOpenBuiltin: openBuiltinDetail,
                }),
              ),
            )
          : h('div', { className: 'co-empty' }, '还没有任何 MCP 连接。点「+ 添加 MCP」，或在下面的列表里连一个内置连接器。'),
        pending.length
          ? [
              h('div', { key: 'pendh', className: 'co-sec' }, '可一键连接'),
              h(
                'div',
                { key: 'pendl', className: 'co-wall' },
                ...pending.map((item) =>
                  h(ConnectorCard, {
                    key: item.id,
                    item,
                    busy: busy === item.id,
                    onOpen: setOpen,
                    onPlus: quickConnect,
                  }),
                ),
              ),
            ]
          : null,
        h(
          'div',
          { style: { fontSize: 11.5, color: T.caption, marginTop: 14, lineHeight: '1.7', maxWidth: '78ch' } },
          '每条连接都是 Loader 里的一行 @deepseek-ai/dsh-mcp-client；启停与配置记在 ~/.dsh/chatops/connections.json，重启后按它重建。',
        ),
        open ? h(ConnectModal, { item: open, onClose: () => { setOpen(null); setSeed(null) }, onChanged: load, deviceSeed: seed && seed.id === open.id ? seed.device : null }) : null,
        customOpen
          ? h(JsonModal, {
              // key 跟模板走：Hub 里换一项时强制重挂，否则表单还停在上一次的初值。
              key: preset ? preset.id || preset.serverName : 'manual',
              preset,
              title: preset ? `安装 ${preset.name}` : undefined,
              onClose: () => {
                setCustomOpen(false)
                setPreset(null)
                setCustomError(null)
              },
              onSubmit: submitCustom,
              busy,
              error: customError,
            })
          : null,
      )
    }

    /* ── 主面板 ─────────────────────────────────────────────────────── */

    const TABS = [
      { id: 'connectors', label: '我的 MCP' },
      { id: 'hub', label: 'MCP Hub' },
      { id: 'overview', label: '概览' },
      { id: 'catalog', label: 'CLI 目录' },
      { id: 'tools', label: '工具预览' },
    ]

    function Panel() {
      const [tab, setTab] = useState('connectors')
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [refreshing, setRefreshing] = useState(false)
      // Hub → 添加 MCP 的交接：Hub 里选中一项后，切回「我的 MCP」并把模板塞进弹层。
      const [presetSeed, setPresetSeed] = useState(null)
      const mounted = useRef(true)

      const loadState = useCallback(async (force) => {
        setRefreshing(true)
        try {
          if (force) await api('/health?force=1').catch(() => null)
          const next = await api('/state')
          if (mounted.current) {
            setState(next)
            setError(null)
          }
        } catch (err) {
          if (mounted.current) setError(err.message)
        } finally {
          if (mounted.current) setRefreshing(false)
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        loadState(false)
        return () => {
          mounted.current = false
        }
      }, [loadState])

      const consumePreset = useCallback(() => setPresetSeed(null), [])

      const pickFromHub = useCallback((item) => {
        // install（hubInstallPayload 的产物）放后面：模板算出来的 command / args / url
        // 才是权威值。反过来的话，item 上缺字段时弹层会静默退回空表单。
        setPresetSeed({ ...item, ...(item.install || {}) })
        setTab('connectors')
      }, [])

      const subtitle = state
        ? `统一管理 MCP 服务 · 缓存 ${state.cacheDir} · TTL ${state.cacheTtlMs ? Math.round(state.cacheTtlMs / 3600000) + ' h' : '—'}`
        : '正在读取宿主状态…'

      return h(
        'div',
        { className: 'co-root' },
        h(
          'div',
          { className: 'co-hero' },
          h(
            'div',
            { className: 'co-logo' },
            h(
              'svg',
              { width: 18, height: 18, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              h('circle', { cx: '3.2', cy: '4', r: '1.6', stroke: 'currentColor', strokeWidth: 1.5 }),
              h('circle', { cx: '3.2', cy: '12', r: '1.6', stroke: 'currentColor', strokeWidth: 1.5 }),
              h('path', { d: 'M4.8 4.6 L7.4 6.9M4.8 11.4 L7.4 9.1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
              h('rect', { x: '8', y: '5.5', width: '5.8', height: '5', rx: '1.7', stroke: 'currentColor', strokeWidth: 1.5 }),
            ),
          ),
          h(
            'div',
            { className: 'co-hd' },
            h('div', { className: 'co-title' }, 'MCP 服务管理'),
            h('div', { className: 'co-sub' }, subtitle),
          ),
        ),
        h(
          'div',
          { className: 'co-toolbar' },
          h(Segmented, { items: TABS, value: tab, onChange: setTab }),
          h('span', { style: { flex: 1 } }),
          error ? h(Chip, { tone: 'bad' }, error) : null,
          tab === 'overview'
            ? h(
                'button',
                { className: 'co-btn', onClick: () => loadState(true), disabled: refreshing },
                refreshing ? '探测中…' : '重新探测',
              )
            : null,
        ),
        tab === 'connectors' ? h(Connectors, { presetSeed, onPresetConsumed: consumePreset }) : null,
        tab === 'hub' ? h(Hub, { onPick: pickFromHub }) : null,
        tab === 'overview' ? h(Overview, { state, refreshing, onRefresh: loadState }) : null,
        tab === 'catalog' ? h(Catalog, { initialSurface: 'dingtalk' }) : null,
        tab === 'tools' ? h(ToolPreview, { initialSurface: 'dingtalk' }) : null,
      )
    }

    /**
     * 侧边栏图标：自绘，不依赖 primitives 图标表的具名导出（那些会变）。
     * 两个圆点经两条线汇到一个圆角方块 —— 「多个 IM 接到一处」。
     */
    function SidebarIcon({ size = 16 } = {}) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: '3.2', cy: '4', r: '1.6', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { cx: '3.2', cy: '12', r: '1.6', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M4.8 4.6 L7.4 6.9M4.8 11.4 L7.4 9.1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('rect', { x: '8', y: '5.5', width: '5.8', height: '5', rx: '1.7', stroke: 'currentColor', strokeWidth: 1.5 }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 静态样式：等价于官方 ui-theme 的注入范式（ctx.effect 里挂 <style>，
        // 卸载时自动移除）。只放 hover / transition / 焦点这类内联写不出的东西。
        if (typeof document !== 'undefined' && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const tag = document.createElement('style')
            tag.dataset.plugin = 'dsh-chatops-mcp'
            tag.dataset.pluginCss = 'dsh-chatops-mcp/panel.css'
            tag.textContent = PANEL_CSS
            document.head.appendChild(tag)
            return () => {
              tag.remove()
            }
          }, 'chatops-mcp: panel stylesheet')
        }

        // 入口一：左侧栏图标
        ctx.slots.inject('sidebar.panellist', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.panellist', id: 'chatops-mcp', order: 3, label: () => 'MCP 服务管理' },
            SidebarIcon,
          )
        })

        // 入口二：主区域页面（id 与 key 必须一致，点击图标才切过来）
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register(
            { name: 'main', key: 'chatops-mcp' },
            () => h('div', { style: { height: '100%', overflow: 'hidden' } }, h(Panel)),
          )
        })

        // 入口三：设置页里也能进（与 memory-panel 一致，同一份组件复用）
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'chatops-mcp', order: 45, label: () => 'MCP 服务管理' },
            () => h('div', { style: { height: '100%', overflow: 'hidden' } }, h(Panel)),
          )
        })
      },
    }
  },
})
