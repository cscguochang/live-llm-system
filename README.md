# Live Stream LLM System

这是一个纯前端的实时视频图文直播采集与 LLM 聊天系统。

## 功能特点

- **内容生成器 (`index.html`)**:
  - 采集任意屏幕、窗口或浏览器标签页的内容。
  - 按配置的时间间隔生成带时间戳的截图。
  - 实时音频转录：
    - **火山引擎 ASR (推荐)**: 通过 WebSocket 实时流式转录系统音频或麦克风音频。支持高精度识别。
    - **Web Speech API**: 浏览器自带的语音识别（通常仅支持麦克风）。
  - 通过 `BroadcastChannel` 将图文内容实时广播给 Chatbot 页面。

- **LLM 聊天伴侣 (`chatbot.html`)**:
  - 实时展示直播的图文流（截图 + 文字解说）。
  - 内置 AI 聊天界面，可针对视频内容进行提问。
  - 支持配置任意兼容 OpenAI 接口的 LLM 服务（如 OpenAI, Azure, DeepSeek 等）。
  - 支持自定义 System Prompt。
  - 自动管理上下文窗口（发送最近 10 条图文记录给 LLM）。

## 使用说明

1. **启动本地服务**:
   由于浏览器安全限制（跨域通信），建议通过本地服务器运行。
   ```bash
   # Python 3
   python3 -m http.server 8000
   ```

2. **打开内容生成器**:
   - 访问 [http://localhost:8000/index.html](http://localhost:8000/index.html)
   - **配置火山引擎 ASR**:
     - 在侧边栏选择 "火山引擎 ASR"。
     - 输入你的 App ID 和 Access Token (需在火山引擎控制台获取)。
     -Resource ID 默认为通用模型，可根据需要修改。
   - 点击 **开始采集**。
   - 选择要共享的标签页或窗口。**注意**: 务必勾选 **"分享标签页音频"** (Share tab audio) 以便捕获系统声音。

3. **打开 Chatbot**:
   - 访问 [http://localhost:8000/chatbot.html](http://localhost:8000/chatbot.html)
   - 点击右上角 **配置** 按钮。
   - 输入你的 LLM API Endpoint (例如 `https://api.openai.com/v1/chat/completions`) 和 API Key。
   - 设置模型名称 (如 `gpt-4o` 或 `gpt-3.5-turbo`)。
   - 直播内容会自动同步显示，你可以随时开始与 AI 聊天。

## 注意事项

- **浏览器安全**: 首次访问可能需要允许麦克风/屏幕录制权限。
- **持久化**: 最近的图文记录会保存在 `localStorage` 中，刷新页面不丢失。
- **跨标签页通信**: 必须在同一源 (Origin) 下打开两个页面才能互通。
- **火山引擎鉴权**: 本项目使用 WebSocket 连接火山引擎 ASR，鉴权信息通过 URL 参数传递（纯前端模式下无法设置自定义 WebSocket Headers）。

## 文件结构

- `index.html`: 采集端主页
- `chatbot.html`: 聊天端主页
- `shared.js`: 共享逻辑 (FeedManager, BroadcastChannel, LocalStorage)
- `style.css`: 样式文件
- `README.md`: 说明文档
