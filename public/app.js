// Global State
let currentPlatform = 'messenger';
let activeConfig = null;
let currentLogFilter = 'all';
let allLogs = [];
let apiKeysList = [];
let activeThreadId = null;
let activeThread = null;
let allThreads = [];
let activeMessages = [];
let allDocuments = [];
let allRegistrations = [];
let systemBotEnabled = true;

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const tabViews = document.querySelectorAll('.tab-view');
const tabTitle = document.getElementById('current-tab-title');
const tabDesc = document.getElementById('current-tab-desc');

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  await loadSystemStatus();
  await loadConfig();
  await loadLogs();
  await loadKnowledge();
  await loadThreads(); // Load threads initially
  await loadLearnedKnowledge(); // Load learned knowledge
  await loadRegistrations(true); // Load registrations initially
  
  // Socket.io Real-time update triggers
  initSocketIO();
});

async function loadSystemStatus(silent = false) {
  try {
    const res = await fetch('/api/system/status');
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    applySystemStatus(data.botEnabled !== false);
  } catch (err) {
    if (!silent) showToast('Không thể tải trạng thái hệ thống.', 'error');
  }
}

function applySystemStatus(enabled) {
  systemBotEnabled = !!enabled;

  const toggle = document.getElementById('settings-bot-enabled-toggle');
  const badge = document.getElementById('bot-status-badge');
  const statusText = document.getElementById('server-status');
  const statusIndicator = document.getElementById('system-status-indicator');

  if (toggle) {
    toggle.checked = systemBotEnabled;
  }

  if (badge) {
    badge.classList.toggle('on', systemBotEnabled);
    badge.classList.toggle('off', !systemBotEnabled);
    badge.textContent = systemBotEnabled ? 'Bot đang bật' : 'Bot đang tắt';
  }

  if (statusText) {
    statusText.textContent = systemBotEnabled ? 'Đang chạy' : 'Đang tắt';
  }

  if (statusIndicator) {
    statusIndicator.classList.toggle('online', systemBotEnabled);
    statusIndicator.classList.toggle('offline', !systemBotEnabled);
  }
}

async function handleBotToggle(enabled) {
  const toggle = document.getElementById('settings-bot-enabled-toggle');
  if (toggle) toggle.disabled = true;

  try {
    const res = await fetch('/api/system/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botEnabled: !!enabled })
    });

    if (res.status === 401) {
      window.location.href = '/';
      return;
    }

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Không thể cập nhật trạng thái hệ thống.');
    }

    applySystemStatus(result.botEnabled !== false);
    showToast(result.botEnabled ? 'Đã bật hệ thống bot.' : 'Đã tắt hệ thống bot.', 'success');
  } catch (err) {
    applySystemStatus(systemBotEnabled);
    showToast(err.message || 'Lỗi khi cập nhật trạng thái bot.', 'error');
  } finally {
    if (toggle) toggle.disabled = false;
  }
}

async function logoutDashboard() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    // ignore
  }
  window.location.href = '/';
}

async function changePassword() {
  const currentPassword = window.prompt('Nhập mật khẩu hiện tại:');
  if (currentPassword === null) return;

  const newPassword = window.prompt('Nhập mật khẩu mới (tối thiểu 6 ký tự):');
  if (newPassword === null) return;
  if (newPassword.trim().length < 6) {
    showToast('Mật khẩu mới phải có ít nhất 6 ký tự.', 'error');
    return;
  }

  const confirmPassword = window.prompt('Nhập lại mật khẩu mới:');
  if (confirmPassword === null) return;
  if (newPassword !== confirmPassword) {
    showToast('Mật khẩu nhập lại không khớp.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });

    if (res.status === 401) {
      window.location.href = '/';
      return;
    }

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Không thể đổi mật khẩu.');
    }

    showToast(result.message || 'Đổi mật khẩu thành công.', 'success');
  } catch (err) {
    showToast(err.message || 'Lỗi khi đổi mật khẩu.', 'error');
  }
}

// 1. Tab Navigation Logic
function setupNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.getAttribute('data-tab');
      
      // Update sidebar active state
      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      
      // Switch Tab view
      tabViews.forEach(view => view.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      
      // Update Top Bar text
      updateTopbarText(tabId);
    });
  });
}

function updateTopbarText(tabId) {
  switch (tabId) {
    case 'tab-dashboard':
      tabTitle.textContent = 'Tổng quan hệ thống';
      tabDesc.textContent = 'Theo dõi hiệu năng và trạng thái tin nhắn thời gian thực.';
      break;
    case 'tab-live-chat':
      tabTitle.textContent = 'Hộp thư Live Chat & Simulator';
      tabDesc.textContent = 'Trò chuyện trực tiếp với khách hàng và giả lập gỡ lỗi AI chatbot.';
      break;
    case 'tab-registrations':
      tabTitle.textContent = 'Thống kê chốt đơn & đăng ký';
      tabDesc.textContent = 'Danh sách khách hàng để lại số điện thoại đăng ký học.';
      loadRegistrations();
      break;
    case 'tab-config':
      tabTitle.textContent = 'Cấu hình API kết nối';
      tabDesc.textContent = 'Thiết lập mã thông báo Access Token và mã định danh Meta Developer.';
      break;
    case 'tab-knowledge':
      tabTitle.textContent = 'Quản lý Tài liệu Tri thức';
      tabDesc.textContent = 'Cập nhật tài liệu sản phẩm và huấn luyện RAG AI.';
      break;
    case 'tab-logs':
      tabTitle.textContent = 'Bảng điều khiển Nhật ký';
      tabDesc.textContent = 'Theo dõi lưu lượng Webhook và tin nhắn gửi/nhận thực tế.';
      break;
    case 'tab-settings':
      tabTitle.textContent = 'Cài đặt hệ thống';
      tabDesc.textContent = 'Bật tắt hoạt động của bot và thay đổi thông tin mật khẩu bảo mật.';
      break;
  }
}

// 2. Active Platform configuration
async function setActivePlatform(platform) {
  if (platform !== 'messenger' && platform !== 'whatsapp') return;
  
  currentPlatform = platform;
  
  // Update UI badges
  document.getElementById('btn-select-messenger').classList.toggle('active', platform === 'messenger');
  document.getElementById('btn-select-whatsapp').classList.toggle('active', platform === 'whatsapp');
  
  // Update inputs & helper labels on other tabs dynamically
  updatePlatformLabels(platform);
  
  // Update on server
  if (activeConfig) {
    activeConfig.general.activePlatform = platform;
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activeConfig)
      });
      showToast(`Đã chuyển nền tảng hoạt động sang ${platform === 'messenger' ? 'Facebook Messenger' : 'WhatsApp Cloud API'}.`, 'success');
    } catch (err) {
      showToast('Không thể cập nhật cấu hình nền tảng trên server.', 'error');
    }
  }
}

