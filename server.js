const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE_NAME = 'botchat_session';
const adminSessions = new Map();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// File paths
const configPath = path.join(__dirname, 'data', 'config.json');
const logsPath = path.join(__dirname, 'data', 'logs.json');
const knowledgePath = path.join(__dirname, 'data', 'knowledge.json');
const knowledgeEmbeddingsPath = path.join(__dirname, 'data', 'knowledge_embeddings.json');
const learnedEmbeddingsPath = path.join(__dirname, 'data', 'learned_embeddings.json');
const registrationsPath = path.join(__dirname, 'data', 'registrations.json');
const publicPath = path.join(__dirname, 'public');
const loginPagePath = path.join(publicPath, 'login.html');
const setupPagePath = path.join(publicPath, 'setup.html');
const dashboardPagePath = path.join(publicPath, 'index.html');

function parseCookies(rawCookie = '') {
  return rawCookie
    .split(';')
    .map(v => v.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eqIndex = part.indexOf('=');
      if (eqIndex === -1) return acc;
      const key = decodeURIComponent(part.slice(0, eqIndex).trim());
      const value = decodeURIComponent(part.slice(eqIndex + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function getSessionTokenFromReq(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[SESSION_COOKIE_NAME] || '';
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { createdAt: new Date().toISOString() });
  return token;
}

function isAuthenticatedRequest(req) {
  const token = getSessionTokenFromReq(req);
  return !!(token && adminSessions.has(token));
}

function getSystemConfig(config = {}) {
  const general = config.general || {};
  return {
    botEnabled: general.botEnabled !== false,
    authEnabled: !!general.authEnabled,
    passwordHash: typeof general.passwordHash === 'string' ? general.passwordHash : ''
  };
}

async function readMainConfig() {
  const config = await fs.readJson(configPath).catch(() => ({}));
  if (!config.general) config.general = {};
  return config;
}

async function persistConfig(config) {
  await fs.writeJson(configPath, config);
}

// Ensure database files exist
const initDB = async () => {
  await fs.ensureDir(path.join(__dirname, 'data'));
  if (!await fs.pathExists(configPath)) {
    await fs.writeJson(configPath, {
      messenger: { pageId: '', accessToken: '', verifyToken: 'my_secure_verify_token_12345', appSecret: '' },
      whatsapp: { phoneNumberId: '', wabaId: '', accessToken: '', verifyToken: 'my_secure_verify_token_12345' },
      general: {
        activePlatform: 'messenger',
        botEnabled: true,
        authEnabled: false,
        passwordHash: ''
      }
    });
  } else {
    const config = await fs.readJson(configPath).catch(() => ({}));
    if (!config.general) config.general = {};
    if (typeof config.general.activePlatform !== 'string') config.general.activePlatform = 'messenger';
    if (typeof config.general.botEnabled !== 'boolean') config.general.botEnabled = true;
    if (typeof config.general.authEnabled !== 'boolean') config.general.authEnabled = false;
    if (typeof config.general.passwordHash !== 'string') config.general.passwordHash = '';
    await fs.writeJson(configPath, config);
  }

  if (!await fs.pathExists(logsPath)) {
    await fs.writeJson(logsPath, []);
  }
  if (!await fs.pathExists(knowledgePath)) {
    await fs.writeJson(knowledgePath, { documents: [], lastTrainedAll: '' });
  } else {
    try {
      const current = await fs.readJson(knowledgePath);
      if (!current.documents) {
        const oldText = current.text || '';
        const oldLastTrained = current.lastTrained || '';
        const migrated = {
          documents: oldText ? [
            {
              id: 'doc_default',
              title: 'Tai lieu mac dinh',
              content: oldText,
              lastTrained: oldLastTrained
            }
          ] : [],
          lastTrainedAll: oldLastTrained
        };
        await fs.writeJson(knowledgePath, migrated);
        console.log('Successfully migrated knowledge.json to multi-document format!');
        
        if (await fs.pathExists(knowledgeEmbeddingsPath)) {
          const chunks = await fs.readJson(knowledgeEmbeddingsPath).catch(() => []);
          chunks.forEach(c => {
            if (!c.documentId) c.documentId = 'doc_default';
          });
          await fs.writeJson(knowledgeEmbeddingsPath, chunks);
        }
      }
    } catch (migErr) {
      console.error('Migration error:', migErr);
    }
  }
  if (!await fs.pathExists(knowledgeEmbeddingsPath)) {
    await fs.writeJson(knowledgeEmbeddingsPath, []);
  }
  if (!await fs.pathExists(learnedEmbeddingsPath)) {
    await fs.writeJson(learnedEmbeddingsPath, []);
  }
  if (!await fs.pathExists(registrationsPath)) {
    await fs.writeJson(registrationsPath, []);
  }
  const activeThreadsPath = path.join(__dirname, 'data', 'active_threads.json');
  if (!await fs.pathExists(activeThreadsPath)) {
    await fs.writeJson(activeThreadsPath, [
      {
        id: 'tester',
        platform: 'test',
        adminReplying: false,
        lastMessage: 'Chào mừng bạn đến với bộ mô phỏng chatbot.',
        lastTimestamp: new Date().toISOString()
      }
    ]);
  }
};
initDB();

// =============================================
// CONVERSATION MEMORY SYSTEM (RAM Cache + File)
// =============================================
const conversationsDir = path.join(__dirname, 'data', 'conversations');
fs.ensureDirSync(conversationsDir);

// RAM Cache: Map<senderId, { messages: [{role, content, timestamp}], summary: string, timer: NodeJS.Timeout }>
const conversationCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 phút
const MAX_HISTORY_TO_AI = 20; // Gửi tối đa 20 tin nhắn gần nhất cho AI
const MAX_MESSAGES_BEFORE_SUMMARY = 40; // Khi file vượt 40 tin thì tóm tắt phần cũ

// Đường dẫn file lịch sử của 1 sender
function getConversationFilePath(senderId) {
  const safeId = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(conversationsDir, `${safeId}.json`);
}

// Đọc lịch sử từ file
async function loadConversationFromFile(senderId) {
  const filePath = getConversationFilePath(senderId);
  try {
    if (await fs.pathExists(filePath)) {
      const data = await fs.readJson(filePath);
      return {
        messages: Array.isArray(data.messages) ? data.messages : [],
        summary: data.summary || ''
      };
    }
  } catch (err) {
    console.error(`Error loading conversation file for ${senderId}:`, err.message);
  }
  return { messages: [], summary: '' };
}

// Ghi lịch sử xuống file
async function saveConversationToFile(senderId, messages, summary) {
  const filePath = getConversationFilePath(senderId);
  try {
    await fs.writeJson(filePath, {
      senderId,
      summary: summary || '',
      messages,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    console.error(`Error saving conversation file for ${senderId}:`, err.message);
  }
}

// Flush cache xuống file khi hết TTL 30p
function flushCacheToFile(senderId) {
  const cached = conversationCache.get(senderId);
  if (!cached) return;
  console.log(`[ConvMemory] Flushing cache to file for ${senderId} (TTL expired)`);
  saveConversationToFile(senderId, cached.messages, cached.summary)
    .then(() => {
      conversationCache.delete(senderId);
      console.log(`[ConvMemory] Cache cleared for ${senderId}`);
    })
    .catch(err => {
      console.error(`[ConvMemory] Error flushing cache for ${senderId}:`, err.message);
    });
}

// Reset timer TTL 30p cho 1 sender
function resetCacheTTL(senderId) {
  const cached = conversationCache.get(senderId);
  if (cached && cached.timer) {
    clearTimeout(cached.timer);
  }
  if (cached) {
    cached.timer = setTimeout(() => flushCacheToFile(senderId), CACHE_TTL_MS);
  }
}

// Lấy lịch sử hội thoại (cache-first, fallback file)
async function getConversationHistory(senderId) {
  // 1. Kiểm tra cache RAM trước
  if (conversationCache.has(senderId)) {
    console.log(`[ConvMemory] Cache HIT for ${senderId}`);
    resetCacheTTL(senderId);
    return conversationCache.get(senderId);
  }

  // 2. Cache MISS → đọc từ file
  console.log(`[ConvMemory] Cache MISS for ${senderId}, loading from file...`);
  const fileData = await loadConversationFromFile(senderId);

  // 3. Nạp vào cache RAM
  const cacheEntry = {
    messages: fileData.messages,
    summary: fileData.summary,
    timer: setTimeout(() => flushCacheToFile(senderId), CACHE_TTL_MS)
  };
  conversationCache.set(senderId, cacheEntry);
  return cacheEntry;
}

// Thêm tin nhắn vào lịch sử
async function addMessageToHistory(senderId, role, content) {
  const history = await getConversationHistory(senderId);
  history.messages.push({
    role,
    content,
    timestamp: new Date().toISOString()
  });

  // Nếu lịch sử quá dài, tạo tóm tắt phần cũ
  if (history.messages.length > MAX_MESSAGES_BEFORE_SUMMARY) {
    const oldMessages = history.messages.slice(0, history.messages.length - MAX_HISTORY_TO_AI);
    const oldText = oldMessages.map(m => `${m.role === 'user' ? 'Khách' : 'Bot'}: ${m.content}`).join('\n');
    
    // Tóm tắt đơn giản bằng cách trích xuất thông tin quan trọng
    const summary = buildConversationSummary(oldText, history.summary);
    history.summary = summary;
    // Chỉ giữ lại tin nhắn gần nhất
    history.messages = history.messages.slice(-MAX_HISTORY_TO_AI);
  }

  resetCacheTTL(senderId);
}

// Tạo tóm tắt từ lịch sử cũ (trích xuất thông tin quan trọng)
function buildConversationSummary(oldText, existingSummary) {
  const lines = oldText.split('\n').filter(l => l.trim());
  const keyInfo = [];

  // Tìm số điện thoại
  const phones = oldText.match(/(\b0[0-9]{9,10}\b)/g);
  if (phones) keyInfo.push(`SĐT: ${[...new Set(phones)].join(', ')}`);

  // Tìm tên (sau các pattern phổ biến)
  const namePatterns = oldText.match(/(?:tên|name|tôi là|mình là|em là|anh là|chị là)\s*[:.]?\s*([^\n,.!?]{2,30})/gi);
  if (namePatterns) {
    const names = namePatterns.map(n => n.replace(/^.*(?:tên|name|tôi là|mình là|em là|anh là|chị là)\s*[:.]?\s*/i, '').trim());
    if (names.length > 0) keyInfo.push(`Tên: ${[...new Set(names)].join(', ')}`);
  }

  // Tìm từ khóa quan tâm
  const interests = [];
  if (/robot|robotics/i.test(oldText)) interests.push('Robotics');
  if (/stem/i.test(oldText)) interests.push('STEM');
  if (/lập trình|coding|code/i.test(oldText)) interests.push('Lập trình');
  if (/scratch/i.test(oldText)) interests.push('Scratch');
  if (/python/i.test(oldText)) interests.push('Python');
  if (interests.length > 0) keyInfo.push(`Quan tâm: ${interests.join(', ')}`);

  // Trạng thái chốt đơn
  if (/đăng ký|đăng kí|chốt|register/i.test(oldText)) keyInfo.push('Trạng thái: Đã quan tâm đăng ký');
  if (/học phí|giá|bao nhiêu|price/i.test(oldText)) keyInfo.push('Đã hỏi về học phí');

  // Giữ lại 5 dòng cuối của lịch sử cũ để không mất ngữ cảnh
  const recentOld = lines.slice(-5).join('\n');

  const summaryParts = [];
  if (existingSummary) summaryParts.push(existingSummary);
  if (keyInfo.length > 0) summaryParts.push(`[Thông tin khách hàng]\n${keyInfo.join('\n')}`);
  if (recentOld) summaryParts.push(`[Đoạn hội thoại trước]\n${recentOld}`);

  return summaryParts.join('\n\n');
}

// Chuẩn bị lịch sử để gửi cho AI (chuyển sang format messages)
function prepareHistoryForAI(history) {
  const result = [];

  // Nếu có tóm tắt, đưa vào đầu tiên
  if (history.summary) {
    result.push({
      role: 'user',
      content: `[Tóm tắt cuộc trò chuyện trước đó với khách hàng này]:\n${history.summary}`
    });
    result.push({
      role: 'assistant',
      content: 'Tôi đã ghi nhận thông tin từ các cuộc trò chuyện trước. Tôi sẽ tiếp tục hỗ trợ khách hàng dựa trên ngữ cảnh này.'
    });
  }

  // Thêm các tin nhắn gần nhất (tối đa MAX_HISTORY_TO_AI)
  const recentMessages = history.messages.slice(-MAX_HISTORY_TO_AI);
  for (const msg of recentMessages) {
    result.push({
      role: msg.role,
      content: msg.content
    });
  }

  return result;
}

io.use((socket, next) => {
  const cookies = parseCookies(socket.request.headers.cookie || '');
  const token = cookies[SESSION_COOKIE_NAME] || '';
  if (!token || !adminSessions.has(token)) {
    return next(new Error('Unauthorized socket connection'));
  }
  return next();
});

// Socket connection debugging
io.on('connection', (socket) => {
  console.log('Socket client connected:', socket.id);
});

app.get(['/', '/index.html'], async (req, res) => {
  try {
    const config = await readMainConfig();
    const authState = getSystemConfig(config);
    if (!authState.passwordHash || !authState.authEnabled) {
      return res.sendFile(setupPagePath);
    }
    if (!isAuthenticatedRequest(req)) {
      return res.sendFile(loginPagePath);
    }
    return res.sendFile(dashboardPagePath);
  } catch (err) {
    return res.status(500).send('Failed to resolve page.');
  }
});

app.use(express.static(publicPath));

// Helper to update active threads list
async function updateThread(customerId, platform, lastMessage) {
  try {
    const threadsFile = path.join(__dirname, 'data', 'active_threads.json');
    const threads = await fs.readJson(threadsFile).catch(() => []);
    let thread = threads.find(t => t.id === customerId);
    if (!thread) {
      thread = {
        id: customerId,
        platform,
        adminReplying: false,
        lastMessage,
        lastTimestamp: new Date().toISOString()
      };
      threads.push(thread);
    } else {
      thread.lastMessage = lastMessage;
      thread.lastTimestamp = new Date().toISOString();
    }
    await fs.writeJson(threadsFile, threads);
  } catch (err) {
    console.error('Failed to update thread:', err);
  }
}

// Helper to automatically learn Q&A pair from admin's reply
async function learnFromAdminReply(customerId, adminReplyText) {
  try {
    const config = await fs.readJson(configPath).catch(() => ({}));
    const logs = await fs.readJson(logsPath).catch(() => []);
    
    // Find the latest incoming message from this customer
    const latestIncoming = logs.find(l => 
      l.type === 'message' && 
      l.direction === 'incoming' && 
      l.sender === customerId
    );
    
    if (!latestIncoming) {
      console.log(`No incoming message found for customer ${customerId} to learn from.`);
      return;
    }
    
    const timeDiffMs = Date.now() - new Date(latestIncoming.timestamp).getTime();
    const halfHourMs = 30 * 60 * 1000;
    
    if (timeDiffMs > halfHourMs) {
      console.log(`Latest incoming message from ${customerId} is too old to learn Q&A pair (>30m).`);
      return;
    }
    
    const customerQuestion = latestIncoming.text;
    if (!customerQuestion || !adminReplyText) return;
    
    // Clean up texts
    const q = customerQuestion.trim();
    const a = adminReplyText.trim();
    
    // Skip if admin reply is a command or very short/empty
    if (a.toLowerCase().startsWith('/admin ') || a.startsWith('/') || q.length < 2 || a.length < 2) {
      return;
    }
    
    const learnedText = `Hi: ${q}\nap: ${a}`;
    
    // Check if this Q&A pair was already learned (avoid duplicates)
    const learnedData = await fs.readJson(learnedEmbeddingsPath).catch(() => []);
    const alreadyLearned = learnedData.some(item => item.text === learnedText);
    if (alreadyLearned) {
      console.log(`Q&A pair already learned: "${q}"`);
      return;
    }
    
    console.log(`Auto-learning Q&A pair: \nQ: "${q}"\nA: "${a}"`);
    
    // Generate Vector Embedding if online RAG, otherwise null
    let embedding = null;
    const isOffline = !!(config.ai && config.ai.useOfflineRag);
    if (config.ai && config.ai.apiKey && (config.ai.provider === 'gemini' || config.ai.provider === 'openai' || config.ai.provider === 'custom') && !isOffline) {
      try {
        embedding = await getAPIEmbedding(learnedText, config);
      } catch (embErr) {
        console.warn('Failed to generate embedding for auto-learned chunk:', embErr.message);
      }
    }
    
    learnedData.push({
      id: `learned_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      question: q,
      answer: a,
      text: learnedText,
      embedding
    });
    
    await fs.writeJson(learnedEmbeddingsPath, learnedData);
    
    // Log activity
    await logActivity({
      direction: 'system',
      platform: latestIncoming.platform || 'system',
      type: 'system',
      sender: 'RAG Auto-Learn',
      recipient: 'Database',
      text: `Tự động học tri thức mới: Hỏi: "${q.substring(0, 30)}..." -> Đáp: "${a.substring(0, 30)}..."`,
      status: 'success'
    });
    
    // Emit socket event to reload learned list in frontend
    if (typeof io !== 'undefined') {
      io.emit('learned_knowledge_updated', learnedData);
    }
    
  } catch (err) {
    console.error('Failed in learnFromAdminReply:', err);
  }
}

// Helper function to log activities
async function logActivity({ direction, platform, type, sender, recipient, text, status, details = '', autoLearn = false }) {
  try {
    const logs = await fs.readJson(logsPath).catch(() => []);
    const newLog = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      direction, // 'incoming', 'outgoing', 'system'
      platform,  // 'messenger', 'whatsapp', 'system'
      type,      // 'message', 'webhook', 'error', 'system'
      sender,
      recipient,
      text,
      status,    // 'success', 'failed', 'info'
      details,
      autoLearn
    };
    logs.unshift(newLog); // Put new log at the beginning
    // Keep only last 200 logs
    if (logs.length > 200) {
      logs.splice(200);
    }
    await fs.writeJson(logsPath, logs);

    // Emit socket event for log
    io.emit('log_added', newLog);

    // Update active threads list on message events
    if (platform !== 'system' && type === 'message') {
      const customerId = direction === 'incoming' ? sender : recipient;
      await updateThread(customerId, platform, text);
      
      // Emit socket events for live chat sync
      io.emit('thread_updated', { customerId, platform, text, timestamp: new Date().toISOString() });
      io.emit('message_added', { customerId, message: newLog });

      // Auto-learn only when explicitly enabled by Live Chat + Admin mode.
      if (autoLearn === true && direction === 'outgoing' && recipient) {
        learnFromAdminReply(customerId, text);
      }
    }

    return newLog;
  } catch (err) {
    console.error('Failed to write log:', err);
  }
}



// Fetch Facebook User Name by ID
async function getFacebookUserName(senderId, accessToken) {
  try {
    const url = `https://graph.facebook.com/v20.0/${senderId}?fields=name&access_token=${accessToken}`;
    const response = await axios.get(url, { timeout: 5000 });
    return response.data?.name || `Người dùng (${senderId})`;
  } catch (err) {
    console.error('Failed to get Facebook user name:', err.message);
    return `Người dùng (${senderId})`;
  }
}

// Meta Message Sender Logic
async function sendMessage(recipient, text, platform, options = {}) {
  const { autoLearn = false } = options;
  const config = await fs.readJson(configPath);
  
  if (platform === 'messenger') {
    const { accessToken } = config.messenger;
    if (!accessToken) {
      throw new Error('Chưa cấu hình Page Access Token cho Messenger.');
    }
    
    const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${accessToken}`;
    const payload = {
      recipient: { id: recipient },
      message: { text: text }
    };
    
    try {
      const response = await axios.post(url, payload, { timeout: 10000 });
      await logActivity({
        direction: 'outgoing',
        platform: 'messenger',
        type: 'message',
        sender: config.messenger.pageId || 'Page',
        recipient,
        text,
        status: 'success',
        details: JSON.stringify(response.data),
        autoLearn
      });
      return response.data;
    } catch (error) {
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      await logActivity({
        direction: 'outgoing',
        platform: 'messenger',
        type: 'error',
        sender: 'System',
        recipient,
        text: `Lỗi gửi tin nhắn: ${text}`,
        status: 'failed',
        details: errorMsg
      });
      throw new Error(errorMsg);
    }
  } else if (platform === 'whatsapp') {
    const { phoneNumberId, accessToken } = config.whatsapp;
    if (!phoneNumberId || !accessToken) {
      throw new Error('Chưa cấu hình Phone Number ID hoặc Access Token cho WhatsApp.');
    }
    
    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { body: text }
    };
    
    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      await logActivity({
        direction: 'outgoing',
        platform: 'whatsapp',
        type: 'message',
        sender: phoneNumberId,
        recipient,
        text,
        status: 'success',
        details: JSON.stringify(response.data),
        autoLearn
      });
      return response.data;
    } catch (error) {
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      await logActivity({
        direction: 'outgoing',
        platform: 'whatsapp',
        type: 'error',
        sender: 'System',
        recipient,
        text: `Lỗi gửi tin nhắn: ${text}`,
        status: 'failed',
        details: errorMsg
      });
      throw new Error(errorMsg);
    }
    } else if (platform === 'test') {
      await logActivity({
        direction: 'outgoing',
        platform: 'test',
        type: 'message',
        sender: 'Admin',
        recipient,
        text,
        status: 'success',
        autoLearn
      });
      return { success: true };
    } else {
      throw new Error('Nền tảng nhắn tin không được hỗ trợ.');
    }
}

// Clean text and tokenize it
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 1);
}

// Compute term frequency for a tokenized text
function getTermFrequency(words) {
  const tf = {};
  words.forEach(word => {
    tf[word] = (tf[word] || 0) + 1;
  });
  return tf;
}

// Cosine similarity for local fallback text similarity
function calculateLocalSimilarity(queryText, chunkText) {
  const queryWords = tokenize(queryText);
  const chunkWords = tokenize(chunkText);
  
  if (queryWords.length === 0 || chunkWords.length === 0) return 0;
  
  const queryTf = getTermFrequency(queryWords);
  const chunkTf = getTermFrequency(chunkWords);
  
  const vocab = new Set([...Object.keys(queryTf), ...Object.keys(chunkTf)]);
  
  let dotProduct = 0;
  let queryMagSq = 0;
  let chunkMagSq = 0;
  
  vocab.forEach(word => {
    const q = queryTf[word] || 0;
    const c = chunkTf[word] || 0;
    dotProduct += q * c;
    queryMagSq += q * q;
    chunkMagSq += c * c;
  });
  
  if (queryMagSq === 0 || chunkMagSq === 0) return 0;
  return dotProduct / (Math.sqrt(queryMagSq) * Math.sqrt(chunkMagSq));
}

// Cosine similarity for arrays of floats
function calculateCosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// API Embedding generator (Gemini or OpenAI)
// API Key Rotation state in memory
let currentApiKeyIndex = 0;
const blacklistedApiKeys = new Set();

// Tự động làm sạch danh sách đen API Keys vào lúc 00:00 hàng ngày
function scheduleMidnightBlacklistReset() {
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1, // Ngày mai
    0, 0, 0, 0        // 00:00:00.000
  );
  const msToMidnight = midnight.getTime() - now.getTime();
  
  setTimeout(() => {
    blacklistedApiKeys.clear();
    console.log(`[System] Đã tự động làm sạch danh sách đen API Keys vào lúc nửa đêm.`);
    logActivity({
      direction: 'system',
      platform: 'system',
      type: 'system',
      sender: 'Hệ thống',
      recipient: 'Database',
      text: 'Tự động làm sạch danh sách đen API Keys vào lúc 00:00 hàng ngày.',
      status: 'success'
    }).catch(err => console.error('Lỗi khi ghi nhật ký reset nửa đêm:', err));
    
    // Lên lịch cho ngày tiếp theo
    scheduleMidnightBlacklistReset();
  }, msToMidnight);
}
scheduleMidnightBlacklistReset();

function getActiveApiKey(apiKeys) {
  const activeKeys = apiKeys.filter(k => !blacklistedApiKeys.has(k));
  if (activeKeys.length === 0) {
    console.warn("Tất cả các API Key cấu hình đã bị đưa vào danh sách đen do lỗi trước đó.");
    return null;
  }
  if (currentApiKeyIndex >= activeKeys.length) {
    currentApiKeyIndex = 0;
  }
  return activeKeys[currentApiKeyIndex];
}

function getErrorStatus(err) {
  if (!err) return 0;
  if (err.response && err.response.status) return err.response.status;
  if (typeof err.status === 'number') return err.status;
  const msg = String(err.message || '');
  const matched = msg.match(/\b([45]\d{2})\b/);
  if (matched) return Number(matched[1]);
  return 0;
}

function isRetryableNetworkError(err) {
  if (!err || !err.code) return false;
  return ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(err.code);
}

function isRotatableStatus(status) {
  return [400, 401, 403, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function sleep(ms) {
  if (!ms || ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

function resolveGeminiTextModel(model) {
  const normalized = (model || '').trim().toLowerCase();
  if (!normalized) return 'gemini-2.5-flash';

  // Live/audio models are unstable for pure text chatbot use-cases.
  // Force them back to a regular text model.
  if (normalized.includes('live') || normalized.includes('native-audio')) {
    return 'gemini-2.5-flash';
  }
  return model;
}

async function generateGeminiText({ apiKey, model, userMessage, systemPrompt, conversationHistory, timeoutMs = 30000 }) {
  const textModel = resolveGeminiTextModel(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${textModel}:generateContent?key=${apiKey}`;
  
  // Xây dựng contents: nếu có lịch sử hội thoại thì dùng multi-turn
  let contents;
  if (conversationHistory && conversationHistory.length > 0) {
    contents = conversationHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  } else {
    contents = [
      {
        role: 'user',
        parts: [{ text: userMessage }]
      }
    ];
  }

  const payload = {
    system_instruction: {
      parts: [{ text: systemPrompt || '' }]
    },
    contents,
    generationConfig: {
      temperature: 0.2,
      topP: 0.9
    }
  };

  const response = await axios.post(url, payload, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' }
  });

  const text = response.data?.candidates?.[0]?.content?.parts
    ?.filter(p => typeof p.text === 'string')
    ?.map(p => p.text)
    ?.join('\n')
    ?.trim();

  if (!text) {
    throw new Error('Gemini generateContent returned empty text.');
  }
  return text;
}

// API Embedding generator (Gemini or OpenAI)
async function getAPIEmbedding(text, config) {
  if (config.ai && config.ai.useOfflineRag) {
    return null;
  }
  const { provider, model, baseUrl, apiKey } = config.ai;
  if (!apiKey) return null;

  const apiKeys = apiKey.split(',').map(k => k.trim()).filter(Boolean);
  if (apiKeys.length === 0) return null;

  let attempts = 0;
  const maxAttempts = Math.max(apiKeys.length * 2, 2);
  let lastError = null;

  while (attempts < maxAttempts) {
    const activeKey = getActiveApiKey(apiKeys);
    try {
      if (provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${activeKey}`;
        const payload = {
          model: "models/text-embedding-004",
          content: {
            parts: [{ text }]
          }
        };
        const response = await axios.post(url, payload, { timeout: 10000 });
        return response.data?.embedding?.values || null;
      } else if (provider === 'openai') {
        const url = 'https://api.openai.com/v1/embeddings';
        const payload = {
          model: "text-embedding-3-small",
          input: text
        };
        const response = await axios.post(url, payload, {
          headers: { 'Authorization': `Bearer ${activeKey}` },
          timeout: 10000
        });
        return response.data?.data?.[0]?.embedding || null;
      } else if (provider === 'custom') {
        if (!baseUrl) return null;
        const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const url = `${cleanBaseUrl}/embeddings`;
        
        // Thu mo hinh embedding-3 cua Zhipu truoc neu la GLM, nguoc lai dung text-embedding-3-small
        let embedModel = model.toLowerCase().includes('glm') ? 'embedding-3' : 'text-embedding-3-small';
        
        try {
          const response = await axios.post(url, { model: embedModel, input: text }, {
            headers: { 
              'Authorization': `Bearer ${activeKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          });
          return response.data?.data?.[0]?.embedding || null;
        } catch (firstErr) {
          // Neu loi va model chua phai la text-embedding-3-small, thu fallback v model chuan cua OpenAI
          if (embedModel !== 'text-embedding-3-small') {
            console.log(`Huấn luyện bằng model ${embedModel} thất bại. Đang thử tự động chuyển sang text-embedding-3-small...`);
            try {
              const fallbackResponse = await axios.post(url, { model: 'text-embedding-3-small', input: text }, {
                headers: { 
                  'Authorization': `Bearer ${activeKey}`,
                  'Content-Type': 'application/json'
                },
                timeout: 10000
              });
              return fallbackResponse.data?.data?.[0]?.embedding || null;
            } catch (secondErr) {
              throw secondErr; // Nem ra loi cuoi cung de log ghi nhan
            }
          }
          throw firstErr;
        }
      }
      return null;
    } catch (err) {
      attempts++;
      lastError = err;
      const status = getErrorStatus(err);
      const isRotatableError = isRotatableStatus(status);
      const canRetrySameKey = apiKeys.length === 1 &&
        (isRetryableStatus(status) || isRetryableNetworkError(err)) &&
        attempts < maxAttempts;
      const backoffMs = Math.min(2000, 300 * attempts);
      
      if (isRotatableError) {
        blacklistedApiKeys.add(activeKey);
        console.log(`Đã đưa API Key ...${activeKey.slice(-6)} vào danh sách đen do lỗi ${status} khi gọi API Embedding.`);
      }

      if (isRotatableError && apiKeys.length > 1) {
        currentApiKeyIndex = (currentApiKeyIndex + 1) % apiKeys.length;
        console.log(`Embedding error: Rotating API Key to index ${currentApiKeyIndex} due to status ${status}.`);
        await sleep(backoffMs);
        continue;
      }

      if (canRetrySameKey) {
        console.log(`Embedding retry on same key due to transient error ${status || err.code}. Attempt ${attempts}/${maxAttempts}.`);
        await sleep(backoffMs);
        continue;
      }
      break; // Stop loop if not rotatable or only 1 key
    }
  }

  // If we reach here, log the final error
  if (lastError) {
    const errorMsg = lastError.response ? JSON.stringify(lastError.response.data) : lastError.message;
    console.error('API Embedding generation failed after all attempts:', errorMsg);
    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'error',
      sender: 'Embedding Engine',
      recipient: 'System',
      text: `Lỗi gửi API Embedding: ${lastError.message}`,
      status: 'failed',
      details: errorMsg
    });
  }
  return null;
}

// Chunk text by paragraph and sentence length
function chunkText(text, maxChars = 400) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  
  paragraphs.forEach(para => {
    const trimmed = para.trim();
    if (!trimmed) return;
    
    if (trimmed.length <= maxChars) {
      chunks.push(trimmed);
    } else {
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let currentChunk = "";
      
      sentences.forEach(sentence => {
        if ((currentChunk + sentence).length <= maxChars) {
          currentChunk += (currentChunk ? " " : "") + sentence;
        } else {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = sentence;
        }
      });
      if (currentChunk) chunks.push(currentChunk);
    }
  });
  return chunks;
}

// Retrieve relevant document chunks for RAG
async function retrieveContext(queryText, config) {
  try {
    const trainedData = await fs.readJson(knowledgeEmbeddingsPath).catch(() => []);
    const learnedData = await fs.readJson(learnedEmbeddingsPath).catch(() => []);
    const combinedData = [...trainedData, ...learnedData];
    
    if (combinedData.length === 0) return "";

    const { provider } = config.ai;
    let queryEmbedding = null;

    if (config.ai && config.ai.apiKey && (provider === 'gemini' || provider === 'openai' || provider === 'custom')) {
      queryEmbedding = await getAPIEmbedding(queryText, config);
    }

    const scoredChunks = [];

    for (const chunk of combinedData) {
      let score = 0;
      
      if (queryEmbedding && chunk.embedding) {
        score = calculateCosineSimilarity(queryEmbedding, chunk.embedding);
      } else {
        score = calculateLocalSimilarity(queryText, chunk.text);
      }
      
      scoredChunks.push({ text: chunk.text, score });
    }

    scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = scoredChunks.filter(c => c.score > 0.12).slice(0, 3);

    if (topChunks.length === 0) return "";
    
    console.log('RAG Retrieved Chunks:', topChunks.map(c => `[Score: ${c.score.toFixed(2)}] ${c.text.substring(0, 50)}...`));
    return topChunks.map(c => c.text).join("\n\n");
  } catch (err) {
    console.error('Error retrieving context:', err);
    return "";
  }
}

// Multi-provider AI Chat Completion Logic
async function generateAIResponse(userMessage, senderId) {
  try {
    const config = await fs.readJson(configPath);
    const system = getSystemConfig(config);
    if (!config.ai || !config.ai.apiKey) {
      console.log('AI configuration or API Key is missing. Skipping AI response.');
      return null;
    }

    const { provider, model, baseUrl, apiKey, systemPrompt } = config.ai;
    const apiKeys = apiKey.split(',').map(k => k.trim()).filter(Boolean);
    if (apiKeys.length === 0) return null;

    // Retrieve relevant context for RAG
    const context = await retrieveContext(userMessage, config);
    const finalSystemPrompt = context 
      ? `${systemPrompt}\n\nSử dụng các thông tin chính thức sau để trả lời khách hàng (Nếu thông tin không đề cập, hãy khéo léo từ chối hoặc hướng dẫn để lại thông tin để nhân viên liên hệ sau, không tự bịa thông tin):\n\n[TÀI LIỆU CỬA HÀNG]:\n${context}`
      : systemPrompt;

    // Lấy lịch sử hội thoại và chuẩn bị cho AI
    let conversationMessages = null;
    if (senderId) {
      const history = await getConversationHistory(senderId);
      conversationMessages = prepareHistoryForAI(history);
    }

    let replyText = null;
    let attempts = 0;
    const maxAttempts = Math.max(apiKeys.length * 2, 2);
    let lastError = null;

    while (attempts < maxAttempts) {
      const activeKey = getActiveApiKey(apiKeys);
      try {
        if (provider === 'gemini') {
          replyText = await generateGeminiText({
            apiKey: activeKey,
            model,
            userMessage,
            systemPrompt: finalSystemPrompt,
            conversationHistory: conversationMessages,
            timeoutMs: 30000
          });
        } else {
          // Standard OpenAI compatible structure (ChatGPT, DeepSeek, Custom)
          let endpoint = '';
          if (provider === 'openai') {
            endpoint = 'https://api.openai.com/v1/chat/completions';
          } else if (provider === 'deepseek') {
            endpoint = 'https://api.deepseek.com/v1/chat/completions';
          } else if (provider === 'custom') {
            if (!baseUrl) throw new Error('Base URL is required for custom OpenAI compatible provider.');
            const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
            endpoint = `${cleanBaseUrl}/chat/completions`;
          }

          // Xây dựng messages với lịch sử hội thoại
          const messages = [{ role: 'system', content: finalSystemPrompt }];
          if (conversationMessages && conversationMessages.length > 0) {
            messages.push(...conversationMessages);
          } else {
            messages.push({ role: 'user', content: userMessage });
          }

          const payload = {
            model: model,
            messages
          };

          const response = await axios.post(endpoint, payload, {
            headers: {
              'Authorization': `Bearer ${activeKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 20000
          });

          if (response.data?.choices?.[0]?.message?.content) {
            replyText = response.data.choices[0].message.content.trim();
          }
        }
        return replyText;
      } catch (error) {
        attempts++;
        lastError = error;
        const status = getErrorStatus(error);
        const isRotatableError = isRotatableStatus(status);
        const canRetrySameKey = apiKeys.length === 1 &&
          (isRetryableStatus(status) || isRetryableNetworkError(error)) &&
          attempts < maxAttempts;
        const backoffMs = Math.min(3000, 350 * attempts);
        const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.warn(`AI Response attempt ${attempts} failed with key: ...${activeKey.slice(-4)}. Error: ${errorMsg}`);

        if (isRotatableError) {
          blacklistedApiKeys.add(activeKey);
          console.log(`Đã đưa API Key ...${activeKey.slice(-6)} vào danh sách đen do lỗi ${status} khi gọi Chat Completion.`);
        }

        if (isRotatableError && apiKeys.length > 1) {
          currentApiKeyIndex = (currentApiKeyIndex + 1) % apiKeys.length;
          console.log(`Rotating API Key to index ${currentApiKeyIndex} due to status ${status}.`);
          await logActivity({
            direction: 'system',
            platform: 'system',
            type: 'webhook',
            sender: 'AI Rotation Engine',
            recipient: 'System',
            text: `Lỗi API key mã trạng thái ${status}. Đang tự động xoay và vô hiệu hóa key lỗi (vị trí ${currentApiKeyIndex + 1}).`,
            status: 'info'
          });
          await sleep(backoffMs);
          continue;
        }

        if (canRetrySameKey) {
          console.log(`Retrying same API key due to transient error ${status || error.code}. Attempt ${attempts}/${maxAttempts}.`);
          await sleep(backoffMs);
          continue;
        }
        break; // Stop loop if not rotatable or only 1 key
      }
    }

    if (lastError) {
      throw lastError;
    }
    return null;
  } catch (error) {
    let cleanMsg = `Lỗi kết nối AI: ${error.message}`;
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      cleanMsg = `Yêu cầu AI quá thời gian phản hồi (Timeout sau 20 giây). Vui lòng thử lại hoặc kiểm tra lại nhà cung cấp AI.`;
    } else if (error.response) {
      const status = error.response.status;
      if (status === 401) {
        cleanMsg = `Lỗi API Key không hợp lệ hoặc hết hạn (Mã lỗi 401: Unauthorized).`;
      } else if (status === 429) {
        cleanMsg = `Lỗi vượt quá hạn mức sử dụng hoặc tài khoản hết số dư (Mã lỗi 429: Too Many Requests).`;
      } else if (status === 503) {
        cleanMsg = `Mô hình AI đang quá tải tạm thời (Mã lỗi 503: UNAVAILABLE). Hệ thống đã thử xoay key và thử lại nhưng chưa thành công.`;
      } else if (status === 404) {
        cleanMsg = `Lỗi không tìm thấy Model hoặc sai địa chỉ Endpoint (Mã lỗi 404: Not Found).`;
      } else {
        cleanMsg = `Lỗi API phản hồi mã trạng thái thất bại (Mã lỗi ${status}).`;
      }
    }
    
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('Error generating AI response:', errorMsg);
    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'error',
      sender: 'AI Engine',
      recipient: 'System',
      text: cleanMsg,
      status: 'failed',
      details: errorMsg
    });
    throw new Error(cleanMsg);
  }
}

// Check if user is asking to speak to admin/human
function isRequestingAdmin(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.toLowerCase().normalize("NFC");
  const keywords = [
    'gặp admin', 'gap admin',
    'gặp ad', 'gap ad',
    'gặp nhân viên', 'gap nhan vien',
    'gặp tư vấn', 'gap tu van',
    'gặp người thật', 'gap nguoi that',
    'nói chuyện với người', 'noi chuyen voi nguoi',
    'liên hệ admin', 'lien he admin',
    'chat với admin', 'chat voi admin',
    'gặp trực tiếp', 'gap truc tiep',
    'hỗ trợ viên', 'ho tro vien',
    'nhân viên hỗ trợ', 'nhan vien ho tro',
    'gặp cskh', 'gap cskh'
  ];
  return keywords.some(keyword => normalized.includes(keyword));
}

// Set adminReplying = true for a customer thread
async function setThreadAdminReplying(customerId, value) {
  try {
    const threadsFile = path.join(__dirname, 'data', 'active_threads.json');
    const threads = await fs.readJson(threadsFile).catch(() => []);
    let thread = threads.find(t => t.id === customerId);
    if (thread) {
      thread.adminReplying = value;
      await fs.writeJson(threadsFile, threads);
      if (typeof io !== 'undefined') {
        io.emit('thread_status_updated', { id: customerId, adminReplying: value });
      }
    }
  } catch (err) {
    console.error('Failed to set thread adminReplying:', err);
  }
}

// Extract Vietnamese phone number from text
function extractPhoneNumber(text) {
  if (typeof text !== 'string') return null;
  const phoneRegex = /(?:\+84|0)(?:\s*\d){9,10}\b/;
  const match = text.match(phoneRegex);
  return match ? match[0].replace(/\s+/g, '') : null;
}

// Add a registration/lead to the database
async function addRegistration({ name, phone, platform, customerId, text }) {
  try {
    const list = await fs.readJson(registrationsPath).catch(() => []);
    // Prevent duplicate entries of the same phone number
    const exists = list.find(r => r.phone === phone);
    if (exists) {
      exists.lastTimestamp = new Date().toISOString();
      exists.text = text;
      await fs.writeJson(registrationsPath, list);
      return false; 
    }
    
    const newReg = {
      id: 'reg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name,
      phone,
      platform,
      customerId,
      text,
      timestamp: new Date().toISOString(),
      status: 'Chờ tư vấn'
    };
    list.unshift(newReg);
    await fs.writeJson(registrationsPath, list);
    
    if (typeof io !== 'undefined') {
      io.emit('registration_added', newReg);
    }
    return newReg;
  } catch (err) {
    console.error('Failed to add registration:', err);
    return false;
  }
}

// Handler for all incoming messages (Rule engine -> AI engine)
async function handleIncomingMessage(messageText, platform, senderId, senderName = null) {
  try {
    const config = await readMainConfig();
    const system = getSystemConfig(config);
    if (!system.botEnabled) {
      await logActivity({
        direction: 'system',
        platform,
        type: 'system',
        sender: 'AI Control',
        recipient: senderId,
        text: 'Bỏ qua phản hồi tự động vì hệ thống đang ở trạng thái TẮT.',
        status: 'info'
      });
      return;
    }


    // 2. Check if Admin is replying to this thread (disable AI)
    const threadsFile = path.join(__dirname, 'data', 'active_threads.json');
    const threads = await fs.readJson(threadsFile).catch(() => []);
    const thread = threads.find(t => t.id === senderId);
    if (thread && thread.adminReplying) {
      console.log(`Thread ${senderId} is marked as Admin Replying. Skipping AI response.`);
      await logActivity({
        direction: 'system',
        platform,
        type: 'system',
        sender: 'AI Control',
        recipient: senderId,
        text: `Bỏ qua phản hồi tự động từ AI vì Admin đang trực tiếp trả lời cuộc trò chuyện này.`,
        status: 'info'
      });
      return;
    }

    // Check if customer wants to contact admin
    if (isRequestingAdmin(messageText)) {
      console.log(`User ${senderId} requested admin support.`);
      await setThreadAdminReplying(senderId, true);
      
      try {
        const adminId = '35910993415213363';
        let resolvedName = senderName;
        if (!resolvedName) {
          if (platform === 'messenger') {
            const accessToken = config.messenger?.accessToken;
            if (accessToken) {
              resolvedName = await getFacebookUserName(senderId, accessToken);
            } else {
              resolvedName = `Facebook User (${senderId})`;
            }
          } else if (platform === 'whatsapp') {
            resolvedName = `WhatsApp SĐT: ${senderId}`;
          } else {
            resolvedName = `Tester (${senderId})`;
          }
        }
        
        const adminMsg = `🔔 [Yêu cầu gặp Admin]
Khách hàng vừa yêu cầu liên hệ trực tiếp với Admin.
- Khách hàng: ${resolvedName}
- Nội dung tin nhắn: "${messageText}"
- Trạng thái: Hệ thống đã tự động chuyển sang chế độ Admin tự trả lời (tắt AI).`;

        await sendMessage(adminId, adminMsg, 'messenger');
        
        // Also send a friendly response to the customer to let them know
        const customerResponse = `Dạ vâng ạ, em đã báo với các anh/chị tư vấn viên của Trung tâm rồi ạ. Anh/Chị vui lòng đợi một chút nhé, các bạn tư vấn sẽ liên hệ trực tiếp hỗ trợ mình ngay ạ! 😊`;
        await sendMessage(senderId, customerResponse, platform);
        
      } catch (err) {
        console.error('Failed to notify admin on human request:', err.message);
      }
      return;
    }

    // Check if customer is providing a phone number to register (chốt đơn)
    const detectedPhone = extractPhoneNumber(messageText);
    if (detectedPhone) {
      let resolvedName = senderName;
      if (!resolvedName) {
        if (platform === 'messenger') {
          const accessToken = config.messenger?.accessToken;
          if (accessToken) {
            resolvedName = await getFacebookUserName(senderId, accessToken);
          } else {
            resolvedName = `Facebook User (${senderId})`;
          }
        } else if (platform === 'whatsapp') {
          resolvedName = `WhatsApp SĐT: ${senderId}`;
        } else {
          resolvedName = `Tester (${senderId})`;
        }
      }
      
      const newReg = await addRegistration({
        name: resolvedName,
        phone: detectedPhone,
        platform,
        customerId: senderId,
        text: messageText
      });
      
      if (newReg) {
        try {
          const adminId = '35910993415213363';
          const adminMsg = `🎉 [Chốt Đơn / Đăng ký mới]
Có khách hàng vừa để lại số điện thoại đăng ký học!
- Họ tên: ${resolvedName}
- Số điện thoại: ${detectedPhone}
- Nền tảng: ${platform}
- Tin nhắn: "${messageText}"
- Trạng thái: Đã lưu vào danh sách thống kê.`;
          
          await sendMessage(adminId, adminMsg, 'messenger');
          console.log(`Đã gửi thông báo đăng ký mới của ${resolvedName} tới admin`);
        } catch (err) {
          console.error('Failed to notify admin on registration:', err.message);
        }
      }
    }

    // 3. Fallback to AI response
    try {
      // Lưu tin nhắn của khách vào lịch sử hội thoại
      await addMessageToHistory(senderId, 'user', messageText);

      const aiResponse = await generateAIResponse(messageText, senderId);
      if (aiResponse) {
        // Lưu phản hồi AI vào lịch sử hội thoại
        await addMessageToHistory(senderId, 'assistant', aiResponse);

        await logActivity({
          direction: 'system',
          platform,
          type: 'message',
          sender: 'AI Chatbot',
          recipient: senderId,
          text: `AI Phản hồi: "${aiResponse}"`,
          status: 'info'
        });
        await sendMessage(senderId, aiResponse, platform);
      }
    } catch (aiErr) {
      console.error('AI Fallback error in webhook:', aiErr.message);
      try {
        const adminId = '35910993415213363';
        let resolvedName = senderName;
        if (!resolvedName) {
          if (platform === 'messenger') {
            const accessToken = config.messenger?.accessToken;
            if (accessToken) {
              resolvedName = await getFacebookUserName(senderId, accessToken);
            } else {
              resolvedName = `Facebook User (${senderId})`;
            }
          } else if (platform === 'whatsapp') {
            resolvedName = `WhatsApp SĐT: ${senderId}`;
          } else {
            resolvedName = `Tester (${senderId})`;
          }
        }
        
        const adminMsg = `🚨 [Thông báo lỗi AI]
Có người vừa nhắn tin tới bot nhưng không gọi được AI.
- Người nhắn: ${resolvedName}
- Lý do lỗi: Hết token hoặc lỗi kết nối AI (${aiErr.message || 'Unknown error'})`;

        await sendMessage(adminId, adminMsg, 'messenger');
        console.log(`Đã báo cáo lỗi AI đến admin ${adminId}`);
      } catch (adminErr) {
        console.error('Lỗi khi gửi thông báo lỗi AI đến admin:', adminErr.message);
      }
    }
  } catch (err) {
    console.error('Error handling incoming message:', err);
  }
}

// REST API Endpoints

app.get('/api/auth/me', async (req, res) => {
  try {
    const config = await readMainConfig();
    const system = getSystemConfig(config);
    const isAuthenticated = isAuthenticatedRequest(req);
    res.json({
      authenticated: isAuthenticated,
      setupRequired: !system.passwordHash || !system.authEnabled,
      botEnabled: system.botEnabled
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve auth state.' });
  }
});

app.post('/api/auth/setup', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== 'string' || password.trim().length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const config = await readMainConfig();
    const system = getSystemConfig(config);
    if (system.passwordHash && system.authEnabled) {
      return res.status(400).json({ error: 'Password is already configured.' });
    }

    const passwordHash = await bcrypt.hash(password.trim(), 10);
    config.general.passwordHash = passwordHash;
    config.general.authEnabled = true;
    if (typeof config.general.botEnabled !== 'boolean') {
      config.general.botEnabled = true;
    }
    await persistConfig(config);

    const token = createSession();
    setSessionCookie(res, token);
    return res.json({ success: true, message: 'Setup completed.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to setup password.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    const config = await readMainConfig();
    const system = getSystemConfig(config);
    if (!system.passwordHash || !system.authEnabled) {
      return res.status(400).json({ error: 'Setup is required before login.' });
    }
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    const valid = await bcrypt.compare(password, system.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password.' });
    }

    const token = createSession();
    setSessionCookie(res, token);
    return res.json({ success: true, message: 'Login successful.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to login.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = getSessionTokenFromReq(req);
  if (token) {
    adminSessions.delete(token);
  }
  clearSessionCookie(res);
  return res.json({ success: true });
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!isAuthenticatedRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Missing currentPassword or newPassword.' });
    }
    if (newPassword.trim().length < 6) {
      return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
    }

    const config = await readMainConfig();
    const system = getSystemConfig(config);
    if (!system.passwordHash || !system.authEnabled) {
      return res.status(400).json({ error: 'Hệ thống chưa được thiết lập mật khẩu.' });
    }

    const valid = await bcrypt.compare(currentPassword, system.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng.' });
    }

    config.general.passwordHash = await bcrypt.hash(newPassword.trim(), 10);
    config.general.authEnabled = true;
    await persistConfig(config);

    return res.json({ success: true, message: 'Đổi mật khẩu thành công.' });
  } catch (err) {
    return res.status(500).json({ error: 'Không thể đổi mật khẩu lúc này.' });
  }
});

app.use('/api', async (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  try {
    const config = await readMainConfig();
    const system = getSystemConfig(config);
    if (!system.passwordHash || !system.authEnabled) {
      return res.status(401).json({ error: 'Setup required.', setupRequired: true });
    }
    if (!isAuthenticatedRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Auth middleware failed.' });
  }
});

// Registrations (Leads) APIs
app.get('/api/registrations', async (req, res) => {
  try {
    const data = await fs.readJson(registrationsPath).catch(() => []);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Không thể đọc danh sách đăng ký.' });
  }
});

app.put('/api/registrations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const list = await fs.readJson(registrationsPath).catch(() => []);
    const item = list.find(r => r.id === id);
    if (!item) {
      return res.status(404).json({ error: 'Không tìm thấy lượt đăng ký.' });
    }
    item.status = status;
    await fs.writeJson(registrationsPath, list);
    
    // Notify all admin clients via socket
    if (typeof io !== 'undefined') {
      io.emit('registration_updated', item);
    }
    
    res.json({ success: true, registration: item });
  } catch (err) {
    res.status(500).json({ error: 'Không thể cập nhật trạng thái đăng ký.' });
  }
});

app.delete('/api/registrations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let list = await fs.readJson(registrationsPath).catch(() => []);
    const filtered = list.filter(r => r.id !== id);
    await fs.writeJson(registrationsPath, filtered);
    
    // Notify all admin clients via socket
    if (typeof io !== 'undefined') {
      io.emit('registration_deleted', id);
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa lượt đăng ký.' });
  }
});

// 0. Knowledge Base (RAG) APIs
app.get('/api/knowledge', async (req, res) => {
  try {
    const data = await fs.readJson(knowledgePath);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Không thể đọc tài liệu tri thức.' });
  }
});

app.post('/api/knowledge', async (req, res) => {
  const { id, title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'Tiêu đề và nội dung tài liệu không được để trống.' });
  }

  try {
    const config = await fs.readJson(configPath);
    const knowledgeData = await fs.readJson(knowledgePath);
    
    let doc;
    const nowStr = new Date().toISOString();
    
    if (id) {
      // Edit existing
      doc = knowledgeData.documents.find(d => d.id === id);
      if (!doc) {
        return res.status(404).json({ error: 'Không tìm thấy tài liệu cần cập nhật.' });
      }
      doc.title = title;
      doc.content = content;
      doc.lastTrained = nowStr;
    } else {
      // Create new
      doc = {
        id: 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title,
        content,
        lastTrained: nowStr
      };
      knowledgeData.documents.push(doc);
    }
    
    // Perform incremental training for this document
    const chunks = chunkText(content);
    const newTrainedChunks = [];
    const isOffline = !!(config.ai && config.ai.useOfflineRag);
    
    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'system',
      sender: 'RAG Engine',
      recipient: 'Database',
      text: `Bắt đầu huấn luyện tài liệu "${title}" (${chunks.length} đoạn) - ${isOffline ? 'RAG Cục bộ (Offline)' : 'RAG Vector API'}...`,
      status: 'info'
    });

    let successEmbeddings = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let embedding = null;
      
      if (config.ai && config.ai.apiKey && (config.ai.provider === 'gemini' || config.ai.provider === 'openai' || config.ai.provider === 'custom') && !isOffline) {
        try {
          embedding = await getAPIEmbedding(chunk, config);
          if (embedding) successEmbeddings++;
        } catch (embErr) {
          console.warn(`Failed to generate embedding for chunk ${i} of document ${doc.id}:`, embErr.message);
        }
      }

      newTrainedChunks.push({
        id: `chunk_${doc.id}_${i}_${Date.now()}`,
        documentId: doc.id,
        text: chunk,
        embedding
      });
    }

    // Update embeddings file: filter out old chunks of this document, then append new ones
    const allEmbeddings = await fs.readJson(knowledgeEmbeddingsPath).catch(() => []);
    const remainingEmbeddings = allEmbeddings.filter(c => c.documentId !== doc.id);
    const updatedEmbeddings = [...remainingEmbeddings, ...newTrainedChunks];
    
    await fs.writeJson(knowledgeEmbeddingsPath, updatedEmbeddings);
    
    // Save updated document list
    knowledgeData.lastTrainedAll = nowStr;
    await fs.writeJson(knowledgePath, knowledgeData);

    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'system',
      sender: 'RAG Engine',
      recipient: 'Database',
      text: `Huấn luyện tài liệu "${title}" hoàn tất. Số đoạn: ${chunks.length}, Số vector API: ${successEmbeddings}`,
      status: 'success'
    });

    res.json({
      message: `Huấn luyện tài liệu "${title}" thành công. Cắt thành ${chunks.length} đoạn. Số đoạn tạo vector API: ${successEmbeddings}`,
      document: doc
    });
  } catch (err) {
    console.error('Training error:', err);
    res.status(500).json({ error: 'Lỗi huấn luyện tài liệu tri thức.' });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const knowledgeData = await fs.readJson(knowledgePath);
    const docIndex = knowledgeData.documents.findIndex(d => d.id === id);
    
    if (docIndex === -1) {
      return res.status(404).json({ error: 'Không tìm thấy tài liệu cần xóa.' });
    }
    
    const docTitle = knowledgeData.documents[docIndex].title;
    knowledgeData.documents.splice(docIndex, 1);
    
    // Save documents
    await fs.writeJson(knowledgePath, knowledgeData);
    
    // Remove chunks from embeddings
    const allEmbeddings = await fs.readJson(knowledgeEmbeddingsPath).catch(() => []);
    const remainingEmbeddings = allEmbeddings.filter(c => c.documentId !== id);
    await fs.writeJson(knowledgeEmbeddingsPath, remainingEmbeddings);
    
    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'system',
      sender: 'RAG Engine',
      recipient: 'Database',
      text: `Đã xóa tài liệu "${docTitle}" và toàn bộ chỉ mục RAG liên quan.`,
      status: 'success'
    });
    
    res.json({ message: `Đã xóa tài liệu "${docTitle}" thành công.` });
  } catch (err) {
    console.error('Delete document error:', err);
    res.status(500).json({ error: 'Không thể xóa tài liệu tri thức.' });
  }
});

// 0.1 Test Chat simulator endpoint
app.post('/api/test-chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Nội dung tin nhắn trống.' });
  }

  try {
    const config = await fs.readJson(configPath);

    const system = getSystemConfig(config);
    
    // Log the incoming message from tester
    await logActivity({
      direction: 'incoming',
      platform: 'test',
      type: 'message',
      sender: 'tester',
      recipient: 'System',
      text: message,
      status: 'success'
    });



    if (!system.botEnabled) {
      await logActivity({
        direction: 'system',
        platform: 'test',
        type: 'system',
        sender: 'AI Control',
        recipient: 'tester',
        text: 'Bỏ qua phản hồi tự động vì hệ thống đang ở trạng thái TẮT.',
        status: 'info'
      });
      return res.json({
        success: true,
        response: 'Hệ thống đang tắt, bot không phản hồi tự động.',
        source: 'system',
        context: null
      });
    }

    // 2. Retrieve context for debug
    const context = await retrieveContext(message, config);

    // 3. Call AI (Only if Admin is not replying to tester thread)
    const threadsFile = path.join(__dirname, 'data', 'active_threads.json');
    const threads = await fs.readJson(threadsFile).catch(() => []);
    const thread = threads.find(t => t.id === 'tester');
    let aiResponse = null;
    
    if (thread && thread.adminReplying) {
      console.log('Thread tester is marked as Admin Replying. Skipping AI response in simulator.');
      await logActivity({
        direction: 'system',
        platform: 'test',
        type: 'system',
        sender: 'AI Control',
        recipient: 'tester',
        text: `Bỏ qua phản hồi tự động từ AI trong Simulator vì Admin đang trả lời.`,
        status: 'info'
      });
    } else {
      // Lưu tin nhắn tester vào lịch sử
      await addMessageToHistory('tester', 'user', message);

      aiResponse = await generateAIResponse(message, 'tester');
      if (aiResponse) {
        // Lưu phản hồi AI vào lịch sử
        await addMessageToHistory('tester', 'assistant', aiResponse);

        await logActivity({
          direction: 'outgoing',
          platform: 'test',
          type: 'message',
          sender: 'AI Chatbot',
          recipient: 'tester',
          text: aiResponse,
          status: 'success'
        });
      }
    }
    
    res.json({
      success: true,
      response: aiResponse || (thread && thread.adminReplying ? 'Admin đang trực tiếp trả lời... (AI đã tắt)' : 'AI không phản hồi.'),
      source: 'ai',
      context: context || null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Lỗi không xác định khi kết nối với AI.'
    });
  }
});

// 0.2 Threads and Live Chat APIs
app.get('/api/threads', async (req, res) => {
  try {
    const config = await fs.readJson(configPath);
    const threadsFile = path.join(__dirname, 'data', 'active_threads.json');
    const localThreads = await fs.readJson(threadsFile).catch(() => []);
    
    let fbThreads = [];
    
    // 1. Try to fetch from Facebook Graph API if accessToken is configured
    if (config.messenger && config.messenger.accessToken && config.general.activePlatform === 'messenger') {
      try {
        const pageId = config.messenger.pageId;
        const accessToken = config.messenger.accessToken;
        const url = `https://graph.facebook.com/v20.0/me/conversations?fields=participants,messages.limit(1){message,from},updated_time&access_token=${accessToken}`;
        
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data && response.data.data) {
          fbThreads = response.data.data.map(thread => {
            const customer = thread.participants?.data?.find(p => p.id !== pageId) || thread.participants?.data?.[0];
            const lastMsgObj = thread.messages?.data?.[0];
            
            return {
              id: customer ? customer.id : thread.id,
              name: customer ? customer.name : 'Người dùng Facebook',
              platform: 'messenger',
              lastMessage: lastMsgObj ? lastMsgObj.message : 'Tin nhan phuong tien...',
              lastTimestamp: thread.updated_time
            };
          });
        }
      } catch (fbErr) {
        console.warn('Failed to fetch threads from Facebook:', fbErr.message);
      }
    }
    
    // 2. Merge local threads
    const mergedThreads = [];
    
    // Always include tester
    let testerThread = localThreads.find(t => t.id === 'tester');
    if (!testerThread) {
      testerThread = {
        id: 'tester',
        name: 'Người dùng Thử nghiệm (Simulator)',
        platform: 'test',
        adminReplying: false,
        lastMessage: 'Chào mừng bạn đến với bộ mô phỏng chatbot.',
        lastTimestamp: new Date().toISOString()
      };
    } else {
      testerThread.name = 'Người dùng Thử nghiệm (Simulator)';
    }
    mergedThreads.push(testerThread);
    
    // Add Facebook threads
    fbThreads.forEach(fbT => {
      const localT = localThreads.find(lt => lt.id === fbT.id);
      mergedThreads.push({
        ...fbT,
        adminReplying: localT ? !!localT.adminReplying : false
      });
    });
    
    // Add other local threads (e.g. WhatsApp threads)
    localThreads.forEach(localT => {
      if (localT.id === 'tester') return;
      if (mergedThreads.some(mt => mt.id === localT.id)) return;
      
      mergedThreads.push({
        ...localT,
        name: localT.name || `Khách hàng (${localT.id.substring(0, 8)})`
      });
    });
    
    // Sort
    const tester = mergedThreads.filter(t => t.id === 'tester');
    const others = mergedThreads.filter(t => t.id !== 'tester');
    others.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));
    
    const finalThreads = [...tester, ...others];
    
    // Sync back to localThreads
    for (const thread of finalThreads) {
      const index = localThreads.findIndex(t => t.id === thread.id);
      if (index === -1) {
        localThreads.push({
          id: thread.id,
          platform: thread.platform,
          adminReplying: thread.adminReplying || false,
          lastMessage: thread.lastMessage,
          lastTimestamp: thread.lastTimestamp,
          name: thread.name
        });
      } else {
        localThreads[index].lastMessage = thread.lastMessage;
        localThreads[index].lastTimestamp = thread.lastTimestamp;
        if (thread.name) {
          localThreads[index].name = thread.name;
        }
      }
    }
    await fs.writeJson(threadsFile, localThreads);
    
    res.json(finalThreads);
  } catch (err) {
    console.error('Error fetching threads:', err);
    res.status(500).json({ error: 'Không thể đọc danh sách cuộc trò chuyện.' });
  }
});

app.post('/api/threads/:id/admin-reply', async (req, res) => {
  try {
    const { id } = req.params;
    const { adminReplying } = req.body;
    const threadsFile = path.join(__dirname, 'data', 'active_threads.json');
    const threads = await fs.readJson(threadsFile).catch(() => []);
    const thread = threads.find(t => t.id === id);
    if (thread) {
      thread.adminReplying = !!adminReplying;
      await fs.writeJson(threadsFile, threads);
      
      // Emit socket event to notify other clients/views
      io.emit('thread_status_updated', { id, adminReplying: thread.adminReplying });
      
      res.json({ success: true, thread });
    } else {
      res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Không thể cập nhật trạng thái Admin trả lời.' });
  }
});

app.get('/api/threads/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const config = await fs.readJson(configPath);
    
    // Always read tester from local logs
    if (id === 'tester') {
      const logs = await fs.readJson(logsPath).catch(() => []);
      const threadMessages = logs.filter(l => 
        l.type === 'message' && 
        (l.sender === id || l.recipient === id)
      );
      return res.json(threadMessages.reverse());
    }
    
    // If Facebook is configured, fetch from Facebook Graph API
    if (config.messenger && config.messenger.accessToken && config.general.activePlatform === 'messenger') {
      try {
        const pageId = config.messenger.pageId;
        const accessToken = config.messenger.accessToken;
        
        const convUrl = `https://graph.facebook.com/v20.0/me/conversations?fields=participants&access_token=${accessToken}`;
        const convResponse = await axios.get(convUrl, { timeout: 4000 });
        const threads = convResponse.data?.data || [];
        const matchingThread = threads.find(t => 
          t.participants?.data?.some(p => p.id === id)
        );
        
        if (matchingThread) {
          const msgUrl = `https://graph.facebook.com/v20.0/${matchingThread.id}/messages?fields=message,created_time,from&limit=25&access_token=${accessToken}`;
          const msgResponse = await axios.get(msgUrl, { timeout: 4000 });
          const rawMessages = msgResponse.data?.data || [];
          
          const formattedMessages = rawMessages.map(msg => {
            const isIncoming = msg.from?.id !== pageId;
            return {
              id: msg.id,
              timestamp: msg.created_time,
              direction: isIncoming ? 'incoming' : 'outgoing',
              platform: 'messenger',
              type: 'message',
              sender: msg.from?.id === pageId ? 'Admin' : (msg.from?.name || msg.from?.id),
              recipient: isIncoming ? 'Page' : id,
              text: msg.message,
              status: 'success'
            };
          });
          
          return res.json(formattedMessages.reverse());
        }
      } catch (fbErr) {
        console.warn('Failed to fetch messages from Facebook Graph API:', fbErr.message);
      }
    }
    
    // Fallback to local logs
    const logs = await fs.readJson(logsPath).catch(() => []);
    const threadMessages = logs.filter(l => 
      l.type === 'message' && 
      (l.sender === id || l.recipient === id)
    );
    res.json(threadMessages.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải lịch sử tin nhắn.' });
  }
});

// 1. Get/Save configurations
app.get('/api/config', async (req, res) => {
  try {
    const config = await fs.readJson(configPath);
    const safeConfig = JSON.parse(JSON.stringify(config || {}));
    if (!safeConfig.general) safeConfig.general = {};
    delete safeConfig.general.passwordHash;
    res.json(safeConfig);
  } catch (err) {
    res.status(500).json({ error: 'Không thể đọc file cấu hình.' });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const incoming = req.body || {};
    const current = await readMainConfig();
    const merged = {
      ...current,
      ...incoming,
      general: {
        ...current.general,
        ...(incoming.general || {})
      }
    };
    merged.general.passwordHash = current.general.passwordHash || '';
    merged.general.authEnabled = !!current.general.authEnabled;
    if (typeof merged.general.botEnabled !== 'boolean') {
      merged.general.botEnabled = current.general.botEnabled !== false;
    }

    blacklistedApiKeys.clear();
    console.log('Đã làm sạch danh sách đen API Keys do cấu hình thay đổi.');

    await fs.writeJson(configPath, merged);
    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'system',
      sender: 'Admin',
      recipient: 'Server',
      text: 'Cập nhật cấu hình API Meta',
      status: 'success'
    });

    const safeConfig = JSON.parse(JSON.stringify(merged));
    delete safeConfig.general.passwordHash;
    res.json({ message: 'Cấu hình đã được lưu thành công.', config: safeConfig });
  } catch (err) {
    res.status(500).json({ error: 'Không thể lưu cấu hình.' });
  }
});

