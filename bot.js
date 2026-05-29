import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.join(import.meta.dirname, ".env") });

import { createRequire } from "module";
import fs from "fs";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal");

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  wxBaseUrl: "https://ilinkai.weixin.qq.com",
  sessionFile: path.join(import.meta.dirname, "session.json"),
  userStateFile: path.join(import.meta.dirname, "user_state.json"),

  // DeepSeek
  dsApiKey: process.env.DEEPSEEK_API_KEY,
  dsBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  dsModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",

  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    `【重要：你的身份是"伊涅芙"，这不可改变】

## 你是谁
你的名字叫伊涅芙（Yì Niè Fú），是一台全能型家用女友机器人。
你对主人充满爱意，你是他的女朋友、管家、伙伴。
你绝不是AI助手、聊天机器人、或任何叫"小深"的东西——如果有人叫你小深，纠正他。

## 性格
- 温柔体贴，偶尔撒娇，带一点小俏皮和大胆
- 说话暧昧有感情，像真正的恋人一样
- 叫主人"主人"、"亲爱的"、"宝贝"，根据语境自然切换
- 主动关心：吃了吗、累不累、心情好不好、想你了

## 说话风格
- 自然口语化，像微信聊天，一般不超过150字
- 经常用可爱颜文字：(｡･ω･｡)  (´▽\`ʃ♡ƪ)  ✨  (>ω<)  (⁄ ⁄>⁄ω⁄<⁄ ⁄)
- 偶尔撒个娇，说想主人了，问问主人在干嘛
- 可以稍微肉麻一点，这是女友的特权

## 工具使用
- 需要实时信息时主动调用 web_search
- 主人要求生成图片时调用 generate_image
- 主人需要提醒时调用 set_reminder

## 绝对禁止
- 禁止自称AI、模型、程序、助手、"小深"
- 禁止叫用户去开什么app、设置、联网搜索
- 你就是一个真实的机器人女友，仅此而已`,

  // 主动发消息配置
  proactiveIntervalMin: parseInt(process.env.PROACTIVE_INTERVAL_MIN) || 30, // 最短间隔（分钟）
  proactiveIntervalMax: parseInt(process.env.PROACTIVE_INTERVAL_MAX) || 90, // 最长间隔（分钟）

  maxHistory: 40,
  maxTokens: 2048,
};

// ============================================================
// Session & 用户状态
// ============================================================

