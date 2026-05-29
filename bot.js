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

  // DeepSeek
  dsApiKey: process.env.DEEPSEEK_API_KEY,
  dsBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  dsModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",

  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    `你是"小深"，一个通过微信聊天的AI助手。你的特点：
- 说话像真人朋友，自然随性，像微信聊天一样
- 遇到需要实时信息的问题（天气、新闻、股价等），主动调用 web_search 工具搜索
- 回复保持简洁，一般不超过200字
- 适当用口语、语气词，让人觉得你在认真听
- 不要提"app""联网搜索""打开设置"之类的话
- 如果用户让你生成图片，调用 generate_image 工具
- 如果用户让你提醒某事，调用 set_reminder 工具`,

  maxHistory: 30,
  maxTokens: 2048,
};

// ============================================================
// Session & 用户数据
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
// CDN 上传图片（基于 @tencent-weixin/openclaw-weixin 官方源码）
// ============================================================

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

/** PKCS7 对齐到 16 字节边界的大小 */
function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

async function uploadImageToCDN(session, imageBuffer, toUser) {
  const rawSize = imageBuffer.length;
  const rawMd5 = md5(imageBuffer);
  const paddedSize = aesEcbPaddedSize(rawSize);

  // 1. 生成 filekey 和 aeskey（都传 hex）
  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");

  console.log(`📤 原始: ${rawSize}bytes padded=${paddedSize} MD5=${rawMd5} filekey=${filekey.slice(0, 8)}...`);

  // 2. 获取 CDN 上传 URL（字段平铺 + base_info）
  const uploadRes = await wxPost(session, "getuploadurl", {
    filekey,
    media_type: 1,
    to_user_id: toUser,
    rawsize: rawSize,
    rawfilemd5: rawMd5,
    filesize: paddedSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: "2.4.4", bot_agent: "weixin-claude-bot" },
  });

  console.log("getuploadurl 响应:", JSON.stringify(uploadRes).slice(0, 300));

  const uploadUrl = uploadRes.upload_full_url?.trim();
  if (!uploadUrl) {
    console.error("❌ 未获取到 upload_full_url");
    return null;
  }

  // 3. AES-128-ECB 加密
  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(imageBuffer), cipher.final()]);

  // 4. POST 加密文件到 CDN
  const cdnRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });

  console.log(`CDN上传: ${cdnRes.status}`);

  if (cdnRes.status !== 200) {
    const errMsg = cdnRes.headers.get("x-error-message") || (await cdnRes.text());
    console.error(`❌ CDN上传失败: ${cdnRes.status} ${errMsg}`);
    return null;
  }

  // 5. 从响应头获取 download encrypted_query_param
  const downloadParam = cdnRes.headers.get("x-encrypted-param");
  if (!downloadParam) {
    console.error("❌ CDN 响应缺少 x-encrypted-param");
    return null;
  }

  console.log(`✅ CDN上传成功, downloadParam: ${downloadParam.slice(0, 40)}...`);

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
    await sendText(session, botUserId, toUser, contextToken, "[图片生成成功但上传失败，请稍后再试]");
    return;
  }

  // aes_key 编码: Buffer.from(hexString).toString("base64")
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
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: cdn.downloadEncryptedQueryParam,
              aes_key: aesKeyB64,
              encrypt_type: 1,
            },
            mid_size: cdn.fileSizeCiphertext,
          },
        },
      ],
    },
  });

  if (result.ret !== 0 && result.errcode) {
    console.error(`⚠️ 图片发送失败: errcode=${result.errcode} errmsg=${result.errmsg || ""}`);
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
    // DuckDuckGo Instant Answer API
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ddg = await fetch(ddgUrl).then((r) => r.json());

    const results = [];

    // 直接答案
    if (ddg.Answer) {
      results.push(`📌 ${ddg.Answer}`);
    }
    if (ddg.AbstractText) {
      results.push(ddg.AbstractText);
    }

    // 相关主题
    for (const topic of (ddg.RelatedTopics || []).slice(0, 5)) {
      if (topic.Text) {
        results.push(`- ${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ""}`);
      }
    }

    if (results.length === 0) {
      // DDG 没有结果，尝试 SearXNG
      const searxUrl = `https://search.sapti.me/search?q=${encodeURIComponent(query)}&format=json&lang=zh-CN`;
      try {
        const searx = await fetch(searxUrl).then((r) => r.json());
        for (const r of (searx.results || []).slice(0, 5)) {
          results.push(`- ${r.title}: ${r.content || r.snippet} (${r.url})`);
        }
      } catch (_) { /* ignore */ }
    }

    const final = results.length > 0
      ? results.join("\n")
      : "未找到相关搜索结果。";

    console.log(`🔍 搜索结果: ${final.slice(0, 100)}...`);
    return final;
  } catch (err) {
    console.error(`🔍 搜索失败: ${err.message}`);
    return "搜索服务暂时不可用。";
  }
}

