export type RoomRole = "host" | "viewer";

export type PlaybackStatus = "idle" | "playing" | "paused";

export interface MemberState {
  id: string;
  nickname: string;
  role: RoomRole;
  muted: boolean;
  connected: boolean;
}

export interface RoomSummary {
  roomId: string;
  inviteUrl: string;
  expiresAt: string;
  hasHost: boolean;
  viewerCount: number;
  iceServers: RTCIceServer[];
}

export interface PlaybackState {
  status: PlaybackStatus;
  position: number;
  duration: number;
  rate: number;
  updatedAt: number;
}

export type ControlAction = "play" | "pause" | "seek";

export interface ControlRequest {
  action: ControlAction;
  position?: number;
}

export interface HostMediaState {
  fileName: string;
  duration: number;
  width?: number;
  height?: number;
}

export type ClientMessage =
  | {
      type: "room:join";
      roomId: string;
      nickname: string;
      role: RoomRole;
    }
  | {
      type: "media:host-ready";
      media: HostMediaState;
    }
  | {
      type: "playback:state";
      state: PlaybackState;
    }
  | {
      type: "control:request";
      request: ControlRequest;
    }
  | {
      type: "voice:mute";
      muted: boolean;
    }
  | {
      type: "webrtc:offer" | "webrtc:answer";
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "webrtc:ice-candidate";
      candidate: RTCIceCandidateInit;
    };

export type ServerMessage =
  | {
      type: "room:joined";
      selfId: string;
      role: RoomRole;
      members: MemberState[];
      playback: PlaybackState;
      media: HostMediaState | null;
    }
  | {
      type: "room:presence";
      members: MemberState[];
    }
  | {
      type: "room:error";
      message: string;
    }
  | {
      type: "media:host-ready";
      media: HostMediaState;
    }
  | {
      type: "playback:state";
      state: PlaybackState;
    }
  | {
      type: "control:request";
      request: ControlRequest;
      from: string;
      nickname: string;
    }
  | {
      type: "voice:mute";
      memberId: string;
      muted: boolean;
    }
  | {
      type: "webrtc:peer-ready";
      peerId: string;
      role: RoomRole;
    }
  | {
      type: "webrtc:peer-left";
      peerId: string;
    }
  | {
      type: "webrtc:offer" | "webrtc:answer";
      from: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: "webrtc:ice-candidate";
      from: string;
      candidate: RTCIceCandidateInit;
    };
