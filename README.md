# Couple Cinema

一个双人异地观影原型：房主选择本地电影，浏览器用 WebRTC 将电影画面、电影声音和双方语音点对点传给观众。服务端只负责临时房间、播放状态和 WebRTC 信令，不上传、不保存电影文件。

## 功能

- 邀请码免登录创建/加入房间
- 房主本地电影播放与 `captureStream()` 推流
- 观众无需本地电影文件，直接接收 WebRTC 远端流
- 双方麦克风语音和静音状态
- 观众向房主发送播放、暂停、快退、快进请求
- Chrome/Edge 桌面端优先，1080p/720p 码率模式

## 运行

```bash
npm install
npm run dev
```

默认端口：

- 前端：http://localhost:5173
- 后端：http://localhost:8787

开发环境通过 Vite 代理 `/api` 和 `/ws` 到后端。公网部署必须使用 HTTPS，否则浏览器不会允许摄像头/麦克风和部分 WebRTC 能力。

## 部署

```bash
npm install
npm run build
npm start
```

生产启动后，后端会同时提供 API、WebSocket 和 `dist` 里的前端静态文件。默认监听 `8787` 端口，可以通过环境变量修改：

```bash
PORT=8787 npm start
```

如果部署在云服务器，建议用 Nginx 或 Caddy 做 HTTPS 反向代理，并把 WebSocket 转发到同一个 Node 服务。

## 生产注意事项

- 配置 TURN 服务，例如 coturn，提高异地网络下的连通率。
- 第一版只限制双人房间，房主离开后观影中断。
- 房主上行带宽决定观众体验。1080p 通常需要稳定的较高上行，卡顿时切换 720p 稳定模式。
- 服务端内存保存房间状态，重启会清空房间；生产需要接 Redis 或数据库。