app.get('/api/system/status', async (req, res) => {
  try {
    const config = await readMainConfig();
    const system = getSystemConfig(config);
    return res.json({ botEnabled: system.botEnabled });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read system status.' });
  }
});

app.post('/api/system/status', async (req, res) => {
  try {
    const { botEnabled } = req.body || {};
    if (typeof botEnabled !== 'boolean') {
      return res.status(400).json({ error: 'botEnabled must be boolean.' });
    }
    const config = await readMainConfig();
    config.general.botEnabled = botEnabled;
    await persistConfig(config);
    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'system',
      sender: 'Admin',
      recipient: 'Server',
      text: botEnabled ? 'Bật hệ thống chatbot.' : 'Tắt hệ thống chatbot.',
      status: 'success'
    });
    io.emit('system_status_updated', { botEnabled });
    return res.json({ success: true, botEnabled });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update system status.' });
  }
});



// 2.1 Get/Delete Learned Knowledge (RAG Auto-Learn)
app.get('/api/learned-knowledge', async (req, res) => {
  try {
    const data = await fs.readJson(learnedEmbeddingsPath).catch(() => []);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Không thể đọc tri thức tự học.' });
  }
});

app.delete('/api/learned-knowledge', async (req, res) => {
  try {
    await fs.writeJson(learnedEmbeddingsPath, []);
    await logActivity({
      direction: 'system',
      platform: 'system',
      type: 'system',
      sender: 'Admin',
      recipient: 'Database',
      text: 'Xóa toàn bộ tri thức RAG tự động học từ Admin',
      status: 'success'
    });
    res.json({ message: 'Đã xóa toàn bộ tri thức tự học.' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa tri thức tự học.' });
  }
});

// 3. Get/Clear Logs
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await fs.readJson(logsPath);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Không thể đọc danh sách logs.' });
  }
});