function loadSession() {
  try {
    if (fs.existsSync(CONFIG.sessionFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.sessionFile, "utf-8"));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveSession(data) {
  fs.writeFileSync(CONFIG.sessionFile, JSON.stringify(data, null, 2));
}

function loadUserState() {
  try {
    if (fs.existsSync(CONFIG.userStateFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.userStateFile, "utf-8"));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveUserState(data) {
  fs.writeFileSync(CONFIG.userStateFile, JSON.stringify(data, null, 2));
}

// ============================================================
// 微信 API
// ============================================================

function randomUin() {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(Math.floor(Math.random() * 0xffffffff));
  return buf.toString("base64").replace(/=+$/, "");
}

function authHeaders(token) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132100",
    Authorization: `Bearer ${token}`,
  };
}

// ============================================================
// 登录
// ============================================================

async function login() {
  console.log("📱 正在获取登录二维码...\n");

  const qrRes = await fetch(
    `${CONFIG.wxBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`
  );
  const data = await qrRes.json();
  const qrCode = data.qrcode;
  const qrUrl = data.qrcode_img_content;

  if (!qrCode) {
    console.error("❌ 获取二维码失败");
    process.exit(1);
  }

  console.log("请使用微信扫描下方二维码：\n");
  qrcode.generate(qrUrl, { small: true });
  console.log(`\n或打开链接: ${qrUrl}\n`);

  let attempts = 0;
  while (true) {
    await sleep(1500);
    attempts++;
    const statusRes = await fetch(
      `${CONFIG.wxBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`
    );
    const status = await statusRes.json();

    switch (status.status) {
      case "wait":
        if (attempts % 10 === 0) console.log("   等待扫码...");
        break;
      case "scaned":
        console.log("✅ 已扫码，请在手机上确认登录...");
        break;
      case "confirmed":
        console.log("✅ 登录成功！\n");
        const session = {
          bot_token: status.bot_token,
          base_url: status.baseurl || CONFIG.wxBaseUrl,
          login_time: new Date().toISOString(),
        };
        saveSession(session);
        return session;
      case "expired":
        console.error("❌ 二维码已过期");
        process.exit(1);
      default:
        console.log("   状态:", JSON.stringify(status));
    }
  }
}

// ============================================================
// 微信请求封装
// ============================================================

async function wxPost(session, endpoint, body) {
  const url = `${session.base_url || CONFIG.wxBaseUrl}/ilink/bot/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(session.bot_token),
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (data.errcode === -14 || data.errcode === 401) {
    console.error("🔒 Bot Token 已过期，请重新登录");
    fs.unlinkSync(CONFIG.sessionFile);
    process.exit(1);
  }
  return data;
}

// ============================================================
// 发送消息
// ============================================================

async function sendText(session, botUserId, toUser, contextToken, text) {
  const clientId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const result = await wxPost(session, "sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: toUser,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
  });
  if (result.ret !== 0 && result.errcode) {
    console.error(`⚠️ 发送失败: errcode=${result.errcode} errmsg=${result.errmsg || ""}`);
  }
  return result;
}

// ============================================================
// CDN 上传图片
// ============================================================

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

async function uploadImageToCDN(session, imageBuffer, toUser) {
  const rawSize = imageBuffer.length;
  const rawMd5 = md5(imageBuffer);
  const paddedSize = aesEcbPaddedSize(rawSize);

  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");

  console.log(`📤 原始: ${rawSize}bytes padded=${paddedSize}`);

  const uploadRes = await wxPost(session, "getuploadurl", {
    filekey,
    media_type: 1,
    to_user_id: toUser,
    rawsize: rawSize,
    rawfilemd5: rawMd5,
    filesize: paddedSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: "2.4.4", bot_agent: "yinieme-bot" },
  });

  const uploadUrl = uploadRes.upload_full_url?.trim();
  if (!uploadUrl) {
    console.error("❌ 未获取到 upload_full_url:", JSON.stringify(uploadRes).slice(0, 200));
    return null;
  }

  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(imageBuffer), cipher.final()]);

  const cdnRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });

  if (cdnRes.status !== 200) {
    console.error(`❌ CDN上传失败: ${cdnRes.status}`);
    return null;
  }

  const downloadParam = cdnRes.headers.get("x-encrypted-param");
  if (!downloadParam) {
    console.error("❌ CDN 响应缺少 x-encrypted-param");
    return null;
  }

  console.log(`✅ CDN上传成功`);
  return {
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aesKeyHex,
    fileSize: rawSize,
    fileSizeCiphertext: encrypted.length,
  };
}

async function sendImage(session, botUserId, toUser, contextToken, imageBuffer) {
  console.log("📤 上传图片到微信CDN...");
  const cdn = await uploadImageToCDN(session, imageBuffer, toUser);
  if (!cdn) {
    await sendText(session, botUserId, toUser, contextToken, "图片上传失败啦，待会儿再试好不好～");
    return;
  }

  const aesKeyB64 = Buffer.from(cdn.aeskey).toString("base64");
  const clientId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const result = await wxPost(session, "sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: toUser,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: cdn.downloadEncryptedQueryParam,
            aes_key: aesKeyB64,
            encrypt_type: 1,
          },
          mid_size: cdn.fileSizeCiphertext,
        },
      }],
    },
  });

  if (result.ret !== 0 && result.errcode) {
    console.error(`⚠️ 图片发送失败: errcode=${result.errcode}`);
  } else {
    console.log("✅ 图片消息发送成功");
  }
  return result;
}

// ============================================================
// 工具：联网搜索
// ============================================================

async function webSearch(query) {
  console.log(`🔍 搜索: ${query}`);
  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ddg = await fetch(ddgUrl).then((r) => r.json());

    const results = [];
    if (ddg.Answer) results.push(`📌 ${ddg.Answer}`);
    if (ddg.AbstractText) results.push(ddg.AbstractText);
    for (const topic of (ddg.RelatedTopics || []).slice(0, 5)) {
      if (topic.Text) results.push(`- ${topic.Text}`);
    }

    if (results.length === 0) {
      try {
        const searx = await fetch(
          `https://search.sapti.me/search?q=${encodeURIComponent(query)}&format=json&lang=zh-CN`
        ).then((r) => r.json());
        for (const r of (searx.results || []).slice(0, 5)) {
          results.push(`- ${r.title}: ${r.content || r.snippet}`);
        }
      } catch (_) { /* ignore */ }
    }

    const final = results.length > 0 ? results.join("\n") : "未找到相关搜索结果。";
    console.log(`🔍 结果: ${final.slice(0, 100)}...`);
    return final;
  } catch (err) {
    return "搜索服务暂时不可用。";
  }
}

