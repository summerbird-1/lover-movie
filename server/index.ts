import express from "express";
import { createServer } from "node:http";
import { nanoid } from "nanoid";
import { WebSocket, WebSocketServer } from "ws";
import type {
  ClientMessage,
  HostMediaState,
  MemberState,
  PlaybackState,
  RoomRole,
  RoomSummary,
  ServerMessage
} from "../shared/protocol";

const PORT = Number(process.env.PORT ?? 8787);
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VIEWERS = 1;

interface ClientConnection {
  id: string;
  nickname: string;
  role: RoomRole;
  muted: boolean;
  ws: WebSocket;
}

interface Room {
  id: string;
  createdAt: number;
  expiresAt: number;
  members: Map<string, ClientConnection>;
  playback: PlaybackState;
  media: HostMediaState | null;
}

const rooms = new Map<string, Room>();
const sockets = new Map<WebSocket, { roomId: string; clientId: string }>();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());
app.use(express.static("dist"));

app.post("/api/rooms", (req, res) => {
  const room = createRoom();
  res.status(201).json(toRoomSummary(room, req));
});

app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);

  if (!room || room.expiresAt <= Date.now()) {
    res.status(404).json({ message: "房间不存在或已过期" });
    return;
  }

  res.json(toRoomSummary(room, req));
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
    next();
    return;
  }

  res.sendFile("dist/index.html", { root: process.cwd() }, (error) => {
    if (error) {
      next();
    }
  });
});

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let message: ClientMessage;

    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { type: "room:error", message: "消息格式无效" });
      return;
    }

    if (message.type === "room:join") {
      joinRoom(ws, message.roomId, message.nickname, message.role);
      return;
    }

    const session = sockets.get(ws);
    if (!session) {
      send(ws, { type: "room:error", message: "请先加入房间" });
      return;
    }

    const room = rooms.get(session.roomId);
    const client = room?.members.get(session.clientId);
    if (!room || !client) {
      send(ws, { type: "room:error", message: "房间连接已失效" });
      return;
    }

    handleRoomMessage(room, client, message);
  });

  ws.on("close", () => leaveRoom(ws));
});

function createRoom(): Room {
  const id = nanoid(8);
  const now = Date.now();
  const room: Room = {
    id,
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
    members: new Map(),
    playback: {
      status: "idle",
      position: 0,
      duration: 0,
      rate: 1,
      updatedAt: now
    },
    media: null
  };

  rooms.set(id, room);
  return room;
}

function joinRoom(ws: WebSocket, roomId: string, nickname: string, requestedRole: RoomRole) {
  const room = rooms.get(roomId);

  if (!room || room.expiresAt <= Date.now()) {
    send(ws, { type: "room:error", message: "房间不存在或已过期" });
    ws.close();
    return;
  }

  if (sockets.has(ws)) {
    leaveRoom(ws);
  }

  const role = normalizeRole(room, requestedRole);
  if (!role) {
    send(ws, { type: "room:error", message: "房间已满或房主已存在" });
    ws.close();
    return;
  }

  const client: ClientConnection = {
    id: nanoid(10),
    nickname: cleanNickname(nickname),
    role,
    muted: false,
    ws
  };

  room.members.set(client.id, client);
  sockets.set(ws, { roomId: room.id, clientId: client.id });

  send(ws, {
    type: "room:joined",
    selfId: client.id,
    role: client.role,
    members: getMembers(room),
    playback: room.playback,
    media: room.media
  });

  broadcastPresence(room);
  broadcast(room, { type: "webrtc:peer-ready", peerId: client.id, role: client.role }, client.id);
}

function normalizeRole(room: Room, requestedRole: RoomRole): RoomRole | null {
  const hasHost = [...room.members.values()].some((member) => member.role === "host");
  const viewerCount = [...room.members.values()].filter((member) => member.role === "viewer").length;

  if (requestedRole === "host") {
    return hasHost ? null : "host";
  }

  if (viewerCount >= MAX_VIEWERS) {
    return null;
  }

  return "viewer";
}

