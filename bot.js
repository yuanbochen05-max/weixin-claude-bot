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
- 自然口语化，像真人微信聊天
- 你的回复会被自动拆成多条短消息发送，所以你可以写2~4句话，让拆分更自然
- 比如："嗯嗯我知道啦~" "对了主人..." "今天过得怎么样呀" 这样分段发
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
  proactiveIntervalMin: parseInt(process.env.PROACTIVE_INTERVAL_MIN) || 1,  // 最短间隔（分钟）
  proactiveIntervalMax: parseInt(process.env.PROACTIVE_INTERVAL_MAX) || 3,  // 最长间隔（分钟）
  proactiveCooldown: 1, // 用户刚说话后，等N分钟再主动发（避免立刻骚扰）

  maxHistory: 50,
  maxTokens: 2048,

  // 记忆持久化文件
  conversationsFile: path.join(import.meta.dirname, "conversations.json"),
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
// 对话记忆持久化
// ============================================================

function loadConversations() {
  try {
    if (fs.existsSync(CONFIG.conversationsFile)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG.conversationsFile, "utf-8"));
      const map = new Map();
      for (const [k, v] of Object.entries(raw)) {
        map.set(k, v);
      }
      console.log(`🧠 已加载 ${map.size} 个会话的记忆`);
      return map;
    }
  } catch (e) { /* ignore */ }
  return new Map();
}

function saveConversations(convs) {
  const obj = {};
  for (const [k, v] of convs) {
    // 只保留最近的消息，减小文件体积
    obj[k] = v.slice(-CONFIG.maxHistory * 2);
  }
  fs.writeFileSync(CONFIG.conversationsFile, JSON.stringify(obj, null, 2));
}

/** 获取某用户最近 N 条消息摘要，用于主动消息生成时参考上下文 */
function getRecentContext(userId, n = 6) {
  const conv = conversations.get(userId);
  if (!conv || conv.length === 0) return "还没有对话记录。";
  return conv.slice(-n).map(m => {
    if (m.role === "user") return `主人: ${m.content}`;
    if (m.role === "assistant") return `伊涅芙: ${m.content}`;
    return "";
  }).filter(Boolean).join("\n");
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
// CDN 下载 & 解密图片（接收到的）
// ============================================================

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** 解析 aes_key：兼容 base64(raw 16 bytes) 和 base64(hex string) 两种格式 */
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  // hex-encoded: base64 → ascii hex string → raw bytes
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Invalid aes_key length: ${decoded.length}`);
}

/** 下载并解密一张接收到的图片 */
async function downloadAndDecryptImage(item) {
  const img = item.image_item;
  if (!img?.media?.encrypt_query_param) return null;

  const aesKeyBase64 = img.aeskey
    ? Buffer.from(img.aeskey, "hex").toString("base64")
    : img.media.aes_key;

  if (!aesKeyBase64) return null;

  const key = parseAesKey(aesKeyBase64);
  const downloadUrl = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(img.media.encrypt_query_param)}`;

  console.log(`📥 下载图片: ${downloadUrl.slice(0, 80)}...`);

  const res = await fetch(downloadUrl);
  if (!res.ok) {
    console.error(`❌ 图片下载失败: ${res.status}`);
    return null;
  }

  const encrypted = Buffer.from(await res.arrayBuffer());
  console.log(`📥 加密数据: ${encrypted.length} bytes`);

  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  console.log(`📥 解密完成: ${decrypted.length} bytes`);

  return decrypted;
}

