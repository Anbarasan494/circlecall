// ─────────────────────────────────────────────────────────────────────────────
//  CircleCall — client
// ─────────────────────────────────────────────────────────────────────────────

// Force WebSocket transport — required for Render's reverse proxy
const socket = io("/", {
  transports: ["websocket", "polling"],
  upgrade: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
})
const videoGrid = document.getElementById("video-grid")
const roomId    = window.location.pathname.split("/")[2]

// ── state ─────────────────────────────────────────────────────────────────────
let myStream, myPeerId, username, myVideo
let amHost      = false
let hostId      = null
let isMuted     = false
let isCameraOff = false
let isLowMode   = false
let isScreenSharing = false
let screenStream    = null
let activePanel     = null
let callStartTime   = null
let timerInterval   = null
let peerReady       = false
let streamReady     = false

// peers[peerId] = { call, wrapper }   — wrapper is the .video-wrapper div
const peers      = {}
const usernames  = {}   // peerId → display name
const mediaState = {}   // peerId → { micOn, camOn }

// Calls that arrived before myStream was ready — answered once stream is set
const pendingCalls = []

// ─────────────────────────────────────────────────────────────────────────────
//  PeerJS
// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect HTTPS (Render) vs HTTP (localhost)
const isSecure = location.protocol === "https:"
const peerPort  = isSecure ? 443 : (parseInt(location.port) || 3000)
const myPeer = new Peer(undefined, {
  host:   location.hostname,
  port:   peerPort,
  path:   "/peerjs",
  secure: isSecure,
  debug:  0,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" }
    ]
  }
})

myPeer.on("open", id => {
  myPeerId = id
  if (username) usernames[myPeerId] = username
  peerReady = true
  tryJoin()
})

myPeer.on("error", err => {
  console.error("PeerJS error:", err)
  showToast("Connection error: " + err.type, "error")
})

// ── FIX: queue calls that arrive before getUserMedia completes ────────────────
myPeer.on("call", call => {
  if (!streamReady || !myStream) {
    pendingCalls.push(call)
    return
  }
  answerCall(call)
})

function answerCall(call) {
  call.answer(myStream)

  const video = makeVideoEl()
  call.on("stream", remoteStream => {
    // Guard: only add tile once per peer
    if (peers[call.peer]?.added) return
    if (!peers[call.peer]) peers[call.peer] = { call, added: false }
    peers[call.peer].added = true
    addVideoTile(call.peer, video, remoteStream, usernames[call.peer])
  })
  call.on("close", () => removeVideoTile(call.peer))
  call.on("error", e => console.warn("inbound call error:", e))
}

