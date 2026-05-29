# 微信 AI Bot

基于腾讯官方 iLink Bot API，将 AI 大模型接入微信个人号。

## 功能

- **智能对话**：接入 DeepSeek，自然聊天
- **联网搜索**：自动搜索实时信息（天气、新闻等）
- **AI 生图**：文字描述即可生成图片，通过微信发送
- **定时提醒**：设置提醒，到时间主动推送消息

## 原理

使用腾讯 `@tencent-weixin/openclaw-weixin` 开源的 iLink Bot 协议：
- 扫码登录获取 bot_token
- 长轮询接收微信消息
- HTTP API 发送回复（文字 + 图片 CDN 上传）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入 DeepSeek API Key

# 3. 启动
npm start

# 终端显示二维码 → 微信扫码 → 手机确认 → 开始聊天
```

## 配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填） | - |
| `DEEPSEEK_MODEL` | 模型名称 | `deepseek-chat` |
| `DEEPSEEK_BASE_URL` | API 地址 | `https://api.deepseek.com` |
| `SYSTEM_PROMPT` | 系统提示词 | 内置中文 prompt |

## 项目结构

```
├── bot.js          # 主程序（~400行）
├── package.json    # 依赖配置
├── .env.example    # 环境变量模板
└── session.json    # 微信登录态（自动生成）
```

## 协议

基于 [@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 开源协议实现。

## License

MIT