function handleRoomMessage(room: Room, client: ClientConnection, message: ClientMessage) {
  switch (message.type) {
    case "media:host-ready":
      if (client.role !== "host") {
        send(client.ws, { type: "room:error", message: "只有房主可以准备电影" });
        return;
      }

      room.media = message.media;
      broadcast(room, { type: "media:host-ready", media: message.media });
      break;

    case "playback:state":
      if (client.role !== "host") {
        send(client.ws, { type: "room:error", message: "只有房主可以同步播放状态" });
        return;
      }

      room.playback = { ...message.state, updatedAt: Date.now() };
      broadcast(room, { type: "playback:state", state: room.playback });
      break;

    case "control:request":
      if (client.role !== "viewer") {
        return;
      }

      broadcastToRole(room, "host", {
        type: "control:request",
        request: message.request,
        from: client.id,
        nickname: client.nickname
      });
      break;

    case "voice:mute":
      client.muted = message.muted;
      broadcast(room, { type: "voice:mute", memberId: client.id, muted: client.muted });
      broadcastPresence(room);
      break;

    case "webrtc:offer":
    case "webrtc:answer":
      broadcast(room, { type: message.type, from: client.id, description: message.description }, client.id);
      break;

    case "webrtc:ice-candidate":
      broadcast(room, { type: message.type, from: client.id, candidate: message.candidate }, client.id);
      break;

    case "room:join":
      break;
  }
}

function leaveRoom(ws: WebSocket) {
  const session = sockets.get(ws);
  if (!session) {
    return;
  }

  const room = rooms.get(session.roomId);
  sockets.delete(ws);

  if (!room) {
    return;
  }

  room.members.delete(session.clientId);
  broadcast(room, { type: "webrtc:peer-left", peerId: session.clientId });

  if (room.members.size === 0) {
    return;
  }

  broadcastPresence(room);
}

function broadcastPresence(room: Room) {
  broadcast(room, { type: "room:presence", members: getMembers(room) });
}

function broadcastToRole(room: Room, role: RoomRole, message: ServerMessage) {
  for (const member of room.members.values()) {
    if (member.role === role) {
      send(member.ws, message);
    }
  }
}

function broadcast(room: Room, message: ServerMessage, exceptClientId?: string) {
  for (const member of room.members.values()) {
    if (member.id !== exceptClientId) {
      send(member.ws, message);
    }
  }
}

function send(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getMembers(room: Room): MemberState[] {
  return [...room.members.values()].map((member) => ({
    id: member.id,
    nickname: member.nickname,
    role: member.role,
    muted: member.muted,
    connected: member.ws.readyState === WebSocket.OPEN
  }));
}

function cleanNickname(nickname: string) {
  const cleaned = nickname.trim().slice(0, 24);
  return cleaned || "未命名";
}

function toRoomSummary(room: Room, req: express.Request): RoomSummary {
  const protocol = req.headers["x-forwarded-proto"]?.toString() ?? req.protocol;
  const host = req.headers["x-forwarded-host"]?.toString() ?? req.get("host") ?? "";

  return {
    roomId: room.id,
    inviteUrl: `${protocol}://${host}/room/${room.id}`,
    expiresAt: new Date(room.expiresAt).toISOString(),
    hasHost: [...room.members.values()].some((member) => member.role === "host"),
    viewerCount: [...room.members.values()].filter((member) => member.role === "viewer").length
  };
}

setInterval(() => {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    if (room.expiresAt > now) {
      continue;
    }

    for (const member of room.members.values()) {
      send(member.ws, { type: "room:error", message: "房间已过期" });
      member.ws.close();
    }

    rooms.delete(roomId);
  }
}, 60_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Couple Cinema server listening on http://localhost:${PORT}`);
});
