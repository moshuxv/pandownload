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

  // === PDF 下载：在页面主世界执行脚本获取直链并触发下载（绕过 CSP）===
  if (message.action === 'downloadPDF') {
    const { fs_id, filename } = message;
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ ok: false, error: 'no tab' });
      return true;
    }

    console.log(`[PDF下载] 注入主世界脚本: ${filename} (fs_id=${fs_id})`);

    // 在页面主世界执行代码，可以访问 yunData 和调用 API
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',  // 关键：在页面主世界执行，可以访问页面全局变量
      func: (fsId) => {
        // 这个函数在页面主世界执行
        return new Promise((resolve) => {
          try {
            // 获取 token - 尝试多种方式
            let bd = '';
            let tokenSource = '';

            // 方式1: yunData.MYBDSTOKEN
            if (typeof yunData !== 'undefined' && yunData) {
              bd = yunData.MYBDSTOKEN || yunData.bdstoken || '';
              if (bd) tokenSource = 'yunData';
            }

            // 方式2: document.cookie
            if (!bd) {
              const ck = document.cookie.match(/BDSTOKEN=([^;]+)/i);
              if (ck) {
                bd = ck[1];
                tokenSource = 'cookie';
              }
            }

            // 方式3: localStorage
            if (!bd) {
              try {
                bd = localStorage.getItem('bdstoken') || '';
                if (bd) tokenSource = 'localStorage';
              } catch (e) {}
            }

            // 方式4: 从页面脚本标签中查找
            if (!bd) {
              const scripts = document.querySelectorAll('script');
              for (const s of scripts) {
                const text = s.textContent || '';
                const match = text.match(/bdstoken["']?\s*[:=]\s*["']?([a-f0-9]{32})/i);
                if (match) {
                  bd = match[1];
                  tokenSource = 'script';
                  break;
                }
              }
            }

            if (!bd) {
              resolve({ ok: false, error: 'NO_BDSTOKEN', debug: 'yunData=' + (typeof yunData) + ',cookie=' + document.cookie.includes('BDSTOKEN') });
              return;
            }

            // 调用 filemetas API 获取下载链接
            console.log('[PDF下载] token来源: ' + tokenSource + ', tk=' + bd.substring(0, 6));
            const xhr = new XMLHttpRequest();
            xhr.open('GET', `https://pan.baidu.com/api/filemetas?fsids=%5B${fsId}%5D&dlink=1&web=1&bdstoken=${bd}`, false);
            xhr.withCredentials = true;
            xhr.send();

            if (xhr.status !== 200) {
              resolve({ ok: false, error: `HTTP_${xhr.status}` });
              return;
            }

            const data = JSON.parse(xhr.responseText);
            if (data.errno !== 0) {
              resolve({ ok: false, error: `ERRNO_${data.errno}` });
              return;
            }

            const dlink = data.info?.[0]?.dlink;
            if (!dlink) {
              resolve({ ok: false, error: 'NO_DLINK' });
              return;
            }

            // 触发下载
            const a = document.createElement('a');
            a.href = dlink;
            a.download = '';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            resolve({ ok: true, dlink });
          } catch (e) {
            resolve({ ok: false, error: 'EXCEPTION:' + e.message });
          }
        });
      },
      args: [fs_id]
    }).then((results) => {
      const result = results?.[0]?.result;
      if (result?.ok) {
        console.log(`[PDF下载] 成功: ${filename}`);
        sendResponse({ ok: true });
      } else {
        console.error(`[PDF下载] 失败: ${filename} - ${result?.error || 'unknown'}`);
        sendResponse({ ok: false, error: result?.error || 'unknown', debug: result?.debug });
      }
    }).catch((err) => {
      console.error(`[PDF下载] 注入失败: ${filename} - ${err.message}`);
      sendResponse({ ok: false, error: err.message });
    });

    return true; // 保持通道开放
  }

  return true;
});

// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && changeInfo.url.includes('pan.baidu.com/pfile/video')) {
    console.log('[字幕自动导出] 检测到视频页面:', changeInfo.url.substring(0, 100));
  }
});
