# 重返未来：1999 风格共同观影厅 (Project Reverse)

一个基于 React + MQTT 的多人在线同步观影应用，采用了《重返未来：1999》的英伦神秘学视觉风格。

## 特性 (Features)

- **神秘学视觉风格**：深色调、金线装饰、暴雨动画、魔法符文。
- **全中文界面**：沉浸式剧情体验。
- **多端同步**：基于 MQTT 协议，实现毫秒级播放同步。
- **角色系统**：队长（房主）与队员（访客），带有随机生成的神秘学头像。
- **无后端**：纯前端实现，可部署于 GitHub Pages。

## 快速开始 (Quick Start)

1. **安装依赖**
   ```bash
   npm install
   ```

2. **启动开发环境**
   ```bash
   npm run dev
   ```

3. **构建部署**
   ```bash
   npm run build
   ```

## 配置说明

默认连接公共 MQTT Broker。如需生产环境使用，请在 `src/App.jsx` 中修改 `MQTT_BROKER_URL` 为自建的 MQTT 服务地址（推荐使用 EMQX 或 Mosquitto）。

## 本地 MQTT + WSS 验证（用于插件联调）

1. 安装 Python 依赖
   ```bash
   pip install websockets
   ```

2. 生成本地证书（PowerShell / Git Bash 任选）
   ```bash
   mkdir -p certs
   openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
     -keyout certs/localhost.key -out certs/localhost.crt \
     -subj "/CN=localhost"
   ```

3. 启动本地 WSS Broker
   ```bash
   python tools/local_mqtt_wss_broker.py --host 0.0.0.0 --port 9001 --path /mqtt
   ```

4. 前端切换到本地 Broker（在项目根目录创建 `.env.local`）
   ```bash
   VITE_MQTT_BROKER_URL=wss://localhost:9001/mqtt
   VITE_MQTT_REJECT_UNAUTHORIZED=false
   ```

5. 重新构建并重载扩展后，用两个页面加入同一房间，观察 broker 控制台输出：
   - `CONNECT`：客户端连接
   - `SUBSCRIBE`：订阅房间 topic
   - `PUBLISH`：收到同步消息并转发

> 注意：浏览器对自签名证书可能仍会拦截 `wss://localhost`。若连不上，请先在浏览器访问一次 `https://localhost:9001` 并信任证书，或使用受信任证书（如 mkcert）。

## 字体

本项目使用系统宋体/明体 (Songti/SimSun) 以还原复古文学气息，无需加载外部字体文件。
