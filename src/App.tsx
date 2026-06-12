import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Clapperboard,
  Copy,
  Link,
  Mic,
  MicOff,
  MonitorPlay,
  Pause,
  PhoneOff,
  Play,
  Radio,
  Send,
  Settings,
  Signal,
  UserRound,
  Video,
  Volume2
} from "lucide-react";
import type {
  ClientMessage,
  ControlAction,
  HostMediaState,
  MemberState,
  PlaybackState,
  RoomRole,
  RoomSummary,
  ServerMessage
} from "../shared/protocol";

const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const initialPlayback: PlaybackState = {
  status: "idle",
  position: 0,
  duration: 0,
  rate: 1,
  updatedAt: Date.now()
};

const qualityProfiles = {
  "1080p": {
    label: "1080p 高画质",
    maxBitrate: 12_000_000,
    maxFramerate: 30
  },
  "720p": {
    label: "720p 稳定",
    maxBitrate: 4_000_000,
    maxFramerate: 30
  }
} as const;

type CapturableVideoElement = HTMLVideoElement & {
  captureStream: () => MediaStream;
};

type ConnectionState = "idle" | "joining" | "connected" | "failed";

export function App() {
  const roomIdFromUrl = getRoomIdFromUrl();
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [joinRoomId, setJoinRoomId] = useState(roomIdFromUrl ?? "");
  const [nickname, setNickname] = useState(localStorage.getItem("cinema:nickname") ?? "");
  const [role, setRole] = useState<RoomRole>(roomIdFromUrl ? "viewer" : "host");
  const [selfId, setSelfId] = useState("");
  const [members, setMembers] = useState<MemberState[]>([]);
  const [media, setMedia] = useState<HostMediaState | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>(initialPlayback);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState>("new");
  const [iceState, setIceState] = useState<RTCIceConnectionState>("new");
  const [muted, setMuted] = useState(false);
  const [movieError, setMovieError] = useState("");
  const [notice, setNotice] = useState("");
  const [qualityMode, setQualityMode] = useState<"1080p" | "720p">("1080p");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remotePlaybackBlocked, setRemotePlaybackBlocked] = useState(false);
  const [localMovieName, setLocalMovieName] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const movieStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const makingOfferRef = useRef(false);
  const membersRef = useRef<MemberState[]>([]);
  const roleRef = useRef<RoomRole>(role);
  const isHost = role === "host";
  const host = members.find((member) => member.role === "host");
  const viewer = members.find((member) => member.role === "viewer");
  const shareUrl = room ? `${window.location.origin}/room/${room.roomId}` : "";

  const canStart = useMemo(() => nickname.trim().length > 0, [nickname]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current
        .play()
        .then(() => setRemotePlaybackBlocked(false))
        .catch(() => setRemotePlaybackBlocked(true));
    }
  }, [remoteStream]);

  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    if (!isHost || !pcRef.current) {
      return;
    }

    void applyVideoQuality(pcRef.current);
  }, [isHost, qualityMode]);

  useEffect(() => {
    return () => {
      cleanupConnections();
    };
  }, []);

  async function createRoom() {
    setNotice("");
    const response = await fetch("/api/rooms", { method: "POST" });

    if (!response.ok) {
      setNotice("创建房间失败，请稍后重试。");
      return;
    }

    const created = (await response.json()) as RoomSummary;
    setRoom(created);
    setJoinRoomId(created.roomId);
    window.history.replaceState(null, "", `/room/${created.roomId}`);
  }

  async function joinRoom(selectedRole = role) {
    if (!canStart) {
      setNotice("先填一个昵称。");
      return;
    }

    localStorage.setItem("cinema:nickname", nickname.trim());
    setConnectionState("joining");
    setNotice("");

    const normalizedRoomId = parseRoomId(joinRoomId);
    setJoinRoomId(normalizedRoomId);

    let summary = room;
    if (!summary || summary.roomId !== normalizedRoomId) {
      const response = await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}`);

      if (!response.ok) {
        setConnectionState("failed");
        setNotice("房间不存在或已经过期。");
        return;
      }

      summary = (await response.json()) as RoomSummary;
      setRoom(summary);
    }

    connectWebSocket(summary.roomId, selectedRole);
  }

  function connectWebSocket(roomId: string, selectedRole: RoomRole) {
    cleanupConnections();
    setRole(selectedRole);

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      send({
        type: "room:join",
        roomId,
        nickname: nickname.trim(),
        role: selectedRole
      });
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      void handleServerMessage(message);
    };

    ws.onclose = () => {
      setConnectionState((current) => (current === "connected" ? "failed" : current));
      setNotice("房间连接已断开，可以刷新或重新加入。");
    };

    ws.onerror = () => {
      setConnectionState("failed");
      setNotice("WebSocket 连接失败。");
    };
  }

  async function handleServerMessage(message: ServerMessage) {
    switch (message.type) {
      case "room:joined":
        setSelfId(message.selfId);
        setRole(message.role);
        setMembers(message.members);
        setPlayback(message.playback);
        setMedia(message.media);
        setConnectionState("connected");
        await ensurePeerConnection(message.role);
        break;

      case "room:presence":
        setMembers(message.members);
        break;

      case "room:error":
        setNotice(message.message);
        break;

      case "media:host-ready":
        setMedia(message.media);
        break;

      case "playback:state":
        setPlayback(message.state);
        break;

      case "control:request":
        setNotice(`${message.nickname} 请求${controlLabel(message.request.action)}。`);
        applyViewerControlRequest(message.request.action, message.request.position);
        break;

      case "voice:mute":
        setMembers((current) =>
          current.map((member) =>
            member.id === message.memberId ? { ...member, muted: message.muted } : member
          )
        );
        break;

      case "webrtc:peer-ready":
        await handlePeerReady(message.role);
        break;

      case "webrtc:peer-left":
        setRemoteStream(null);
        closePeerConnection();
        await ensurePeerConnection(roleRef.current);
        break;

      case "webrtc:offer":
        await handleOffer(message.description);
        break;

      case "webrtc:answer":
        await handleAnswer(message.description);
        break;

      case "webrtc:ice-candidate":
        await handleIceCandidate(message.candidate);
        break;
    }
  }

  async function ensurePeerConnection(currentRole = role) {
    if (pcRef.current) {
      return pcRef.current;
    }

    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        send({ type: "webrtc:ice-candidate", candidate: event.candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        setRemoteStream(stream);
      }
    };

    pc.onconnectionstatechange = () => setRtcState(pc.connectionState);
    pc.oniceconnectionstatechange = () => setIceState(pc.iceConnectionState);

    if (currentRole === "viewer") {
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "sendrecv" });
      await addMicrophoneTrack(pc);
    }

    return pc;
  }

  async function handlePeerReady(peerRole: RoomRole) {
    if (roleRef.current !== "host" || peerRole !== "viewer") {
      return;
    }

    const pc = await ensurePeerConnection("host");
    await addHostTracks(pc);
    await renegotiateIfViewerPresent(pc, true);
  }

  async function handleOffer(description: RTCSessionDescriptionInit) {
    const currentRole = roleRef.current;
    const pc = await ensurePeerConnection(currentRole);
    await pc.setRemoteDescription(description);
    await flushPendingCandidates(pc);

    if (currentRole === "viewer") {
      await addMicrophoneTrack(pc);
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "webrtc:answer", description: answer });
  }

  async function handleAnswer(description: RTCSessionDescriptionInit) {
    const pc = await ensurePeerConnection(roleRef.current);
    await pc.setRemoteDescription(description);
    await flushPendingCandidates(pc);
  }

  async function handleIceCandidate(candidate: RTCIceCandidateInit) {
    const pc = await ensurePeerConnection(roleRef.current);

    if (!pc.remoteDescription) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }

    await pc.addIceCandidate(candidate);
  }

  async function flushPendingCandidates(pc: RTCPeerConnection) {
    for (const candidate of pendingCandidatesRef.current) {
      await pc.addIceCandidate(candidate);
    }

    pendingCandidatesRef.current = [];
  }

  async function createAndSendOffer(pc: RTCPeerConnection) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "webrtc:offer", description: offer });
  }

  async function onMovieSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const video = videoRef.current;

    if (!file || !video) {
      return;
    }

    setMovieError("");
    setLocalMovieName(file.name);
    video.src = URL.createObjectURL(file);
    video.load();
  }

  async function prepareHostStream() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    try {
      if (!isCapturableVideo(video)) {
        setMovieError("当前浏览器不支持 captureStream，请使用桌面 Chrome 或 Edge。");
        return;
      }

      await video.play();
      const movieStream = video.captureStream();
      movieStreamRef.current = movieStream;
      const pc = await ensurePeerConnection("host");
      await addHostTracks(pc);
      await renegotiateIfViewerPresent(pc);

      const mediaState: HostMediaState = {
        fileName: localMovieName || "本地电影",
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight
      };

      setMedia(mediaState);
      send({ type: "media:host-ready", media: mediaState });
      syncPlayback("playing");
      setNotice("电影已经开始推流。");
    } catch (error) {
      setMovieError(error instanceof Error ? error.message : "准备推流失败。");
    }
  }

  async function addHostTracks(pc: RTCPeerConnection) {
    const video = videoRef.current;
    if (!movieStreamRef.current && (!video || !isCapturableVideo(video))) {
      await addMicrophoneTrack(pc);
      return;
    }

    if (!movieStreamRef.current && video && isCapturableVideo(video)) {
      movieStreamRef.current = video.captureStream();
    }

    const movieStream = movieStreamRef.current;
    if (!movieStream) {
      await addMicrophoneTrack(pc);
      return;
    }

    for (const track of movieStream.getTracks()) {
      if (!pc.getSenders().some((sender) => sender.track === track)) {
        const sender = pc.addTrack(track, movieStream);
        if (track.kind === "video") {
          track.contentHint = "detail";
          await setVideoBitrate(sender);
        }
      }
    }

    await addMicrophoneTrack(pc);
  }

  async function addMicrophoneTrack(pc: RTCPeerConnection) {
    if (!micStreamRef.current) {
      try {
        micStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
      } catch {
        setNotice("麦克风权限被拒绝，语音暂不可用。");
        return;
      }
    }

    for (const track of micStreamRef.current.getAudioTracks()) {
      track.enabled = !muted;
      if (!pc.getSenders().some((sender) => sender.track === track)) {
        pc.addTrack(track, micStreamRef.current);
      }
    }
  }

  async function setVideoBitrate(sender: RTCRtpSender) {
    const parameters = sender.getParameters();
    const profile = qualityProfiles[qualityMode];

    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = profile.maxBitrate;
    parameters.encodings[0].maxFramerate = profile.maxFramerate;
    parameters.encodings[0].scaleResolutionDownBy = 1;
    await sender.setParameters(parameters);
  }

  async function applyVideoQuality(pc: RTCPeerConnection) {
    const videoSenders = pc.getSenders().filter((sender) => sender.track?.kind === "video");

    for (const sender of videoSenders) {
      await setVideoBitrate(sender);
    }
  }

  async function renegotiateIfViewerPresent(pc: RTCPeerConnection, force = false) {
    const hasViewer = force || membersRef.current.some((member) => member.role === "viewer");
    if (!hasViewer || makingOfferRef.current || pc.signalingState !== "stable") {
      return;
    }

    makingOfferRef.current = true;
    try {
      await createAndSendOffer(pc);
    } finally {
      makingOfferRef.current = false;
    }
  }

  function toggleMute() {
    const nextMuted = !muted;
    setMuted(nextMuted);

    for (const track of micStreamRef.current?.getAudioTracks() ?? []) {
      track.enabled = !nextMuted;
    }

    send({ type: "voice:mute", muted: nextMuted });
  }

  function requestControl(action: ControlAction, position?: number) {
    send({ type: "control:request", request: { action, position } });
    setNotice(`已向房主发送${controlLabel(action)}请求。`);
  }

  function applyViewerControlRequest(action: ControlAction, position?: number) {
    const video = videoRef.current;
    if (!video || role !== "host") {
      return;
    }

    if (action === "play") {
      void video.play();
    }

    if (action === "pause") {
      video.pause();
    }

    if (action === "seek" && typeof position === "number") {
      video.currentTime = Math.max(0, Math.min(position, video.duration || position));
    }
  }

  function syncPlayback(status: PlaybackState["status"]) {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const state: PlaybackState = {
      status,
      position: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      rate: video.playbackRate,
      updatedAt: Date.now()
    };

    setPlayback(state);
    send({ type: "playback:state", state });
  }

  function send(message: ClientMessage) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function closePeerConnection() {
    pcRef.current?.close();
    pcRef.current = null;
    pendingCandidatesRef.current = [];
    setRtcState("new");
    setIceState("new");
  }

  function cleanupConnections() {
    wsRef.current?.close();
    wsRef.current = null;
    closePeerConnection();

    for (const stream of [movieStreamRef.current, micStreamRef.current]) {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
    }

    movieStreamRef.current = null;
    micStreamRef.current = null;
  }

  async function copyInvite() {
    if (!shareUrl) {
      return;
    }

    await navigator.clipboard.writeText(shareUrl);
    setNotice("邀请链接已复制。");
  }

  async function playRemoteStream() {
    try {
      await remoteVideoRef.current?.play();
      setRemotePlaybackBlocked(false);
    } catch {
      setNotice("浏览器仍然阻止播放，请检查页面声音或自动播放权限。");
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand">
          <Clapperboard size={28} />
          <div>
            <h1>Couple Cinema</h1>
            <p>房主本地电影点对点观影</p>
          </div>
        </div>
        <div className="status-pill">
          <Signal size={16} />
          {connectionState === "connected" ? "房间已连接" : "等待连接"}
        </div>
      </section>

      {connectionState !== "connected" ? (
        <section className="entry-layout">
          <div className="entry-copy">
            <h2>一人有片，两人一起看</h2>
            <p>
              房主选择本地电影后，浏览器用 WebRTC 将画面、电影声音和语音直接推给另一端。
              服务器只保存临时房间和信令。
            </p>
          </div>

          <div className="panel entry-panel">
            <label>
              昵称
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="例如：阿南"
              />
            </label>

            <div className="role-switch">
              <button
                className={role === "host" ? "selected" : ""}
                onClick={() => setRole("host")}
                type="button"
              >
                <MonitorPlay size={18} />
                我是房主
              </button>
              <button
                className={role === "viewer" ? "selected" : ""}
                onClick={() => setRole("viewer")}
                type="button"
              >
                <UserRound size={18} />
                我是观众
              </button>
            </div>

            {role === "host" ? (
              <button className="primary" disabled={!canStart} onClick={createRoom} type="button">
                <Video size={18} />
                创建观影房间
              </button>
            ) : (
              <label>
                房间码
                <input
                  value={joinRoomId}
                  onChange={(event) => setJoinRoomId(event.target.value.trim())}
                  placeholder="粘贴邀请链接或房间码"
                />
              </label>
            )}

            {room && role === "host" ? (
              <div className="invite-box">
                <span>{shareUrl}</span>
                <button onClick={copyInvite} type="button" title="复制邀请链接">
                  <Copy size={16} />
                </button>
                <button onClick={() => void joinRoom("host")} type="button">
                  <Link size={16} />
                  进入房间
                </button>
              </div>
            ) : null}

            {role === "viewer" ? (
              <button
                className="primary"
                disabled={!canStart || !joinRoomId}
                onClick={() => void joinRoom("viewer")}
                type="button"
              >
                <Send size={18} />
                加入观影
              </button>
            ) : null}

            {notice ? <p className="notice">{notice}</p> : null}
          </div>
        </section>
      ) : (
        <section className="room-layout">
          <div className="watch-stage">
            {isHost ? (
              <div className="host-player">
                <video
                  ref={videoRef}
                  controls
                  playsInline
                  onPlay={() => syncPlayback("playing")}
                  onPause={() => syncPlayback("paused")}
                  onSeeked={() => syncPlayback(videoRef.current?.paused ? "paused" : "playing")}
                  onRateChange={() => syncPlayback(videoRef.current?.paused ? "paused" : "playing")}
                />
                <div className="host-tools">
                  <label className="file-picker">
                    <Video size={18} />
                    选择本地电影
                    <input accept="video/*" onChange={onMovieSelected} type="file" />
                  </label>
                  <button className="primary" onClick={prepareHostStream} type="button">
                    <Radio size={18} />
                    开始推流
                  </button>
                </div>
                {movieError ? <p className="error">{movieError}</p> : null}
              </div>
            ) : (
              <div className="viewer-player">
                <video ref={remoteVideoRef} autoPlay controls playsInline />
                {!remoteStream ? (
                  <div className="empty-video">
                    <MonitorPlay size={36} />
                    等待房主开始推流
                  </div>
                ) : null}
                {remotePlaybackBlocked ? (
                  <div className="empty-video action-overlay">
                    <button className="primary" onClick={playRemoteStream} type="button">
                      <Play size={18} />
                      播放远端电影
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <aside className="side-panel">
            <div className="panel">
              <div className="panel-title">
                <Settings size={18} />
                房间
              </div>
              <div className="meta-row">
                <span>房间码</span>
                <strong>{room?.roomId}</strong>
              </div>
              <div className="meta-row">
                <span>电影</span>
                <strong>{media?.fileName ?? "未准备"}</strong>
              </div>
              <div className="meta-row">
                <span>状态</span>
                <strong>{playback.status === "playing" ? "播放中" : "暂停/待机"}</strong>
              </div>
              <div className="invite-box compact">
                <span>{shareUrl}</span>
                <button onClick={copyInvite} type="button" title="复制邀请链接">
                  <Copy size={16} />
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">
                <Volume2 size={18} />
                语音
              </div>
              <button className="wide" onClick={toggleMute} type="button">
                {muted ? <MicOff size={18} /> : <Mic size={18} />}
                {muted ? "解除静音" : "麦克风静音"}
              </button>
              <div className="member-list">
                {members.map((member) => (
                  <div className="member" key={member.id}>
                    <span>{member.nickname}</span>
                    <small>
                      {member.role === "host" ? "房主" : "观众"}
                      {member.muted ? " · 已静音" : ""}
                    </small>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">
                <Signal size={18} />
                连接质量
              </div>
              <div className="meta-row">
                <span>WebRTC</span>
                <strong>{rtcState}</strong>
              </div>
              <div className="meta-row">
                <span>ICE</span>
                <strong>{iceState}</strong>
              </div>
              {isHost ? (
                <div className="quality-toggle">
                  <button
                    className={qualityMode === "1080p" ? "selected" : ""}
                    onClick={() => setQualityMode("1080p")}
                    type="button"
                  >
                    {qualityProfiles["1080p"].label}
                  </button>
                  <button
                    className={qualityMode === "720p" ? "selected" : ""}
                    onClick={() => setQualityMode("720p")}
                    type="button"
                  >
                    {qualityProfiles["720p"].label}
                  </button>
                </div>
              ) : null}
            </div>

            {!isHost ? (
              <div className="panel">
                <div className="panel-title">
                  <PhoneOff size={18} />
                  请求控制
                </div>
                <div className="control-grid">
                  <button onClick={() => requestControl("play")} type="button">
                    <Play size={18} />
                    继续
                  </button>
                  <button onClick={() => requestControl("pause")} type="button">
                    <Pause size={18} />
                    暂停
                  </button>
                  <button onClick={() => requestControl("seek", Math.max(0, playback.position - 30))} type="button">
                    -30s
                  </button>
                  <button onClick={() => requestControl("seek", playback.position + 30)} type="button">
                    +30s
                  </button>
                </div>
              </div>
            ) : null}

            {notice ? <p className="notice">{notice}</p> : null}
            {!host || !viewer ? <p className="hint">双人都进入房间后会自动建立点对点连接。</p> : null}
          </aside>
        </section>
      )}
    </main>
  );
}

function getRoomIdFromUrl() {
  const match = window.location.pathname.match(/\/room\/([^/]+)/);
  return match?.[1] ?? "";
}

function parseRoomId(value: string) {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    const fromPath = url.pathname.match(/\/room\/([^/]+)/)?.[1];
    return fromPath ?? trimmed;
  } catch {
    return trimmed.replace(/^.*\/room\//, "");
  }
}

function controlLabel(action: ControlAction) {
  if (action === "play") {
    return "继续播放";
  }

  if (action === "pause") {
    return "暂停";
  }

  return "调整进度";
}

function isCapturableVideo(video: HTMLVideoElement): video is CapturableVideoElement {
  return typeof (video as Partial<CapturableVideoElement>).captureStream === "function";
}
