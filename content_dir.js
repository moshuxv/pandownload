// content_dir.js — 注入到百度网盘目录页
// 在页面右上角添加批量控制面板，自动递归扫描所有子目录的视频文件
// 逐个打开视频播放页，保持最多5个并发标签页
// v2.1: 递归扫描 + 完整诊断信息（总文件/视频/非视频分类）+ API分页 + 失败重试

(function () {
  'use strict';

  if (window.__BaiduPanBatchController__) return;
  window.__BaiduPanBatchController__ = true;

  const STATE = {
    enabled: false,
    videos: [],          // [{name, path, fs_id, relPath, status}]
    currentIndex: 0,
    activeTabs: [],
    maxConcurrent: 5,
    totalDone: 0,
    totalSkip: 0,
    totalFailed: 0,     // 失败计数（找不到文稿按钮等）
    pollTimer: null,
    rootDir: '',         // 启动批量导出时的根目录（用于计算相对路径）
    scanning: false,
    scanProgress: '',
    // 诊断信息
    scanStats: {
      totalDirs: 0,        // 扫描的目录总数
      totalFiles: 0,       // 所有文件总数（含视频和非视频）
      totalVideos: 0,      // 视频文件数
      totalNonVideos: 0,   // 非视频文件数
      failedDirs: [],      // 扫描失败的目录 [{path, error, retries}]
      nonVideoFiles: [],   // 非视频文件列表 [{name, dir, ext}]
      dirDetails: [],      // 每个目录的详细信息 [{path, totalFiles, videos, nonVideos, nonVideoNames}]
    },
    showDetails: false,    // 是否显示详细诊断信息
    showFailed: false,     // 是否显示失败视频列表
    // === PDF 下载相关 ===
    pdfs: [],              // [{name, path, fs_id, relPath, size, status}]
    pdfMode: 'idle',       // 'idle' | 'scanning' | 'downloading' | 'done'
    pdfsTotal: 0,
    pdfsDone: 0,
    pdfsFailed: 0,
    pdfsFailList: [],      // 下载失败的PDF列表
    pdfCurrentName: '',    // 当前正在下载的PDF名称
  };

  function log(msg) {
    console.log(`[批量导出] ${msg}`);
    updatePanel();
  }

  // ========== 浮动控制面板 ==========
  let panelEl = null;

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
      padding: 16px 20px;
      border-radius: 10px;
      font-size: 13px;
      font-family: -apple-system, "Microsoft YaHei", sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
      min-width: 460px;
      max-width: 620px;
      max-height: 85vh;
      overflow-y: auto;
      line-height: 1.6;
    `;
    document.documentElement.appendChild(panelEl);
    renderPanel();
  }

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
      ? `<div style="margin-top:4px;font-size:12px;opacity:0.8;color:#f39c12;">🔄 ${STATE.scanProgress}</div>`
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
    if (isVideoRunning) {
      videoBtnText = '⏹ 停止导出';
      videoBtnColor = '#e74c3c';
    } else if (videoProcessing > 0 && !isVideoRunning) {
      videoBtnText = '▶ 继续导出';
      videoBtnColor = '#2ea0a3';
    }

    // ===== PDF下载按钮 =====
    const pdfTotal = STATE.pdfs.length;
    const isPDFDownloading = STATE.pdfMode === 'downloading';
    const isPDFDone = STATE.pdfMode === 'done';
    const pdfProgress = pdfTotal > 0 ? Math.round((STATE.pdfsDone / pdfTotal) * 100) : 0;
    const pdfRemaining = pdfTotal - STATE.pdfsDone - STATE.pdfsFailed;

    let pdfBtnText = '📕 下载PDF文档';
    let pdfBtnColor = '#e67e22';
    let pdfBtnDisabled = '';
    if (isPDFDownloading) {
      pdfBtnText = '⏳ 下载中...';
      pdfBtnColor = '#c0392b';
      pdfBtnDisabled = 'disabled';
    } else if (isPDFDone && STATE.pdfsFailed > 0) {
      pdfBtnText = '🔁 重新下载PDF';
      pdfBtnColor = '#e67e22';
    } else if (isPDFDone) {
      pdfBtnText = '✅ PDF下载完成';
      pdfBtnColor = '#27ae60';
    }

    // ===== 组装HTML =====
    let html = '';
    html += `<div style="font-weight:bold;font-size:15px;margin-bottom:10px;">📂 百度网盘文件批量处理 v3.0</div>`;

    // 扫描按钮行
    html += `<div style="margin-bottom:10px;">`;
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

    // 两个操作按钮（扫描完成才显示）
    if (hasScanned) {
      // 分隔线
      html += `<div style="border-top:1px solid rgba(255,255,255,0.2);margin:8px 0;padding-top:8px;">`;

      // ===== 视频字幕导出区域 =====
      html += `<div style="margin-bottom:10px;">`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">`;
      html += `<span style="font-weight:bold;">🎬 视频字幕</span>`;
      html += `<span style="font-size:12px;opacity:0.7;">${videoTotal} 个视频</span>`;
      html += `</div>`;
      html += `<button id="__batch_video_btn__" style="
        background:${videoBtnColor};color:#fff;border:none;padding:8px 18px;
        border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;
      ">${videoBtnText}</button>`;

      // 视频进度
      if (videoProcessing > 0) {
        html += `<div style="margin-top:6px;">`;
        html += `<div style="font-size:11px;opacity:0.85;">`;
        html += `✅ ${videoDone} ❌ ${videoFailed} ⏭ ${videoSkip} 📄活跃 ${videoActive} ⏳剩 ${videoRemaining}`;
        html += `</div>`;
        html += `<div style="margin-top:2px;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;">`;
        html += `<div style="height:100%;width:${videoProgress}%;background:#2ea0a3;border-radius:2px;transition:width 0.3s;"></div>`;
        html += `</div>`;
        html += `</div>`;
      }

      // 正在进行中的标签页
      if (STATE.activeTabs.length > 0) {
        html += `<div style="margin-top:4px;font-size:11px;opacity:0.7;">`;
        for (const t of STATE.activeTabs) {
          const v = STATE.videos[t.videoIndex];
          if (v) {
            const sn = v.name.length > 35 ? v.name.substring(0, 32) + '...' : v.name;
            const el = Math.round((Date.now() - t.openedAt) / 1000);
            html += `<div>  ⏳ ${sn} (${el}s)</div>`;
          }
        }
        html += `</div>`;
      }
      html += `</div>`;

      // ===== PDF下载区域 =====
      html += `<div style="border-top:1px solid rgba(255,255,255,0.15);padding-top:8px;">`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">`;
      html += `<span style="font-weight:bold;">📕 PDF文档</span>`;
      html += `<span style="font-size:12px;opacity:0.7;">${pdfTotal} 个PDF</span>`;
      html += `</div>`;
      html += `<button id="__batch_pdf_btn__" style="
        background:${pdfBtnColor};color:#fff;border:none;padding:8px 18px;
        border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;
      " ${pdfBtnDisabled}>${pdfBtnText}</button>`;

      // PDF进度
      if (isPDFDownloading || isPDFDone) {
        html += `<div style="margin-top:6px;">`;
        html += `<div style="font-size:11px;opacity:0.85;">`;
        html += `✅ ${STATE.pdfsDone} ❌ ${STATE.pdfsFailed} ⏳剩 ${pdfRemaining} 📊 ${pdfProgress}%`;
        html += `</div>`;
        if (STATE.pdfCurrentName) {
          html += `<div style="font-size:10px;opacity:0.5;margin-top:2px;">📥 ${STATE.pdfCurrentName}</div>`;
        }
        html += `<div style="margin-top:2px;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;">`;
        html += `<div style="height:100%;width:${pdfProgress}%;background:#e67e22;border-radius:2px;transition:width 0.3s;"></div>`;
        html += `</div>`;
        html += `</div>`;
      }

      // PDF失败列表
      if (STATE.pdfsFailList.length > 0 && !isPDFDownloading) {
        html += `<div style="margin-top:4px;font-size:11px;opacity:0.75;max-height:100px;overflow-y:auto;">`;
        html += `<div style="color:#e74c3c;">失败 (${STATE.pdfsFailList.length})：</div>`;
        for (const f of STATE.pdfsFailList.slice(-8)) {
          html += `<div style="padding-left:6px;">  ❌ ${f}</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;

      // ===== 扫描统计 =====
      const stats = STATE.scanStats;
      html += `<div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.2);padding-top:8px;">`;
      html += `<div style="font-weight:bold;margin-bottom:4px;">📊 扫描统计</div>`;
      html += `<div style="font-size:11px;opacity:0.85;">`;
      html += `📁目录 <b>${stats.totalDirs}</b> 📄文件 <b>${stats.totalFiles}</b> 🎬视频 <b style="color:#2ea0a3;">${stats.totalVideos}</b> 📕PDF <b style="color:#e74c3c;">${pdfTotal}</b>`;
      html += `</div>`;
      if (stats.failedDirs.length > 0) {
        html += `<div style="font-size:11px;color:#e74c3c;margin-top:2px;">⚠️ ${stats.failedDirs.length} 个目录扫描失败</div>`;
      }
      html += `<div style="margin-top:4px;">`;
      html += `<button id="__batch_toggle_details__" style="
        background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);
        padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;
      ">${STATE.showDetails ? '隐藏' : '显示'}详细信息</button>`;
      html += `</div>`;
      if (STATE.showDetails) html += renderDetailsHtml();
      html += `</div>`;

      // 视频失败列表
      html += renderFailedHtml();
    }

    if (!hasScanned && !STATE.scanning) {
      html += `<div style="margin-top:6px;font-size:12px;opacity:0.5;">点击"扫描目录"分析当前文件夹及子文件夹中的所有文件</div>`;
    }

    html += `<div style="margin-top:8px;font-size:10px;opacity:0.4;">v3.0 · 最多${STATE.maxConcurrent}个视频并发 · 3个PDF并发</div>`;

    panelEl.innerHTML = html;

    // ===== 绑定事件 =====
    const scanBtn = panelEl.querySelector('#__batch_scan_btn__');
    if (scanBtn) scanBtn.addEventListener('click', doScan);

    const videoBtn = panelEl.querySelector('#__batch_video_btn__');
    if (videoBtn) videoBtn.addEventListener('click', toggleVideoExport);

    const pdfBtn = panelEl.querySelector('#__batch_pdf_btn__');
    if (pdfBtn) pdfBtn.addEventListener('click', startPDFDownload);

    const detailBtn = panelEl.querySelector('#__batch_toggle_details__');
    if (detailBtn) {
      detailBtn.addEventListener('click', () => {
        STATE.showDetails = !STATE.showDetails;
        renderPanel();
      });
    }

    const retryBtn = panelEl.querySelector('#__batch_retry_failed__');
    if (retryBtn) retryBtn.addEventListener('click', retryFailedVideos);
  }

  // ========== 渲染详细诊断信息 ==========
  function renderDetailsHtml() {
    const stats = STATE.scanStats;
    let html = '<div style="margin-top:8px;font-size:11px;opacity:0.85;max-height:300px;overflow-y:auto;border:1px solid rgba(255,255,255,0.15);padding:8px;border-radius:4px;">';

    // 失败目录
    if (stats.failedDirs.length > 0) {
      html += '<div style="color:#e74c3c;font-weight:bold;margin-bottom:4px;">⚠️ 扫描失败的目录：</div>';
      for (const fd of stats.failedDirs) {
        html += `<div style="color:#e74c3c;">  ❌ ${fd.path} (重试${fd.retries}次: ${fd.error})</div>`;
      }
      html += '<hr style="border-color:rgba(255,255,255,0.15);margin:6px 0;">';
    }

    // 每个目录的详情
    html += '<div style="font-weight:bold;margin-bottom:4px;">📁 各目录详情：</div>';
    for (const dir of stats.dirDetails) {
      const shortPath = dir.path.length > 60 ? '...' + dir.path.substring(dir.path.length - 57) : dir.path;
      html += `<div style="margin-bottom:3px;">`;
      html += `<div style="color:#aaa;">📂 ${shortPath}</div>`;
      html += `<div style="padding-left:12px;">总文件: ${dir.totalFiles}, 视频: <span style="color:#2ea0a3;">${dir.videos}</span>, 非视频: <span style="color:#f39c12;">${dir.nonVideos}</span></div>`;
      // 列出非视频文件
      if (dir.nonVideoNames.length > 0) {
        html += '<div style="padding-left:12px;font-size:10px;opacity:0.7;">非视频文件：</div>';
        for (const nv of dir.nonVideoNames) {
          html += `<div style="padding-left:24px;font-size:10px;opacity:0.6;">📎 ${nv}</div>`;
        }
      }
      html += `</div>`;
    }

    // 非视频文件汇总
    if (stats.nonVideoFiles.length > 0) {
      html += '<hr style="border-color:rgba(255,255,255,0.15);margin:6px 0;">';
      html += `<div style="font-weight:bold;margin-bottom:4px;">📎 全部非视频文件 (${stats.nonVideoFiles.length})：</div>`;
      // 按扩展名分组统计
      const extMap = {};
      for (const nvf of stats.nonVideoFiles) {
        const ext = nvf.ext || '(无扩展名)';
        if (!extMap[ext]) extMap[ext] = [];
        extMap[ext].push(nvf);
      }
      for (const ext of Object.keys(extMap).sort()) {
        const list = extMap[ext];
        html += `<div style="margin-bottom:3px;"><b style="color:#f39c12;">.${ext}</b> (${list.length}个)</div>`;
        for (const nvf of list) {
          const shortDir = nvf.dir.length > 40 ? '...' + nvf.dir.substring(nvf.dir.length - 37) : nvf.dir;
          html += `<div style="padding-left:12px;font-size:10px;opacity:0.6;">${nvf.name} <span style="opacity:0.5;">@ ${shortDir}</span></div>`;
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
    const failedVideos = STATE.videos.filter(v => v.status === 'failed');
    if (failedVideos.length === 0) return '';

    let html = `
      <div style="margin-top:10px;border-top:1px solid rgba(231,76,60,0.4);padding-top:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-weight:bold;color:#e74c3c;">❌ 失败的视频 (${failedVideos.length})：</span>
          <button id="__batch_retry_failed__" style="
            background:#e67e22;color:#fff;border:none;padding:4px 12px;
            border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;
          ">🔁 一键重新打开</button>
        </div>
    `;

    for (let i = 0; i < failedVideos.length; i++) {
      const v = failedVideos[i];
      const shortPath = (v.relPath ? v.relPath + '/' : '') + v.name;
      const displayName = shortPath.length > 55 ? '...' + shortPath.substring(shortPath.length - 52) : shortPath;
      html += `<div style="font-size:11px;opacity:0.75;padding-left:8px;">  ${i + 1}. ${displayName}</div>`;
    }

    html += '</div>';
    return html;
  }

  // ========== 一键重新打开失败视频 ==========
  function retryFailedVideos() {
    const failedVideos = STATE.videos.filter(v => v.status === 'failed');
    if (failedVideos.length === 0) return;

    // 重置失败视频状态为 pending
    for (const v of failedVideos) {
      v.status = 'pending';
    }
    STATE.totalFailed = 0;

    // 将失败视频重新排到队列前面
    // 找到所有 pending 的视频，把失败的放前面
    const stillPending = STATE.videos.filter(v => v.status === 'pending' && !failedVideos.includes(v));
    const newOrder = [...failedVideos, ...stillPending];
    // 重建 videos 数组：已完成的保持原位，新的 pending 排在后面
    const completed = STATE.videos.filter(v => v.status !== 'pending');
    STATE.videos = [...completed, ...newOrder];
    STATE.currentIndex = completed.length;

    // 如果批量导出已停止，重新启动
    if (!STATE.enabled) {
      STATE.enabled = true;
      log(`🔁 重新打开 ${failedVideos.length} 个失败视频...`);
      scheduleNext();
      startPolling();
    } else {
      log(`🔁 将 ${failedVideos.length} 个失败视频加入队列...`);
      scheduleNext();
    }
    updatePanel();
  }

  // ========== 获取 bdstoken（百度网盘 CSRF 令牌） ==========
  function getBdstoken() {
    // 从页面上下文中获取 bdstoken
    // 1. yunData 全局变量
    try {
      if (typeof yunData !== 'undefined' && yunData && yunData.MYBDSTOKEN) {
        return yunData.MYBDSTOKEN;
      }
    } catch (e) {}
    // 2. document.cookie
    const match = document.cookie.match(/BDSTOKEN=([^;]+)/);
    if (match) return match[1];
    // 3. 页面 HTML 中的 meta 标签
    const meta = document.querySelector('meta[name="bdstoken"]');
    if (meta) return meta.content;
    // 4. localStorage
    try {
      return localStorage.getItem('bdstoken') || '';
    } catch (e) {}
    return '';
  }

  // ========== 获取 logid（百度网盘请求追踪ID） ==========
  function getLogid() {
    try {
      if (typeof yunData !== 'undefined' && yunData && yunData.LOGID) {
        return yunData.LOGID;
      }
    } catch (e) {}
    // 随机生成一个，格式类似
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return String(arr[0]);
  }

  // ========== 下载单个PDF文件 ==========
  async function downloadSinglePDF(pdfInfo) {
    const { name, fs_id, relPath } = pdfInfo;
    const shortName = name.length > 50 ? name.substring(0, 47) + '...' : name;
    STATE.pdfCurrentName = relPath ? `${relPath}/${shortName}` : shortName;
    updatePanel();

    const bdstoken = getBdstoken();
    if (!bdstoken) {
      log(`❌ PDF下载失败: 无法获取bdstoken - ${name}`);
      return false;
    }

    try {
      // 方法1: 调用百度网盘 filemetas API 获取下载链接
      const metaUrl = `https://pan.baidu.com/api/filemetas?fsids=[${fs_id}]&dlink=1&web=1&bdstoken=${bdstoken}&channel=chunlei&clienttype=0&app_id=250528`;
      const metaResp = await fetch(metaUrl);
      const metaData = await metaResp.json();

      let dlink = '';
      if (metaData.errno === 0 && metaData.info && metaData.info[0]) {
        dlink = metaData.info[0].dlink || '';
      }

      // 方法2: 如果 filemetas 没有返回 dlink，尝试 download API
      if (!dlink) {
        log(`  方法1无dlink，尝试download API...`);
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = await computeDownloadSign(fs_id, timestamp, bdstoken);
        const logid = getLogid();
        const dlUrl = `https://pan.baidu.com/api/download?fs_id=${fs_id}&timestamp=${timestamp}&sign=${sign}&bdstoken=${bdstoken}&channel=chunlei&clienttype=0&web=1&app_id=250528&logid=${logid}`;
        const dlResp = await fetch(dlUrl);
        const dlData = await dlResp.json();
        if (dlData.errno === 0 && dlData.dlink) {
          dlink = dlData.dlink;
        } else {
          log(`  方法2失败: errno=${dlData.errno} errmsg=${dlData.errmsg || ''}`);
        }
      }

      if (!dlink) {
        log(`❌ PDF下载失败: 无法获取下载链接 - ${name}`);
        return false;
      }

      // 构建下载路径（保持文件夹结构）
      let downloadPath = '';
      if (relPath) {
        const safeDir = relPath.split('/').map(s => s.replace(/[<>:"/\\|?*]/g, '_')).join('/');
        downloadPath = safeDir + '/';
      }
      const safeName = name.replace(/[<>:"/\\|?*]/g, '_');
      downloadPath += safeName;

      // 发送到 background 执行下载
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'downloadFile', url: dlink, filename: downloadPath },
          (response) => {
            if (chrome.runtime.lastError) {
              log(`❌ 下载消息发送失败: ${chrome.runtime.lastError.message}`);
              resolve(false);
              return;
            }
            if (response && response.ok) {
              log(`✅ PDF已下载: ${downloadPath}`);
              resolve(true);
            } else {
              log(`❌ PDF下载失败: ${response?.error || '未知错误'} - ${name}`);
              resolve(false);
            }
          }
        );
      });
    } catch (e) {
      log(`❌ PDF下载异常: ${e.message} - ${name}`);
      return false;
    }
  }

  // ========== 计算下载签名 ==========
  async function computeDownloadSign(fs_id, timestamp, bdstoken) {
    // 尝试从页面获取签名种子
    try {
      // 方法a: 使用页面上下文中的 sign 函数
      const signResult = await new Promise((resolve) => {
        const scriptId = '__pdf_sign_helper__';
        // 清理旧脚本
        const old = document.getElementById(scriptId);
        if (old) old.remove();

        const script = document.createElement('script');
        script.id = scriptId;
        script.textContent = `
          (function() {
            try {
              var signVal = '';
              // 尝试调用页面的签名函数
              if (typeof yunData !== 'undefined') {
                var sign1 = yunData.sign1 || '';
                var sign3 = yunData.sign3 || '';
                signVal = sign1 + '_' + sign3;
              }
              window.__pdf_sign_result = signVal;
            } catch(e) {
              window.__pdf_sign_result = '';
            }
          })();
        `;
        document.documentElement.appendChild(script);
        setTimeout(() => {
          const val = window.__pdf_sign_result || '';
          delete window.__pdf_sign_result;
          script.remove();
          resolve(val);
        }, 200);
      });

      if (signResult) {
        return signResult;
      }
    } catch (e) {
      // 忽略
    }

    // 方法b: 用简单方式生成（可能不适用于所有情况）
    // 注意：这只是一个近似值，可能需要页面实际的签名逻辑
    return bdstoken + '_' + timestamp;
  }

  // ========== 批量下载PDF（限制并发数，避免触发反爬） ==========
  // ========== PDF下载（自动扫描如果还未扫描） ==========
  async function startPDFDownload() {
    if (STATE.pdfMode === 'downloading') return;

    // 如果还没扫描，先扫描
    if (STATE.scanStats.totalDirs === 0) {
      await doScan();
    }

    if (STATE.pdfs.length === 0) {
      log('❌ 没有可下载的PDF文档，请先扫描目录');
      return;
    }

    STATE.pdfMode = 'downloading';
    STATE.pdfsDone = 0;
    STATE.pdfsFailed = 0;
    STATE.pdfsFailList = [];
    STATE.pdfCurrentName = '';

    for (const pdf of STATE.pdfs) {
      pdf.status = 'pending';
    }

    const total = STATE.pdfs.length;
    log(`📥 开始批量下载 ${total} 个PDF文档...`);
    updatePanel();

    const concurrency = 3;
    let index = 0;

    async function downloadNext() {
      while (index < total) {
        const pdf = STATE.pdfs[index];
        index++;

        const success = await downloadSinglePDF(pdf);
        if (success) {
          pdf.status = 'done';
          STATE.pdfsDone++;
        } else {
          pdf.status = 'failed';
          STATE.pdfsFailed++;
          const failName = (pdf.relPath ? pdf.relPath + '/' : '') + pdf.name;
          STATE.pdfsFailList.push(failName);
        }
        updatePanel();
      }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(downloadNext());
    }

    await Promise.all(workers);

    STATE.pdfMode = 'done';
    STATE.pdfCurrentName = '';
    if (STATE.pdfsFailed > 0) {
      log(`📥 PDF下载完成: 成功 ${STATE.pdfsDone}/${total}，失败 ${STATE.pdfsFailed}`);
    } else {
      log(`🎉 全部PDF下载完成！共 ${STATE.pdfsDone} 个`);
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

  // ========== 判断是否是PDF文件 ==========
  function isPDFFile(filename) {
    return getExt(filename) === 'pdf';
  }

  // ========== 调用百度网盘 API 列出目录内容（支持分页 + 重试） ==========
  async function listDir(dirPath) {
    const maxRetries = 3;
    let lastError = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const allItems = [];
        let page = 1;
        const num = 200; // 每页最多200条
        let hasMore = true;

        while (hasMore) {
          const resp = await fetch(`https://pan.baidu.com/api/list?order=time&desc=1&showempty=0&web=1&page=${page}&num=${num}&dir=${encodeURIComponent(dirPath)}`);
          const data = await resp.json();
          if (data.errno !== 0) {
            lastError = `errno=${data.errno}`;
            console.error(`[批量导出] API错误 (${dirPath} page=${page}): errno=${data.errno}`);
            // 如果是第一页就出错，认为是目录访问失败
            if (page === 1) {
              hasMore = false;
              break;
            }
            // 后续页出错，用已有数据
            hasMore = false;
            break;
          }
          const items = data.list || [];
          allItems.push(...items);
          // 如果返回数量小于 num，说明没有更多了
          hasMore = items.length === num;
          page++;
        }

        const files = [];
        const dirs = [];
        for (const item of allItems) {
          if (item.isdir === 1 || item.isdir === true) {
            dirs.push({
              name: item.server_filename,
              path: item.path,
              fs_id: item.fs_id,
            });
          } else {
            files.push({
              name: item.server_filename,
              path: item.path,
              fs_id: item.fs_id,
              size: item.size,
            });
          }
        }
        return { files, dirs, error: null };
      } catch (e) {
        lastError = e.message;
        console.error(`[批量导出] 列出目录失败 (${dirPath} attempt=${attempt + 1}):`, e.message);
        // 等待 1 秒后重试
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    return { files: [], dirs: [], error: lastError };
  }

  // ========== 递归扫描所有子目录，收集视频文件 ==========
  async function scanAllVideos(rootPath) {
    const allVideos = [];
    const visited = new Set();  // 防止循环引用
    const stats = STATE.scanStats;
    // 重置统计
    stats.totalDirs = 0;
    stats.totalFiles = 0;
    stats.totalVideos = 0;
    stats.totalNonVideos = 0;
    stats.failedDirs = [];
    stats.nonVideoFiles = [];
    stats.dirDetails = [];

    async function scan(dirPath, depth) {
      if (visited.has(dirPath)) {
        console.log(`[批量导出] 跳过已访问目录: ${dirPath}`);
        return;
      }
      visited.add(dirPath);
      stats.totalDirs++;

      const shortDir = dirPath.length > 50 ? '...' + dirPath.substring(dirPath.length - 47) : dirPath;
      STATE.scanProgress = `扫描第${stats.totalDirs}个目录 (已找到${stats.totalVideos}个视频): ${shortDir}`;
      updatePanel();

      const result = await listDir(dirPath);
      const { files, dirs, error } = result;

      // 记录目录详情
      const dirDetail = {
        path: dirPath,
        totalFiles: files.length,
        videos: 0,
        nonVideos: 0,
        nonVideoNames: [],
      };

      if (error) {
        stats.failedDirs.push({ path: dirPath, error, retries: 3 });
        stats.dirDetails.push(dirDetail);
        return; // 跳过此目录
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
          // 视频文件
          if (ext === 'mp4') {
            // 只有 .mp4 才加入导出队列（其他格式百度网盘不一定能播）
            allVideos.push({
              name: f.name,
              path: f.path,
              fs_id: f.fs_id,
              relPath: relPath,
              status: 'pending',
            });
            stats.totalVideos++;
            dirDetail.videos++;
          } else {
            // 其他视频格式（m4v, mkv 等），也计入视频统计但不导出
            stats.totalVideos++;
            dirDetail.videos++;
            stats.nonVideoFiles.push({
              name: f.name,
              dir: relPath || '(根目录)',
              ext: ext,
            });
            dirDetail.nonVideoNames.push(f.name);
            dirDetail.nonVideos++;
            stats.totalNonVideos++;
          }
        } else {
          // 非视频文件
          stats.totalNonVideos++;
          dirDetail.nonVideos++;
          dirDetail.nonVideoNames.push(f.name);
          stats.nonVideoFiles.push({
            name: f.name,
            dir: relPath || '(根目录)',
            ext: ext,
          });
        }

        // 收集PDF文件（独立于视频统计）
        if (isPDFFile(f.name)) {
          STATE.pdfs.push({
            name: f.name,
            path: f.path,
            fs_id: f.fs_id,
            relPath: relPath,
            size: f.size || 0,
            status: 'pending',
          });
        }
      }

      stats.dirDetails.push(dirDetail);

      // 递归扫描子目录
      for (const d of dirs) {
        await scan(d.path, depth + 1);
      }
    }

    await scan(rootPath, 0);
    STATE.scanProgress = '';
    return allVideos;
  }

  // ========== 打开视频播放页 ==========
  function openVideoTab(videoIndex) {
    const video = STATE.videos[videoIndex];
    if (!video) return false;

    // 在 URL 中附带 relPath 参数，content.js 读取后用于构建下载路径
    const url = `https://pan.baidu.com/pfile/video?path=${encodeURIComponent(video.path)}&fid=${video.fs_id}&relPath=${encodeURIComponent(video.relPath || '')}`;
    const newWin = window.open(url, '_blank');
    if (newWin) {
      STATE.activeTabs.push({
        win: newWin,
        videoIndex: videoIndex,
        openedAt: Date.now(),
      });
      video.status = 'opened';
      log(`📂 打开: ${video.relPath ? video.relPath + '/' : ''}${video.name}`);
      return true;
    } else {
      log(`❌ 无法打开标签页（可能被浏览器拦截）: ${video.name}`);
      video.status = 'skip';
      STATE.totalSkip++;
      return false;
    }
  }

  // ========== 接收视频页面的结果通知 ==========
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'subtitle_export_result') return;
    const { status, url } = event.data;
    // 根据 URL 匹配视频
    const tab = STATE.activeTabs.find(t => {
      const v = STATE.videos[t.videoIndex];
      if (!v) return false;
      // 用 path 和 fs_id 匹配
      return url.includes(`fid=${v.fs_id}`) || url.includes(`path=${encodeURIComponent(v.path)}`);
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

  // ========== 轮询检测标签页关闭 ==========
  function startPolling() {
    if (STATE.pollTimer) return;
    STATE.pollTimer = setInterval(() => {
      if (!STATE.enabled) {
        stopPolling();
        return;
      }

      const stillOpen = [];
      for (const t of STATE.activeTabs) {
        try {
          if (t.win.closed) {
            const v = STATE.videos[t.videoIndex];
            if (v) {
              // 如果状态还是 'opened'，说明没收到 postMessage
              // 可能是成功关闭但消息没送达，也可能是失败关闭
              // 此时保守处理：标记为 done（大多数情况是成功的）
              if (v.status === 'opened') {
                v.status = 'done';
                STATE.totalDone++;
                log(`✅ 完成: ${v.name}`);
              }
              // 如果已经是 done/failed/skip，说明 postMessage 已处理过，不用重复计数
            }
          } else {
            stillOpen.push(t);
          }
        } catch (e) {
          try {
            if (t.win.closed) {
              const v = STATE.videos[t.videoIndex];
              if (v && v.status === 'opened') {
                v.status = 'done';
                STATE.totalDone++;
                log(`✅ 完成: ${v.name}`);
              }
            } else {
              stillOpen.push(t);
            }
          } catch (e2) {
            stillOpen.push(t);
          }
        }
      }

      STATE.activeTabs = stillOpen;
      updatePanel();
      scheduleNext();

      if (STATE.currentIndex >= STATE.videos.length && STATE.activeTabs.length === 0) {
        log(`🎉 全部完成！导出 ${STATE.totalDone} 个，失败 ${STATE.totalFailed} 个，跳过 ${STATE.totalSkip} 个`);
        STATE.enabled = false;
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

  function scheduleNext() {
    if (!STATE.enabled) return;
    while (STATE.activeTabs.length < STATE.maxConcurrent && STATE.currentIndex < STATE.videos.length) {
      const ok = openVideoTab(STATE.currentIndex);
      STATE.currentIndex++;
    }
    updatePanel();
  }

  // ========== 纯扫描（不启动导出，只收集文件列表） ==========
  async function doScan() {
    if (STATE.scanning) return;

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
    STATE.pdfs = [];
    STATE.currentIndex = 0;
    STATE.activeTabs = [];
    STATE.totalDone = 0;
    STATE.totalSkip = 0;
    STATE.totalFailed = 0;
    STATE.enabled = false;
    STATE.pdfMode = 'idle';
    STATE.pdfsDone = 0;
    STATE.pdfsFailed = 0;
    STATE.pdfsFailList = [];
    STATE.pdfCurrentName = '';
    STATE.showDetails = false;

    log(`📋 开始递归扫描: ${currentDir}`);
    updatePanel();

    const videos = await scanAllVideos(currentDir);
    STATE.scanning = false;

    // 按路径排序
    videos.sort((a, b) => {
      const pa = (a.relPath + '/' + a.name).toLowerCase();
      const pb = (b.relPath + '/' + b.name).toLowerCase();
      return pa.localeCompare(pb, 'zh-CN');
    });
    STATE.videos = videos;

    const pdfCount = STATE.pdfs.length;
    log(`🔍 扫描完成：${STATE.scanStats.totalDirs}个目录, ${STATE.scanStats.totalFiles}个文件, ${STATE.scanStats.totalVideos}个视频, ${pdfCount}个PDF`);

    if (STATE.scanStats.totalVideos === 0 && pdfCount === 0) {
      log('❌ 未找到任何视频或PDF文件');
    }
    updatePanel();
  }

  // ========== 视频字幕导出开关 ==========
  function toggleVideoExport() {
    const videoCount = STATE.videos.length;
    if (videoCount === 0) {
      log('❌ 未找到任何视频文件，请先扫描目录');
      return;
    }

    if (STATE.enabled) {
      STATE.enabled = false;
      stopPolling();
      log('⏹ 视频字幕导出已停止');
      updatePanel();
    } else {
      STATE.enabled = true;
      STATE.currentIndex = 0;
      STATE.activeTabs = [];
      STATE.totalDone = 0;
      STATE.totalSkip = 0;
      STATE.totalFailed = 0;

      for (const v of STATE.videos) {
        v.status = 'pending';
      }

      log(`🎬 开始导出视频字幕: ${videoCount} 个视频`);
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