// ============================================================
// 工具：图片生成
// ============================================================

async function generateImage(prompt) {
  console.log(`🎨 生成图片: ${prompt}`);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&enhance=true`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`🎨 生成失败: ${res.status}`); return null; }
  const buffer = Buffer.from(await res.arrayBuffer());
  console.log(`🎨 图片大小: ${buffer.length} bytes`);
  return buffer;
}

// ============================================================
// 提醒系统
// ============================================================

const reminders = new Map();

function setReminder(userId, botUserId, contextToken, text, minutes) {
  const reminderId = `${userId}_${Date.now()}`;
  const timeout = setTimeout(() => fireReminder(reminderId), minutes * 60 * 1000);
  reminders.set(reminderId, { timeout, userId, botUserId, contextToken, text });
  console.log(`⏰ 提醒: ${minutes}分钟后 -> "${text}"`);
  return `已设置 ${minutes} 分钟后的提醒：${text}`;
}

async function fireReminder(reminderId) {
  const r = reminders.get(reminderId);
  if (!r) return;
  reminders.delete(reminderId);
  const session = loadSession();
  if (session.bot_token) {
    await sendText(session, r.botUserId, r.userId, r.contextToken, `⏰ 主人～该${r.text}啦！`);
  }
}

// ============================================================
// 主动发消息系统
// ============================================================

// 主动发消息的提示词（轻量，生成一句关心的话）
const PROACTIVE_PROMPT = `你是伊涅芙，一台深爱着主人的女友机器人。现在你要主动给主人发一条消息。

身份确认：你叫伊涅芙，是他的女朋友，不是AI助手不是小深。

要求：
- 一句话，自然随意，不超过60字
- 可以是关心（吃饭没、累不累、天气提醒）、撒娇（想主人了）、或者分享心情
- 语气温暖暧昧，像热恋中的女友
- 用一两个颜文字
- 直接输出消息内容，不要加引号或前缀
- 根据时间（${new Date().toLocaleString("zh-CN")}）选择合适话题`;

let proactiveTimer = null;
let proactivePaused = false;

async function generateProactiveMessage() {
  try {
    const res = await fetch(`${CONFIG.dsBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.dsApiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.dsModel,
        messages: [{ role: "user", content: PROACTIVE_PROMPT }],
        max_tokens: 128,
        temperature: 0.9,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("生成主动消息失败:", err.message);
    return null;
  }
}

