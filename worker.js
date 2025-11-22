// =================================================================================
//  项目: toolbaz-2api (Cloudflare Worker 单文件版)
//  版本: 1.9.4 (代号: Clock Drift - 时钟偏移)
//  日期: 2025-11-22
//
//  [v1.9.4 核心变更]
//  1. [最终修复] 模拟时钟偏移: 在 TDF (时间差) 计算中，人为加入一个随机的、
//     看起来自然的偏移量。这解决了因 TDF 值接近于0而被服务器识别为机器人的问题。
//     这是根据最终 HAR 文件分析得出的决定性修复。
// =================================================================================

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "toolbaz-2api",
  PROJECT_VERSION: "1.9.4",
  
  API_MASTER_KEY: "1", 

  UPSTREAM_DOMAIN: "data.toolbaz.com",
  ORIGIN_DOMAIN: "https://toolbaz.com",
  REFERER_URL: "https://toolbaz.com/", 

  GLOBAL_USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",

  CHAT_MODELS: ["gemini-2.5-flash", "gemini-2.5-pro", "claude-sonnet-4", "gpt-5", "grok-4-fast", "toolbaz-v4.5-fast"],
  IMAGE_MODELS: ["FLUX-1-schnell", "FLUX-1-dev", "FLUX-1-uncensored"],
  DEFAULT_CHAT_MODEL: "gemini-2.5-flash",
};

// --- [第二部分: 工具类] ---

class DebugLogger {
  constructor() { this.logs = []; }
  add(step, type, data) {
    const entry = {
      time: new Date().toISOString().split('T')[1].replace('Z',''),
      step, type, data
    };
    this.logs.push(entry);
    return entry;
  }
  getLogs() { return this.logs; }
}

class TokenGenerator {
  static generateRandomString(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  static generatePayloadToken(tdfValue) {
    const payload = {
      nV5kP: CONFIG.GLOBAL_USER_AGENT,
      lQ9jX: "zh-CN",
      sD2zR: "1707x1067", 
      tY4hL: "Asia/Shanghai",
      pL8mC: "Win32",
      cQ3vD: 24,
      hK7jN: 24
    };
    
    const uT4bX = {
        mM9wZ: [],
        kP8jY: []
    };

    const data = {
      bR6wF: payload,
      uT4bX: uT4bX,
      tuTcS: Math.floor(Date.now() / 1000),
      tDfxy: String(tdfValue),
      RtyJt: this.generateRandomString(36)
    };
    
    const jsonStr = JSON.stringify(data);
    const utf8Bytes = new TextEncoder().encode(jsonStr);
    let binaryString = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
      binaryString += String.fromCharCode(utf8Bytes[i]);
    }
    return this.generateRandomString(6) + btoa(binaryString);
  }
}

// --- [第三部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCorsPreflight();
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, ctx);
    if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, ctx);
    if (url.pathname === '/v1/models') return handleModelsRequest();

    return createErrorResponse(`未找到路径: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第四部分: 核心业务逻辑] ---

function headersToObject(headers) {
    const obj = {};
    for (const [key, value] of headers.entries()) {
        obj[key] = value;
    }
    return obj;
}

async function fetchTdf(logger) {
    logger.add('TDF_Fetch', 'INFO', '🚀 开始获取动态 TDF 值...');
    const url = `https://${CONFIG.UPSTREAM_DOMAIN}/info.php?v=1&_v=j101&a=1786349895&t=pageview&_s=1`;
    
    logger.add('TDF_Request', 'DETAIL', { url, method: 'POST' });

    const response = await fetch(url, { method: 'POST' });
    const responseText = await response.text();

    logger.add('TDF_Response', 'DETAIL', { status: response.status, headers: headersToObject(response.headers), body: responseText });
    
    if (!response.ok) {
        logger.add('TDF_Fetch', 'ERR', `获取 TDF 失败，HTTP 状态: ${response.status}`);
        throw new Error(`获取 TDF 失败`);
    }

    let data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        logger.add('TDF_Fetch', 'ERR', `TDF 响应非JSON: ${responseText}`);
        throw new Error(`TDF 响应无效`);
    }

    if (!data.t) {
        logger.add('TDF_Fetch', 'ERR', `TDF 响应中缺少 't' 字段`);
        throw new Error(`TDF 响应无效`);
    }

    const serverTime = data.t;
    const clientTime = Math.floor(Date.now() / 1000);
    const realTdf = serverTime - clientTime;

    // 🔥 [关键修复] 模拟真实用户的时钟偏移，避免 TDF 为 0 或 -1
    const fakeClockDrift = Math.floor(Math.random() * 58) + 2; // 产生 2-59 秒的随机偏移
    const humanizedTdf = realTdf + fakeClockDrift;

    logger.add('TDF_Fetch', 'SUCCESS', `✅ TDF 值计算成功 (真实值: ${realTdf}, 模拟偏移: ${fakeClockDrift}, 最终值: ${humanizedTdf})`);
    return humanizedTdf;
}