function updatePlatformLabels(platform) {
  const quickRecipientLabel = document.getElementById('quick-recipient-label');
  const quickRecipient = document.getElementById('quick-recipient');
  const quickRecipientHelper = document.getElementById('quick-recipient-helper');
  if (!quickRecipientLabel || !quickRecipient) return;
  
  if (platform === 'messenger') {
    quickRecipientLabel.textContent = 'ID người nhận (Messenger PSID)';
    quickRecipient.placeholder = 'Ví dụ: 829302198302183';
    if (quickRecipientHelper) quickRecipientHelper.textContent = 'Nhập Messenger Page-Scoped User ID (PSID).';
  } else {
    quickRecipientLabel.textContent = 'Số điện thoại người nhận (WhatsApp)';
    quickRecipient.placeholder = 'Ví dụ: 84912345678';
    if (quickRecipientHelper) quickRecipientHelper.textContent = 'Nhập số điện thoại kèm mã quốc gia (không kèm dấu + hoặc số 0 ở đầu).';
  }
}

// 3. API Config actions
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    activeConfig = await res.json();
    
    // Fill Messenger Inputs
    document.getElementById('fb-page-id').value = activeConfig.messenger.pageId || '';
    document.getElementById('fb-app-secret').value = activeConfig.messenger.appSecret || '';
    document.getElementById('fb-access-token').value = activeConfig.messenger.accessToken || '';
    document.getElementById('fb-verify-token').value = activeConfig.messenger.verifyToken || 'my_secure_verify_token_12345';
    
    // Fill WhatsApp Inputs
    document.getElementById('wa-phone-id').value = activeConfig.whatsapp.phoneNumberId || '';
    document.getElementById('wa-waba-id').value = activeConfig.whatsapp.wabaId || '';
    document.getElementById('wa-access-token').value = activeConfig.whatsapp.accessToken || '';
    document.getElementById('wa-verify-token').value = activeConfig.whatsapp.verifyToken || 'my_secure_verify_token_12345';
    
    // Fill AI Inputs
    if (activeConfig.ai) {
      document.getElementById('ai-provider').value = activeConfig.ai.provider || 'gemini';
      document.getElementById('ai-model').value = activeConfig.ai.model || 'gemini-1.5-flash';
      document.getElementById('ai-base-url').value = activeConfig.ai.baseUrl || '';
      const apiKeyVal = activeConfig.ai.apiKey || '';
      document.getElementById('ai-api-key').value = apiKeyVal;
      apiKeysList = apiKeyVal.split(',').map(k => k.trim()).filter(Boolean);
      renderApiKeysList();
      document.getElementById('ai-offline-rag').checked = !!activeConfig.ai.useOfflineRag;
      document.getElementById('ai-system-prompt').value = activeConfig.ai.systemPrompt || '';
    } else {
      activeConfig.ai = {
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        baseUrl: '',
        apiKey: '',
        useOfflineRag: false,
        systemPrompt: 'Bạn là trợ lý AI thông minh phản hồi tin nhắn tự động từ Fanpage.'
      };
      document.getElementById('ai-offline-rag').checked = false;
    }
    toggleAIProviderFields();
    
    // Set Active Platform state
    currentPlatform = activeConfig.general.activePlatform || 'messenger';
    document.getElementById('btn-select-messenger').classList.toggle('active', currentPlatform === 'messenger');
    document.getElementById('btn-select-whatsapp').classList.toggle('active', currentPlatform === 'whatsapp');
    updatePlatformLabels(currentPlatform);
    
    // Set Webhook display based on URL
    const protocol = window.location.protocol;
    const host = window.location.host;
    document.getElementById('webhook-url-display').value = `${protocol}//${host}/webhook`;
    document.getElementById('webhook-token-display').value = currentPlatform === 'messenger' ? activeConfig.messenger.verifyToken : activeConfig.whatsapp.verifyToken;
    
  } catch (err) {
    showToast('Lỗi tải cấu hình API.', 'error');
  }
}

async function saveConfiguration(e) {
  e.preventDefault();
  
  // Collect values
  activeConfig.messenger.pageId = document.getElementById('fb-page-id').value.trim();
  activeConfig.messenger.appSecret = document.getElementById('fb-app-secret').value.trim();
  activeConfig.messenger.accessToken = document.getElementById('fb-access-token').value.trim();
  activeConfig.messenger.verifyToken = document.getElementById('fb-verify-token').value.trim();
  
  activeConfig.whatsapp.phoneNumberId = document.getElementById('wa-phone-id').value.trim();
  activeConfig.whatsapp.wabaId = document.getElementById('wa-waba-id').value.trim();
  activeConfig.whatsapp.accessToken = document.getElementById('wa-access-token').value.trim();
  activeConfig.whatsapp.verifyToken = document.getElementById('wa-verify-token').value.trim();
  
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeConfig)
    });
    
    if (res.ok) {
      showToast('Đã lưu cấu hình API thành công!', 'success');
      document.getElementById('webhook-token-display').value = currentPlatform === 'messenger' ? activeConfig.messenger.verifyToken : activeConfig.whatsapp.verifyToken;
    } else {
      showToast('Gặp lỗi khi lưu cấu hình.', 'error');
    }
  } catch (err) {
    showToast('Không kết nối được tới server.', 'error');
  }
}

function toggleAIProviderFields() {
  const provider = document.getElementById('ai-provider').value;
  const baseUrlGroup = document.getElementById('ai-base-url-group');
  const modelInput = document.getElementById('ai-model');
  
  if (provider === 'custom') {
    baseUrlGroup.style.display = 'block';
  } else {
    baseUrlGroup.style.display = 'none';
  }
  
  // Set default models for convenience if empty
  if (provider === 'gemini') {
    modelInput.placeholder = 'Ví dụ: gemini-1.5-flash, gemini-1.5-pro...';
    if (!modelInput.value || modelInput.value.startsWith('gpt') || modelInput.value.startsWith('deepseek')) {
      modelInput.value = 'gemini-1.5-flash';
    }
  } else if (provider === 'openai') {
    modelInput.placeholder = 'Ví dụ: gpt-4o-mini, gpt-4o, gpt-3.5-turbo...';
    if (!modelInput.value || modelInput.value.startsWith('gemini') || modelInput.value.startsWith('deepseek')) {
      modelInput.value = 'gpt-4o-mini';
    }
  } else if (provider === 'deepseek') {
    modelInput.placeholder = 'Ví dụ: deepseek-chat, deepseek-coder...';
    if (!modelInput.value || modelInput.value.startsWith('gemini') || modelInput.value.startsWith('gpt')) {
      modelInput.value = 'deepseek-chat';
    }
  } else if (provider === 'custom') {
    modelInput.placeholder = 'Ví dụ: glm-4-flash, llama3...';
  }
}

