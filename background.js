// background.js — Service Worker
// 处理关闭/刷新标签页、以及下载请求（在后台上下文中执行，不依赖标签页生命周期）

chrome.runtime.onInstalled.addListener(() => {
  console.log('[百度网盘字幕自动导出] 扩展已安装');
});

// 接收 content script 消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // === 关闭标签页 ===
  if (message.action === 'closeTab' && sender.tab) {
    const tabId = sender.tab.id;
    console.log('[字幕自动导出] 关闭标签页:', tabId);
    chrome.tabs.remove(tabId, () => {
      if (chrome.runtime.lastError) {
        console.error('[字幕自动导出] 关闭失败:', chrome.runtime.lastError.message);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  // === 刷新标签页 ===
  if (message.action === 'reloadTab' && sender.tab) {
    const tabId = sender.tab.id;
    console.log('[字幕自动导出] 刷新标签页:', tabId);
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) {
        console.error('[字幕自动导出] 刷新失败:', chrome.runtime.lastError.message);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  // === 下载文稿（在后台上下文中执行 chrome.downloads） ===
  if (message.action === 'downloadText') {
    const { text, filename } = message;
    console.log(`[字幕自动导出] 后台下载: ${filename} (${text.length} 字符)`);

    // ⚠ MV3 Service Worker 中 URL.createObjectURL() 不可用！
    // 用 data URL 代替（纯字符串拼接，不依赖 createObjectURL）
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);

    chrome.downloads.download({
      url: dataUrl,
      filename: filename,       // 支持子目录路径，如 "11.天诺.../[10]--9、xxx.txt"
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[字幕自动导出] 下载失败:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        console.log(`[字幕自动导出] 下载已开始: ${filename} (id=${downloadId})`);
        sendResponse({ ok: true, downloadId });
      }
    });

    return true; // 保持通道开放等待异步回调
  }

  // === 下载文件（PDF等），使用 URL 直链 ===
  if (message.action === 'downloadFile') {
    const { url, filename } = message;
    console.log(`[PDF下载] 后台下载: ${filename}`);

    chrome.downloads.download({
      url: url,
      filename: filename,       // 支持子目录路径
      saveAs: false,
      conflictAction: 'uniquify',
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[PDF下载] 下载失败:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        console.log(`[PDF下载] 下载已开始: ${filename} (id=${downloadId})`);
        sendResponse({ ok: true, downloadId });
      }
    });

    return true;
  }

  return true;
});

// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && changeInfo.url.includes('pan.baidu.com/pfile/video')) {
    console.log('[字幕自动导出] 检测到视频页面:', changeInfo.url.substring(0, 100));
  }
});