// Answer all calls that were queued before stream was ready
function drainPendingCalls() {
  while (pendingCalls.length) answerCall(pendingCalls.shift())
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeVideoEl(muted = false) {
  const v = document.createElement("video")
  v.autoplay    = true
  v.playsInline = true   // required for iOS Safari
  v.muted       = muted
  return v
}

function tryJoin() {
  if (peerReady && streamReady)
    socket.emit("join-room", roomId, myPeerId, username)
}

function safePlay(v) {
  v.play().catch(() =>
    v.addEventListener("loadedmetadata", () => v.play(), { once: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
//  enterRoom — called by name-modal Join button
// ─────────────────────────────────────────────────────────────────────────────
function enterRoom() {
  const inp  = document.getElementById("name-input")
  const name = inp.value.trim()
  if (!name) { inp.style.outline = "2px solid #ff6b6b"; inp.focus(); return }

  username = name
  if (myPeerId) usernames[myPeerId] = username

  document.getElementById("name-modal").style.display  = "none"
  document.getElementById("meeting-ui").style.display  = "flex"
  document.getElementById("room-id-label").textContent = roomId

  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
      myStream = stream

      myVideo = makeVideoEl(true)   // muted locally — no echo
      addVideoTile("local", myVideo, stream, username)

      streamReady = true
      drainPendingCalls()   // answer any calls that arrived early
      startTimer()
      tryJoin()
    })
    .catch(err => {
      console.error("getUserMedia:", err)
      showToast("Camera/mic denied — check browser permissions", "error")
    })
}

// ─────────────────────────────────────────────────────────────────────────────
//  Video tile management
// ─────────────────────────────────────────────────────────────────────────────
function addVideoTile(id, video, stream, name) {
  // Guard: never add duplicates
  if (document.querySelector(`[data-uid="${id}"]`)) return

  video.srcObject = stream
  safePlay(video)

  const wrapper = document.createElement("div")
  wrapper.classList.add("video-wrapper")
  wrapper.dataset.uid = id      // ← FIX: uid on wrapper so removal works
  wrapper.appendChild(video)

  // Name tag
  const tag = document.createElement("div")
  tag.classList.add("name-tag")
  tag.textContent = name || usernames[id] || "Guest"
  wrapper.appendChild(tag)

  // Mic / cam status icons
  const icons = document.createElement("div")
  icons.classList.add("tile-status")
  icons.innerHTML = `<span class="ts-mic">🎙️</span><span class="ts-cam">📷</span>`
  wrapper.appendChild(icons)

  videoGrid.appendChild(wrapper)
  updateGridLayout()
}

// ── FIX: remove by data-uid, not by video element ────────────────────────────
function removeVideoTile(id) {
  document.querySelector(`[data-uid="${id}"]`)?.remove()
  try { peers[id]?.call?.close() } catch {}
  delete peers[id]
  delete usernames[id]
  delete mediaState[id]
  updateGridLayout()
  rerenderParticipants()
}

function setTileStatus(id, micOn, camOn) {
  const wrapper = document.querySelector(`[data-uid="${id}"]`)
  if (!wrapper) return
  const mic = wrapper.querySelector(".ts-mic")
  const cam = wrapper.querySelector(".ts-cam")
  if (mic) { mic.textContent = micOn ? "🎙️" : "🔇"; mic.style.filter = micOn ? "" : "grayscale(1)" }
  if (cam) { cam.textContent = camOn ? "📷" : "📵"; cam.style.filter = camOn ? "" : "grayscale(1)" }
}

// ─────────────────────────────────────────────────────────────────────────────
//  callPeer — outbound call
// ─────────────────────────────────────────────────────────────────────────────
function callPeer(id, name) {
  if (peers[id]) return           // already connected
  if (!myStream) {
    // Stream not yet ready — will be called again from existing-users once stream is set
    console.warn("callPeer: myStream not ready for", id)
    return
  }

  const call  = myPeer.call(id, myStream)
  if (!call)  { console.warn("myPeer.call() returned null for", id); return }

  const video = makeVideoEl()
  peers[id]   = { call, added: false }

  call.on("stream", remoteStream => {
    if (peers[id]?.added) return
    peers[id].added = true
    addVideoTile(id, video, remoteStream, name || usernames[id])
    rerenderParticipants()
  })
  call.on("close", () => removeVideoTile(id))
  call.on("error", e => console.warn("outbound call error:", e))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Socket events
// ─────────────────────────────────────────────────────────────────────────────

socket.on("existing-users", (users, isHost, hId) => {
  amHost = isHost
  hostId = hId
  if (isHost) document.getElementById("host-badge-label").style.display = "inline-flex"

  users.forEach(u => {
    // Support both object {id,username,...} and plain string (defensive)
    const uid   = typeof u === "object" ? u.id       : u
    const uname = typeof u === "object" ? u.username : (usernames[uid] || uid)
    usernames[uid]  = uname
    mediaState[uid] = { micOn: u.micOn !== false, camOn: u.camOn !== false }
    callPeer(uid, uname)
  })
  rerenderParticipants()
})

socket.on("user-connected", (id, name) => {
  usernames[id]  = name
  mediaState[id] = { micOn: true, camOn: true }
  showToast(`${name} joined`, "success")
  callPeer(id, name)
})

socket.on("user-disconnected", id => {
  showToast(`${usernames[id] || "Someone"} left`)
  removeVideoTile(id)
})

// Waiting room ----------------------------------------------------------------
socket.on("waiting", () => showWaitingScreen())

socket.on("user-waiting", (id, name) => {
  if (!amHost) return
  showAdmitCard(id, name)
})

// ── FIX: approved triggers socket.emit("approved") to finalise join ──────────
socket.on("approved", () => {
  hideWaitingScreen()
  showToast("You were admitted!", "success")
  socket.emit("approved")   // signals server → server sends existing-users back
})

socket.on("denied", () => {
  hideWaitingScreen()
  showToast("The host denied your request.", "error")
  setTimeout(() => window.location.href = "/", 2000)
})

socket.on("you-were-kicked", () => {
  showToast("You were removed from the meeting.", "error")
  setTimeout(() => window.location.href = "/", 2000)
})

socket.on("meeting-ended", () => {
  showToast("Meeting ended by host", "info")
  setTimeout(() => window.location.href = "/", 1500)
})

// Participants live update ----------------------------------------------------
socket.on("participants-update", (list, hId) => {
  hostId = hId
  list.forEach(p => {
    if (p.id !== myPeerId) {
      usernames[p.id]  = p.username
      mediaState[p.id] = { micOn: p.micOn, camOn: p.camOn }
      setTileStatus(p.id, p.micOn, p.camOn)
    }
  })
  rerenderParticipants(list)
})

// Host mic/cam commands -------------------------------------------------------
socket.on("force-mute", () => {
  applyMute(true)
  showToast("Host muted your microphone", "info")
})

socket.on("request-unmute", () => {
  showActionPrompt("The host asked you to unmute.", "Unmute", () => applyMute(false))
})

socket.on("force-cam-off", () => {
  applyCamOff(true)
  showToast("Host turned off your camera", "info")
})

socket.on("request-cam-on", () => {
  showActionPrompt("The host asked you to turn on your camera.", "Turn on", () => applyCamOff(false))
})

// Screen share (remote) -------------------------------------------------------
socket.on("screen-share-started", sharerId => {
  if (sharerId === myPeerId) return
  showToast(`${usernames[sharerId] || "Someone"} is sharing their screen`, "info")
  // The sharer replaced their video track via replaceTrack — the stream event
  // fires on the existing peer connection, so we get the screen via the
  // existing video element. Mount the overlay using that element's srcObject.
  const existingVideo = document.querySelector(`[data-uid="${sharerId}"] video`)
  if (existingVideo) {
    mountScreenShareUI(existingVideo.srcObject, null, sharerId, usernames[sharerId])
  }
})

socket.on("screen-share-stopped", sharerId => {
  showToast(`${usernames[sharerId] || "Someone"} stopped sharing`, "info")
  unmountScreenShareUI()
})

// Chat ------------------------------------------------------------------------
socket.on("chat-message", (message, senderName) => appendMessage(senderName, message, false))

// Socket reconnection ---------------------------------------------------------
socket.on("connect_error", () => showToast("Connection lost, reconnecting…", "error"))
socket.on("reconnect",     () => showToast("Reconnected!", "success"))

// ─────────────────────────────────────────────────────────────────────────────
//  Mic / cam control
// ─────────────────────────────────────────────────────────────────────────────
function applyMute(mute) {
  isMuted = mute
  const track = myStream?.getAudioTracks()[0]
  if (track) track.enabled = !mute
  const btn = document.getElementById("btn-mute")
  btn.classList.toggle("ctrl-btn--active", mute)
  btn.querySelector(".ctrl-icon").textContent  = mute ? "🔇" : "🎙️"
  btn.querySelector(".ctrl-label").textContent = mute ? "Unmute" : "Mute"
  socket.emit("media-state", !isMuted, !isCameraOff)
}

function applyCamOff(off) {
  isCameraOff = off
  const track = myStream?.getVideoTracks()[0]
  if (track) track.enabled = !off
  const btn = document.getElementById("btn-camera")
  btn.classList.toggle("ctrl-btn--active", off)
  btn.querySelector(".ctrl-icon").textContent  = off ? "📵" : "📷"
  btn.querySelector(".ctrl-label").textContent = off ? "Start Cam" : "Camera"
  socket.emit("media-state", !isMuted, !isCameraOff)
}

function toggleMute()   { applyMute(!isMuted) }
function toggleCamera() { applyCamOff(!isCameraOff) }

function toggleLowMode() {
  isLowMode = !isLowMode
  myStream?.getVideoTracks()[0]?.applyConstraints(
    isLowMode ? { width: 320, height: 240, frameRate: 10 }
              : { width: 1280, height: 720, frameRate: 30 }
  )
  const btn = document.getElementById("btn-low")
  btn.classList.toggle("ctrl-btn--active", isLowMode)
  btn.querySelector(".ctrl-label").textContent = isLowMode ? "Normal" : "Low Mode"
  showToast(isLowMode ? "Low bandwidth mode on" : "Normal quality restored", "info")
}

function leave() {
  myStream?.getTracks().forEach(t => t.stop())
  window.location.href = "/"
}

// ─────────────────────────────────────────────────────────────────────────────
//  Screen share
// ─────────────────────────────────────────────────────────────────────────────
async function toggleScreenShare() {
  if (isScreenSharing) { stopScreenShare(); return }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    isScreenSharing = true
    const screenTrack = screenStream.getVideoTracks()[0]

    // Replace video track in every active peer connection
    for (const pid in peers) {
      const pc = peers[pid].call?.peerConnection
      const sender = pc?.getSenders().find(s => s.track?.kind === "video")
      if (sender) sender.replaceTrack(screenTrack)
    }

    socket.emit("screen-share-started")
    mountScreenShareUI(screenStream, myStream, "local", username)
    screenTrack.onended = stopScreenShare

    const btn = document.getElementById("btn-screen")
    btn.classList.add("ctrl-btn--active")
    btn.querySelector(".ctrl-label").textContent = "Stop Share"
  } catch {
    showToast("Screen share cancelled or unavailable", "info")
  }
}

function stopScreenShare() {
  if (!screenStream) return
  screenStream.getTracks().forEach(t => t.stop())
  screenStream    = null
  isScreenSharing = false

  const camTrack = myStream?.getVideoTracks()[0]
  for (const pid in peers) {
    const pc = peers[pid].call?.peerConnection
    const sender = pc?.getSenders().find(s => s.track?.kind === "video")
    if (sender && camTrack) sender.replaceTrack(camTrack)
  }

  socket.emit("screen-share-stopped")
  unmountScreenShareUI()

  const btn = document.getElementById("btn-screen")
  btn.classList.remove("ctrl-btn--active")
  btn.querySelector(".ctrl-label").textContent = "Share"
}

function mountScreenShareUI(screenSrc, camSrc, sharerId, sharerName) {
  unmountScreenShareUI()

  const overlay = document.createElement("div")
  overlay.id = "ss-overlay"

  const mainVid = makeVideoEl(true)
  mainVid.id = "ss-main-video"
  mainVid.srcObject = screenSrc
  safePlay(mainVid)
  overlay.appendChild(mainVid)

  const label = document.createElement("div")
  label.className = "ss-label"
  label.textContent = `${sharerName || usernames[sharerId] || "Someone"} is presenting`
  overlay.appendChild(label)

  if (camSrc) {
    const pip    = document.createElement("div")
    pip.className = "ss-pip"
    const pipVid = makeVideoEl(sharerId === "local")
    pipVid.srcObject = camSrc
    safePlay(pipVid)
    pip.appendChild(pipVid)
    const pipName = document.createElement("div")
    pipName.className = "ss-pip-name"
    pipName.textContent = sharerName || usernames[sharerId] || "Camera"
    pip.appendChild(pipName)
    overlay.appendChild(pip)
  }

  const collapseBtn = document.createElement("button")
  collapseBtn.className = "ss-collapse"
  collapseBtn.textContent = "✕ Exit fullscreen"
  collapseBtn.onclick = unmountScreenShareUI
  overlay.appendChild(collapseBtn)

  document.body.appendChild(overlay)
}

function unmountScreenShareUI() {
  document.getElementById("ss-overlay")?.remove()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Panels
// ─────────────────────────────────────────────────────────────────────────────
function togglePanel(name) {
  if (activePanel === name) { closePanel(); return }
  activePanel = name
  document.getElementById("side-panel").classList.add("open")
  document.getElementById("panel-participants").style.display = name === "participants" ? "flex" : "none"
  document.getElementById("panel-chat").style.display         = name === "chat"         ? "flex" : "none"
  document.getElementById("btn-people").classList.toggle("ctrl-btn--active", name === "participants")
  document.getElementById("btn-chat").classList.toggle("ctrl-btn--active",   name === "chat")
}

function closePanel() {
  document.getElementById("side-panel").classList.remove("open")
  activePanel = null
  document.getElementById("btn-people").classList.remove("ctrl-btn--active")
  document.getElementById("btn-chat").classList.remove("ctrl-btn--active")
}

// ─────────────────────────────────────────────────────────────────────────────
//  Participants panel
// ─────────────────────────────────────────────────────────────────────────────
let lastParticipantList = []

function rerenderParticipants(list) {
  if (list) lastParticipantList = list
  const ul    = document.getElementById("participants-list")
  const count = document.getElementById("participant-count")
  if (!ul) return

  // Always include self
  const self = {
    id: myPeerId || "local",
    username: username || "You",
    micOn: !isMuted,
    camOn: !isCameraOff,
    isSelf: true
  }

  const map = {}
  lastParticipantList.forEach(p => { map[p.id] = { ...p, isSelf: false } })
  map[self.id] = self

  const all    = Object.values(map)
  count.textContent = all.length
  ul.innerHTML      = ""

  all.forEach(p => {
    const isHost = p.id === hostId
    const li = document.createElement("li")
    li.classList.add("participant-item")

    li.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;width:100%">
        <div class="p-avatar" style="background:${avatarColor(p.username)}">${(p.username[0]||"?").toUpperCase()}</div>
        <div class="p-info">
          <span class="p-name">${escapeHtml(p.username)}${p.isSelf ? ' <em>(You)</em>' : ""}${isHost ? " 👑" : ""}</span>
          <span class="p-status">
            <span title="Mic">${p.micOn ? "🎙️" : "🔇"}</span>
            <span title="Camera">${p.camOn ? "📷" : "📵"}</span>
          </span>
        </div>
      </div>`

    // Host controls shown for every non-self participant
    if (amHost && !p.isSelf) {
      const hc = document.createElement("div")
      hc.className = "hc-row"

      const micBtn = document.createElement("button")
      micBtn.className = "hc-btn"
      micBtn.textContent = p.micOn ? "🔇 Mute" : "🎙️ Unmute"
      micBtn.onclick = () => socket.emit(p.micOn ? "host-mute-user" : "host-unmute-user", p.id)

      const camBtn = document.createElement("button")
      camBtn.className = "hc-btn"
      camBtn.textContent = p.camOn ? "📵 Stop cam" : "📷 Start cam"
      camBtn.onclick = () => socket.emit(p.camOn ? "host-cam-off" : "host-cam-on", p.id)

      const kickBtn = document.createElement("button")
      kickBtn.className = "hc-btn hc-btn--danger"
      kickBtn.textContent = "Remove"
      kickBtn.onclick = () => confirm(`Remove ${p.username}?`) && socket.emit("kick-user", p.id)

      hc.append(micBtn, camBtn, kickBtn)
      li.appendChild(hc)
    }

    ul.appendChild(li)
  })
}

function avatarColor(name = "") {
  const colors = ["#3b82f6","#8b5cf6","#ec4899","#f59e0b","#10b981","#ef4444","#06b6d4"]
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % colors.length
  return colors[h]
}

// ─────────────────────────────────────────────────────────────────────────────
//  Waiting / admit UI
// ─────────────────────────────────────────────────────────────────────────────
function showWaitingScreen() {
  document.getElementById("name-modal").style.display = "none"
  let el = document.getElementById("waiting-screen")
  if (!el) {
    el = document.createElement("div")
    el.id = "waiting-screen"
    el.innerHTML = `
      <div class="waiting-box">
        <div class="waiting-spinner"></div>
        <h3>Waiting for host</h3>
        <p>The host will admit you shortly…</p>
      </div>`
    document.body.appendChild(el)
  }
  el.style.display = "flex"
}

function hideWaitingScreen() {
  const el = document.getElementById("waiting-screen")
  if (el) el.style.display = "none"
}

function showAdmitCard(id, name) {
  let container = document.getElementById("admit-container")
  if (!container) {
    container = document.createElement("div")
    container.id = "admit-container"
    document.body.appendChild(container)
  }
  const card = document.createElement("div")
  card.className = "admit-card"
  card.innerHTML = `
    <div class="admit-info">
      <div class="admit-avatar">${(name[0]||"?").toUpperCase()}</div>
      <span><strong>${escapeHtml(name)}</strong> wants to join</span>
    </div>
    <div class="admit-btns">
      <button class="admit-deny">Deny</button>
      <button class="admit-allow">Admit</button>
    </div>`
  card.querySelector(".admit-allow").onclick = () => { socket.emit("approve-user", id); card.remove() }
  card.querySelector(".admit-deny").onclick  = () => { socket.emit("deny-user",    id); card.remove() }
  container.appendChild(card)
}

function showActionPrompt(message, btnLabel, action) {
  const d = document.createElement("div")
  d.className = "action-prompt"
  d.innerHTML = `<p>${message}</p>
    <div class="ap-btns">
      <button class="ap-dismiss">Dismiss</button>
      <button class="ap-action">${btnLabel}</button>
    </div>`
  d.querySelector(".ap-action").onclick  = () => { action(); d.remove() }
  d.querySelector(".ap-dismiss").onclick = () => d.remove()
  document.body.appendChild(d)
  setTimeout(() => d.remove(), 15000)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chat
// ─────────────────────────────────────────────────────────────────────────────
function sendMessage() {
  const inp = document.getElementById("chat_message")
  const msg = inp.value.trim()
  if (!msg) return
  socket.emit("chat-message", roomId, msg, username)
  appendMessage(username, msg, true)
  inp.value = ""
}

function appendMessage(sender, text, isSelf) {
  const ul = document.getElementById("messages")
  const li = document.createElement("li")
  li.classList.add("msg-item", isSelf ? "msg-self" : "msg-other")
  li.innerHTML = `<span class="msg-sender">${isSelf ? "You" : escapeHtml(sender)}</span>
                  <span class="msg-text">${escapeHtml(text)}</span>`
  ul.appendChild(li)
  ul.scrollTop = ul.scrollHeight
}

function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────────────────────
// ── FIX: showToast sets className correctly with all required classes ─────────
function showToast(message, type = "info", duration = 3000) {
  const t = document.getElementById("toast")
  if (!t) return
  t.textContent = message
  // Set both base class and modifier at once — avoids partial class wipe
  t.className = `toast--show toast--${type}`
  if (duration > 0) setTimeout(() => { t.className = "" }, duration)
}

function copyRoomCode() {
  navigator.clipboard.writeText(roomId).then(() => showToast("Room code copied!", "success"))
}

function updateGridLayout() {
  const n = videoGrid.querySelectorAll(".video-wrapper").length
  videoGrid.style.gridTemplateColumns =
    n <= 1 ? "1fr" : n <= 4 ? "repeat(2,1fr)" : "repeat(3,1fr)"
}

function startTimer() {
  callStartTime = Date.now()
  timerInterval = setInterval(() => {
    const s  = Math.floor((Date.now() - callStartTime) / 1000)
    const el = document.getElementById("call-timer")
    if (el) el.textContent =
      `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`
  }, 1000)
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOMContentLoaded wiring
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const display = document.getElementById("room-code-display")
  if (display) display.textContent = `Code: ${roomId}`

  document.getElementById("name-input")
    ?.addEventListener("keydown", e => e.key === "Enter" && enterRoom())

  document.getElementById("chat_message")
    ?.addEventListener("keydown", e => e.key === "Enter" && sendMessage())
})
