// popup.js — 弹出页面逻辑
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('enableToggle');
  const batchToggle = document.getElementById('batchToggle');
  const pdfToggle = document.getElementById('pdfToggle');
  const status = document.getElementById('status');

  // 读取启用状态
  chrome.storage.local.get(['enabled', 'batchEnabled', 'pdfEnabled'], (result) => {
    const enabled = result.enabled !== false;
    const batchEnabled = result.batchEnabled !== false;
    const pdfEnabled = result.pdfEnabled !== false;
    toggle.checked = enabled;
    batchToggle.checked = batchEnabled;
    pdfToggle.checked = pdfEnabled;
    updateStatus(enabled, batchEnabled, pdfEnabled);
  });

  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: toggle.checked });
    updateStatus(toggle.checked, batchToggle.checked, pdfToggle.checked);
  });

  batchToggle.addEventListener('change', () => {
    chrome.storage.local.set({ batchEnabled: batchToggle.checked });
    updateStatus(toggle.checked, batchToggle.checked, pdfToggle.checked);
  });

  pdfToggle.addEventListener('change', () => {
    chrome.storage.local.set({ pdfEnabled: pdfToggle.checked });
    updateStatus(toggle.checked, batchToggle.checked, pdfToggle.checked);
  });

  function updateStatus(enabled, batchEnabled, pdfEnabled) {
    const parts = [];
    parts.push(enabled ? '✅ 单页自动导出' : '⛔ 单页已禁用');
    parts.push(batchEnabled ? '✅ 批量控制' : '⛔ 批量已禁用');
    parts.push(pdfEnabled ? '✅ PDF下载' : '⛔ PDF已禁用');
    status.textContent = parts.join(' | ');
    status.style.background = (enabled && batchEnabled && pdfEnabled) ? '#e8f5e9' : '#fff3e0';
  }
});
