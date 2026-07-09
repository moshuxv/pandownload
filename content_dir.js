// content_dir.js — 注入到百度网盘目录页
// 在页面右上角添加批量控制面板，自动递归扫描所有子目录的视频/文档文件
// v3.2.3: 高度自适应+内容自然流动+紧凑布局

(function () {
  'use strict';

  if (window.__BaiduPanBatchController__) return;
  window.__BaiduPanBatchController__ = true;

  // ========== 支持下载的文件类型 ==========
  const DOC_TYPES = {
    documents: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'],
    images: ['jpg', 'jpeg', 'png', 'webp'],
    text: ['md', 'txt'],
    audio: ['mp3', 'm4a', 'wav', 'aac'],
    other: ['xmind', 'html'],
  };
  const ALL_DOC_EXTS = Object.values(DOC_TYPES).flat();

  // ========== 默认选中的下载类型 ==========
  const DEFAULT_SELECTED = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'md', 'txt']);

  const STATE = {
    enabled: false,
    paused: false,
    collapsed: false,   // 是否最小化面板
    videos: [],
    currentIndex: 0,
    activeTabs: [],
    maxConcurrent: 5,
    userConcurrency: 5,    // 用户可调节的并发数（1-10）
    totalDone: 0,
    totalSkip: 0,
    totalFailed: 0,
    pollTimer: null,
    rootDir: '',
    scanning: false,
    scanProgress: '',
    scanStats: {
      totalDirs: 0,
      totalFiles: 0,
      totalVideos: 0,
      totalNonVideos: 0,
      failedDirs: [],
      nonVideoFiles: [],
      dirDetails: [],
    },
    showDetails: false,
    showFailed: false,
    // === 文档下载相关 ===
    docs: [],              // [{name, path, fs_id, relPath, size, status, ext}]
    docMode: 'idle',       // 'idle' | 'downloading' | 'done'
    docsTotal: 0,
    docsDone: 0,
    docsFailed: 0,
    docsFailList: [],
    docsCurrentName: '',
    selectedDocTypes: DEFAULT_SELECTED, // Set of selected extensions
    showDocTypes: false,   // 是否展开文件类型选择
  };

  function log(msg) {
    console.log(`[批量导出] ${msg}`);
    updatePanel();
  }

  // ========== 浮动控制面板 ==========
  let panelEl = null;
  let panelInner = null;  // 内层可滚动容器

  function createPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = '__batch_subtitle_panel__';
    panelEl.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      background: rgba(30, 30, 40, 0.97);
      color: #fff;
      padding: 0;
      border-radius: 10px;
      font-size: 13px;
      font-family: -apple-system, "Microsoft YaHei", sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
      width: 420px;
      line-height: 1.5;
    `;

    // 内层容器：内容自适应高度，超出自动滚动
    if (!panelInner) {
      panelInner = document.createElement('div');
      panelInner.style.cssText = `
        padding: 10px 12px;
        overflow-y: auto;
        overflow-x: hidden;
        box-sizing: border-box;
      `;
      panelEl.appendChild(panelInner);
    }
    document.documentElement.appendChild(panelEl);
    console.log('[BatchPanel] 面板已创建, panelEl:', panelEl);
    renderPanel();
    console.log('[BatchPanel] 初始渲染完成, currentDir:', getCurrentDirPath());
  }

  // ========== 获取文件扩展名 ==========
  function getExt(filename) {
    const idx = filename.lastIndexOf('.');
    return idx >= 0 ? filename.substring(idx + 1).toLowerCase() : '';
  }

  // ========== 判断是否是视频文件 ==========
  function isVideoFile(filename) {
    const ext = getExt(filename);
    return ['mp4', 'm4v', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4a'].includes(ext);
  }

  // ========== 判断是否是选中的文档文件 ==========
  function isDocFile(filename) {
    return STATE.selectedDocTypes.has(getExt(filename));
  }

  // ========== 渲染面板 ==========
  function renderPanel() {
    if (!panelEl) return;

    const currentDir = getCurrentDirPath();
    const hasScanned = STATE.scanStats.totalDirs > 0;

    // ===== 扫描区域 =====
    const scanBtnText = STATE.scanning
      ? '⏳ 扫描中...'
      : (hasScanned ? '🔄 重新扫描' : '🔍 扫描目录');
    const scanBtnColor = STATE.scanning ? '#7f8c8d' : '#3498db';
    const scanInfo = STATE.scanning
      ? `<div style="margin-top:3px;font-size:11px;opacity:0.8;color:#f39c12;">🔄 ${STATE.scanProgress}</div>`
      : '';

    // ===== 视频字幕导出按钮 =====
    const videoTotal = STATE.videos.length;
    const videoDone = STATE.totalDone;
    const videoFailed = STATE.totalFailed;
    const videoSkip = STATE.totalSkip;
    const videoActive = STATE.activeTabs.length;
    const videoProcessing = videoTotal > 0 ? (videoDone + videoSkip + videoFailed) : 0;
    const videoRemaining = videoTotal - videoProcessing;
    const videoProgress = videoTotal > 0 ? Math.round((videoProcessing / videoTotal) * 100) : 0;
    const isVideoRunning = STATE.enabled;

    let videoBtnText = '🎬 导出视频字幕';
    let videoBtnColor = '#2ea0a3';
    if (isVideoRunning && !STATE.paused) {
      videoBtnText = '⏸ 暂停';
      videoBtnColor = '#e67e22';
    } else if (isVideoRunning && STATE.paused) {
      videoBtnText = '▶ 继续';
      videoBtnColor = '#27ae60';
    } else if (videoProcessing > 0 && !isVideoRunning) {
      videoBtnText = '▶ 继续导出';
      videoBtnColor = '#2ea0a3';
    }

    // ===== 文档下载按钮 =====
    const docTotal = STATE.docs.length;
    const isDocDownloading = STATE.docMode === 'downloading';
    const isDocDone = STATE.docMode === 'done';
    const docProgress = docTotal > 0 ? Math.round((STATE.docsDone / docTotal) * 100) : 0;
    const docRemaining = docTotal - STATE.docsDone - STATE.docsFailed;

    let docBtnText = '📄 下载文档';
    let docBtnColor = '#e67e22';
    if (isDocDownloading) {
      docBtnText = '⏳ 下载中...';
      docBtnColor = '#c0392b';
    } else if (isDocDone && STATE.docsFailed > 0) {
      docBtnText = '🔁 重新下载';
      docBtnColor = '#e67e22';
    } else if (isDocDone) {
      docBtnText = '✅ 下载完成';
      docBtnColor = '#27ae60';
    }

    // ===== 组装HTML =====
    let html = '';
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">`;
    html += `<span style="font-weight:bold;font-size:15px;">📂 批量处理</span>`;
    html += `<button id="__batch_toggle_collapse__" style="
      background:rgba(255,255,255,0.15);color:#fff;border:none;padding:2px 8px;
      border-radius:4px;font-size:11px;cursor:pointer;
    ">${STATE.collapsed ? '▼ 展开' : '▲ 收起'}</button>`;
    html += `</div>`;

    // ===== 折叠内容 =====
    if (STATE.collapsed) {
      const vc = STATE.videos.length;
      const dc = STATE.docs.length;
      html += `<div style="font-size:11px;opacity:0.6;">`;
      html += `🎬 ${STATE.totalDone}/${vc} &nbsp; 📄 ${STATE.docsDone}/${dc}`;
      html += `</div>`;
      panelInner.innerHTML = html;
      panelEl.style.height = '42px';
      const collapseBtn = panelInner.querySelector('#__batch_toggle_collapse__');
      if (collapseBtn) collapseBtn.addEventListener('click', () => {
        STATE.collapsed = false;
        panelEl.style.height = 'auto';
        updatePanel();
      });
      return;
    }

    // 展开时恢复正常高度
    panelEl.style.height = 'auto';

    // 扫描按钮行
    html += `<div style="margin-bottom:6px;">`;
    html += `<button id="__batch_scan_btn__" style="
      background:${scanBtnColor};color:#fff;border:none;padding:6px 14px;
      border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;
    " ${STATE.scanning ? 'disabled' : ''}>${scanBtnText}</button>`;
    if (currentDir) {
      const shortDir = currentDir.length > 40 ? '...' + currentDir.substring(currentDir.length - 37) : currentDir;
      html += `<span style="margin-left:8px;font-size:11px;opacity:0.5;">${shortDir}</span>`;
    }
    html += `</div>`;
    html += scanInfo;

    // ===== 两个操作按钮（扫描完成后才显示）=====
    if (hasScanned) {
      html += `<div style="border-top:1px solid rgba(255,255,255,0.2);margin:6px 0;padding-top:6px;">`;

      // ===== 视频字幕导出区域 =====
      html += `<div style="margin-bottom:6px;">`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">`;
      html += `<span style="font-weight:bold;">🎬 视频字幕</span>`;
      html += `<span style="font-size:12px;opacity:0.7;">${videoTotal} 个视频</span>`;
      html += `</div>`;

      // 并发控制（加减按钮，实时生效）
      if (videoTotal > 0) {
        html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px;">`;
        html += `<span style="opacity:0.7;">并发:</span>`;
        html += `<button id="__batch_conc_dec__" style="background:rgba(255,255,255,0.15);color:#fff;border:none;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;padding:0;">−</button>`;
        html += `<span id="__batch_conc_val__" style="min-width:20px;text-align:center;font-weight:bold;">${STATE.userConcurrency}</span>`;
        html += `<button id="__batch_conc_inc__" style="background:rgba(255,255,255,0.15);color:#fff;border:none;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;padding:0;">+</button>`;
        html += `<span style="opacity:0.5;font-size:10px;margin-left:2px;">(1-10)</span>`;
        html += `</div>`;
      }

      html += `<button id="__batch_video_btn__" onclick="window.__toggleVideoExport && window.__toggleVideoExport()" style="
        background:${videoBtnColor};color:#fff;border:none;padding:6px 12px;
        border-radius:5px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;
      ">${videoBtnText}</button>`;

      // 视频进度
      if (videoProcessing > 0) {
        html += `<div style="margin-top:4px;">`;
        html += `<div style="font-size:11px;opacity:0.85;">`;
        html += `✅${videoDone} ❌${videoFailed} ⏭${videoSkip} 📄${videoActive} ⏳${videoRemaining}`;
        html += `</div>`;
        html += `<div style="margin-top:3px;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;">`;
        html += `<div style="height:100%;width:${videoProgress}%;background:#2ea0a3;border-radius:2px;transition:width 0.3s;"></div>`;
        html += `</div>`;
        if (STATE.activeTabs.length > 0) {
          html += `<div style="margin-top:3px;font-size:11px;opacity:0.7;">`;
          for (const t of STATE.activeTabs.slice(0, 2)) {
            const v = STATE.videos[t.videoIndex];
            if (v) {
              const sn = v.name.length > 38 ? v.name.substring(0, 35) + '...' : v.name;
              const el = Math.round((Date.now() - t.openedAt) / 1000);
              html += `<div>⏳ ${sn} (${el}s)</div>`;
            }
          }
          html += `</div>`;
        }
        html += `</div>`;
      }

      // ===== 文档下载区域 =====
      html += `<div style="border-top:1px solid rgba(255,255,255,0.15);padding-top:8px;">`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">`;
      html += `<span style="font-weight:bold;">📄 文档下载</span>`;
      html += `<span style="font-size:12px;opacity:0.7;">${docTotal} 个文件</span>`;
      html += `</div>`;

      // 文件类型选择（可展开）
      html += `<div style="margin-bottom:6px;">`;
      html += `<button id="__batch_toggle_doc_types__" style="
        background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.25);
        padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;
      ">${STATE.showDocTypes ? '收起' : '选择文件类型'} (已选${STATE.selectedDocTypes.size}种)</button>`;
      html += `</div>`;

      if (STATE.showDocTypes) {
        html += `<div style="background:rgba(0,0,0,0.25);border-radius:6px;padding:10px;margin-bottom:8px;font-size:11px;">`;

        const renderGroup = (label, exts, color) => {
          html += `<div style="margin-bottom:6px;"><span style="color:${color};font-weight:bold;">${label}:</span></div>`;
          html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">`;
          for (const ext of exts) {
            const checked = STATE.selectedDocTypes.has(ext);
            const id = `__doc_type_${ext}__`;
            html += `<label style="display:flex;align-items:center;gap:3px;cursor:pointer;background:rgba(255,255,255,${checked ? '0.2' : '0.08'});padding:2px 7px;border-radius:3px;border:1px solid rgba(255,255,255,${checked ? '0.4' : '0.15'});">`;
            html += `<input type="checkbox" id="${id}" data-ext="${ext}" ${checked ? 'checked' : ''} style="cursor:pointer;">`;
            html += `<span>.${ext}</span>`;
            html += `</label>`;
          }
          html += `</div>`;
        };

        renderGroup('📕 文档', DOC_TYPES.documents, '#e74c3c');
        renderGroup('🖼 图片', DOC_TYPES.images, '#3498db');
        renderGroup('📝 文本', DOC_TYPES.text, '#2ecc71');
        renderGroup('🎵 音频', DOC_TYPES.audio, '#9b59b6');
        renderGroup('📎 其他', DOC_TYPES.other, '#f39c12');

        // 快速操作
        html += `<div style="display:flex;gap:6px;margin-top:4px;">`;
        html += `<button id="__doc_select_all__" style="background:#3498db;color:#fff;border:none;padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;">全选</button>`;
        html += `<button id="__doc_select_none__" style="background:#7f8c8d;color:#fff;border:none;padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;">清空</button>`;
        html += `</div>`;
        html += `</div>`;
      }

      html += `<button id="__batch_doc_btn__" style="
        background:${docBtnColor};color:#fff;border:none;padding:6px 12px;
        border-radius:5px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;
      ">${docBtnText}</button>`;

      // 文档下载进度
      if (isDocDownloading || isDocDone) {
        html += `<div style="margin-top:4px;">`;
        html += `<div style="font-size:11px;opacity:0.85;">`;
        html += `✅${STATE.docsDone} ❌${STATE.docsFailed} ⏳${docRemaining} 📊${docProgress}%`;
        html += `</div>`;
        if (STATE.docsCurrentName) {
          html += `<div style="font-size:10px;opacity:0.5;margin-top:2px;">📥 ${STATE.docsCurrentName}</div>`;
        }
        html += `<div style="margin-top:2px;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;">`;
        html += `<div style="height:100%;width:${docProgress}%;background:#e67e22;border-radius:2px;transition:width 0.3s;"></div>`;
        html += `</div>`;
        html += `</div>`;
      }

      // 文档失败列表
      if (STATE.docsFailList.length > 0 && !isDocDownloading) {
        html += `<div style="margin-top:4px;font-size:11px;opacity:0.75;max-height:80px;overflow-y:auto;">`;
        html += `<div style="color:#e74c3c;">失败 (${STATE.docsFailList.length})：</div>`;
        for (const f of STATE.docsFailList.slice(-8)) {
          html += `<div style="padding-left:6px;">  ❌ ${f}</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`; // end 文档下载区域

      // ===== 扫描统计 =====
      const stats = STATE.scanStats;
      html += `<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.2);padding-top:5px;">`;
      html += `<div style="font-weight:bold;margin-bottom:2px;">📊 扫描统计</div>`;
      html += `<div style="font-size:11px;opacity:0.85;">`;
      html += `📁目录 <b>${stats.totalDirs}</b> 📄文件 <b>${stats.totalFiles}</b> 🎬视频 <b style="color:#2ea0a3;">${stats.totalVideos}</b> 📄文档 <b style="color:#e67e22;">${docTotal}</b>`;
      html += `</div>`;
      if (stats.failedDirs.length > 0) {
        html += `<div style="font-size:11px;color:#e74c3c;margin-top:2px;">⚠️ ${stats.failedDirs.length} 个目录扫描失败</div>`;
      }
      html += `<div style="margin-top:3px;">`;
      html += `<button id="__batch_toggle_details__" style="
        background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);
        padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;
      ">${STATE.showDetails ? '隐藏' : '显示'}详细信息</button>`;
      html += `</div>`;
      if (STATE.showDetails) html += renderDetailsHtml();
      html += `</div>`;

      html += renderFailedHtml();
    }

    if (!hasScanned && !STATE.scanning) {
      html += `<div style="margin-top:4px;font-size:11px;opacity:0.45;">点击"扫描目录"分析所有子文件夹</div>`;
    }

    html += `<div style="margin-top:5px;font-size:10px;opacity:0.3;">v3.2.6</div>`;

    panelInner.innerHTML = html;

    // ===== 绑定事件 =====
    const scanBtn = panelEl.querySelector('#__batch_scan_btn__');
    if (scanBtn) scanBtn.addEventListener('click', () => {
      // 扫描前先根据当前选中类型重新收集文件
      doScan();
    });

    const videoBtn = panelEl.querySelector('#__batch_video_btn__');
    console.log('[BatchPanel] 查找视频按钮, videoBtn:', videoBtn, 'innerHTML:', videoBtn ? videoBtn.outerHTML : 'NOT FOUND');
    if (videoBtn) videoBtn.addEventListener('click', window.__toggleVideoExport);

    const docBtn = panelEl.querySelector('#__batch_doc_btn__');
    if (docBtn) docBtn.addEventListener('click', startDocDownload);

    // 并发加减按钮（实时生效）
    const concVal = panelEl.querySelector('#__batch_conc_val__');
    const concDec = panelEl.querySelector('#__batch_conc_dec__');
    const concInc = panelEl.querySelector('#__batch_conc_inc__');

    if (concDec && concInc && concVal) {
      concDec.addEventListener('click', () => {
        if (STATE.userConcurrency > 1) {
          STATE.userConcurrency--;
          STATE.maxConcurrent = STATE.userConcurrency;
          renderPanel();
          // 正在运行时立即触发调度
          if (STATE.enabled && !STATE.paused) {
            for (let i = 0; i < STATE.userConcurrency; i++) scheduleNext();
          }
        }
      });
      concInc.addEventListener('click', () => {
        if (STATE.userConcurrency < 10) {
          STATE.userConcurrency++;
          STATE.maxConcurrent = STATE.userConcurrency;
          renderPanel();
          // 正在运行时立即触发调度
          if (STATE.enabled && !STATE.paused) {
            for (let i = 0; i < STATE.userConcurrency; i++) scheduleNext();
          }
        }
      });
    }
    STATE.maxConcurrent = STATE.userConcurrency;

    const detailBtn = panelEl.querySelector('#__batch_toggle_details__');
    if (detailBtn) {
      detailBtn.addEventListener('click', () => {
        STATE.showDetails = !STATE.showDetails;
        renderPanel();
      });
    }

    const retryBtn = panelEl.querySelector('#__batch_retry_failed__');
    if (retryBtn) retryBtn.addEventListener('click', retryFailedVideos);

    // 文档类型选择
    const toggleDocTypesBtn = panelEl.querySelector('#__batch_toggle_doc_types__');
    if (toggleDocTypesBtn) {
      toggleDocTypesBtn.addEventListener('click', () => {
        STATE.showDocTypes = !STATE.showDocTypes;
        renderPanel();
      });
    }

    // 文件类型复选框
    panelEl.querySelectorAll('input[data-ext]').forEach(cb => {
      cb.addEventListener('change', () => {
        const ext = cb.dataset.ext;
        if (cb.checked) {
          STATE.selectedDocTypes.add(ext);
        } else {
          STATE.selectedDocTypes.delete(ext);
        }
        // 重新收集文件
        reCollectDocs();
        renderPanel();
      });
    });

    // 折叠按钮
    const collapseBtn = panelEl.querySelector('#__batch_toggle_collapse__');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        STATE.collapsed = !STATE.collapsed;
        updatePanel();
      });
    }

    const selectAllBtn = panelEl.querySelector('#__doc_select_all__');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        ALL_DOC_EXTS.forEach(e => STATE.selectedDocTypes.add(e));
        reCollectDocs();
        renderPanel();
      });
    }

    const selectNoneBtn = panelEl.querySelector('#__doc_select_none__');
    if (selectNoneBtn) {
      selectNoneBtn.addEventListener('click', () => {
        STATE.selectedDocTypes.clear();
        reCollectDocs();
        renderPanel();
      });
    }
  }

  // ========== 根据当前选中类型重新收集文档 ==========
  function reCollectDocs() {
    // 从已扫描的 nonVideoFiles 中按扩展名重新筛选
    const newDocs = [];
    for (const f of STATE.scanStats.nonVideoFiles) {
      if (STATE.selectedDocTypes.has(f.ext)) {
        newDocs.push({
          name: f.name,
          path: f.path,
          fs_id: f.fs_id,
          relPath: f.dir === '(根目录)' ? '' : f.dir,
          size: f.size || 0,
          status: 'pending',
          ext: f.ext,
        });
      }
    }
    STATE.docs = newDocs;
    STATE.docsTotal = newDocs.length;
    STATE.docsDone = 0;
    STATE.docsFailed = 0;
    STATE.docsFailList = [];
    STATE.docMode = 'idle';
    log(`已按所选类型筛选文档: ${newDocs.length} 个文件`);
  }

  // ========== 渲染详细诊断信息 ==========
  function renderDetailsHtml() {
    const stats = STATE.scanStats;
    let html = '<div style="margin-top:8px;font-size:11px;opacity:0.85;max-height:300px;overflow-y:auto;border:1px solid rgba(255,255,255,0.15);padding:8px;border-radius:4px;">';

    if (stats.failedDirs.length > 0) {
      html += '<div style="color:#e74c3c;font-weight:bold;margin-bottom:4px;">⚠️ 扫描失败的目录：</div>';
      for (const fd of stats.failedDirs) {
        html += `<div style="color:#e74c3c;">  ❌ ${fd.path} (重试${fd.retries}次: ${fd.error})</div>`;
      }
      html += '<hr style="border-color:rgba(255,255,255,0.15);margin:6px 0;">';
    }

    html += '<div style="font-weight:bold;margin-bottom:4px;">📁 各目录详情：</div>';
    for (const dir of stats.dirDetails) {
      const shortPath = dir.path.length > 60 ? '...' + dir.path.substring(dir.path.length - 57) : dir.path;
      html += `<div style="margin-bottom:3px;">`;
      html += `<div style="color:#aaa;">📂 ${shortPath}</div>`;
      html += `<div style="padding-left:12px;">总文件: ${dir.totalFiles}, 视频: <span style="color:#2ea0a3;">${dir.videos}</span>, 非视频: <span style="color:#f39c12;">${dir.nonVideos}</span></div>`;
      if (dir.nonVideoNames.length > 0) {
        html += '<div style="padding-left:12px;font-size:10px;opacity:0.7;">非视频文件：</div>';
        for (const nv of dir.nonVideoNames) {
          html += `<div style="padding-left:24px;font-size:10px;opacity:0.6;">📎 ${nv}</div>`;
        }
      }
      html += `</div>`;
    }

    if (stats.nonVideoFiles.length > 0) {
      html += '<hr style="border-color:rgba(255,255,255,0.15);margin:6px 0;">';
      html += `<div style="font-weight:bold;margin-bottom:4px;">📎 全部非视频文件 (${stats.nonVideoFiles.length})：</div>`;
      const extMap = {};
      for (const nvf of stats.nonVideoFiles) {
        const ext = nvf.ext || '(无扩展名)';
        if (!extMap[ext]) extMap[ext] = [];
        extMap[ext].push(nvf);
      }
      for (const ext of Object.keys(extMap).sort()) {
        const list = extMap[ext];
        const isSelected = STATE.selectedDocTypes.has(ext);
        html += `<div style="margin-bottom:3px;"><b style="color:${isSelected ? '#e67e22' : '#f39c12'};">.${ext}</b> (${list.length}个)${isSelected ? ' ✅' : ''}</div>`;
        for (const nvf of list.slice(0, 3)) {
          const shortDir = nvf.dir.length > 40 ? '...' + nvf.dir.substring(nvf.dir.length - 37) : nvf.dir;
          html += `<div style="padding-left:12px;font-size:10px;opacity:0.6;">${nvf.name} <span style="opacity:0.5;">@ ${shortDir}</span></div>`;
        }
        if (list.length > 3) {
          html += `<div style="padding-left:12px;font-size:10px;opacity:0.4;">... 还有 ${list.length - 3} 个</div>`;
        }
      }
    }

    html += '</div>';
    return html;
  }

  function updatePanel() {
    if (panelEl) renderPanel();
  }

  // ========== 渲染失败视频列表 ==========
  function renderFailedHtml() {
    if (STATE.totalFailed === 0) return '';
    const failedVideos = STATE.videos.filter(v => v.status === 'failed');
    return `
      <div style="margin-top:6px;">
        <button id="__batch_retry_failed__" style="
          background:rgba(200,50,50,0.3);color:#fff;border:1px solid rgba(200,50,50,0.5);
          padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;
        ">🔁 重试失败 (${failedVideos.length})</button>
      </div>
    `;
  }

  // ========== 重试失败视频 ==========
  function retryFailedVideos() {
    const failedIndices = [];
    STATE.videos.forEach((v, i) => {
      if (v.status === 'failed') failedIndices.push(i);
    });
    if (failedIndices.length === 0) {
      log('没有失败的视频可重试');
      return;
    }
    // 重置失败视频状态
    failedIndices.forEach(i => {
      STATE.videos[i].status = 'pending';
    });
    STATE.totalFailed = 0;
    STATE.currentIndex = failedIndices[0];
    STATE.enabled = true;
    STATE.paused = false;
    log(`🔁 重试 ${failedIndices.length} 个失败视频`);
    updatePanel();
    scheduleNext();
    startPolling();
  }

  // ========== 发送下载文档消息给 background ==========
  function triggerDocDownload(fs_id, filename) {
    return new Promise((resolve) => {
      log('  [调试] 请求下载: ' + filename);
      chrome.runtime.sendMessage(
        { action: 'downloadPDF', fs_id, filename },
        (response) => {
          if (chrome.runtime.lastError) {
            log('  [调试] 错误: ' + chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          if (response?.ok) {
            log('  [调试] 下载已触发(id=' + response.downloadId + ')');
            resolve(true);
          } else {
            log('  [调试] 失败: ' + (response?.error || 'unknown') + (response?.debug ? ' (' + response.debug + ')' : ''));
            resolve(false);
          }
        }
      );
    });
  }

  // ========== 下载单个文档 ==========
  async function downloadSingleDoc(docInfo, delayMs = 1000) {
    const { name, fs_id, relPath } = docInfo;
    const displayName = relPath ? relPath + '/' + name : name;
    STATE.docsCurrentName = displayName.length > 55 ? displayName.substring(0, 52) + '...' : displayName;
    updatePanel();

    const ok = await triggerDocDownload(fs_id, displayName);
    STATE.docsCurrentName = '';
    log((ok ? '✅ ' : '❌ ') + displayName);

    // 串行下载，每个文件间隔延迟
    if (ok) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    return ok;
  }

  // ========== 批量下载文档 ==========
  async function startDocDownload() {
    if (STATE.docMode === 'downloading') return;

    // 如果还没扫描，先扫描
    if (STATE.scanStats.totalDirs === 0) {
      await doScan();
    }

    if (STATE.docs.length === 0) {
      log('❌ 没有可下载的文档，请先扫描或选择文件类型');
      updatePanel();
      return;
    }

    STATE.docMode = 'downloading';
    STATE.docsDone = 0;
    STATE.docsFailed = 0;
    STATE.docsFailList = [];
    STATE.docsCurrentName = '';

    for (const doc of STATE.docs) {
      doc.status = 'pending';
    }

    const total = STATE.docs.length;
    log(`📥 开始批量下载 ${total} 个文档...`);
    updatePanel();

    // 串行下载
    for (let i = 0; i < total; i++) {
      const doc = STATE.docs[i];
      const ok = await downloadSingleDoc(doc, 1000);
      if (ok) {
        doc.status = 'done';
        STATE.docsDone++;
      } else {
        doc.status = 'failed';
        STATE.docsFailed++;
        const failName = (doc.relPath ? doc.relPath + '/' : '') + doc.name;
        STATE.docsFailList.push(failName);
      }
      updatePanel();
    }

    STATE.docMode = 'done';
    STATE.docsCurrentName = '';
    if (STATE.docsFailed > 0) {
      log(`📥 文档下载完成: 成功 ${STATE.docsDone}/${total}，失败 ${STATE.docsFailed}`);
    } else {
      log(`🎉 全部文档下载完成！共 ${STATE.docsDone} 个`);
    }
    updatePanel();
  }

  // ========== 获取当前目录路径 ==========
  function getCurrentDirPath() {
    const hash = window.location.hash;
    const match = hash.match(/path=([^&]+)/);
    if (match) {
      return decodeURIComponent(match[1]);
    }
    return '';
  }

  // ========== 调用百度网盘 API 列出目录内容（支持分页 + 重试） ==========
  async function listDir(dirPath) {
    const maxRetries = 3;
    let lastError = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const allItems = [];
        let page = 1;
        const num = 100; // 每页100条
        let hasMore = true;

        while (hasMore) {
          const resp = await fetch(`https://pan.baidu.com/api/list?order=time&desc=1&showempty=0&web=1&page=${page}&num=${num}&dir=${encodeURIComponent(dirPath)}`);
          const data = await resp.json();
          if (data.errno !== 0) {
            lastError = `errno=${data.errno}`;
            console.error(`[批量导出] API错误 (${dirPath} page=${page}): errno=${data.errno}`);
            if (page === 1) {
              hasMore = false;
              break;
            }
            hasMore = false;
            break;
          }
          const items = data.list || [];
          allItems.push(...items);
          hasMore = items.length === num;
          page++;
        }

        const files = [];
        const dirs = [];
        for (const item of allItems) {
          if (item.isdir === 1 || item.isdir === true) {
            dirs.push({ name: item.server_filename, path: item.path, fs_id: item.fs_id });
          } else {
            files.push({ name: item.server_filename, path: item.path, fs_id: item.fs_id, size: item.size });
          }
        }
        return { files, dirs, error: null };
      } catch (e) {
        lastError = e.message;
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return { files: [], dirs: [], error: lastError };
  }

  // ========== 优化后的递归扫描（并行获取子目录） ==========
  async function scanAllVideos(rootPath) {
    const allVideos = [];
    const visited = new Set();
    const stats = STATE.scanStats;

    stats.totalDirs = 0;
    stats.totalFiles = 0;
    stats.totalVideos = 0;
    stats.totalNonVideos = 0;
    stats.failedDirs = [];
    stats.nonVideoFiles = [];
    stats.dirDetails = [];

    // 并行扫描目录（批量控制并发数）
    const PARALLEL_BATCH = 5; // 每批并行5个目录

    async function scan(dirPath) {
      if (visited.has(dirPath)) return;
      visited.add(dirPath);
      stats.totalDirs++;

      const shortDir = dirPath.length > 50 ? '...' + dirPath.substring(dirPath.length - 47) : dirPath;
      STATE.scanProgress = `扫描${stats.totalDirs}个目录 (${stats.totalVideos}视频/${stats.totalFiles}文件): ${shortDir}`;
      updatePanel();

      const result = await listDir(dirPath);
      const { files, dirs, error } = result;

      const dirDetail = {
        path: dirPath, totalFiles: files.length,
        videos: 0, nonVideos: 0, nonVideoNames: [],
      };

      if (error) {
        stats.failedDirs.push({ path: dirPath, error, retries: 3 });
        stats.dirDetails.push(dirDetail);
        return;
      }

      // 计算相对路径
      let relPath = '';
      if (dirPath.startsWith(rootPath)) {
        relPath = dirPath.substring(rootPath.length).replace(/^\//, '');
      } else {
        relPath = dirPath.split('/').pop();
      }

      // 分类处理文件
      for (const f of files) {
        stats.totalFiles++;
        const ext = getExt(f.name);

        if (isVideoFile(f.name)) {
          if (ext === 'mp4') {
            allVideos.push({ name: f.name, path: f.path, fs_id: f.fs_id, relPath, status: 'pending' });
            stats.totalVideos++;
            dirDetail.videos++;
          } else {
            stats.totalVideos++;
            dirDetail.videos++;
            stats.nonVideoFiles.push({ name: f.name, dir: relPath || '(根目录)', ext, fs_id: f.fs_id, size: f.size });
            dirDetail.nonVideoNames.push(f.name);
            dirDetail.nonVideos++;
            stats.totalNonVideos++;
          }
        } else {
          // 非视频文件 → 收集到 nonVideoFiles，后续按选中类型筛选为文档
          stats.nonVideoFiles.push({ name: f.name, dir: relPath || '(根目录)', ext, fs_id: f.fs_id, size: f.size });
          dirDetail.nonVideos++;
          dirDetail.nonVideoNames.push(f.name);
          stats.totalNonVideos++;
        }
      }

      stats.dirDetails.push(dirDetail);

      // 收集子目录用于并行扫描
      if (dirs.length > 0) {
        const subQueue = dirs.map(d => d.path);

        // 分批并行处理子目录
        for (let i = 0; i < subQueue.length; i += PARALLEL_BATCH) {
          const batch = subQueue.slice(i, i + PARALLEL_BATCH);
          await Promise.all(batch.map(p => scan(p)));
        }
      }
    }

    await scan(rootPath);
    STATE.scanProgress = '';
    return allVideos;
  }

  // ========== 打开视频播放页（后台标签页，不切换焦点）==========
  function openVideoTab(videoIndex) {
    const video = STATE.videos[videoIndex];
    if (!video) return false;

    const url = `https://pan.baidu.com/pfile/video?path=${encodeURIComponent(video.path)}&fid=${video.fs_id}&relPath=${encodeURIComponent(video.relPath || '')}`;
    console.log('[BatchPanel] openVideoTab, index:', videoIndex, 'url:', url);

    // 使用 chrome.tabs.create 在后台打开标签页，不切换焦点
    chrome.tabs.create({ url, active: false }, (newTab) => {
      if (newTab && !chrome.runtime.lastError) {
        STATE.activeTabs.push({ tabId: newTab.id, videoIndex, openedAt: Date.now() });
        video.status = 'opened';
        log(`📂 打开: ${video.relPath ? video.relPath + '/' : ''}${video.name}`);
      } else {
        log(`❌ 无法打开标签页: ${video.name}`);
        video.status = 'skip';
        STATE.totalSkip++;
        updatePanel();
      }
    });
    return true;
  }

  // ========== 接收视频页面的结果通知 ==========
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'subtitle_export_result') return;
    const { status, url } = event.data;
    const tab = STATE.activeTabs.find(t => {
      const v = STATE.videos[t.videoIndex];
      return v && (url.includes(`fid=${v.fs_id}`) || url.includes(`path=${encodeURIComponent(v.path)}`));
    });
    if (!tab) return;
    const v = STATE.videos[tab.videoIndex];
    if (!v) return;

    if (status === 'success') {
      v.status = 'done';
      STATE.totalDone++;
      log(`✅ 完成: ${v.name}`);
    } else if (status === 'failed') {
      v.status = 'failed';
      STATE.totalFailed++;
      log(`❌ 失败: ${v.name}（找不到文稿按钮）`);
    } else if (status === 'skip') {
      v.status = 'skip';
      STATE.totalSkip++;
      log(`⏭ 跳过: ${v.name}`);
    }
    updatePanel();
  });

  // ========== 轮询检测标签页关闭（通过 chrome.tabs.get 检查）==========
  function startPolling() {
    if (STATE.pollTimer) return;
    STATE.pollTimer = setInterval(async () => {
      if (!STATE.enabled) {
        stopPolling();
        return;
      }

      const stillOpen = [];
      for (const t of STATE.activeTabs) {
        if (t.tabId) {
          try {
            await new Promise(resolve => {
              chrome.tabs.get(t.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                  // 标签页已关闭
                  const v = STATE.videos[t.videoIndex];
                  if (v && v.status === 'opened') {
                    v.status = 'done';
                    STATE.totalDone++;
                    log(`✅ 完成: ${v.name}`);
                  }
                  resolve(false);
                } else {
                  stillOpen.push(t);
                  resolve(true);
                }
              });
            });
          } catch (e) {
            // 忽略错误
          }
        } else {
          // 兼容旧版 win 对象
          try {
            if (t.win && t.win.closed) {
              const v = STATE.videos[t.videoIndex];
              if (v && v.status === 'opened') {
                v.status = 'done';
                STATE.totalDone++;
                log(`✅ 完成: ${v.name}`);
              }
            } else {
              stillOpen.push(t);
            }
          } catch (e) {
            stillOpen.push(t);
          }
        }
      }

      STATE.activeTabs = stillOpen;
      updatePanel();

      if (!STATE.paused) {
        scheduleNext();
      }

      if (STATE.currentIndex >= STATE.videos.length && STATE.activeTabs.length === 0) {
        log(`🎉 全部完成！导出 ${STATE.totalDone} 个，失败 ${STATE.totalFailed} 个，跳过 ${STATE.totalSkip} 个`);
        STATE.enabled = false;
        STATE.paused = false;
        stopPolling();
        updatePanel();
      }
    }, 2000);
  }

  function stopPolling() {
    if (STATE.pollTimer) {
      clearInterval(STATE.pollTimer);
      STATE.pollTimer = null;
    }
  }

  // ========== 调度下一个视频 ==========
  function scheduleNext() {
    if (!STATE.enabled || STATE.paused) return;
    // 使用用户设置的并发数
    STATE.maxConcurrent = STATE.userConcurrency;
    while (STATE.activeTabs.length < STATE.maxConcurrent && STATE.currentIndex < STATE.videos.length) {
      openVideoTab(STATE.currentIndex);
      STATE.currentIndex++;
    }
    updatePanel();
  }

  // ========== 纯扫描（不启动导出，只收集文件列表） ==========
  async function doScan() {
    if (STATE.scanning) return;
    console.log('[BatchPanel] doScan 开始, currentDir:', getCurrentDirPath());

    const currentDir = getCurrentDirPath();
    if (!currentDir) {
      log('❌ 无法获取当前目录路径');
      updatePanel();
      return;
    }

    // 重置所有状态
    STATE.rootDir = currentDir;
    STATE.scanning = true;
    STATE.videos = [];
    STATE.docs = [];
    STATE.currentIndex = 0;
    STATE.activeTabs = [];
    STATE.totalDone = 0;
    STATE.totalSkip = 0;
    STATE.totalFailed = 0;
    STATE.enabled = false;
    STATE.paused = false;
    STATE.docMode = 'idle';
    STATE.docsDone = 0;
    STATE.docsFailed = 0;
    STATE.docsFailList = [];
    STATE.docsCurrentName = '';
    STATE.showDetails = false;
    STATE.showDocTypes = false;

    log(`📋 开始递归扫描: ${currentDir}`);
    updatePanel();

    const videos = await scanAllVideos(currentDir);
    STATE.scanning = false;

    videos.sort((a, b) => {
      const pa = (a.relPath + '/' + a.name).toLowerCase();
      const pb = (b.relPath + '/' + b.name).toLowerCase();
      return pa.localeCompare(pb, 'zh-CN');
    });
    STATE.videos = videos;

    // 扫描完成后，根据选中类型收集文档
    const docs = [];
    for (const f of STATE.scanStats.nonVideoFiles) {
      if (STATE.selectedDocTypes.has(f.ext)) {
        docs.push({
          name: f.name, path: f.path, fs_id: f.fs_id,
          relPath: f.dir === '(根目录)' ? '' : f.dir,
          size: f.size || 0, status: 'pending', ext: f.ext,
        });
      }
    }
    STATE.docs = docs;
    STATE.docsTotal = docs.length;

    const docCount = STATE.docs.length;
    console.log('[BatchPanel] 扫描完成, videos:', STATE.videos.length, 'docs:', STATE.docs.length, 'scanStats:', STATE.scanStats);
    log(`🔍 扫描完成：${STATE.scanStats.totalDirs}个目录, ${STATE.scanStats.totalFiles}个文件, ${STATE.scanStats.totalVideos}个视频, ${docCount}个文档`);

    if (STATE.scanStats.totalVideos === 0 && docCount === 0) {
      log('❌ 未找到任何视频或文档文件');
    }
    updatePanel();
  }

  // ========== 视频字幕导出开关（暂停/继续） ==========
  window.__toggleVideoExport = function toggleVideoExport() {
    console.log('[BatchPanel] toggleVideoExport called', {
      videoCount: STATE.videos.length,
      enabled: STATE.enabled,
      paused: STATE.paused,
      scanStats: STATE.scanStats,
      rootDir: STATE.rootDir,
    });
    if (STATE.videos.length === 0) {
      log('❌ 未找到任何视频文件，请先扫描目录');
      return;
    }

    if (STATE.enabled) {
      // 正在运行 → 切换暂停/继续
      STATE.paused = !STATE.paused;
      if (STATE.paused) {
        log('⏸ 导出已暂停（标签页保持打开）');
      } else {
        log('▶ 继续导出');
        scheduleNext();
        startPolling();
      }
      updatePanel();
    } else {
      // 未运行 → 启动
      STATE.enabled = true;
      STATE.paused = false;
      STATE.currentIndex = 0;
      STATE.activeTabs = [];
      STATE.totalDone = 0;
      STATE.totalSkip = 0;
      STATE.totalFailed = 0;

      for (const v of STATE.videos) {
        v.status = 'pending';
      }

      log(`🎬 开始导出视频字幕: ${STATE.videos.length} 个视频（并发${STATE.userConcurrency}）`);
      updatePanel();
      scheduleNext();
      startPolling();
    }
  }

  // ========== 初始化 ==========
  function init() {
    const hash = window.location.hash;
    if (!hash.includes('path=')) return;

    chrome.storage.local.get('batchEnabled', (result) => {
      if (result.batchEnabled === false) return;
      createPanel();
    });
  }

  setTimeout(init, 2000);

  let lastHash = window.location.hash;
  setInterval(() => {
    if (window.location.hash !== lastHash) {
      lastHash = window.location.hash;
      if (lastHash.includes('path=') && !panelEl) {
        setTimeout(init, 1000);
      }
    }
  }, 2000);
})();