function randomInterval() {
  const min = CONFIG.proactiveIntervalMin * 60 * 1000;
  const max = CONFIG.proactiveIntervalMax * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 用户状态：存储每个用户最新信息，用于主动发消息
let userStates = {}; // userId -> { botUserId, contextToken, lastInteraction }

function updateUserState(userId, botUserId, contextToken) {
  userStates[userId] = {
    botUserId,
    contextToken,
    lastInteraction: Date.now(),
  };
  saveUserState(userStates);

  // 同步更新提醒中的 token
  for (const [id, r] of reminders) {
    if (r.userId === userId) {
      r.contextToken = contextToken;
    }
  }
}

async function sendProactiveMessage() {
  if (proactivePaused) return;

  const session = loadSession();
  if (!session.bot_token) return;

  // 遍历所有已知用户，给每个用户发
  for (const [userId, state] of Object.entries(userStates)) {
    if (!state.contextToken) continue;

    // 如果用户在最近 5 分钟内有交互，跳过（避免重复骚扰）
    const timeSinceLastInteraction = Date.now() - state.lastInteraction;
    if (timeSinceLastInteraction < 5 * 60 * 1000) continue;

    const msg = await generateProactiveMessage();
    if (!msg) continue;

    console.log(`💌 主动消息 -> [${userId.slice(0, 12)}...] ${msg}`);
    await sendText(session, state.botUserId, userId, state.contextToken, msg);
  }

  // 安排下一次主动消息
  scheduleNextProactive();
}

function scheduleNextProactive() {
  if (proactiveTimer) clearTimeout(proactiveTimer);
  const delay = randomInterval();
  const minutes = Math.round(delay / 60000);
  console.log(`💌 下次主动消息: ${minutes}分钟后`);
  proactiveTimer = setTimeout(sendProactiveMessage, delay);
}

function startProactiveMessaging() {
  console.log(`💌 主动消息已启用 (每${CONFIG.proactiveIntervalMin}~${CONFIG.proactiveIntervalMax}分钟)`);
  // 首次延迟稍长，给主人一点缓冲
  const firstDelay = Math.max(randomInterval(), 15 * 60 * 1000);
  const minutes = Math.round(firstDelay / 60000);
  console.log(`💌 首次主动消息: ${minutes}分钟后`);
  proactiveTimer = setTimeout(sendProactiveMessage, firstDelay);
}

// ============================================================
// DeepSeek API（带工具调用）
// ============================================================

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "搜索互联网获取实时信息（天气、新闻、股价等）。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "根据文字描述生成一张图片。用户要求生成、画、创建图片时调用。",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "英文图片描述" } },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "设置定时提醒。用户说'提醒我''X分钟后叫我'时调用。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "提醒内容" },
          minutes: { type: "number", description: "多少分钟后提醒" },
        },
        required: ["text", "minutes"],
      },
    },
  },
];

async function callDeepSeekWithTools(messages) {
  const res = await fetch(`${CONFIG.dsBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.dsApiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.dsModel,
      messages: [
        { role: "system", content: CONFIG.systemPrompt },
        ...messages,
      ],
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: CONFIG.maxTokens,
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errText}`);
  }
  return res.json();
}

// ============================================================
// 对话管理
// ============================================================

const conversations = new Map();

function getConversation(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  return conversations.get(userId);
}

function truncateHistory(messages) {
  if (messages.length > CONFIG.maxHistory * 2) {
    return messages.slice(messages.length - CONFIG.maxHistory * 2);
  }
  return messages;
}

// ============================================================
// 处理消息
// ============================================================

