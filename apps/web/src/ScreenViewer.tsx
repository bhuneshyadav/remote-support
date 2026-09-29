import { useEffect, useRef, useState } from "react";
import {
  remoteControlMessageSchema,
  signalingServerMessageSchema,
  webSocketSignalingMessageSchema,
} from "@remote-support/contracts";
import { getIceServers, getSignalingUrl } from "./screen-viewer-config";
import { createRemoteControlMessage, getNormalizedVideoPoint } from "./remote-control";

type ViewerPhase = "connecting" | "waiting" | "viewing" | "ended" | "error";
type ControlPhase = "unavailable" | "disabled" | "requesting" | "enabled";

interface ScreenViewerProps {
  sessionId: string;
  token: string;
  onDisconnect: () => void;
}

export function ScreenViewer({ sessionId, token, onDisconnect }: ScreenViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlChannelRef = useRef<RTCDataChannel | null>(null);
  const pressedKeysRef = useRef(new Set<string>());
  const pressedButtonsRef = useRef(new Set<"left" | "right" | "middle">());
  const lastPointerMessageAtRef = useRef(0);
  const [phase, setPhase] = useState<ViewerPhase>("connecting");
  const [controlPhase, setControlPhase] = useState<ControlPhase>("unavailable");
  const [message, setMessage] = useState("");

  function sendControlMessage(value: unknown) {
    const channel = controlChannelRef.current;
    const parsed = remoteControlMessageSchema.safeParse(value);
    if (!parsed.success || !channel || channel.readyState !== "open" || channel.bufferedAmount > 65_536) {
      return false;
    }
    channel.send(JSON.stringify(parsed.data));
    return true;
  }

  function requestControl() {
    if (sendControlMessage({ type: "control_request" })) setControlPhase("requesting");
  }

  function cancelControlRequest() {
    if (sendControlMessage({ type: "control_revoke" })) setControlPhase("disabled");
  }

  function revokeControl() {
    releaseAllInput();
    sendControlMessage({ type: "control_revoke" });
    setControlPhase("disabled");
  }

  function releaseAllInput() {
    for (const code of pressedKeysRef.current) {
      sendControlMessage({ type: "key", action: "up", code });
    }
    for (const button of pressedButtonsRef.current) {
      sendControlMessage({ type: "pointer_button", button, pressed: false });
    }
    pressedKeysRef.current.clear();
    pressedButtonsRef.current.clear();
  }

  function onPointerMove(event: React.PointerEvent<HTMLVideoElement>) {
    if (controlPhase !== "enabled") return;
    const now = performance.now();
    if (now - lastPointerMessageAtRef.current < 30) return;
    const video = event.currentTarget;
    const point = getNormalizedVideoPoint(
      event.clientX,
      event.clientY,
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
    if (!point) return;
    if (sendControlMessage({ type: "pointer_move", ...point })) {
      lastPointerMessageAtRef.current = now;
    }
  }

  function onPointerButton(event: React.PointerEvent<HTMLVideoElement>, pressed: boolean) {
    if (controlPhase !== "enabled" || event.button < 0 || event.button > 2) return;
    const button = (["left", "middle", "right"] as const)[event.button] as "left" | "middle" | "right";
    if (pressed) {
      event.currentTarget.focus();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        setMessage("Pointer capture is unavailable; keep the pointer over the shared screen.");
      }
      pressedButtonsRef.current.add(button);
    } else {
      pressedButtonsRef.current.delete(button);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
    const video = event.currentTarget;
    const point = getNormalizedVideoPoint(
      event.clientX,
      event.clientY,
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
    if (point) sendControlMessage({ type: "pointer_move", ...point });
    if (sendControlMessage({ type: "pointer_button", button, pressed })) {
      event.preventDefault();
    }
  }

  function onKey(event: React.KeyboardEvent<HTMLVideoElement>, action: "down" | "up") {
    if (controlPhase !== "enabled") return;
    const message = createRemoteControlMessage({ type: "key", action, code: event.code });
    if (!message) return;
    if (action === "down") pressedKeysRef.current.add(event.code);
    else pressedKeysRef.current.delete(event.code);
    if (sendControlMessage(JSON.parse(message))) event.preventDefault();
  }

  function onVideoWheel(event: React.WheelEvent<HTMLVideoElement>) {
    if (controlPhase !== "enabled") return;
    if (sendControlMessage({
      type: "pointer_scroll",
      deltaX: Math.max(-1200, Math.min(1200, Math.round(event.deltaX))),
      deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY))),
    })) event.preventDefault();
  }

  useEffect(() => {
    let disposed = false;
    let terminated = false;
    let authenticated = false;
    let viewingGranted = false;
    let customerConnected = false;
    let signalingIceServers: RTCIceServer[] = [];
    let iceServersReceived = false;
    let socketClosedByUs = false;
    let peer: RTCPeerConnection | null = null;
    let socket: WebSocket | null = null;
    let pendingCandidates: RTCIceCandidateInit[] = [];
    let localCandidates: RTCIceCandidateInit[] = [];
    let offerSentForPeer = false;

    const setViewerState = (nextPhase: ViewerPhase, nextMessage = "") => {
      if (!disposed) {
        setPhase(nextPhase);
        setMessage(nextMessage);
      }
    };

    const closePeer = () => {
      if (peer) {
        peer.onicecandidate = null;
        peer.ontrack = null;
        peer.ondatachannel = null;
        peer.close();
        peer = null;
      }
      controlChannelRef.current = null;
      pressedKeysRef.current.clear();
      pressedButtonsRef.current.clear();
      setControlPhase("unavailable");
      pendingCandidates = [];
      localCandidates = [];
      offerSentForPeer = false;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const closeConnection = (nextPhase: ViewerPhase, reason = "") => {
      terminated = true;
      closePeer();
      socketClosedByUs = true;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      socket = null;
      setViewerState(nextPhase, reason);
    };

    const send = (payload: unknown) => {
      if (terminated || !authenticated || !socket || socket.readyState !== WebSocket.OPEN) return false;
      const parsed = webSocketSignalingMessageSchema.safeParse(payload);
      if (!parsed.success) return false;
      socket.send(JSON.stringify(parsed.data));
      return true;
    };

    const createOffer = async (retry = false) => {
      if (!authenticated || !viewingGranted || !iceServersReceived || !socket || socket.readyState !== WebSocket.OPEN) return;

      if (retry && peer) {
        if (
          !offerSentForPeer ||
          peer.localDescription?.type !== "offer" ||
          !peer.localDescription.sdp
        ) return;
        const previousOffer = peer.localDescription;
        if (!send({ type: "offer", payload: { type: previousOffer.type, sdp: previousOffer.sdp } })) {
          closeConnection("error", "The signaling connection was lost.");
          return;
        }
        for (const candidate of localCandidates) send({ type: "candidate", payload: candidate });
        setViewerState("waiting", "Retrying the screen connection with the customer's agent…");
        return;
      }

      if (!peer) {
        try {
          peer = new RTCPeerConnection({ iceServers: [...getIceServers(), ...signalingIceServers] });
          peer.addTransceiver("video", { direction: "recvonly" });
          const controlChannel = peer.createDataChannel("remote-control", { ordered: true });
          controlChannelRef.current = controlChannel;
          controlChannel.onopen = () => {
            if (!disposed && controlChannelRef.current === controlChannel) setControlPhase("disabled");
          };
          controlChannel.onmessage = (event) => {
            if (disposed || controlChannelRef.current !== controlChannel || typeof event.data !== "string") return;
            let raw: unknown;
            try {
              raw = JSON.parse(event.data);
            } catch {
              setControlPhase("disabled");
              setMessage("The customer agent sent an invalid control response.");
              return;
            }
            const response = remoteControlMessageSchema.safeParse(raw);
            if (!response.success) return;
            if (response.data.type === "control_decision") {
              pressedKeysRef.current.clear();
              pressedButtonsRef.current.clear();
              setControlPhase(response.data.granted ? "enabled" : "disabled");
              setMessage(response.data.granted
                ? "REMOTE CONTROL ACTIVE — the customer approved it separately. They can revoke it at any time."
                : "The customer did not approve remote control.");
            } else if (response.data.type === "control_revoke") {
              pressedKeysRef.current.clear();
              pressedButtonsRef.current.clear();
              setControlPhase("disabled");
              setMessage("The customer revoked remote control.");
            }
          };
          controlChannel.onclose = () => {
            if (controlChannelRef.current === controlChannel) {
              controlChannelRef.current = null;
              pressedKeysRef.current.clear();
              pressedButtonsRef.current.clear();
              setControlPhase("unavailable");
            }
          };
        } catch {
          closeConnection("error", "Could not create a secure screen-viewing connection.");
          return;
        }

        const currentPeer = peer;
        currentPeer.onicecandidate = ({ candidate }) => {
          if (candidate && peer === currentPeer) {
            const payload = candidate.toJSON();
            localCandidates.push(payload);
            if (offerSentForPeer) send({ type: "candidate", payload });
          }
        };
        currentPeer.ontrack = ({ track, streams }) => {
          if (peer !== currentPeer || disposed) return;
          const video = videoRef.current;
          if (video) {
            video.srcObject = streams[0] ?? new MediaStream([track]);
            void video.play().catch(() => {
              setViewerState("viewing", "Screen is connected. Press play to start viewing.");
            });
          }
          setViewerState("viewing");
        };
      }

      const currentPeer = peer;
      if (!currentPeer) return;
      try {
        const offer = await currentPeer.createOffer();
        if (peer !== currentPeer || disposed || !offer.sdp) return;
        await currentPeer.setLocalDescription(offer);
        if (peer !== currentPeer || disposed) return;
        if (!send({ type: "offer", payload: { type: "offer", sdp: offer.sdp } })) {
          closeConnection("error", "The signaling connection was lost.");
        } else {
          offerSentForPeer = true;
          for (const candidate of localCandidates) send({ type: "candidate", payload: candidate });
          setViewerState("waiting", customerConnected
            ? "Offer sent. Waiting for the customer's screen…"
            : "Waiting for the customer's screen-sharing agent…");
        }
      } catch {
        if (peer === currentPeer && !disposed) {
          closeConnection("error", "Could not start screen viewing. Disconnect and try again.");
        }
      }
    };

    const grantViewing = () => {
      if (viewingGranted) return;
      viewingGranted = true;
      if (!authenticated) return;
      setViewerState("waiting", "Screen viewing is approved. Waiting for secure connection settings…");
    };

    const applyAnswer = async (payload: unknown) => {
      if (!peer || !payload || typeof payload !== "object") return;
      const description = payload as { type?: unknown; sdp?: unknown };
      if (description.type !== "answer" || typeof description.sdp !== "string") return;

      const currentPeer = peer;
      try {
        await currentPeer.setRemoteDescription({ type: "answer", sdp: description.sdp });
        if (peer !== currentPeer || disposed) return;
        for (const candidate of pendingCandidates) {
          await currentPeer.addIceCandidate(candidate);
        }
        pendingCandidates = [];
      } catch {
        if (peer === currentPeer && !disposed) {
          setViewerState("error", "Could not complete the screen connection.");
        }
      }
    };

    const applyCandidate = async (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const candidate = payload as RTCIceCandidateInit;
      if (typeof candidate.candidate !== "string") return;
      if (!peer?.remoteDescription) {
        pendingCandidates.push(candidate);
        return;
      }
      try {
        await peer.addIceCandidate(candidate);
      } catch {
        setViewerState("error", "A screen connection candidate could not be applied.");
      }
    };

    try {
      socket = new WebSocket(getSignalingUrl());
    } catch {
      setViewerState("error", "Could not open the screen-viewing signaling connection.");
      return () => {
        disposed = true;
        closePeer();
      };
    }

    socket.onopen = () => {
      if (disposed || !socket) return;
      // This must remain the first signaling message on the socket.
      const auth = webSocketSignalingMessageSchema.safeParse({ type: "auth", sessionId, token });
      if (!auth.success) {
        closeConnection("error", "Could not authenticate the screen-viewing connection.");
        return;
      }
      socket.send(JSON.stringify(auth.data));
    };

    socket.onmessage = (event) => {
      if (disposed || terminated || typeof event.data !== "string") return;
      let incoming: ReturnType<typeof signalingServerMessageSchema.parse>;
      try {
        incoming = signalingServerMessageSchema.parse(JSON.parse(event.data));
      } catch {
        setViewerState("error", "Received an invalid signaling message.");
        return;
      }

      switch (incoming.type) {
        case "auth_ok":
          if (incoming.role !== "technician") {
            closeConnection("error", "This connection is not authorized as a technician.");
            return;
          }
          authenticated = true;
          if (incoming.screenViewingGranted === true) {
            viewingGranted = true;
            setViewerState("waiting", "Screen viewing is approved. Waiting for secure connection settings…");
          }
          if (viewingGranted) {
            void createOffer();
          } else {
            setViewerState("waiting", "Waiting for customer approval to view the screen…");
          }
          break;
        case "ice_servers":
          if (!authenticated || !viewingGranted) break;
          signalingIceServers = incoming.servers;
          iceServersReceived = true;
          setViewerState("waiting", "Screen viewing is approved. Connecting to the customer's screen…");
          void createOffer();
          break;
        case "status":
          if (incoming.status === "viewing_granted") {
            grantViewing();
          } else if (incoming.status === "viewing_revoked") {
            closeConnection("ended", "The customer stopped screen viewing.");
          } else if (incoming.status === "ended") {
            closeConnection("ended", "This support session has ended.");
          } else if (incoming.status === "expired") {
            closeConnection("ended", "This support session has expired.");
          }
          break;
        case "participant_connected":
          if (incoming.role === "customer") {
            customerConnected = true;
            if (authenticated && viewingGranted) void createOffer(true);
          }
          break;
        case "answer":
          void applyAnswer(incoming.payload);
          break;
        case "candidate":
          void applyCandidate(incoming.payload);
          break;
        case "error":
          closeConnection("error", typeof incoming.error === "string" ? `Signaling error: ${incoming.error}` : "The signaling server rejected the connection.");
          break;
      }
    };

    socket.onerror = () => {
      if (!disposed) closeConnection("error", "The signaling connection encountered an error.");
    };
    socket.onclose = () => {
      if (!disposed && !socketClosedByUs) {
        terminated = true;
        closePeer();
        socket = null;
        setViewerState("error", "The signaling connection closed.");
      }
    };

    return () => {
      disposed = true;
      closePeer();
      socketClosedByUs = true;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      socket = null;
    };
  // A viewer instance is intentionally tied to one explicitly selected approved session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token]);

  function disconnect() {
    onDisconnect();
  }

  const stateLabel = {
    connecting: "Connecting",
    waiting: "Waiting",
    viewing: "Viewing",
    ended: "Closed",
    error: "Connection issue",
  }[phase];

  return (
    <section className="panel screen-viewer" aria-label="Remote screen viewer">
      <div className="viewer-heading">
        <div>
          <p className="eyebrow">ATTENDED SUPPORT SESSION</p>
          <h2>Customer screen</h2>
        </div>
        <button className="danger" onClick={disconnect}>Disconnect</button>
      </div>
      <p className="notice">The customer can stop screen viewing or separately revoke remote control at any time. Audio, files, clipboard sharing, and recording are not available.</p>
      <p role="status" aria-live="polite">{message || stateLabel}</p>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        tabIndex={0}
        aria-label="Customer shared screen"
        onPointerMove={onPointerMove}
        onPointerDown={(event) => onPointerButton(event, true)}
        onPointerUp={(event) => onPointerButton(event, false)}
        onPointerCancel={releaseAllInput}
        onWheel={onVideoWheel}
        onKeyDown={(event) => onKey(event, "down")}
        onKeyUp={(event) => onKey(event, "up")}
        onBlur={releaseAllInput}
        onContextMenu={(event) => {
          if (controlPhase === "enabled") event.preventDefault();
        }}
      />
      <div className="control-panel">
        <p className={controlPhase === "enabled" ? "control-active" : "control-inactive"} role="status">
          {controlPhase === "enabled"
            ? "REMOTE CONTROL ACTIVE — customer-approved"
            : controlPhase === "requesting"
              ? "Waiting for the customer to approve remote control…"
              : controlPhase === "disabled"
                ? "Remote control is off. Customer approval is required separately from screen viewing."
                : "Remote control is unavailable until the secure screen connection is ready."}
        </p>
        {controlPhase === "disabled" && <button onClick={requestControl}>Request remote control</button>}
        {controlPhase === "requesting" && <button className="secondary" onClick={cancelControlRequest}>Cancel request</button>}
        {controlPhase === "enabled" && <button className="danger" onClick={revokeControl}>Stop remote control</button>}
      </div>
    </section>
  );
}