async function saveAIConfiguration(e) {
  e.preventDefault();
  
  if (!activeConfig.ai) activeConfig.ai = {};
  
  activeConfig.ai.provider = document.getElementById('ai-provider').value;
  activeConfig.ai.model = document.getElementById('ai-model').value.trim();
  activeConfig.ai.baseUrl = document.getElementById('ai-base-url').value.trim();
  activeConfig.ai.apiKey = document.getElementById('ai-api-key').value.trim();
  activeConfig.ai.useOfflineRag = document.getElementById('ai-offline-rag').checked;
  activeConfig.ai.systemPrompt = document.getElementById('ai-system-prompt').value.trim();
  
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeConfig)
    });
    
    if (res.ok) {
      showToast('Đã lưu cấu hình AI thành công!', 'success');
    } else {
      showToast('Gặp lỗi khi lưu cấu hình AI.', 'error');
    }
  } catch (err) {
    showToast('Không kết nối được tới server.', 'error');
  }
}

// Export AI Config to file
function exportAIConfig() {
  if (!activeConfig || !activeConfig.ai) {
    showToast('Không có cấu hình AI để xuất.', 'error');
    return;
  }
  
  const aiData = {
    provider: document.getElementById('ai-provider').value,
    model: document.getElementById('ai-model').value.trim(),
    baseUrl: document.getElementById('ai-base-url').value.trim(),
    apiKey: document.getElementById('ai-api-key').value.trim(),
    useOfflineRag: document.getElementById('ai-offline-rag').checked,
    systemPrompt: document.getElementById('ai-system-prompt').value.trim()
  };

  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(aiData, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `botchatsms_ai_config_${aiData.provider}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  showToast('Đã xuất file cấu hình AI thành công!', 'success');
}

// Import AI Config from file
function importAIConfig(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      
      if (!imported.provider || !imported.model) {
        throw new Error('Định dạng file cấu hình AI không hợp lệ.');
      }

      document.getElementById('ai-provider').value = imported.provider || 'gemini';
      document.getElementById('ai-model').value = imported.model || '';
      document.getElementById('ai-base-url').value = imported.baseUrl || '';
      document.getElementById('ai-api-key').value = imported.apiKey || '';
      document.getElementById('ai-offline-rag').checked = !!imported.useOfflineRag;
      document.getElementById('ai-system-prompt').value = imported.systemPrompt || '';

      const apiKeyVal = imported.apiKey || '';
      apiKeysList = apiKeyVal.split(',').map(k => k.trim()).filter(Boolean);
      renderApiKeysList();
      toggleAIProviderFields();

      // Trigger automatic save to server
      const fakeEvent = { preventDefault: () => {} };
      await saveAIConfiguration(fakeEvent);
      
      showToast('Đã nhập và lưu cấu hình AI thành công!', 'success');
    } catch (err) {
      showToast('Lỗi khi đọc file cấu hình: ' + err.message, 'error');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

// 4. Auto-reply Rules Actions


// 5. Send single message action
async function handleQuickSend(e) {
  e.preventDefault();
  
  const recipient = document.getElementById('quick-recipient').value.trim();
  const text = document.getElementById('quick-message').value.trim();
  const btn = document.getElementById('btn-quick-send');
  
  if (!recipient || !text) return;
  
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi...`;
  
  try {
    const res = await fetch('/api/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, text, platform: currentPlatform })
    });
    
    const result = await res.json();
    if (res.ok && result.success) {
      showToast('Gửi tin nhắn thử nghiệm thành công!', 'success');
      document.getElementById('quick-message').value = '';
      await loadLogs();
    } else {
      showToast(`Gửi thất bại: ${result.error || 'Lỗi chưa xác định'}`, 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối hoặc cấu hình API sai.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Gửi tin nhắn ngay`;
  }
}



// 7. Logs & Monitor Screen Actions
async function loadLogs(silent = false) {
  try {
    const res = await fetch('/api/logs');
    allLogs = await res.json();
    
    // Recalculate Stats in Dashboard
    updateStats(allLogs);
    
    // Render logs based on current filter
    renderLogs();
    
    if (!silent) {
      console.log('Logs reloaded from server');
    }
  } catch (err) {
    if (!silent) showToast('Lỗi khi tải nhật ký hoạt động.', 'error');
  }
}

function updateStats(logs) {
  const sent = logs.filter(l => l.direction === 'outgoing' && l.status === 'success').length;
  const received = logs.filter(l => l.direction === 'incoming').length;
  const replies = logs.filter(l => l.direction === 'system' && l.text.includes('Phản hồi:')).length;
  const errors = logs.filter(l => l.type === 'error' || l.status === 'failed').length;
  
  document.getElementById('stat-sent-count').textContent = sent;
  document.getElementById('stat-received-count').textContent = received;
  document.getElementById('stat-auto-replies').textContent = replies;
  document.getElementById('stat-error-count').textContent = errors;
}

function filterLogs(filter) {
  currentLogFilter = filter;
  
  // Highlight chip
  const chips = document.querySelectorAll('.filter-chip');
  chips.forEach(chip => {
    chip.classList.toggle('active', chip.getAttribute('onclick').includes(filter));
  });
  
  renderLogs();
}

function renderLogs() {
  const container = document.getElementById('console-log-list');
  container.innerHTML = '';
  
  let filtered = allLogs;
  if (currentLogFilter === 'incoming') {
    filtered = allLogs.filter(l => l.direction === 'incoming');
  } else if (currentLogFilter === 'outgoing') {
    filtered = allLogs.filter(l => l.direction === 'outgoing');
  } else if (currentLogFilter === 'system') {
    filtered = allLogs.filter(l => l.direction === 'system');
  } else if (currentLogFilter === 'error') {
    filtered = allLogs.filter(l => l.type === 'error' || l.status === 'failed');
  }
  
  if (filtered.length === 0) {
    container.innerHTML = `<div class="console-line system"><span class="console-text">Chưa có bản ghi nhật ký nào cho mục này.</span></div>`;
    return;
  }
  
  filtered.forEach(log => {
    const line = document.createElement('div');
    line.className = `console-line ${log.type === 'error' || log.status === 'failed' ? 'error' : ''} ${log.direction === 'system' ? 'system' : ''}`;
    
    // Time
    const timeStr = new Date(log.timestamp).toLocaleTimeString();
    
    // Badge
    let badgeClass = 'sys';
    let badgeText = 'Sys';
    if (log.direction === 'incoming') {
      badgeClass = 'in';
      badgeText = 'Nhận';
    } else if (log.direction === 'outgoing') {
      badgeClass = 'out';
      badgeText = 'Gửi';
    }
    if (log.status === 'failed' || log.type === 'error') {
      badgeClass = 'err';
      badgeText = 'Lỗi';
    }
    
    // Text description
    let displayMsg = '';
    if (log.direction === 'incoming') {
      displayMsg = `Từ ${log.sender}: "${log.text}"`;
    } else if (log.direction === 'outgoing') {
      displayMsg = `Đến ${log.recipient}: "${log.text}"` + (log.status === 'success' ? ' (Thành công)' : ' (Thất bại)');
    } else {
      displayMsg = `${log.text}`;
    }
    
    line.innerHTML = `
      <span class="console-time">[${timeStr}]</span>
      <span class="console-badge ${badgeClass}">${badgeText}</span>
      <span class="console-text">${escapeHtml(displayMsg)}</span>
    `;
    
    // Hover details title for debugging
    if (log.details) {
      line.title = `Chi tiet API:\n${log.details}`;
      line.style.cursor = 'help';
    }
    
    container.appendChild(line);
  });
}

async function clearLogs() {
  if (!confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử nhật ký không?')) return;
  try {
    const res = await fetch('/api/logs', { method: 'DELETE' });
    if (res.ok) {
      showToast('Đã dọn dẹp toàn bộ nhật ký.', 'success');
      await loadLogs();
    }
  } catch (err) {
    showToast('Gặp lỗi khi xóa nhật ký.', 'error');
  }
}

// 8. Copy helper triggers
function copyWebhookUrl() {
  const input = document.getElementById('webhook-url-display');
  input.select();
  document.execCommand('copy');
  showToast('Đã sao chép Callback URL vào Clipboard!', 'success');
}

function copyVerifyToken() {
  const input = document.getElementById('webhook-token-display');
  input.select();
  document.execCommand('copy');
  showToast('Đã sao chép Verify Token vào Clipboard!', 'success');
}

// 9. Config Sub Tab switcher
function switchConfigSubTab(subTabId) {
  const subTabs = document.querySelectorAll('.config-sub-tab');
  const btns = document.querySelectorAll('.config-tab-btn');
  
  subTabs.forEach(tab => tab.classList.remove('active'));
  btns.forEach(btn => btn.classList.remove('active'));
  
  document.getElementById(subTabId).classList.add('active');
  
  // Find current button and add active class
  event.currentTarget.classList.add('active');
}

// 10. Utilities
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.className = `toast show ${type}`;
  toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-xmark' : 'fa-circle-exclamation'}"></i> ${message}`;
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeJs(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// 11. Knowledge Base (RAG) actions
// 11. Knowledge Base (RAG) actions
async function loadKnowledge() {
  try {
    const res = await fetch('/api/knowledge');
    const data = await res.json();
    
    allDocuments = data.documents || [];
    renderDocumentsList();
    
    // Reset form after reloading list
    resetDocumentForm();
  } catch (err) {
    showToast('Lỗi khi tải danh sách tài liệu tri thức.', 'error');
  }
}

function renderDocumentsList() {
  const container = document.getElementById('knowledge-documents-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (allDocuments.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 12px;">Chưa có tài liệu nào. Bấm nút Thêm để bắt đầu.</div>`;
    return;
  }
  
  allDocuments.forEach(doc => {
    const item = document.createElement('div');
    const isActive = document.getElementById('document-id').value === doc.id;
    item.className = `thread-item ${isActive ? 'active' : ''}`;
    item.style = 'cursor: pointer; padding: 10px 12px; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); background-color: rgba(255,255,255,0.01); display: flex; justify-content: space-between; align-items: center; transition: all 0.2s;';
    
    const charCount = doc.content ? doc.content.length : 0;
    
    item.innerHTML = `
      <div style="flex-grow: 1; min-width: 0; margin-right: 10px;" onclick="selectDocument('${doc.id}')">
        <div style="font-weight: 600; color: #fff; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(doc.title)}</div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">${charCount} ký tự - ${new Date(doc.lastTrained).toLocaleDateString('vi-VN')}</div>
      </div>
      <div style="flex-shrink: 0; display: flex; gap: 8px;">
        <button class="btn-icon-only edit-btn" onclick="selectDocument('${doc.id}')" title="Sửa" style="width: 26px; height: 26px; font-size: 11px;">
          <i class="fa-regular fa-pen-to-square"></i>
        </button>
        <button class="btn-icon-only delete-btn" onclick="deleteDocument('${doc.id}')" title="Xóa" style="width: 26px; height: 26px; font-size: 11px;">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </div>
    `;
    
    // Highlight if selected
    if (isActive) {
      item.style.borderColor = 'var(--primary)';
      item.style.background = 'linear-gradient(135deg, rgba(79, 70, 229, 0.1), rgba(139, 92, 246, 0.02))';
    }
    
    container.appendChild(item);
  });
}

function selectDocument(docId) {
  const doc = allDocuments.find(d => d.id === docId);
  if (!doc) return;
  
  document.getElementById('document-id').value = doc.id;
  document.getElementById('document-title').value = doc.title;
  document.getElementById('knowledge-text').value = doc.content;
  
  document.getElementById('document-form-title').innerHTML = `<i class="fa-solid fa-pen-to-square text-gradient"></i> Hiệu chỉnh tài liệu`;
  document.getElementById('btn-cancel-document').style.display = 'inline-flex';
  
  const statusEl = document.getElementById('knowledge-status');
  const lastTrainedEl = document.getElementById('knowledge-last-trained');
  
  statusEl.innerHTML = `<span style="color: var(--success);"><i class="fa-solid fa-circle-check"></i> Đã huấn luyện</span>`;
  lastTrainedEl.textContent = `Cập nhật: ${new Date(doc.lastTrained).toLocaleString('vi-VN')}`;
  
  // Refresh border highlight in list
  renderDocumentsList();
}

function resetDocumentForm() {
  document.getElementById('document-id').value = '';
  document.getElementById('document-title').value = '';
  document.getElementById('knowledge-text').value = '';
  
  document.getElementById('document-form-title').innerHTML = `<i class="fa-solid fa-file-invoice text-gradient"></i> Thêm tài liệu mới`;
  document.getElementById('btn-cancel-document').style.display = 'none';
  
  document.getElementById('knowledge-status').textContent = 'Trạng thái: Sẵn sàng';
  document.getElementById('knowledge-last-trained').textContent = 'Cập nhật lần cuối: --';
  
  renderDocumentsList();
}

async function handleSaveDocument(e) {
  e.preventDefault();
  
  const id = document.getElementById('document-id').value.trim();
  const title = document.getElementById('document-title').value.trim();
  const content = document.getElementById('knowledge-text').value.trim();
  const btn = document.getElementById('btn-train-knowledge');
  
  if (!title || !content) return;
  
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang huấn luyện...`;
  
  try {
    const res = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || undefined, title, content })
    });
    
    const result = await res.json();
    if (res.ok) {
      showToast(result.message || 'Huấn luyện tài liệu thành công!', 'success');
      await loadKnowledge();
    } else {
      showToast(`Lỗi: ${result.error || 'Huấn luyện thất bại'}`, 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối tới server để huấn luyện.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-graduation-cap"></i> Lưu & Huấn luyện RAG`;
  }
}

async function deleteDocument(docId) {
  event.stopPropagation(); // Stop click from selecting document
  
  const doc = allDocuments.find(d => d.id === docId);
  if (!doc) return;
  
  if (!confirm(`Bạn có chắc chắn muốn xóa tài liệu "${doc.title}"? Chỉ mục RAG liên quan cũng sẽ bị gỡ bỏ.`)) return;
  
  try {
    const res = await fetch(`/api/knowledge/${docId}`, {
      method: 'DELETE'
    });
    
    const result = await res.json();
    if (res.ok) {
      showToast(result.message || 'Đã xóa tài liệu thành công.', 'success');
      
      // If the currently edited document is deleted, reset form
      if (document.getElementById('document-id').value === docId) {
        resetDocumentForm();
      }
      
      await loadKnowledge();
    } else {
      showToast(`Không thể xóa: ${result.error || 'Lỗi hệ thống'}`, 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng khi xóa tài liệu.', 'error');
  }
}

// 12. Chat Simulator Actions
async function handleSimulatorSend(e) {
  e.preventDefault();
  
  const inputEl = document.getElementById('chat-user-input');
  const messageText = inputEl.value.trim();
  const chatMessagesBox = document.getElementById('chat-messages-box');
  const btn = document.getElementById('btn-send-chat');
  const statusEl = document.getElementById('simulator-status');
  
  if (!messageText) return;
  
  // 1. Add User bubble
  addChatBubble('user', messageText);
  inputEl.value = '';
  
  // Scroll to bottom
  chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
  
  // Set status loading
  btn.disabled = true;
  statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Bot đang nghĩ...`;
  statusEl.style.color = 'var(--primary-light)';
  
  try {
    const res = await fetch('/api/test-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageText })
    });
    
    const result = await res.json();
    
    if (res.ok && result.success) {
      // 2. Add Bot bubble
      addChatBubble('bot', result.response, result.source, result.context);
    } else {
      // 3. Add Error bubble
      addChatBubble('error', result.error || 'AI không phản hồi hoặc gặp sự cố kết nối.');
    }
  } catch (err) {
    addChatBubble('error', 'Lỗi kết nối tới máy chủ hoặc cấu hình mạng.');
  } finally {
    btn.disabled = false;
    statusEl.innerHTML = `<i class="fa-solid fa-circle text-success pulse"></i> Sẵn sàng`;
    statusEl.style.color = '';
    // Scroll to bottom again
    chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
    
    // Refresh Logs in background
    await loadLogs(true);
  }
}

function addChatBubble(type, text, source = null, context = null) {
  const container = document.getElementById('chat-messages-box');
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${type}`;
  
  let contentHtml = `<div class="bubble-content">${escapeHtml(text)}</div>`;
  
  // If it's a bot response, attach debug info
  if (type === 'bot' && source) {
    let sourceLabel = 'Trí tuệ nhân tạo AI (RAG)';
    let debugHtml = `
      <div class="rag-debug-info">
        <div class="rag-debug-title">
          <i class="fa-solid fa-circle-info"></i> Nguồn: ${sourceLabel}
        </div>
    `;
    if (context) {
      debugHtml += `
        <div class="rag-debug-title" style="margin-top: 4px; color: var(--text-secondary);">
          <i class="fa-solid fa-database"></i> Tài liệu RAG tìm được:
        </div>
        <div class="rag-debug-text">${escapeHtml(context)}</div>
      `;
    }
    debugHtml += `</div>`;
    contentHtml = `<div class="bubble-content">${escapeHtml(text)}${debugHtml}</div>`;
  }
  
  bubble.innerHTML = contentHtml;
  container.appendChild(bubble);
}

function renderApiKeysList() {
  const container = document.getElementById('api-keys-list-container');
  container.innerHTML = '';
  
  apiKeysList.forEach((key, index) => {
    const item = document.createElement('div');
    item.className = 'api-key-item';
    
    let maskedKey = key;
    if (key.length > 12) {
      maskedKey = key.slice(0, 8) + '...' + key.slice(-6);
    }
    
    item.innerHTML = `
      <span title="${escapeHtml(key)}">${escapeHtml(maskedKey)}</span>
      <button type="button" onclick="removeApiKeyFromList(${index})" title="Xóa khóa này">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    `;
    container.appendChild(item);
  });
  
  document.getElementById('ai-api-key').value = apiKeysList.join(', ');
}

function addApiKeyToList() {
  const input = document.getElementById('ai-new-key-input');
  const key = input.value.trim();
  if (!key) return;
  
  if (!apiKeysList.includes(key)) {
    apiKeysList.push(key);
    renderApiKeysList();
  }
  
  input.value = '';
}

function removeApiKeyFromList(index) {
  apiKeysList.splice(index, 1);
  renderApiKeysList();
}

// Live Chat & Realtime Simulator state management
async function loadThreads(silent = false) {
  try {
    const res = await fetch('/api/threads');
    allThreads = await res.json();
    renderThreadsList();
  } catch (err) {
    if (!silent) showToast('Lỗi khi tải danh sách cuộc trò chuyện.', 'error');
  }
}

function renderThreadsList() {
  const container = document.getElementById('threads-list');
  if (!container) return;
  
  // If threads empty, insert tester as fallback in UI just in case
  if (allThreads.length === 0) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;">Chưa có cuộc trò chuyện nào</div>`;
    return;
  }
  
  container.innerHTML = '';
  allThreads.forEach(thread => {
    const item = document.createElement('div');
    item.className = `thread-item ${activeThreadId === thread.id ? 'active' : ''}`;
    item.onclick = () => selectThread(thread.id);
    
    const timeStr = new Date(thread.lastTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let platformBadge = `<span class="badge-platform ${thread.platform}">${thread.platform}</span>`;
    let adminModeBadge = thread.adminReplying ? `<span class="badge-admin-mode">Admin</span>` : '';
    
    let previewText = thread.lastMessage || '...';
    if (previewText.length > 25) {
      previewText = previewText.slice(0, 22) + '...';
    }
    
    item.innerHTML = `
      <div class="thread-meta">
        <span class="thread-id" title="${thread.id}">${escapeHtml(thread.name || thread.id)}</span>
        <span class="thread-time">${timeStr}</span>
      </div>
      <div class="thread-preview">${escapeHtml(previewText)}</div>
      <div class="thread-badges" style="display: flex; gap: 5px; margin-top: 5px;">
        ${platformBadge}
        ${adminModeBadge}
      </div>
    `;
    container.appendChild(item);
  });
}

async function selectThread(threadId) {
  activeThreadId = threadId;
  activeThread = allThreads.find(t => t.id === threadId);
  
  renderThreadsList();
  
  if (!activeThread) return;
  
  document.getElementById('chat-active-title').textContent = activeThread.name || activeThread.id;
  document.getElementById('chat-active-subtitle').textContent = `Nền tảng: ${activeThread.platform.toUpperCase()} (ID: ${activeThread.id})`;
  
  const inputEl = document.getElementById('chat-user-input');
  document.getElementById('chat-input-form').style.display = 'flex';
  document.getElementById('admin-control-toggle-wrapper').style.display = 'flex';
  document.getElementById('chk-admin-replying').checked = !!activeThread.adminReplying;
  
  if (threadId === 'tester') {
    if (activeThread.adminReplying) {
      inputEl.placeholder = "Nhập tin Khách hàng, hoặc gõ '/admin [nội dung]' để Admin trả lời...";
    } else {
      inputEl.placeholder = "Nhập tin nhắn thử nghiệm đóng vai Khách...";
    }
  } else {
    inputEl.placeholder = "Nhập tin nhắn phản hồi với tư cách Admin...";
  }
  
  await loadActiveThreadMessages();
}

async function loadActiveThreadMessages(silent = false) {
  if (!activeThreadId) return;
  
  try {
    const res = await fetch(`/api/threads/${activeThreadId}/messages`);
    const messages = await res.json();
    renderChatMessages(messages);
  } catch (err) {
    if (!silent) showToast('Lỗi khi tải lịch sử tin nhắn.', 'error');
  }
}

function renderChatMessages(messages) {
  activeMessages = messages;
  const container = document.getElementById('chat-messages-box');
  if (!container) return;
  container.innerHTML = '';
  
  if (messages.length === 0) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">Chưa có tin nhắn nào trong cuộc hội thoại này.</div>`;
    return;
  }
  
  messages.forEach(msg => {
    const bubble = document.createElement('div');
    
    let type = 'bot'; // Left side for customer
    if (msg.direction === 'outgoing') {
      type = 'user'; // Right side for Bot/Admin
    } else if (msg.type === 'error' || msg.status === 'failed') {
      type = 'error';
    }
    
    bubble.className = `chat-bubble ${type}`;
    
    let contentHtml = `<div class="bubble-content">${escapeHtml(msg.text)}`;
    
    let senderLabel = msg.direction === 'incoming' ? `Khách (${msg.sender})` : `${msg.sender}`;
    if (msg.direction === 'outgoing' && msg.sender === 'AI Chatbot') {
      senderLabel = ` AI Bot`;
    } else if (msg.direction === 'outgoing' && msg.sender === 'Admin') {
      senderLabel = ` Admin`;
    }
    
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    contentHtml += `
      <div style="font-size: 9px; margin-top: 5px; opacity: 0.6; display: flex; justify-content: space-between; gap: 15px;">
        <span>${senderLabel}</span>
        <span>${timeStr}</span>
      </div>
    </div>`;
    
    bubble.innerHTML = contentHtml;
    container.appendChild(bubble);
  });
  
  container.scrollTop = container.scrollHeight;
}

function appendChatMessage(msg) {
  // Check if message already exists in list (by ID, or by text and near timestamp)
  const exists = activeMessages.some(m => m.id === msg.id || (m.text === msg.text && Math.abs(new Date(m.timestamp) - new Date(msg.timestamp)) < 2000));
  if (exists) return;
  
  activeMessages.push(msg);
  
  const container = document.getElementById('chat-messages-box');
  if (!container) return;
  
  // Remove "no messages" placeholder if it is visible
  const placeholder = container.querySelector('div[style*="text-align: center"]');
  if (placeholder) {
    placeholder.remove();
  }
  
  const bubble = document.createElement('div');
  
  let type = 'bot'; // Left side for customer
  if (msg.direction === 'outgoing') {
    type = 'user'; // Right side for Bot/Admin
  } else if (msg.type === 'error' || msg.status === 'failed') {
    type = 'error';
  }
  
  bubble.className = `chat-bubble ${type}`;
  
  let contentHtml = `<div class="bubble-content">${escapeHtml(msg.text)}`;
  
  let senderLabel = msg.direction === 'incoming' ? `Khách (${msg.sender})` : `${msg.sender}`;
  if (msg.direction === 'outgoing' && msg.sender === 'AI Chatbot') {
    senderLabel = ` AI Bot`;
  } else if (msg.direction === 'outgoing' && msg.sender === 'Admin') {
    senderLabel = ` Admin`;
  }
  
  const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  contentHtml += `
    <div style="font-size: 9px; margin-top: 5px; opacity: 0.6; display: flex; justify-content: space-between; gap: 15px;">
      <span>${senderLabel}</span>
      <span>${timeStr}</span>
    </div>
  </div>`;
  
  bubble.innerHTML = contentHtml;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

async function handleLiveChatSend(e) {
  e.preventDefault();
  if (!activeThreadId || !activeThread) return;
  
  const inputEl = document.getElementById('chat-user-input');
  const messageText = inputEl.value.trim();
  const btn = document.getElementById('btn-send-chat');
  
  if (!messageText) return;
  
  inputEl.value = '';
  btn.disabled = true;
  
  try {
    if (activeThreadId === 'tester') {
      if (messageText.toLowerCase().startsWith('/admin ')) {
        // Send as Admin reply
        const cleanText = messageText.substring(7).trim();
        if (!cleanText) return;
        
        await fetch('/api/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            recipient: 'tester', 
            text: cleanText, 
            platform: 'test',
            fromLiveChat: true
          })
        });
      } else {
        // Send as Customer message to simulator
        await fetch('/api/test-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: messageText })
        });
      }
    } else {
      // Real Facebook/WhatsApp thread - Send as Admin
      const res = await fetch('/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          recipient: activeThreadId, 
          text: messageText, 
          platform: activeThread.platform,
          fromLiveChat: true
        })
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        showToast(`Gửi tin nhắn thất bại: ${result.error || 'Lỗi chưa xác định'}`, 'error');
      }
    }
  } catch (err) {
    showToast('Lỗi kết nối tới server.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function toggleAdminReplying(checked) {
  if (!activeThreadId) return;
  
  try {
    const res = await fetch(`/api/threads/${activeThreadId}/admin-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminReplying: checked })
    });
    
    const result = await res.json();
    if (res.ok && result.success) {
      showToast(checked ? 'Đã tắt tự động trả lời AI cho cuộc hội thoại này.' : 'Đã bật lại tự động trả lời AI.', 'success');
      await loadThreads(true);
      
      // Update placeholder
      const inputEl = document.getElementById('chat-user-input');
      if (activeThreadId === 'tester') {
        if (checked) {
          inputEl.placeholder = "Nhập tin Khách hàng, hoặc gõ '/admin [nội dung]' để Admin trả lời...";
        } else {
          inputEl.placeholder = "Nhập tin nhắn thử nghiệm đóng vai Khách...";
        }
      }
    } else {
      showToast('Không thể cập nhật trạng thái Admin.', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng khi cập nhật trạng thái Admin.', 'error');
  }
}



// Socket.io Real-time Event Listeners Setup
function initSocketIO() {
  const socket = io();

  socket.on('log_added', (log) => {
    // Add log to local list
    allLogs.unshift(log);
    if (allLogs.length > 200) allLogs.splice(200);
    
    // Update stats
    updateStats(allLogs);
    
    // Prepend to logs table list if active
    const logsTabActive = document.getElementById('tab-logs').classList.contains('active');
    if (logsTabActive) {
      renderLogs();
    }
  });

  socket.on('thread_updated', async (data) => {
    // Reload threads list dynamically
    await loadThreads(true);
  });

  socket.on('message_added', (data) => {
    // If the active thread matches the message customer ID, append message smoothly
    if (activeThreadId === data.customerId) {
      appendChatMessage(data.message);
    }
  });

  socket.on('thread_status_updated', (data) => {
    const thread = allThreads.find(t => t.id === data.id);
    if (thread) {
      thread.adminReplying = data.adminReplying;
      renderThreadsList();
      
      if (activeThreadId === data.id) {
        document.getElementById('chk-admin-replying').checked = data.adminReplying;
        
        const inputEl = document.getElementById('chat-user-input');
        if (activeThreadId === 'tester') {
          if (data.adminReplying) {
            inputEl.placeholder = "Nhập tin Khách hàng, hoặc gõ '/admin [nội dung]' để Admin trả lời...";
          } else {
            inputEl.placeholder = "Nhập tin nhắn thử nghiệm đóng vai Khách...";
          }
        }
      }
    }
  });

  socket.on('learned_knowledge_updated', (learnedData) => {
    renderLearnedKnowledgeList(learnedData);
  });

  socket.on('system_status_updated', (payload) => {
    if (payload && typeof payload.botEnabled === 'boolean') {
      applySystemStatus(payload.botEnabled);
    }
  });

  socket.on('registration_added', (reg) => {
    allRegistrations.unshift(reg);
    updateRegistrationStats(allRegistrations);
    
    const regTabActive = document.getElementById('tab-registrations').classList.contains('active');
    if (regTabActive) {
      filterRegistrations();
    }
    showToast(`🎉 Đăng ký học mới từ ${reg.name} (${reg.phone})!`, 'success');
  });

  socket.on('registration_updated', (updatedItem) => {
    const idx = allRegistrations.findIndex(r => r.id === updatedItem.id);
    if (idx !== -1) {
      allRegistrations[idx] = updatedItem;
      updateRegistrationStats(allRegistrations);
      const regTabActive = document.getElementById('tab-registrations').classList.contains('active');
      if (regTabActive) {
        filterRegistrations();
      }
    }
  });

  socket.on('registration_deleted', (deletedId) => {
    allRegistrations = allRegistrations.filter(r => r.id !== deletedId);
    updateRegistrationStats(allRegistrations);
    const regTabActive = document.getElementById('tab-registrations').classList.contains('active');
    if (regTabActive) {
      filterRegistrations();
    }
  });
}

// 13. Learned Knowledge Manager (RAG Auto-Learn)
async function loadLearnedKnowledge() {
  try {
    const res = await fetch('/api/learned-knowledge');
    const data = await res.json();
    renderLearnedKnowledgeList(data);
  } catch (err) {
    console.error('Failed to load learned knowledge:', err);
  }
}

function renderLearnedKnowledgeList(data) {
  const container = document.getElementById('learned-knowledge-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (!data || data.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 13px;">Chưa học được tri thức nào từ cuộc hội thoại của Admin.</div>`;
    return;
  }
  
  // Clone to avoid reversing active array in memory multiple times
  const displayData = [...data];
  displayData.reverse().forEach((item) => {
    const card = document.createElement('div');
    card.className = 'learned-qa-card';
    card.style = 'background-color: var(--bg-dark-elevated); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; position: relative; margin-top: 8px;';
    
    let isVector = item.embedding ? `<span class="badge-platform messenger" style="font-size: 8px; padding: 1px 4px;">Vector API</span>` : `<span class="badge-platform test" style="font-size: 8px; padding: 1px 4px;">Local RAG</span>`;
    
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.04); padding-bottom: 4px; margin-bottom: 4px;">
        <span style="font-size: 10px; color: var(--text-muted);">${new Date(item.timestamp).toLocaleString('vi-VN')}</span>
        ${isVector}
      </div>
      <div style="font-size: 12px; color: var(--primary-light); font-weight: 600;"><span style="color: var(--text-muted); font-weight: 500;">Hỏi:</span> ${escapeHtml(item.question)}</div>
      <div style="font-size: 12px; color: var(--success); font-weight: 500;"><span style="color: var(--text-muted); font-weight: 500;">Đáp:</span> ${escapeHtml(item.answer)}</div>
    `;
    container.appendChild(card);
  });
}

async function clearLearnedKnowledge() {
  if (!confirm('Bạn có chắc chắn muốn xóa toàn bộ tri thức tự học từ Admin không? (Hành động này không thể hoàn tác)')) return;
  
  try {
    const res = await fetch('/api/learned-knowledge', { method: 'DELETE' });
    const result = await res.json();
    if (res.ok) {
      showToast(result.message || 'Đã xóa tri thức tự học.', 'success');
      await loadLearnedKnowledge();
    } else {
      showToast('Xóa tri thức tự học thất bại.', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối tới server.', 'error');
  }
}

// 14. Registrations & Leads Management (Thống kê chốt đơn)
async function loadRegistrations(silent = false) {
  try {
    const res = await fetch('/api/registrations');
    if (!res.ok) throw new Error();
    allRegistrations = await res.json();
    
    // Update stats cards in UI
    updateRegistrationStats(allRegistrations);
    
    // Render list
    renderRegistrationsList(allRegistrations);
    
    if (!silent) console.log('Registrations loaded from server');
  } catch (err) {
    if (!silent) showToast('Lỗi khi tải danh sách đăng ký học.', 'error');
  }
}

function updateRegistrationStats(list) {
  const total = list.length;
  const messenger = list.filter(r => r.platform === 'messenger').length;
  const whatsapp = list.filter(r => r.platform === 'whatsapp').length;
  const closed = list.filter(r => r.status === 'Đã chốt đơn').length;
  
  const totalEl = document.getElementById('stat-reg-total');
  const messengerEl = document.getElementById('stat-reg-messenger');
  const whatsappEl = document.getElementById('stat-reg-whatsapp');
  const closedEl = document.getElementById('stat-reg-closed');
  
  if (totalEl) totalEl.textContent = total;
  if (messengerEl) messengerEl.textContent = messenger;
  if (whatsappEl) whatsappEl.textContent = whatsapp;
  if (closedEl) closedEl.textContent = closed;

  // Update funnel stats
  updateFunnelAnalytics();
}

function renderRegistrationsList(list) {
  const container = document.getElementById('registrations-table-body');
  if (!container) return;
  container.innerHTML = '';
  
  if (!list || list.length === 0) {
    container.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px; font-size: 13px;">Chưa ghi nhận lượt đăng ký học nào.</td></tr>`;
    return;
  }
  
  list.forEach(item => {
    const tr = document.createElement('tr');
    tr.style = 'border-bottom: 1px solid var(--border-color); transition: background-color 0.2s;';
    
    const timeStr = new Date(item.timestamp).toLocaleString('vi-VN');
    
    // Platform badge
    let platformBadge = `<span class="badge-platform sys">Chưa rõ</span>`;
    if (item.platform === 'messenger') {
      platformBadge = `<span class="badge-platform messenger"><i class="fa-brands fa-facebook-messenger"></i> FB</span>`;
    } else if (item.platform === 'whatsapp') {
      platformBadge = `<span class="badge-platform whatsapp"><i class="fa-brands fa-whatsapp"></i> WA</span>`;
    } else if (item.platform === 'test') {
      platformBadge = `<span class="badge-platform test"><i class="fa-solid fa-flask"></i> Sim</span>`;
    }
    
    // Status select element with direct onchange handler
    const statuses = ['Chờ tư vấn', 'Đang tư vấn', 'Đã chốt đơn', 'Từ chối'];
    let statusOptions = statuses.map(s => `
      <option value="${s}" ${item.status === s ? 'selected' : ''}>${s}</option>
    `).join('');
    
    // Status text color based on value
    let statusSelectClass = 'select-status-waiting';
    if (item.status === 'Đang tư vấn') statusSelectClass = 'select-status-inprogress';
    if (item.status === 'Đã chốt đơn') statusSelectClass = 'select-status-success';
    if (item.status === 'Từ chối') statusSelectClass = 'select-status-danger';

    tr.innerHTML = `
      <td style="padding: 14px 16px; font-weight: 600;">${escapeHtml(item.name)}</td>
      <td style="padding: 14px 16px; font-weight: 500; color: var(--primary-light);">${escapeHtml(item.phone)}</td>
      <td style="padding: 14px 16px;">${platformBadge}</td>
      <td style="padding: 14px 16px; color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</td>
      <td style="padding: 14px 16px; color: var(--text-muted); font-size: 11.5px;">${timeStr}</td>
      <td style="padding: 14px 16px;">
        <select class="custom-select status-select-el ${statusSelectClass}" onchange="changeRegistrationStatus('${item.id}', this.value)" style="margin-bottom: 0; padding: 4px 8px; font-size: 12px; width: 120px; font-weight: 600;">
          ${statusOptions}
        </select>
      </td>
      <td style="padding: 14px 16px; text-align: right;">
        <button class="btn-icon-only delete-btn" onclick="deleteRegistration('${item.id}')" title="Xóa khách hàng" style="width: 28px; height: 28px;">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </td>
    `;
    
    container.appendChild(tr);
  });
}

function filterRegistrations() {
  const platformFilter = document.getElementById('filter-reg-platform').value;
  const statusFilter = document.getElementById('filter-reg-status').value;
  
  let filtered = allRegistrations;
  if (platformFilter !== 'all') {
    filtered = filtered.filter(r => r.platform === platformFilter);
  }
  if (statusFilter !== 'all') {
    filtered = filtered.filter(r => r.status === statusFilter);
  }
  
  renderRegistrationsList(filtered);
}

async function changeRegistrationStatus(id, newStatus) {
  try {
    const res = await fetch(`/api/registrations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    
    const result = await res.json();
    if (res.ok && result.success) {
      showToast(`Đã chuyển trạng thái sang "${newStatus}".`, 'success');
      // Update local state item to keep stats consistent
      const item = allRegistrations.find(r => r.id === id);
      if (item) {
        item.status = newStatus;
        updateRegistrationStats(allRegistrations);
        
        // Re-apply current filtering to keep view clean
        filterRegistrations();
      }
    } else {
      showToast('Không thể cập nhật trạng thái.', 'error');
    }
  } catch (err) {
    showToast('Lỗi mạng khi cập nhật trạng thái.', 'error');
  }
}

async function deleteRegistration(id) {
  if (!confirm('Bạn có chắc muốn xóa lượt đăng ký này khỏi hệ thống không?')) return;
  
  try {
    const res = await fetch(`/api/registrations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Đã xóa lượt đăng ký thành công.', 'success');
      allRegistrations = allRegistrations.filter(r => r.id !== id);
      updateRegistrationStats(allRegistrations);
      filterRegistrations();
    } else {
      showToast('Không thể xóa lượt đăng ký.', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối tới server.', 'error');
  }
}

// 15. Customer Funnel Analytics & Conversion Rates
function calculateCustomerAnalytics() {
  const list = allThreads.filter(t => t.id !== 'tester');
  const regs = allRegistrations;
  
  let closedCount = 0;
  let consultingCount = 0;
  let rejectedCount = 0;
  let inquiringCount = 0;
  let newCount = 0;
  
  list.forEach(t => {
    const reg = regs.find(r => r.customerId === t.id);
    if (reg) {
      if (reg.status === 'Đã chốt đơn') {
        closedCount++;
      } else if (reg.status === 'Từ chối') {
        rejectedCount++;
      } else {
        consultingCount++;
      }
    } else {
      const userLogsCount = allLogs.filter(l => 
        l.type === 'message' && 
        (l.sender === t.id || l.recipient === t.id)
      ).length;
      
      if (userLogsCount <= 2) {
        newCount++;
      } else {
        inquiringCount++;
      }
    }
  });

  return {
    totalCustomers: list.length,
    closed: closedCount,
    consulting: consultingCount + inquiringCount,
    rejected: rejectedCount,
    newLeads: newCount
  };
}

function updateFunnelAnalytics() {
  const stats = calculateCustomerAnalytics();
  
  const totalInboxesEl = document.getElementById('analytics-total-inboxes');
  const totalConsultingEl = document.getElementById('analytics-total-consulting');
  const totalClosedEl = document.getElementById('analytics-total-closed');
  const totalRejectedEl = document.getElementById('analytics-total-rejected');
  const rateEl = document.getElementById('analytics-conversion-rate');
  
  const barConsulting = document.getElementById('bar-total-consulting');
  const barClosed = document.getElementById('bar-total-closed');
  const barRejected = document.getElementById('bar-total-rejected');
  
  if (totalInboxesEl) totalInboxesEl.textContent = `${stats.totalCustomers} người`;
  if (totalConsultingEl) totalConsultingEl.textContent = `${stats.consulting} người`;
  if (totalClosedEl) totalClosedEl.textContent = `${stats.closed} người`;
  if (totalRejectedEl) totalRejectedEl.textContent = `${stats.rejected} người`;
  
  const rate = stats.totalCustomers > 0 ? Math.round((stats.closed / stats.totalCustomers) * 100) : 0;
  if (rateEl) rateEl.textContent = `${rate}%`;
  
  if (barConsulting) {
    const pct = stats.totalCustomers > 0 ? (stats.consulting / stats.totalCustomers) * 100 : 0;
    barConsulting.style.width = `${pct}%`;
  }
  if (barClosed) {
    const pct = stats.totalCustomers > 0 ? (stats.closed / stats.totalCustomers) * 100 : 0;
    barClosed.style.width = `${pct}%`;
  }
  if (barRejected) {
    const pct = stats.totalCustomers > 0 ? (stats.rejected / stats.totalCustomers) * 100 : 0;
    barRejected.style.width = `${pct}%`;
  }
}