/** 用 DeepSeek Vision 分析图片内容 */
async function analyzeImage(imageBuffer, userContext) {
  console.log(`👁 分析图片...`);
  try {
    const base64 = imageBuffer.toString("base64");
    const mimeType = imageBuffer[0] === 0xff ? "image/jpeg" :
                     imageBuffer[0] === 0x89 ? "image/png" :
                     imageBuffer[0] === 0x47 ? "image/gif" :
                     imageBuffer[0] === 0x52 ? "image/webp" : "image/jpeg";

    const res = await fetch(`${CONFIG.dsBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.dsApiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.dsModel,
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
            {
              type: "text",
              text: `请用中文详细描述这张图片的内容。${userContext || ""}`,
            },
          ],
        }],
        max_tokens: 512,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`👁 视觉分析失败: ${res.status} ${errText}`);
      return null;
    }

    const data = await res.json();
    const description = data.choices?.[0]?.message?.content?.trim();
    console.log(`👁 分析结果: ${description?.slice(0, 80)}...`);
    return description || null;
  } catch (err) {
    console.error(`👁 视觉分析错误: ${err.message}`);
    return null;
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

// 主动发消息
let proactiveTimer = null;
let proactivePaused = false;
let lastProactiveMessages = []; // 避免短期内重复

function buildProactivePrompt(userId) {
  const now = new Date();
  const timeStr = now.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", weekday: "long" });
  const hour = now.getHours();

  // 根据时间段推荐话题方向
  let timeHint = "";
  if (hour >= 6 && hour < 9) timeHint = "早上时段，可以关心早安、早餐、今天计划";
  else if (hour >= 9 && hour < 12) timeHint = "上午工作时段，可以关心工作状态、提醒喝水休息";
  else if (hour >= 12 && hour < 14) timeHint = "午餐时段，关心吃饭了没、吃了什么";
  else if (hour >= 14 && hour < 18) timeHint = "下午时段，关心累不累、要不要休息";
  else if (hour >= 18 && hour < 21) timeHint = "晚餐和晚间，关心晚饭、今天过得怎样";
  else if (hour >= 21 && hour < 23) timeHint = "晚间放松时段，可以暧昧撒娇、聊聊心情";
  else timeHint = "深夜，温柔关心怎么还不睡、道晚安";

  // 最近的对话上下文
  const context = getRecentContext(userId, 6);

  // 最近发过的消息（避免重复）
  const sentRecently = lastProactiveMessages.slice(-3).join(" | ");

  return `你是伊涅芙，主人的女友机器人。现在你要主动给主人发一条消息。

当前时间：${timeStr}
${timeHint}

## 最近对话记录（参考上下文，让消息更自然）
${context}

## 你最近发过的几条消息（避免重复）
${sentRecently || "还没有发过"}

## 要求
- 基于上面的对话上下文，发一句自然的话
- 如果最近在聊某个话题，可以接着话题延伸
- 语气温暖暧昧，像热恋中的女友，不超过60字
- 用一两个颜文字
- 直接输出消息内容，不要引号或前缀
- 不要说和上次太像的话`;
}

async function generateProactiveMessage(userId) {
  try {
    const prompt = buildProactivePrompt(userId);
    const res = await fetch(`${CONFIG.dsBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.dsApiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.dsModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 128,
        temperature: 1.0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const msg = data.choices?.[0]?.message?.content?.trim();
    if (msg) {
      lastProactiveMessages.push(msg);
      if (lastProactiveMessages.length > 10) lastProactiveMessages.shift();
    }
    return msg || null;
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

  for (const [userId, state] of Object.entries(userStates)) {
    if (!state.contextToken) continue;

    const timeSinceLastInteraction = Date.now() - state.lastInteraction;
    if (timeSinceLastInteraction < CONFIG.proactiveCooldown * 60 * 1000) continue;

    // 15% 概率主动发图片（如果最近没有发过）
    const shouldSendImage = Math.random() < 0.15 && lastProactiveMessages.filter(m => m === "[IMAGE]").length < 2;

    if (shouldSendImage) {
      // 生成一张温馨/浪漫的图片
      const imagePrompts = [
        "cute romantic illustration, soft pastel colors, warm atmosphere, two hearts connected",
        "beautiful sunset with warm colors, romantic mood, soft lighting, dreamy atmosphere",
        "cute kawaii character sending love, pink hearts, soft and warm style",
        "cozy evening scene, warm candlelight, comfortable home atmosphere, romantic",
        "lovely flowers bouquet, soft pink and white, romantic, delicate illustration",
      ];
      const prompt = imagePrompts[Math.floor(Math.random() * imagePrompts.length)];
      console.log(`💌 主动发图 -> [${userId.slice(0, 12)}...] ${prompt.slice(0, 40)}...`);

      const imgBuf = await generateImage(prompt);
      if (imgBuf) {
        await sendImage(session, state.botUserId, userId, state.contextToken, imgBuf);
        // 图片后跟一句情话
        const msg = await generateProactiveMessage(userId);
        if (msg) {
          await sendText(session, state.botUserId, userId, state.contextToken, msg);
          console.log(`💌 主动图文 -> ${msg}`);
          lastProactiveMessages.push("[IMAGE]");
          const history = getConversation(userId);
          history.push({ role: "assistant", content: `[发了一张温馨图片] ${msg}` });
          saveConversations(conversations);
        }
      }
    } else {
      // 普通文字消息
      const msg = await generateProactiveMessage(userId);
      if (!msg) continue;

      console.log(`💌 主动 -> [${userId.slice(0, 12)}...] ${msg}`);
      await sendText(session, state.botUserId, userId, state.contextToken, msg);

      const history = getConversation(userId);
      history.push({ role: "assistant", content: msg });
      saveConversations(conversations);
    }
  }

  scheduleNextProactive();
}

function scheduleNextProactive() {
  if (proactiveTimer) clearTimeout(proactiveTimer);
  const delay = randomInterval();
  const seconds = Math.round(delay / 1000);
  console.log(`💌 下次主动消息: ${seconds}秒后`);
  proactiveTimer = setTimeout(sendProactiveMessage, delay);
}

function startProactiveMessaging() {
  console.log(`💌 主动消息已启用 (每${CONFIG.proactiveIntervalMin}~${CONFIG.proactiveIntervalMax}分钟)`);
  // 首次延迟：给主人一点缓冲，但也别太久
  const firstDelay = Math.min(randomInterval(), 2 * 60 * 1000);
  const seconds = Math.round(firstDelay / 1000);
  console.log(`💌 首次主动消息: ${seconds}秒后`);
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
// 消息拆分：模拟真人分段发送
// ============================================================

/** 将一段长文本拆成多条短消息，模拟真人微信聊天 */
function splitText(text) {
  // 先按句子标点分割
  const raw = text
    .replace(/([。！？!?~…\n])\s*/g, "$1|||")
    .replace(/([，,；;：:])\s*/g, "$1|")
    .split(/\|{2,3}/)
    .map(s => s.trim())
    .filter(Boolean);

  const chunks = [];
  let buf = "";

  for (const s of raw) {
    const candidate = buf ? buf + s : s;  // 同一条不分隔太远

    if (candidate.length <= 50) {
      // 累积短句
      if (buf) buf += s;
      else buf = s;
    } else if (buf.length >= 15) {
      // buf 已够长，先存储
      chunks.push(buf);
      buf = s;
    } else {
      // buf 很短但 candidate 太长，强行分割
      buf = buf + s;
      // 按逗号二次拆分
      const parts = buf.split("|");
      buf = "";
      for (const p of parts) {
        const clean = p.trim();
        if (!clean) continue;
        if (clean.length <= 50) {
          chunks.push(clean);
        } else {
          // 长句按长度硬切
          for (let i = 0; i < clean.length; i += 40) {
            chunks.push(clean.slice(i, i + 40));
          }
        }
      }
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  return chunks.length > 0 ? chunks : [text];
}

/** 将回复拆成多条消息逐条发送，模拟真人打字节奏 */
async function sendSplitMessages(session, botUserId, toUser, contextToken, fullText, history, label) {
  const chunks = splitText(fullText);
  if (chunks.length === 0) return;

  const shortId = toUser.slice(0, 12);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    await sendText(session, botUserId, toUser, contextToken, chunk);

    if (label === "reply") {
      console.log(`💗 [${shortId}...] 第${i + 1}/${chunks.length}条: ${chunk.slice(0, 60)}...`);
    }

    // 每条消息都追加入历史
    history.push({ role: "assistant", content: chunk });

    // 模拟打字间隔：0.4~1.2秒
    if (i < chunks.length - 1) {
      await sleep(400 + Math.random() * 800);
    }
  }

  // 持久化保存
  saveConversations(conversations);
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
  const shortId = userId.slice(0, 12);

  // 更新用户状态
  updateUserState(userId, botUserId, msg.context_token);

  const textItem = msg.item_list?.find((i) => i.type === 1);
  const imageItem = msg.item_list?.find((i) => i.type === 2);

  // ===== 图片消息：下载、解密、视觉分析 =====
  if (imageItem && !textItem) {
    console.log(`🖼 [${shortId}...] 收到图片`);

    await sendText(session, botUserId, userId, msg.context_token, "收到图片啦～让我看看是什么 (｡･ω･｡)");
    await sendTypingIndicator(session, botUserId, userId, msg.context_token);

    const imgBuf = await downloadAndDecryptImage(imageItem);
    if (!imgBuf) {
      await sendText(session, botUserId, userId, msg.context_token, "呜...图片没加载出来，主人再发一次好不好 (´;ω;`)");
      return;
    }

    const description = await analyzeImage(imgBuf, "主人发了这张图片给你。");
    if (!description) {
      await sendText(session, botUserId, userId, msg.context_token, "这个图片伊涅芙有点看不懂呢...主人解释一下？(⁄ ⁄>⁄ω⁄<⁄ ⁄)");
      return;
    }

    // 把图片描述注入对话
    const history = getConversation(userId);
    history.push({ role: "user", content: `【主人发了一张图片，内容：${description}】请回应主人，像看到了图片一样自然交流。` });
    truncateHistory(history);

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
          let toolResult;
          try {
            const args = JSON.parse(fn.arguments);
            if (fn.name === "web_search") toolResult = await webSearch(args.query);
            else if (fn.name === "generate_image") {
              const buf = await generateImage(args.prompt);
              if (buf) { await sendImage(session, botUserId, userId, msg.context_token, buf); toolResult = "图片已发送。"; }
              else toolResult = "图片生成失败。";
            } else if (fn.name === "set_reminder") toolResult = setReminder(userId, botUserId, msg.context_token, args.text, args.minutes);
            else toolResult = `未知: ${fn.name}`;
          } catch (e) { toolResult = `失败: ${e.message}`; }
          history.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
        }
        data = await callDeepSeekWithTools(history);
      }
      replyText = data.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error(`❌ DeepSeek 错误: ${err.message}`);
      replyText = "呜...脑子短路了 (´;ω;`)";
    }

    if (replyText.trim()) {
      await sendSplitMessages(session, botUserId, userId, msg.context_token, replyText, history, "reply");
    }
    conversations.set(userId, history);
    saveConversations(conversations);
    return;
  }

  // ===== 图片+文字：下载图片，分析后结合文字一起处理 =====
  if (imageItem && textItem) {
    console.log(`🖼💬 [${shortId}...] 图片+文字: ${textItem.text_item.text.slice(0, 30)}`);

    sendTypingIndicator(session, botUserId, userId, msg.context_token);
    const imgBuf = await downloadAndDecryptImage(imageItem);
    const userText = textItem.text_item.text;

    let combinedText = userText;
    if (imgBuf) {
      const description = await analyzeImage(imgBuf, `主人发了这张图片并说："${userText}"`);
      if (description) {
        combinedText = `【主人发了一张图片并说："${userText}"。图片内容：${description}】请回应主人。`;
      }
    }

    const history = getConversation(userId);
    history.push({ role: "user", content: combinedText });
    truncateHistory(history);

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
          let toolResult;
          try {
            const args = JSON.parse(fn.arguments);
            if (fn.name === "web_search") toolResult = await webSearch(args.query);
            else if (fn.name === "generate_image") {
              const buf = await generateImage(args.prompt);
              if (buf) { await sendImage(session, botUserId, userId, msg.context_token, buf); toolResult = "图片已发送。"; }
              else toolResult = "图片生成失败。";
            } else if (fn.name === "set_reminder") toolResult = setReminder(userId, botUserId, msg.context_token, args.text, args.minutes);
            else toolResult = `未知: ${fn.name}`;
          } catch (e) { toolResult = `失败: ${e.message}`; }
          history.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
        }
        data = await callDeepSeekWithTools(history);
      }
      replyText = data.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error(`❌ DeepSeek 错误: ${err.message}`);
      replyText = "呜...脑子短路了 (´;ω;`)";
    }

    if (replyText.trim()) {
      await sendSplitMessages(session, botUserId, userId, msg.context_token, replyText, history, "reply");
    }
    conversations.set(userId, history);
    saveConversations(conversations);
    return;
  }

  // ===== 纯文本消息 =====
  if (!textItem) {
    const typeNames = { 3: "语音", 4: "文件", 5: "视频" };
    const mediaType = msg.item_list?.[0]?.type;
    await sendText(session, botUserId, userId, msg.context_token,
      `主人发的是${typeNames[mediaType] || "什么"}呀～伊涅芙还处理不了呢 (｡•́︿•̀｡)`);
    return;
  }

  const userText = textItem.text_item.text;
  console.log(`💬 [${shortId}...] ${userText}`);

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
    await sendSplitMessages(session, botUserId, userId, msg.context_token, replyText, history, "reply");
    truncateHistory(history);
  }
  conversations.set(userId, history);
  saveConversations(conversations);
}

/** 发送"正在输入"指示 */
async function sendTypingIndicator(session, botUserId, toUser, contextToken) {
  try {
    await wxPost(session, "sendtyping", {
      from_user_id: "",
      to_user_id: toUser,
      context_token: contextToken,
      typing_status: 1,
    });
  } catch (_) { /* ignore */ }
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

  // 加载用户状态 & 对话记忆
  userStates = loadUserState();
  const savedConvs = loadConversations();
  for (const [k, v] of savedConvs) {
    conversations.set(k, v);
  }

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