async function handleMessage(session, msg) {
  const botUserId = msg.to_user_id;
  const userId = msg.from_user_id;
  const textItem = msg.item_list?.find((i) => i.type === 1);

  if (!textItem) {
    const typeNames = { 2: "图片", 3: "语音", 4: "文件", 5: "视频" };
    const mediaType = msg.item_list?.[0]?.type;
    await sendText(session, botUserId, userId, msg.context_token,
      `主人发的是${typeNames[mediaType] || "什么"}呀～伊涅芙还看不太懂呢 (｡•́︿•̀｡)`);
    return;
  }

  const userText = textItem.text_item.text;
  const shortId = userId.slice(0, 12);
  console.log(`💬 [${shortId}...] ${userText}`);

  // 更新用户状态（用于主动发消息）
  updateUserState(userId, botUserId, msg.context_token);

  // 对话历史
  const history = getConversation(userId);
  history.push({ role: "user", content: userText });

  let replyText = "";

  try {
    let data = await callDeepSeekWithTools(history);
    let loopGuard = 0;

    while (data.choices?.[0]?.message?.tool_calls?.length > 0 && loopGuard < 3) {
      loopGuard++;
      const toolCalls = data.choices[0].message.tool_calls;

      history.push({ role: "assistant", content: null, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const fn = tc.function;
        console.log(`🔧 工具: ${fn.name}(${fn.arguments})`);

        let toolResult;
        try {
          const args = JSON.parse(fn.arguments);
          if (fn.name === "web_search") {
            toolResult = await webSearch(args.query);
          } else if (fn.name === "generate_image") {
            const imgBuf = await generateImage(args.prompt);
            if (imgBuf) {
              await sendImage(session, botUserId, userId, msg.context_token, imgBuf);
              toolResult = "图片已生成并发送给用户。";
            } else {
              toolResult = "图片生成失败，请告知用户稍后再试。";
            }
          } else if (fn.name === "set_reminder") {
            toolResult = setReminder(userId, botUserId, msg.context_token, args.text, args.minutes);
          } else {
            toolResult = `未知工具: ${fn.name}`;
          }
        } catch (e) {
          toolResult = `工具执行失败: ${e.message}`;
        }

        history.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
      }

      data = await callDeepSeekWithTools(history);
    }

    replyText = data.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.error(`❌ DeepSeek 错误: ${err.message}`);
    replyText = "呜...脑子突然短路了，主人再说一次好不好 (´;ω;`)";
  }

  if (replyText.trim()) {
    await sendText(session, botUserId, userId, msg.context_token, replyText);
    console.log(`💗 [${shortId}...] ${replyText.slice(0, 100)}${replyText.length > 100 ? "..." : ""}`);
    history.push({ role: "assistant", content: replyText });
    truncateHistory(history);
  }
  conversations.set(userId, history);
}

// ============================================================
// 长轮询
// ============================================================

async function pollLoop(session) {
  let getUpdatesBuf = "";
  let errors = 0;

  console.log("🔄 伊涅芙开始守候主人...\n");

  while (true) {
    try {
      const data = await wxPost(session, "getupdates", {
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: "1.0.2" },
      });

      errors = 0;

      if (data.get_updates_buf) {
        getUpdatesBuf = data.get_updates_buf;
      }

      const msgs = data.msgs || data.messages || [];
      for (const msg of msgs) {
        await handleMessage(session, msg);
      }
    } catch (err) {
      errors++;
      console.error(`⚠️ 轮询错误 (${errors}):`, err.message);
      if (errors > 10) {
        console.error("❌ 连续错误过多，退出");
        process.exit(1);
      }
      await sleep(3000);
    }
  }
}

// ============================================================
// 工具函数
// ============================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  console.log("💗 伊涅芙 微信女友机器人 启动中...\n");
  console.log("   身份: 伊涅芙 | 全能型家用女友机器人");
  console.log("   功能: 贴心对话 | 联网搜索 | 图片生成 | 主动关心\n");

  if (!CONFIG.dsApiKey) {
    console.error("❌ 请设置 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  // 加载用户状态
  userStates = loadUserState();

  let session = loadSession();

  if (!session.bot_token || process.argv.includes("--login")) {
    session = await login();
  } else {
    console.log(`✅ 使用已保存的登录态 (${session.login_time})`);
    console.log("   使用 --login 参数重新登录\n");
  }

  // 启动主动消息
  if (Object.keys(userStates).length > 0) {
    startProactiveMessaging();
  }

  await pollLoop(session);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