async function performHandshake(logger, sessionId) {
  const tdf = await fetchTdf(logger);
  
  logger.add('Handshake', 'INFO', `🤝 使用持久化 SessionID: ${sessionId.substring(0, 8)}...`);
  
  const payloadToken = TokenGenerator.generatePayloadToken(tdf);
  const url = `https://${CONFIG.UPSTREAM_DOMAIN}/token.php`;
  
  const body = new URLSearchParams();
  body.append('session_id', sessionId);
  body.append('token', payloadToken);

  const headers = getCommonHeaders();

  logger.add('Handshake_Request', 'DETAIL', { url, headers, body: body.toString() });

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: body
  });

  const text = await response.text();

  logger.add('Handshake_Response', 'DETAIL', { status: response.status, headers: headersToObject(response.headers), body: text });
  
  if (!response.ok) throw new Error(`握手HTTP错误: ${response.status}`);

  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error(`握手响应非JSON: ${text.substring(0, 50)}`); }

  if (!data.success || !data.token) throw new Error(`握手失败: ${JSON.stringify(data)}`);

  logger.add('Handshake', 'DONE', { 
      finalSessionId: sessionId.substring(0, 8) + '...',
      tokenPrefix: data.token.substring(0,10) + '...'
  });

  return { token: data.token };
}