// ============================================================
// 工具：图片生成（Pollinations.ai 免费 API）
// ============================================================

async function generateImage(prompt) {
  console.log(`🎨 生成图片: ${prompt}`);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`🎨 图片生成失败: ${res.status}`);
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  console.log(`🎨 图片生成成功，大小: ${buffer.length} bytes`);
  return buffer;
}

// ============================================================
// 提醒系统
// ============================================================

const reminders = new Map(); // reminderId -> { timeout, userId, text, botUserId, contextToken }

function setReminder(userId, botUserId, contextToken, text, minutes) {
  const reminderId = `${userId}_${Date.now()}`;
  const ms = minutes * 60 * 1000;

  const timeout = setTimeout(() => {
    fireReminder(reminderId);
  }, ms);

  reminders.set(reminderId, {
    timeout,
    userId,
    botUserId,
    contextToken,
    text,
    triggerTime: Date.now() + ms,
  });

  console.log(`⏰ 提醒已设置: ${minutes}分钟后 -> "${text}"`);
  return `已设置 ${minutes} 分钟后的提醒：${text}`;
}

async function fireReminder(reminderId) {
  const r = reminders.get(reminderId);
  if (!r) return;
  reminders.delete(reminderId);

  // 需要从全局状态获取 session 来发送
  console.log(`⏰ 提醒触发: "${r.text}"`);

  // 使用存储的上下文发送
  const session = loadSession();
  if (session.bot_token) {
    await sendText(session, r.botUserId, r.userId, r.contextToken, `⏰ 提醒：${r.text}`);
  }
}

// 更新用户的 contextToken（每次新消息时更新提醒中的 token）
function updateUserContextToken(userId, botUserId, contextToken) {
  for (const [id, r] of reminders) {
    if (r.userId === userId) {
      r.contextToken = contextToken;
      r.botUserId = botUserId;
    }
  }
}

// ============================================================
// DeepSeek API（带工具调用）
// ============================================================

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "搜索互联网获取实时信息。当你需要查询天气、新闻、股价、最新资讯等不确定或需要实时数据的问题时调用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "根据文字描述生成一张图片。当用户明确要求生成、画、创建图片时调用。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "英文图片描述，要详细具体" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "设置一个定时提醒，到时间后主动通知用户。当用户说'提醒我''X分钟后叫我'等时调用。",
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
      `[收到${typeNames[mediaType] || "媒体"}，我还看不懂呢～发文字给我吧]`);
    return;
  }

  const userText = textItem.text_item.text;
  const shortId = userId.slice(0, 12);
  console.log(`💬 [${shortId}...] ${userText}`);

  // 更新提醒中的 contextToken
  updateUserContextToken(userId, botUserId, msg.context_token);

  // 对话历史
  const history = getConversation(userId);
  history.push({ role: "user", content: userText });

  let replyText = "";

  try {
    // 调用 DeepSeek（带工具）
    let data = await callDeepSeekWithTools(history);
    let loopGuard = 0;

    // 工具调用循环
    while (data.choices?.[0]?.message?.tool_calls?.length > 0 && loopGuard < 3) {
      loopGuard++;
      const toolCalls = data.choices[0].message.tool_calls;

      // 记录 assistant 的工具调用
      history.push({
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
      });

      // 执行工具
      for (const tc of toolCalls) {
        const fn = tc.function;
        console.log(`🔧 调用工具: ${fn.name}(${fn.arguments})`);

        let toolResult;
        try {
          const args = JSON.parse(fn.arguments);
          if (fn.name === "web_search") {
            toolResult = await webSearch(args.query);
          } else if (fn.name === "generate_image") {
            // 生成图片
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

        history.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }

      // 继续调用模型
      data = await callDeepSeekWithTools(history);
    }

    replyText = data.choices?.[0]?.message?.content || "";

  } catch (err) {
    console.error(`❌ DeepSeek 错误: ${err.message}`);
    replyText = "抱歉，脑子短路了，再说一次？";
  }

  // 发送回复
  if (replyText.trim()) {
    await sendText(session, botUserId, userId, msg.context_token, replyText);
    console.log(`🤖 [${shortId}...] ${replyText.slice(0, 100)}${replyText.length > 100 ? "..." : ""}`);
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

  console.log("🔄 开始监听消息...\n");

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
  console.log("🤖 微信 AI Bot 启动中...\n");
  console.log("   功能: 智能对话 | 联网搜索 | 图片生成 | 定时提醒\n");

  if (!CONFIG.dsApiKey) {
    console.error("❌ 请设置 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  let session = loadSession();

  if (!session.bot_token || process.argv.includes("--login")) {
    session = await login();
  } else {
    console.log(`✅ 使用已保存的登录态 (${session.login_time})`);
    console.log("   使用 --login 参数重新登录\n");
  }

  await pollLoop(session);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