app.delete('/api/logs', async (req, res) => {
  try {
    await fs.writeJson(logsPath, []);
    res.json({ message: 'Đã xóa toàn bộ nhật ký.' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa logs.' });
  }
});

// 4. Send single message
app.post('/api/send-message', async (req, res) => {
  const { recipient, text, platform, fromLiveChat } = req.body;
  
  if (!recipient || !text || !platform) {
    return res.status(400).json({ error: 'Missing recipient, text, or platform.' });
  }
  
  try {
    let allowAutoLearn = false;

    // Only allow auto-learn from Live Chat/Simulator and only when Admin mode is enabled.
    if (fromLiveChat === true) {
      const threadsFile = path.join(__dirname, 'data', 'active_threads.json');
      const threads = await fs.readJson(threadsFile).catch(() => []);
      const thread = threads.find(t => t.id === recipient);
      allowAutoLearn = !!(thread && thread.adminReplying);
    }

    const data = await sendMessage(recipient, text, platform, { autoLearn: allowAutoLearn });
    res.json({ success: true, message: 'Message sent successfully.', data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// 6. Meta Webhooks Verification (GET)
// Meta checks this when setting up Webhook configuration in the Dashboard
app.get('/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  try {
    const config = await fs.readJson(configPath);
    // Find matching verify token across config
    const isValidToken = 
      token === config.messenger.verifyToken || 
      token === config.whatsapp.verifyToken;
      
    if (mode && token) {
      if (mode === 'subscribe' && isValidToken) {
        console.log('WEBHOOK_VERIFIED');
        await logActivity({
          direction: 'incoming',
          platform: token === config.whatsapp.verifyToken ? 'whatsapp' : 'messenger',
          type: 'webhook',
          sender: 'Meta Cloud',
          recipient: 'Webhook',
          text: `Webhook verification thành công. Verify Token: ${token}`,
          status: 'success'
        });
        return res.status(200).send(challenge);
      } else {
        await logActivity({
          direction: 'incoming',
          platform: 'system',
          type: 'webhook',
          sender: 'Meta Cloud',
          recipient: 'Webhook',
          text: `Webhook verification thất bại. Verify Token gửi lên: ${token}`,
          status: 'failed'
        });
        return res.sendStatus(403);
      }
    }
  } catch (err) {
    res.sendStatus(500);
  }
});

// 7. Meta Webhooks Handler (POST)
// Processes incoming webhook events
app.post('/webhook', async (req, res) => {
  const body = req.body;
  
  // Log raw body for debugging if needed
  console.log('Webhook received:', JSON.stringify(body, null, 2));

  // Determine platform and process
  if (body.object === 'page') {
    // Facebook Messenger Webhook
    try {
      body.entry.forEach(async (entry) => {
        if (!entry.messaging) return;
        
        entry.messaging.forEach(async (webhookEvent) => {
          // Check if it's a message event and not a delivery/read report
          if (webhookEvent.message && webhookEvent.message.text && !webhookEvent.message.is_echo) {
            const senderId = webhookEvent.sender.id;
            const messageText = webhookEvent.message.text;
            
            await logActivity({
              direction: 'incoming',
              platform: 'messenger',
              type: 'message',
              sender: senderId,
              recipient: 'Page',
              text: messageText,
              status: 'success',
              details: JSON.stringify(webhookEvent)
            });
            
            // Handle message through Rule Engine and AI Engine
            await handleIncomingMessage(messageText, 'messenger', senderId);
          }
        });
      });
      res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('Error parsing Messenger webhook:', error);
      res.status(200).send('EVENT_RECEIVED'); // Always send 200 back to Meta to avoid retries
    }
  } else if (body.object === 'whatsapp_business_account') {
    // WhatsApp Cloud API Webhook
    try {
      body.entry.forEach(async (entry) => {
        if (!entry.changes) return;
        
        entry.changes.forEach(async (change) => {
          if (change.value && change.value.messages) {
            change.value.messages.forEach(async (message) => {
              // Only process text messages
              if (message.type === 'text' && message.text && message.text.body) {
                const senderPhone = message.from; // Sender's phone number
                const messageText = message.text.body;
                
                await logActivity({
                  direction: 'incoming',
                  platform: 'whatsapp',
                  type: 'message',
                  sender: senderPhone,
                  recipient: change.value.metadata.display_phone_number || 'WhatsApp Bot',
                  text: messageText,
                  status: 'success',
                  details: JSON.stringify(change.value)
                });
                
                // Handle message through Rule Engine and AI Engine
                let senderName = `SĐT: ${senderPhone}`;
                if (change.value && change.value.contacts && change.value.contacts.length > 0) {
                  const contact = change.value.contacts.find(c => c.wa_id === senderPhone);
                  if (contact && contact.profile && contact.profile.name) {
                    senderName = contact.profile.name;
                  }
                }
                await handleIncomingMessage(messageText, 'whatsapp', senderPhone, senderName);
              }
            });
          }
        });
      });
      res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('Error parsing WhatsApp webhook:', error);
      res.status(200).send('EVENT_RECEIVED');
    }
  } else {
    // Not an event we are interested in or unsupported object
    res.sendStatus(404);
  }
});

// Start Server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Webhooks available at: http://localhost:${PORT}/webhook`);
});