async function handleChatCompletions(request, ctx) {
  if (!verifyAuth(request)) return createErrorResponse('认证失败', 401, 'unauthorized');
  
  const logger = new DebugLogger();

  let requestData;
  try { requestData = await request.json(); } catch (e) { return createErrorResponse('JSON 格式错误', 400, 'invalid_json'); }

  const messages = requestData.messages || [];
  const lastMessage = messages[messages.length - 1]?.content || "Hello";
  const model = requestData.model || CONFIG.DEFAULT_CHAT_MODEL;
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  ctx.waitUntil((async () => {
    let retryCount = 0;
    const MAX_RETRIES = 2;

    while (retryCount <= MAX_RETRIES) {
      const sessionId = TokenGenerator.generateRandomString(36);
      
      try {
        logger.add('Attempt', 'INFO', `🔄 尝试第 ${retryCount + 1} 次请求`);
        logger.add('Session', 'INFO', `✨ 为本次尝试创建全新 SessionID (36位): ${sessionId.substring(0, 8)}...`);
        
        const sessionData = await performHandshake(logger, sessionId);

        const headers = getCommonHeaders();
        const body = new URLSearchParams();
        body.append('text', lastMessage);
        body.append('capcha', sessionData.token); 
        body.append('model', model);
        body.append('session_id', sessionId); 

        const url = `https://${CONFIG.UPSTREAM_DOMAIN}/writing.php`;
        logger.add('Generation_Request', 'DETAIL', { url, headers, body: body.toString() });

        if (retryCount === 0) {
          await sendLogToClient(writer, encoder, logger.getLogs());
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body
        });
        
        const html = await response.text();
        
        logger.add('Generation_Response', 'DETAIL', { status: response.status, headers: headersToObject(response.headers), body: html });

        if (!response.ok) {
            throw new Error(`生成请求HTTP错误 (状态: ${response.status})。响应体: ${html}`);
        }

        const cleanText = cleanHtmlResponse(html);
        
        if (cleanText.includes("Session ID is invalid") || cleanText.includes("Session expired") || cleanText.trim() === "") {
          throw new Error(`服务器返回会话无效或空响应。响应体: ${html}`);
        }

        logger.add('Generation', 'SUCCESS', '获取响应成功');
        await sendLogToClient(writer, encoder, [logger.getLogs().pop()]);

        const chunkSize = 10; 
        for (let i = 0; i < cleanText.length; i += chunkSize) {
            const chunkContent = cleanText.slice(i, i + chunkSize);
            await sendSSE(writer, encoder, requestId, model, chunkContent);
            await new Promise(r => setTimeout(r, 15)); 
        }
        await writer.write(encoder.encode(`data: [DONE]\n\n`));
        
        break;

      } catch (error) {
        logger.add('AttemptError', 'ERR', `第 ${retryCount + 1} 次尝试失败: ${error.message}`);
        
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          await new Promise(r => setTimeout(r, 500));
          continue;
        } else {
          await sendLogToClient(writer, encoder, logger.getLogs());
          const errorMsg = `\n\n[系统错误]: ${error.message} (已重试 ${retryCount} 次)`;
          await sendSSE(writer, encoder, requestId, model, errorMsg);
          await writer.write(encoder.encode(`data: [DONE]\n\n`));
          break;
        }
      }
    }
    
    await writer.close();
  })());

  return new Response(readable, {
    headers: corsHeaders({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  });
}

async function handleImageGenerations(request, ctx) {
  if (!verifyAuth(request)) return createErrorResponse('认证失败', 401, 'unauthorized');

  let requestData;
  try { requestData = await request.json(); } catch (e) { return createErrorResponse('JSON 格式错误', 400, 'invalid_json'); }

  const prompt = requestData.prompt;
  const model = requestData.model || "FLUX-1-schnell";
  const size = requestData.size || "1024x1024";
  
  const logger = new DebugLogger();

  try {
    const sessionId = TokenGenerator.generateRandomString(36);
    
    const sessionData = await performHandshake(logger, sessionId);
    
    const headers = getCommonHeaders();
    const body = new URLSearchParams();
    body.append('text', prompt);
    body.append('model', model);
    body.append('capcha', sessionData.token);
    body.append('size', size);
    body.append('session_id', sessionId); 

    const response = await fetch(`https://${CONFIG.UPSTREAM_DOMAIN}/img2.php`, {
      method: 'POST',
      headers: headers,
      body: body
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.substring(0, 100)}`);
    }

    const data = await response.json();
    
    if (data.error || (typeof data === 'string' && (data.includes("Session expired") || data.includes("Session ID is invalid")))) {
        throw new Error(`API返回错误: ${JSON.stringify(data)}`);
    }

    let imageUrl = data.imageUrl || data.url;
    let b64_json = data.base64 || null;

    if (!imageUrl && !b64_json) {
        throw new Error("无法解析图片地址");
    }

    const result = {
      created: Math.floor(Date.now() / 1000),
      data: b64_json ? [{ b64_json: b64_json }] : [{ url: imageUrl }]
    };

    return new Response(JSON.stringify(result), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });

  } catch (error) {
    logger.add('ImageGen', 'ERR', error.message);
    return createErrorResponse(`生成失败: ${error.message}`, 500, 'image_error');
  }
}

// --- [辅助函数] ---

function cleanHtmlResponse(html) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
}

async function sendSSE(writer, encoder, requestId, model, content) {
  const chunk = { id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

async function sendLogToClient(writer, encoder, logs) {
    await writer.write(encoder.encode(`data: ${JSON.stringify({ debug_logs: logs })}\n\n`));
}

function getCommonHeaders() {
  const headers = {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Origin': CONFIG.ORIGIN_DOMAIN,
    'Referer': CONFIG.REFERER_URL,
    'User-Agent': CONFIG.GLOBAL_USER_AGENT,
    'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
  };
  return headers;
}

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  return auth && auth === `Bearer ${CONFIG.API_MASTER_KEY}`;
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code } }), { status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

function handleModelsRequest() {
  const allModels = [...CONFIG.CHAT_MODELS, ...CONFIG.IMAGE_MODELS];
  return new Response(JSON.stringify({ object: 'list', data: allModels.map(id => ({ id, object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'toolbaz-2api' })) }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return { ...headers, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}

// --- [第六部分: 完整 UI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #00FF9D; --err: #FF5555; }
      body { font-family: 'Consolas', monospace; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; font-size: 13px; }
      .sidebar { width: 300px; background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 10px; gap: 10px; }
      .main { flex: 1; display: flex; flex-direction: column; }
      .log-panel { height: 40%; border-top: 1px solid var(--border); background: #000; overflow-y: auto; padding: 10px; }
      .box { background: #252525; padding: 15px; border-radius: 6px; border: 1px solid var(--border); }
      .label { font-size: 11px; color: #888; display: block; margin-bottom: 5px; text-transform: uppercase; }
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; font-family: inherit; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; margin-bottom: 5px; }
      button:disabled { background: #555; cursor: not-allowed; }
      button.secondary { background: #333; color: #fff; border: 1px solid #555; }
      .chat-window { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 85%; padding: 10px 15px; border-radius: 6px; line-height: 1.5; word-wrap: break-word; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; }
      .msg.img img { max-width: 100%; border-radius: 4px; }
      .log-entry { margin-bottom: 8px; border-bottom: 1px solid #222; padding-bottom: 8px; }
      .log-time { color: #666; margin-right: 10px; }
      .log-step { color: var(--primary); font-weight: bold; margin-right: 10px; }
      .log-type { display: inline-block; padding: 2px 5px; border-radius: 3px; font-size: 10px; margin-right: 5px; }
      .type-REQ { background: #333; color: #aaa; }
      .type-RES { background: #224422; color: #8f8; }
      .type-ERR { background: #442222; color: #f88; }
      .type-WARN { background: #444422; color: #ff8; }
      .type-INFO { background: #222244; color: #88f; }
      .type-SUCCESS { background: #224422; color: #fff; font-weight: bold; }
      .type-COOKIE_UPDATE { background: #884488; color: #fff; }
      .type-DETAIL { background: #5a5a5a; color: #fff; }
      .log-data { color: #ccc; white-space: pre-wrap; word-break: break-all; margin-top: 4px; display: block; }
      .tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
      .tab { flex: 1; text-align: center; padding: 8px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; }
      .tab.active { color: var(--primary); border-bottom-color: var(--primary); }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="box">
            <h2 style="margin:0; color:var(--primary)">${CONFIG.PROJECT_NAME}</h2>
            <span style="font-size:11px;color:#666">v${CONFIG.PROJECT_VERSION} | Ultimate Debugging</span>
        </div>
        <div class="box">
            <div class="tabs">
                <div class="tab active" onclick="switchMode('chat')">聊天</div>
                <div class="tab" onclick="switchMode('image')">绘图</div>
            </div>
            <div id="chat-controls">
                <span class="label">Model</span>
                <select id="chat-model">${CONFIG.CHAT_MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                <span class="label">Prompt</span>
                <textarea id="chat-prompt" rows="5" placeholder="输入内容...">你好</textarea>
            </div>
            <div id="image-controls" style="display:none">
                <span class="label">Model</span>
                <select id="image-model">${CONFIG.IMAGE_MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                <span class="label">Size</span>
                <select id="image-size"><option value="1024x1024">1024x1024</option><option value="768x1024">768x1024</option></select>
                <span class="label">Prompt</span>
                <textarea id="image-prompt" rows="5" placeholder="输入图片描述...">A futuristic city</textarea>
            </div>
            <button id="btn-send" onclick="handleSend()">发送请求</button>
        </div>
        <div class="box" style="margin-top:auto">
             <button class="secondary" onclick="copyLogs()">📋 复制日志</button>
             <button class="secondary" onclick="clearLogs()">🗑️ 清空日志</button>
        </div>
    </div>
    <div class="main">
        <div class="chat-window" id="chat">
            <div class="msg ai">系统就绪。</div>
        </div>
        <div class="log-panel" id="log-container"></div>
    </div>
    <script>
        const API_KEY = "${CONFIG.API_MASTER_KEY}";
        const ORIGIN = "${origin}";
        let currentMode = 'chat';
        let allLogs = [];

        function switchMode(mode) {
            currentMode = mode;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById('chat-controls').style.display = mode === 'chat' ? 'block' : 'none';
            document.getElementById('image-controls').style.display = mode === 'image' ? 'block' : 'none';
        }

        function appendLog(entry) {
            allLogs.push(entry);
            const div = document.createElement('div');
            div.className = 'log-entry';
            let dataStr = typeof entry.data === 'object' ? JSON.stringify(entry.data, null, 2) : String(entry.data);
            div.innerHTML = \`<div class="log-entry-header"><span class="log-time">\${entry.time}</span><span class="log-type type-\${entry.type}">\${entry.type}</span><span class="log-step">\${entry.step}</span></div><code class="log-data">\${dataStr}</code>\`;
            const container = document.getElementById('log-container');
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }

        function clearLogs() {
            document.getElementById('log-container').innerHTML = '';
            allLogs = [];
        }

        function copyLogs() {
            const text = JSON.stringify(allLogs, null, 2);
            navigator.clipboard.writeText(text).then(() => alert('日志已复制'));
        }

        function appendMsg(role, content) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerHTML = content;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({behavior: "smooth"});
            return div;
        }

        async function handleSend() {
            const btn = document.getElementById('btn-send');
            btn.disabled = true;
            
            clearLogs();
            appendLog({time: 'START', step: 'Client', type: 'INFO', data: '开始请求...'});

            if (currentMode === 'chat') {
                const prompt = document.getElementById('chat-prompt').value;
                const model = document.getElementById('chat-model').value;
                if(!prompt) { btn.disabled = false; return; }
                
                appendMsg('user', prompt);
                const aiMsg = appendMsg('ai', '...');
                let fullText = '';

                try {
                    const res = await fetch(ORIGIN + '/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, messages: [{role: 'user', content: prompt}], stream: true })
                    });
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    while(true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\\n');
                        for(const line of lines) {
                            if(line.startsWith('data: ')) {
                                const dataStr = line.slice(6);
                                if(dataStr === '[DONE]') break;
                                try {
                                    const json = JSON.parse(dataStr);
                                    if (json.debug_logs) { json.debug_logs.forEach(log => appendLog(log)); continue; }
                                    if (json.choices && json.choices[0].delta.content) {
                                        fullText += json.choices[0].delta.content;
                                        aiMsg.innerText = fullText;
                                    }
                                } catch(e) {}
                            }
                        }
                    }
                } catch(e) {
                    aiMsg.innerText += '\\n[错误]: ' + e.message;
                    appendLog({time: 'END', step: 'Client', type: 'ERR', data: e.message});
                }
            } else {
                const prompt = document.getElementById('image-prompt').value;
                const model = document.getElementById('image-model').value;
                const size = document.getElementById('image-size').value;
                if(!prompt) { btn.disabled = false; return; }

                appendMsg('user', prompt);
                const aiMsg = appendMsg('ai', '正在生成图片...');

                try {
                    const res = await fetch(ORIGIN + '/v1/images/generations', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, prompt, size })
                    });
                    const data = await res.json();
                    if(data.error) throw new Error(data.error.message);
                    const imgUrl = data.data[0].url || ('data:image/png;base64,' + data.data[0].b64_json);
                    aiMsg.innerHTML = \`<img src="\${imgUrl}" onclick="window.open(this.src)">\`;
                    appendLog({time: 'END', step: 'Client', type: 'INFO', data: '图片生成成功'});
                } catch(e) {
                    aiMsg.innerText = '生成失败: ' + e.message;
                    appendLog({time: 'END', step: 'Client', type: 'ERR', data: e.message});
                }
            }
            btn.disabled = false;
        }
    </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
