// content.js — 注入到百度网盘视频播放页
// 自动流程：等待标签栏 → 点击"文稿" → 等待文稿加载 → 提取 DOM 文本 → 触发下载
// v3.1: 成功→关闭标签页，失败→刷新网页重试

(function () {
  'use strict';

  // 防止重复执行
  if (window.__BaiduPanSubtitleAutoExported__) return;
  window.__BaiduPanSubtitleAutoExported__ = true;

  const STATE = {
    log: [],
    done: false,
    success: false,
  };

  function log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    STATE.log.push(`[${t}] ${msg}`);
    console.log(`[字幕自动导出] ${msg}`);
    updatePanel();
  }

  // ========== 浮动状态面板 ==========
  let panelEl = null;
  let statusEl = null;

  function createPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = '__subtitle_auto_panel__';
    panelEl.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      background: rgba(30, 30, 40, 0.95);
      color: #fff;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-family: -apple-system, "Microsoft YaHei", sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      min-width: 260px;
      max-width: 400px;
      line-height: 1.6;
      pointer-events: none;
    `;
    panelEl.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;font-size:14px;">📝 字幕自动导出</div>
      <div id="__subtitle_status__">初始化中...</div>
      <div style="margin-top:6px;font-size:11px;opacity:0.6;">v3.7 成功关闭·失败也关闭</div>
    `;
    document.documentElement.appendChild(panelEl);
    statusEl = panelEl.querySelector('#__subtitle_status__');
  }

  function setPanelColor(state) {
    if (!panelEl) return;
    if (state === 'success') {
      panelEl.style.background = 'rgba(46, 160, 67, 0.95)';
      panelEl.querySelector('div').textContent = '✅ 字幕自动导出';
    } else if (state === 'error') {
      panelEl.style.background = 'rgba(200, 50, 50, 0.95)';
      panelEl.querySelector('div').textContent = '❌ 字幕自动导出';
    } else if (state === 'working') {
      panelEl.style.background = 'rgba(30, 30, 40, 0.95)';
      panelEl.querySelector('div').textContent = '📝 字幕自动导出';
    }
  }

  function updatePanel() {
    if (!statusEl) return;
    const last = STATE.log[STATE.log.length - 1] || '等待中...';
    statusEl.textContent = last;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ========== 查找"文稿"按钮 ==========
  function findDraftButton() {
    const tabs = document.querySelectorAll('div.vp-tabs__header-item');
    for (const tab of tabs) {
      if (tab.textContent.trim() === '文稿') {
        return tab;
      }
    }
    const allDivs = document.querySelectorAll('div');
    let best = null;
    let bestArea = Infinity;
    for (const div of allDivs) {
      if (div.textContent.trim() === '文稿' && div.offsetParent !== null) {
        const r = div.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > 0 && area < bestArea) {
          best = div;
          bestArea = area;
        }
      }
    }
    return best;
  }

  // ========== 获取文稿内容 ==========
  function getDraftText() {
    const wrap = document.querySelector('.ai-draft__wrap-content');
    if (!wrap) return '';
    return wrap.innerText.trim();
  }

  // ========== 从 URL 解析视频文件名 ==========
  function getVideoFilename() {
    try {
      const url = new URL(window.location.href);
      const path = decodeURIComponent(url.searchParams.get('path') || '');
      return path.split('/').pop() || 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  // ========== 从 URL 获取相对路径（由 content_dir.js 传入） ==========
  // relPath 是视频文件相对于批量导出根目录的路径（不含根目录名）
  // 例如：根目录为 "千川扫地僧更多课程FaiJ512"，视频路径为 "千川扫地僧更多课程FaiJ512/11.天诺老吴.../第10节.mp4"
  // 则 relPath = "11.天诺老吴.../第10节.mp4"
  function getRelPath() {
    try {
      const url = new URL(window.location.href);
      return decodeURIComponent(url.searchParams.get('relPath') || '');
    } catch (e) {
      return '';
    }
  }

  // ========== 从 URL 解析视频所在目录名（兼容旧版，无 relPath 时使用） ==========
  function getVideoDirName() {
    try {
      const url = new URL(window.location.href);
      const path = decodeURIComponent(url.searchParams.get('path') || '');
      const parts = path.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return parts[parts.length - 2];
      }
      return '';
    } catch (e) {
      return '';
    }
  }

  // ========== 触发下载（发送到 background.js，在后台上下文中执行 chrome.downloads） ==========
  // background service worker 独立于标签页生命周期，下载不会受标签页关闭影响
  function triggerDownload(filename, subdir, text) {
    return new Promise((resolve) => {
      const fullPath = subdir ? `${subdir}/${filename}` : filename;
      log(`📥 发送下载请求: ${fullPath}`);

      chrome.runtime.sendMessage(
        { action: 'downloadText', text, filename: fullPath },
        (response) => {
          if (chrome.runtime.lastError) {
            log('❌ 发送消息失败: ' + chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          if (response && response.ok) {
            log(`✅ 后台下载已开始: ${fullPath}`);
            resolve(true);
          } else {
            log('❌ 后台下载失败: ' + (response?.error || '未知错误'));
            resolve(false);
          }
        }
      );
    });
  }

  // ========== 关闭/刷新标签页 ==========
  function closeTab() {
    if (STATE.done) return;
    STATE.done = true;
    try {
      chrome.runtime.sendMessage({ action: 'closeTab' });
    } catch (e) {
      log('无法关闭标签页：' + e.message);
    }
  }

  function reloadTab() {
    if (STATE.done) return;
    STATE.done = true;
    try {
      chrome.runtime.sendMessage({ action: 'reloadTab' });
    } catch (e) {
      log('无法刷新标签页：' + e.message);
    }
  }

  // ========== 通知目录页批量控制器 ==========
  function notifyBatchController(status) {
    try {
      // 通过 postMessage 通知目录页（同源窗口直接通信）
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: 'subtitle_export_result',
          status: status, // 'success' | 'failed' | 'skip'
          url: window.location.href,
          timestamp: Date.now(),
        }, '*');
      }
      // 同时通过 storage 通知（备份通道）
      const tabKey = `tab_done_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      chrome.storage.local.set({ [tabKey]: { status, url: window.location.href } });
      // 5秒后清理
      setTimeout(() => {
        try { chrome.storage.local.remove(tabKey); } catch(e) {}
      }, 5000);
    } catch (e) {
      console.log('[字幕自动导出] 通知控制器失败:', e.message);
    }
  }

  // ========== 等待页面加载完成 ==========
  async function waitForPageReady() {
    const maxWait = 120000;
    const interval = 2000;
    const start = Date.now();

    // 步骤1：先等待页面 DOM 和关键资源加载完成
    if (document.readyState !== 'complete') {
      log('等待 document.readyState = complete...');
      await new Promise(resolve => {
        if (document.readyState === 'complete') { resolve(); return; }
        window.addEventListener('load', () => resolve(), { once: true });
        // 超时兜底
        setTimeout(resolve, 30000);
      });
      log('页面 load 事件已触发');
    }

    // 步骤2：等待 React/百度网盘 SPA 初始化（等待主要 DOM 元素出现）
    while (Date.now() - start < maxWait) {
      // 检查标签栏是否出现
      const tabs = document.querySelectorAll('div.vp-tabs__header-item');
      if (tabs.length > 0) {
        log(`页面加载完成（${tabs.length} 个标签）`);
        return true;
      }
      // 检查播放器是否出现（有些视频页面可能没有标签栏）
      const player = document.querySelector('.vp-video-player, .video-player, video, .vp-main');
      if (player) {
        log('播放器/主界面已加载，等待标签栏...');
        await sleep(3000);
        const tabs2 = document.querySelectorAll('div.vp-tabs__header-item');
        if (tabs2.length > 0) {
          log(`页面加载完成（${tabs2.length} 个标签）`);
          return true;
        }
        // 如果有播放器但没有标签栏，再等几秒后重试
        await sleep(5000);
        const tabs3 = document.querySelectorAll('div.vp-tabs__header-item');
        if (tabs3.length > 0) {
          log(`页面加载完成（${tabs3.length} 个标签）`);
          return true;
        }
      }
      log('等待页面加载（已等待 ' + Math.round((Date.now() - start) / 1000) + 's）...');
      await sleep(interval);
    }
    log('页面加载超时（2分钟）');
    return false;
  }

  // ========== 主流程 ==========
  async function main() {
    createPanel();
    setPanelColor('working');
    log('检测到视频播放页，启动自动提取');

    // 检查是否启用
    try {
      const result = await chrome.storage.local.get('enabled');
      if (result.enabled === false) {
        log('自动导出已禁用，跳过');
        setPanelColor('error');
        return;
      }
    } catch (e) {}

    // 步骤0：等待页面充分加载
    const ready = await waitForPageReady();
    if (!ready) {
      log('❌ 页面未加载完成，刷新重试...');
      setPanelColor('error');
      // 不通知控制器，刷新后会重新执行
      await sleep(3000);
      reloadTab();
      return;
    }

    // 步骤1：查找并点击"文稿"按钮（重试5次，每次间隔10秒）
    // 5次仍找不到 → 标记为失败，关闭标签页（由目录页控制器记录到失败列表）
    let draftBtn = null;
    const maxRetries = 5;
    const retryInterval = 10000; // 10秒
    let retryCount = 0;

    while (retryCount < maxRetries) {
      draftBtn = findDraftButton();
      if (draftBtn) break;
      retryCount++;
      if (retryCount < maxRetries) {
        log(`未找到"文稿"按钮，重试 ${retryCount}/${maxRetries}（${retryInterval / 1000}秒后再试）...`);
      } else {
        log(`❌ 已重试 ${maxRetries} 次仍未找到"文稿"按钮，标记为失败`);
      }
      await sleep(retryInterval);
    }

    if (!draftBtn) {
      // 通知目录页控制器：失败（找不到文稿按钮）
      setPanelColor('error');
      log('❌ 失败 — 未找到"文稿"按钮，关闭标签页');
      notifyBatchController('failed');
      await sleep(2000);
      closeTab();
      return;
    }

    // 点击"文稿"按钮（多次点击确保生效）
    log('点击"文稿"按钮');
    for (let i = 0; i < 3; i++) {
      draftBtn.click();
      await sleep(500);
    }

    // 等待文稿面板展开
    await sleep(3000);

    // 步骤2：轮询等待文稿内容加载（最多等 5 分钟）
    log('等待文稿内容加载...');
    let lastLen = 0;
    let stableCount = 0;
    const maxWait = 300000;
    const pollInterval = 3000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const text = getDraftText();
      const len = text.length;

      if (len > lastLen) {
        log(`文稿加载中... ${len} 字符`);
        stableCount = 0;
        lastLen = len;
      } else if (len > 0) {
        stableCount++;
        if (stableCount >= 8) {
          log(`文稿已稳定（${len} 字符）`);
          break;
        }
      } else {
        // 还没出现内容，可能"文稿"按钮点击没生效，重试点击
        if ((Date.now() - startTime) % 15000 < pollInterval) {
          log('文稿内容未出现，重新点击"文稿"按钮...');
          const btn = findDraftButton();
          if (btn) {
            btn.click();
            await sleep(2000);
          }
        } else {
          log('等待文稿内容出现...');
        }
      }

      await sleep(pollInterval);
    }

    // 步骤3：提取文稿内容
    const draftText = getDraftText();
    if (!draftText || draftText.length < 50) {
      log(`❌ 文稿内容过短或为空（${draftText.length} 字符），刷新重试...`);
      setPanelColor('error');
      await sleep(3000);
      reloadTab();
      return;
    }

    // 步骤4：生成文件名并触发下载
    // 下载路径：优先使用 relPath（完整相对路径），否则回退到仅目录名
    const videoName = getVideoFilename();
    const relPath = getRelPath();
    const safeName = videoName.replace(/\.mp4$/i, '').replace(/[<>:"/\\|?*]/g, '_') + '.txt';

    let downloadSubdir = '';
    // relPath 来自 content_dir.js 的递归扫描
    // - 非空字符串：视频在子目录中，如 "11.天诺老吴.../子目录"
    // - 空字符串：视频直接在根目录下，不需要子目录
    // - undefined/null（URL 中没有该参数）：回退到仅目录名
    const urlHasRelPath = new URL(window.location.href).searchParams.has('relPath');
    if (urlHasRelPath) {
      if (relPath) {
        downloadSubdir = relPath.split('/').map(seg => seg.replace(/[<>:"/\\|?*]/g, '_')).join('/');
      }
      // relPath 为空字符串时，downloadSubdir 保持为空（视频在根目录下）
    } else {
      // 回退：仅使用所在目录名（兼容旧版，无 relPath 参数时）
      const videoDir = getVideoDirName();
      downloadSubdir = videoDir.replace(/[<>:"/\\|?*]/g, '_');
    }

    const fullDownloadPath = downloadSubdir ? `${downloadSubdir}/${safeName}` : safeName;
    log(`✅ 文稿提取成功（${draftText.length} 字符），下载: ${fullDownloadPath}`);

    // 发送到 background.js 执行下载
    // triggerDownload 接受完整的相对路径作为 filename 参数
    const ok = await triggerDownload(fullDownloadPath, '', draftText);
    if (!ok) {
      log('❌ 下载失败，刷新重试...');
      setPanelColor('error');
      await sleep(3000);
      reloadTab();
      return;
    }

    // 给 chrome.downloads 一点时间启动实际下载
    await sleep(3000);
    log(`✅ 完成，关闭标签页`);
    setPanelColor('success');
    STATE.success = true;

    // 通知目录页控制器：成功
    notifyBatchController('success');

    await sleep(1000);
    closeTab();
  }

  // 启动
  main().catch(e => {
    log('❌ 错误: ' + e.message + '，刷新重试...');
    setPanelColor('error');
    setTimeout(() => reloadTab(), 3000);
  });
})();
