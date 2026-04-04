// ─────────────────────────────────────────────────────────────────────────────
//  CircleCall — client  (all fixes applied)
// ─────────────────────────────────────────────────────────────────────────────

const socket = io("/", {
  transports: ["polling", "websocket"],
  upgrade: true,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 2000,
  timeout: 20000,
})

const videoGrid = document.getElementById("video-grid")
const roomId    = window.location.pathname.split("/")[2]

// ── State ─────────────────────────────────────────────────────────────────────
let myStream, myPeerId, username, myVideo
let amHost          = false
let hostId          = null
let isMuted         = false
let isCameraOff     = false
let isScreenSharing = false
let screenStream    = null
let activePanel     = null
let callStartTime   = null
let timerInterval   = null
let peerReady       = false
let streamReady     = false
let pinnedId        = null
let chatUnread      = 0
let _ssVisCleanup   = null
let _audioCtx       = null
const _analyserNodes = {}
let waitingList      = {}

const peers       = {}
const usernames   = {}
const mediaState  = {}
const pendingCalls = []
const tileStore   = []

// ─────────────────────────────────────────────────────────────────────────────
//  PeerJS
// ─────────────────────────────────────────────────────────────────────────────
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
myPeer.on("error", err => { console.error("PeerJS:", err); showToast("Connection error: " + err.type, "error") })
myPeer.on("call", call => {
  if (!streamReady || !myStream) { pendingCalls.push(call); return }
  answerCall(call)
})

function answerCall(call) {
  call.answer(myStream)
  const video = makeVideoEl()
  call.on("stream", remoteStream => {
    if (peers[call.peer]?.added) return
    if (!peers[call.peer]) peers[call.peer] = { call, added: false }
    peers[call.peer].added = true
    addVideoTile(call.peer, video, remoteStream, usernames[call.peer])
    _attachAnalyser(call.peer, remoteStream)
  })
  call.on("close", () => { _detachAnalyser(call.peer); removeVideoTile(call.peer) })
  call.on("error", e => console.warn("inbound call error:", e))
}

function drainPendingCalls() {
  while (pendingCalls.length) answerCall(pendingCalls.shift())
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeVideoEl(muted = false) {
  const v = document.createElement("video")
  v.autoplay = true; v.playsInline = true; v.muted = muted
  return v
}
function tryJoin() {
  if (peerReady && streamReady) {
    const roomNameInput = document.getElementById("room-name-input")
    const roomName = roomNameInput ? roomNameInput.value.trim() : ""
    const isCreator = new URLSearchParams(window.location.search).get("host") === "1"
    socket.emit("join-room", roomId, myPeerId, username, roomName, isCreator)
  }
}
function safePlay(v) {
  v.play().catch(() => v.addEventListener("loadedmetadata", () => v.play(), { once: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Notes — PERSONAL only, never shared. Downloadable as PDF.
// ─────────────────────────────────────────────────────────────────────────────
let notesContent = ""

function toggleNotes() {
  togglePanel("notes")
}

function downloadNotesPDF() {
  const text = document.getElementById("notes-area")?.value || notesContent
  if (!text.trim()) { showToast("Notes are empty", "info"); return }

  // Build a simple printable HTML page and trigger print-to-PDF
  const win = window.open("", "_blank")
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>CircleCall Meeting Notes</title>
    <style>
      body { font-family: 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #111; line-height: 1.7; }
      h1 { font-size: 22px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px; color: #0369a1; }
      .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
      pre { white-space: pre-wrap; font-family: inherit; font-size: 15px; background: #f0f9ff; padding: 20px; border-radius: 8px; border-left: 4px solid #38bdf8; }
    </style></head><body>
    <h1>Meeting Notes — CircleCall</h1>
    <p class="meta">Room: ${roomId.toUpperCase()} &nbsp;·&nbsp; ${new Date().toLocaleString()}</p>
    <pre>${escapeHtml(text)}</pre>
    <script>window.onload=()=>{window.print();}<\/script>
    </body></html>`)
  win.document.close()
}

// Broadcast notes changes to all participants via chat channel
// Notes are now PERSONAL — no broadcast to others
socket.on("notes-update", () => { /* no-op — notes are personal */ })

function broadcastNotes() {
  // Personal notes: just save locally, no socket emit
  const area = document.getElementById("notes-area")
  if (!area) return
  notesContent = area.value
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pre-join preview — mic/camera toggles before entering the room
// ─────────────────────────────────────────────────────────────────────────────
let previewStream = null
let previewMuted  = false
let previewCamOff = false

async function initPreview() {
  const preview = document.getElementById("preview-video")
  const micBtn  = document.getElementById("preview-mic-btn")
  const camBtn  = document.getElementById("preview-cam-btn")
  if (!preview) return

  // Inject SVG icons into preview buttons (SVG object is defined by now)
  const micIcon = document.querySelector("#preview-mic-btn .preview-btn-icon")
  const camIcon = document.querySelector("#preview-cam-btn .preview-btn-icon")
  if (micIcon) micIcon.innerHTML = SVG.micOn
  if (camIcon) camIcon.innerHTML = SVG.camOn

  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    preview.srcObject = previewStream
    preview.muted = true
    safePlay(preview)
  } catch(e) {
    // Camera/mic not available — that's fine, still allow joining
    document.getElementById("preview-avatar")?.classList.remove("hidden")
    if (preview) preview.style.display = "none"
  }

  micBtn?.addEventListener("click", () => {
    previewMuted = !previewMuted
    const track = previewStream?.getAudioTracks()[0]
    if (track) track.enabled = !previewMuted
    micBtn.classList.toggle("preview-btn--off", previewMuted)
    micBtn.querySelector(".preview-btn-icon").innerHTML = previewMuted ? SVG.micOff : SVG.micOn
    micBtn.querySelector(".preview-btn-label").textContent = previewMuted ? "Muted" : "Unmuted"
  })

  camBtn?.addEventListener("click", () => {
    previewCamOff = !previewCamOff
    const track = previewStream?.getVideoTracks()[0]
    if (track) track.enabled = !previewCamOff
    preview.style.display  = previewCamOff ? "none" : "block"
    document.getElementById("preview-avatar")?.classList.toggle("hidden", !previewCamOff)
    camBtn.classList.toggle("preview-btn--off", previewCamOff)
    camBtn.querySelector(".preview-btn-icon").innerHTML = previewCamOff ? SVG.camOff : SVG.camOn
    camBtn.querySelector(".preview-btn-label").textContent = previewCamOff ? "Cam Off" : "Cam On"
  })
}

// ─────────────────────────────────────────────────────────────────────────────
//  enterRoom — uses previewStream if available
// ─────────────────────────────────────────────────────────────────────────────
function enterRoom() {
  const inp  = document.getElementById("name-input")
  const name = inp.value.trim()
  if (!name) { inp.style.outline = "2px solid #f43f5e"; inp.focus(); return }

  username = name
  if (myPeerId) usernames[myPeerId] = username

  document.getElementById("name-modal").style.display = "none"
  document.getElementById("meeting-ui").style.display = "flex"
  document.getElementById("room-id-label").textContent = roomId

  // Re-use the preview stream if we already have it
  const streamPromise = previewStream
    ? Promise.resolve(previewStream)
    : navigator.mediaDevices.getUserMedia({ video: true, audio: true })

  streamPromise
    .then(stream => {
      myStream = stream
      // Apply pre-join mute/cam state
      if (previewMuted)  { const t = stream.getAudioTracks()[0]; if (t) t.enabled = false }
      if (previewCamOff) { const t = stream.getVideoTracks()[0]; if (t) t.enabled = false }

      myVideo = makeVideoEl(true)
      addVideoTile("local", myVideo, stream, username)
      // Reflect pre-join state immediately on local tile
      setTileStatus("local", !previewMuted, !previewCamOff)
      isMuted     = previewMuted
      isCameraOff = previewCamOff
      _syncControlButtons()
      _attachLocalAnalyser()
      streamReady = true
      drainPendingCalls()
      startTimer()
      tryJoin()
      previewStream = null
    })
    .catch(err => {
      console.warn("getUserMedia:", err)
      // Allow joining without camera/mic
      myStream = new MediaStream()
      myVideo = makeVideoEl(true)
      addVideoTile("local", myVideo, myStream, username)
      isMuted = true; isCameraOff = true
      _syncControlButtons()
      streamReady = true
      drainPendingCalls()
      startTimer()
      tryJoin()
      previewStream = null
      showToast("No camera/mic — joined audio-free", "info")
    })
}

function _syncControlButtons() {
  const muteBtn = document.getElementById("btn-mute")
  const camBtn  = document.getElementById("btn-camera")
  if (muteBtn) {
    muteBtn.classList.toggle("ctrl-btn--active", !isMuted)
    muteBtn.classList.toggle("ctrl-btn--muted",   isMuted)
    muteBtn.querySelector(".ctrl-icon").innerHTML = isMuted ? SVG.micOff : SVG.micOn
  }
  if (camBtn) {
    camBtn.classList.toggle("ctrl-btn--active", !isCameraOff)
    camBtn.classList.toggle("ctrl-btn--muted",   isCameraOff)
    camBtn.querySelector(".ctrl-icon").innerHTML = isCameraOff ? SVG.camOff : SVG.camOn
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Video tile management
// ─────────────────────────────────────────────────────────────────────────────
function addVideoTile(id, video, stream, name) {
  if (tileStore.find(t => t.dataset.uid === id)) return

  video.srcObject = stream
  safePlay(video)

  const wrapper = document.createElement("div")
  wrapper.classList.add("video-wrapper")
  wrapper.dataset.uid = id

  // Avatar initials — shown when camera is off
  const av = document.createElement("div")
  av.className = "tile-avatar"
  av.textContent = (name || "?")[0].toUpperCase()
  av.style.background = avatarColor(name || "")
  wrapper.appendChild(av)

  wrapper.appendChild(video)

  // Name tag
  const tag = document.createElement("div")
  tag.className = "name-tag"
  tag.textContent = name || usernames[id] || "Guest"
  wrapper.appendChild(tag)

  // Status icons (SVG — no emoji)
  const icons = document.createElement("div")
  icons.className = "tile-status"
  icons.innerHTML = `<span class="ts-mic" title="Mic">${SVG.micOn}</span><span class="ts-cam" title="Camera">${SVG.camOn}</span>`
  wrapper.appendChild(icons)

  // Speaking indicator — centred circle glow (not border)
  const ring = document.createElement("div")
  ring.className = "speaking-ring"
  wrapper.appendChild(ring)

  // Pin overlay on hover
  const pinOv = document.createElement("div")
  pinOv.className = "pin-overlay"
  pinOv.innerHTML = `<button class="pin-btn">${SVG.pin}<span>Pin</span></button>`
  pinOv.querySelector(".pin-btn").addEventListener("click", e => { e.stopPropagation(); togglePin(id) })
  wrapper.appendChild(pinOv)

  tileStore.push(wrapper)
  updateGridLayout()
}

function removeVideoTile(id) {
  _detachAnalyser(id)
  const idx = tileStore.findIndex(t => t.dataset.uid === id)
  if (idx !== -1) tileStore.splice(idx, 1)
  try { peers[id]?.call?.close() } catch {}
  delete peers[id]; delete usernames[id]; delete mediaState[id]
  if (pinnedId === id) pinnedId = null
  updateGridLayout()
  rerenderParticipants()
}

function setTileStatus(id, micOn, camOn) {
  const w = tileStore.find(t => t.dataset.uid === id)
  if (!w) return
  const mic  = w.querySelector(".ts-mic")
  const cam  = w.querySelector(".ts-cam")
  const av   = w.querySelector(".tile-avatar")
  const vid  = w.querySelector("video")
  const ring = w.querySelector(".speaking-ring")

  // Show avatar (initials) only when camera is off
  if (av)  av.style.display  = camOn ? "none"  : "flex"
  if (vid) vid.style.display = camOn ? "block" : "none"

  // When camera is ON: hide all status icons — the live video speaks for itself
  // When camera is OFF: show mic icon so people know if they can be heard
  const showIcons = !camOn
  if (mic) {
    mic.innerHTML = micOn ? SVG.micOn : SVG.micOff
    mic.style.display = showIcons ? "flex" : "none"
  }
  if (cam) {
    cam.style.display = "none" // never show cam icon — redundant with video/avatar
  }

  // Speaking ring — shown always (border when cam on, center ring when cam off)
  if (ring) {
    // Always keep it in DOM; CSS classes control appearance based on cam state
    ring.dataset.camOn = camOn ? "1" : "0"
  }

  // Update muted indicator on name tag
  const tag = w.querySelector(".name-tag")
  if (tag) tag.classList.toggle("name-tag--muted", !micOn)
}

// ─────────────────────────────────────────────────────────────────────────────
//  SVG icon set — professional, no emoji in buttons/tiles
// ─────────────────────────────────────────────────────────────────────────────
const SVG = {
  micOn:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  micOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  camOn:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  camOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34"/></svg>`,
  pin:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="m15 6.5-1.5 1.5-2-5-4 4 5 2-1.5 1.5 4 4 1.5-1.5 2 5 4-4-5-2 1.5-1.5z"/><line x1="2" y1="22" x2="9.5" y2="14.5"/></svg>`,
  unpin:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><line x1="1" y1="1" x2="23" y2="23"/><path d="m15 6.5-1.5 1.5-2-5-4 4 5 2-1.5 1.5"/><line x1="2" y1="22" x2="9.5" y2="14.5"/></svg>`,
  share:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  check:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  xmark:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  kick:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="23" y2="14"/><line x1="23" y1="8" x2="17" y2="14"/></svg>`,
  notes:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pin / spotlight
// ─────────────────────────────────────────────────────────────────────────────
function togglePin(id) {
  pinnedId = (pinnedId === id) ? null : id
  tileStore.forEach(t => {
    const isPinned = t.dataset.uid === pinnedId
    t.classList.toggle("pinned", isPinned)
    const btn = t.querySelector(".pin-btn")
    if (btn) btn.innerHTML = (isPinned ? SVG.unpin : SVG.pin) + `<span>${isPinned ? "Unpin" : "Pin"}</span>`
  })
  updateGridLayout()
  showToast(pinnedId ? `Pinned ${usernames[pinnedId] || "tile"}` : "Unpinned", "info", 1500)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Grid layout — CSS grid, square tiles, respects pin + split window
// ─────────────────────────────────────────────────────────────────────────────
function updateGridLayout() {
  const n = tileStore.length
  if (n === 0) return

  // Use element width for accurate split-window behaviour
  const w = videoGrid.offsetWidth || window.innerWidth
  const isMobile = w <= 600

  // Pinned layout: big tile + sidebar strip
  if (pinnedId && n > 1) {
    videoGrid.style.display = "flex"
    videoGrid.style.flexDirection = isMobile ? "column" : "row"
    videoGrid.style.gridTemplateColumns = ""
    videoGrid.innerHTML = ""

    const pinned = tileStore.find(t => t.dataset.uid === pinnedId)
    const others = tileStore.filter(t => t.dataset.uid !== pinnedId)

    if (pinned) {
      pinned.style.flex = "1"; pinned.style.aspectRatio = ""; pinned.style.minWidth = "0"
      pinned.style.width = "100%"; pinned.style.height = isMobile ? "calc(100% - 126px)" : "100%"
      videoGrid.appendChild(pinned)
    }
    const strip = document.createElement("div")
    strip.style.cssText = isMobile
      ? "display:flex;flex-direction:row;gap:5px;overflow-x:auto;padding:4px 5px;height:120px;flex-shrink:0;background:#0a0b0e"
      : "display:flex;flex-direction:column;gap:5px;overflow-y:auto;padding:5px 4px;width:180px;flex-shrink:0;background:#0a0b0e"
    others.forEach(t => {
      t.style.flex = ""; t.style.width = isMobile ? "160px" : "100%"
      t.style.height = isMobile ? "90px" : "auto"; t.style.aspectRatio = "16/9"; t.style.flexShrink = "0"
      strip.appendChild(t)
    })
    videoGrid.appendChild(strip)
    return
  }

  // Normal grid
  let cols
  if      (n === 1) cols = 1
  else if (n === 2) cols = 2
  else if (n === 3) cols = 3
  else if (n === 4) cols = 4
  else if (n <= 6)  cols = 3
  else if (n <= 9)  cols = 3
  else if (n <= 16) cols = 4
  else              cols = Math.ceil(Math.sqrt(n))
  if (isMobile && cols > 2) cols = 2

  videoGrid.style.display = "grid"
  videoGrid.style.flexDirection = ""
  videoGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
  videoGrid.style.gridAutoRows = "minmax(0, 1fr)"
  videoGrid.style.gridTemplateRows = ""
  videoGrid.innerHTML = ""

  tileStore.forEach(t => {
    t.style.flex = ""; t.style.width = "100%"; t.style.height = "100%"
    t.style.aspectRatio = "16/9"; t.style.flexShrink = ""
    videoGrid.appendChild(t)
  })
}

window.addEventListener("resize", () => { if (tileStore.length) updateGridLayout() })

// ─────────────────────────────────────────────────────────────────────────────
//  Speaking detection — ring around centre, not tile border
// ─────────────────────────────────────────────────────────────────────────────
function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return _audioCtx
}
function _attachLocalAnalyser() { if (myStream) _attachAnalyser("local", myStream) }
function _attachAnalyser(id, stream) {
  try {
    const ctx = _getAudioCtx()
    const src = ctx.createMediaStreamSource(stream)
    const an  = ctx.createAnalyser()
    an.fftSize = 512; an.smoothingTimeConstant = 0.3
    src.connect(an)
    const data = new Uint8Array(an.frequencyBinCount)
    const iv = setInterval(() => {
      an.getByteFrequencyData(data)
      const vol = data.reduce((a, b) => a + b, 0) / data.length
      const tile = tileStore.find(t => t.dataset.uid === id)
      if (!tile) return
      const isSpeaking = vol > 12
      const camOn = tile.querySelector("video")?.style.display !== "none"
      // Only show speaking indicator when camera is OFF (mic-only mode)
      // When camera is on the video is already showing — no extra indicator needed
      tile.classList.toggle("speaking", isSpeaking && !camOn)
    }, 100)
    _analyserNodes[id] = { iv }
  } catch(e) {}
}
function _detachAnalyser(id) {
  if (_analyserNodes[id]) { clearInterval(_analyserNodes[id].iv); delete _analyserNodes[id] }
}

// ─────────────────────────────────────────────────────────────────────────────
//  callPeer — outbound
// ─────────────────────────────────────────────────────────────────────────────
function callPeer(id, name) {
  if (peers[id]) return
  if (!myStream) { console.warn("callPeer: myStream not ready for", id); return }
  const call = myPeer.call(id, myStream)
  if (!call) { console.warn("myPeer.call() null for", id); return }
  const video = makeVideoEl()
  peers[id] = { call, added: false }
  call.on("stream", remoteStream => {
    if (peers[id]?.added) return
    peers[id].added = true
    addVideoTile(id, video, remoteStream, name || usernames[id])
    _attachAnalyser(id, remoteStream)
    rerenderParticipants()
  })
  call.on("close", () => { _detachAnalyser(id); removeVideoTile(id) })
  call.on("error", e => console.warn("outbound call error:", e))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Socket events
// ─────────────────────────────────────────────────────────────────────────────
socket.on("existing-users", (users, isHost, hId, rName) => {
  amHost = isHost; hostId = hId
  if (isHost) document.getElementById("host-badge-label").style.display = "inline-flex"
  // Display room name
  if (rName) {
    const lbl = document.getElementById("room-name-display")
    if (lbl) { lbl.textContent = rName; lbl.style.display = "inline-flex" }
    document.title = rName + " — CircleCall"
  }
  // Hide room name input once joined (non-host shouldn't set name)
  if (!isHost) {
    const rnw = document.getElementById("room-name-wrap")
    if (rnw) rnw.style.display = "none"
  }
  users.forEach(u => {
    const uid   = typeof u === "object" ? u.id       : u
    const uname = typeof u === "object" ? u.username : (usernames[uid] || uid)
    usernames[uid]  = uname
    mediaState[uid] = { micOn: u.micOn !== false, camOn: u.camOn !== false }
    callPeer(uid, uname)
  })
  rerenderParticipants()
  updatePrivateRecipientList()
})

socket.on("room-ended", () => {
  showToast("This meeting has ended — the host has left.", "error", 0)
  setTimeout(() => window.location.href = "/", 3000)
})

socket.on("user-connected", (id, name) => {
  usernames[id] = name; mediaState[id] = { micOn: true, camOn: true }
  showToast(`${name} joined`, "success"); callPeer(id, name)
  updatePrivateRecipientList()
})
socket.on("user-disconnected", id => {
  showToast(`${usernames[id] || "Someone"} left`)
  removeVideoTile(id)
  updatePrivateRecipientList()
})

socket.on("waiting", () => showWaitingScreen())
socket.on("user-waiting", (id, name) => {
  if (!amHost) return
  waitingList[id] = name
  showAdmitCard(id, name)
  rerenderParticipants()
})
socket.on("approved", () => {
  hideWaitingScreen(); showToast("You were admitted!", "success"); socket.emit("approved")
})
socket.on("denied", () => {
  hideWaitingScreen(); showToast("Host denied your request.", "error")
  setTimeout(() => window.location.href = "/", 2000)
})
socket.on("you-were-kicked", () => {
  showToast("You were removed from the meeting.", "error")
  setTimeout(() => window.location.href = "/", 2000)
})
socket.on("meeting-ended", () => {
  showToast("Meeting ended by host", "info")
  const area = document.getElementById("notes-area")
  const hasNotes = (area?.value || notesContent || "").trim()
  if (hasNotes) {
    // Give user a moment to download notes before leaving
    showNoteDownloadPrompt()
    setTimeout(() => window.location.href = "/", 12000)
  } else {
    setTimeout(() => window.location.href = "/", 1500)
  }
})

function showNoteDownloadPrompt() {
  const d = document.createElement("div")
  d.className = "note-end-prompt"
  d.innerHTML = `
    <div class="nep-inner">
      <div class="nep-icon">${SVG.notes}</div>
      <h3>Meeting ended</h3>
      <p>The host has ended this meeting.<br>Download your notes before leaving?</p>
      <div class="nep-btns">
        <button class="nep-download" onclick="downloadNotesPDF();this.closest('.note-end-prompt').remove();setTimeout(()=>location.href='/',1500)">
          ${SVG.download} Download Notes PDF
        </button>
        <button class="nep-skip" onclick="this.closest('.note-end-prompt').remove();window.location.href='/'">
          Leave without saving
        </button>
      </div>
    </div>`
  document.body.appendChild(d)
}
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

socket.on("force-mute",     () => { applyMute(true);   showToast("Host muted your mic", "info") })
socket.on("request-unmute", () => showActionPrompt("Host asked you to unmute.", "Unmute", () => applyMute(false)))
socket.on("force-cam-off",  () => { applyCamOff(true); showToast("Host turned off your camera", "info") })
socket.on("request-cam-on", () => showActionPrompt("Host asked you to turn on camera.", "Turn on", () => applyCamOff(false)))

// Screen share — remote
socket.on("screen-share-started", sharerId => {
  if (sharerId === myPeerId) return
  showToast(`${usernames[sharerId] || "Someone"} is sharing their screen`, "info")
  setTimeout(() => {
    const tile = tileStore.find(t => t.dataset.uid === sharerId)
    const vid  = tile?.querySelector("video")
    if (vid?.srcObject) enterPresentationMode(vid.srcObject, sharerId, usernames[sharerId])
  }, 600)
})
socket.on("screen-share-stopped", sharerId => {
  showToast(`${usernames[sharerId] || "Someone"} stopped sharing`, "info")
  exitPresentationMode()
})

// Chat
socket.on("chat-message", (message, senderName) => {
  appendMessage(senderName, message, false)
  if (activePanel !== "chat") {
    chatUnread++
    const badge = document.getElementById("chat-badge")
    if (badge) { badge.textContent = chatUnread; badge.style.display = "flex" }
    // No toast — badge on Chat button is sufficient
  }
})

socket.on("connect_error", () => showToast("Connection lost, reconnecting…", "error"))
socket.on("reconnect",     () => showToast("Reconnected!", "success"))

// ─────────────────────────────────────────────────────────────────────────────
//  Mic / cam
// ─────────────────────────────────────────────────────────────────────────────
function applyMute(mute) {
  isMuted = mute
  const track = myStream?.getAudioTracks()[0]
  if (track) track.enabled = !mute
  const btn = document.getElementById("btn-mute")
  if (!btn) return
  btn.classList.toggle("ctrl-btn--active", !mute)
  btn.classList.toggle("ctrl-btn--muted",   mute)
  btn.querySelector(".ctrl-icon").innerHTML = mute ? SVG.micOff : SVG.micOn
  socket.emit("media-state", !isMuted, !isCameraOff)
  setTileStatus("local", !isMuted, !isCameraOff)
}

function applyCamOff(off) {
  isCameraOff = off
  const track = myStream?.getVideoTracks()[0]
  if (track) track.enabled = !off
  const btn = document.getElementById("btn-camera")
  if (!btn) return
  btn.classList.toggle("ctrl-btn--active", !off)
  btn.classList.toggle("ctrl-btn--muted",   off)
  btn.querySelector(".ctrl-icon").innerHTML = off ? SVG.camOff : SVG.camOn
  socket.emit("media-state", !isMuted, !isCameraOff)
  setTileStatus("local", !isMuted, !isCameraOff)
}

function toggleMute()   { applyMute(!isMuted) }
function toggleCamera() { applyCamOff(!isCameraOff) }

function leave() {
  if (isScreenSharing) stopScreenShare()
  myStream?.getTracks().forEach(t => t.stop())
  Object.values(_analyserNodes).forEach(n => clearInterval(n.iv))
  socket.disconnect()
  window.location.href = "/"
}

// ─────────────────────────────────────────────────────────────────────────────
//  Screen share — inline layout, no position:fixed, works in split windows
//  Structure inside .video-area.ss-active:
//    [top-bar]
//    [#ss-wrap  flex-row]
//      [#ss-thumbs]  LEFT  : participant tiles (camera, not screen)
//      [#ss-main]    RIGHT : shared screen + blank overlay
//    [.controls]
// ─────────────────────────────────────────────────────────────────────────────
async function toggleScreenShare() {
  if (isScreenSharing) { stopScreenShare(); return }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("Screen sharing not supported on this browser.", "error", 4000); return
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: false })
    isScreenSharing = true
    const screenTrack = screenStream.getVideoTracks()[0]

    // Send screen to peers — local tile stays on camera
    for (const pid in peers) {
      const pc     = peers[pid].call?.peerConnection
      const sender = pc?.getSenders().find(s => s.track?.kind === "video")
      if (sender) sender.replaceTrack(screenTrack)
    }
    if (myVideo) { myVideo.srcObject = myStream; safePlay(myVideo) }

    socket.emit("screen-share-started")
    enterPresentationMode(screenStream, "local", username)
    screenTrack.onended = stopScreenShare

    const btn = document.getElementById("btn-screen")
    if (btn) { btn.classList.add("ctrl-btn--active") }
  } catch {
    showToast("Screen share cancelled or unavailable", "info")
  }
}

function stopScreenShare() {
  if (!screenStream) return
  screenStream.getTracks().forEach(t => t.stop())
  screenStream = null; isScreenSharing = false

  if (_ssVisCleanup) { _ssVisCleanup(); _ssVisCleanup = null }

  const camTrack = myStream?.getVideoTracks()[0]
  for (const pid in peers) {
    const pc     = peers[pid].call?.peerConnection
    const sender = pc?.getSenders().find(s => s.track?.kind === "video")
    if (sender && camTrack) sender.replaceTrack(camTrack)
  }
  if (myVideo) { myVideo.srcObject = myStream; safePlay(myVideo) }

  socket.emit("screen-share-stopped")
  exitPresentationMode()

  const btn = document.getElementById("btn-screen")
  if (btn) { btn.classList.remove("ctrl-btn--active") }
}

function enterPresentationMode(screenSrc, sharerId, sharerName) {
  exitPresentationMode()

  const videoArea = document.querySelector(".video-area")
  videoArea.classList.add("ss-active")

  const wrap = document.createElement("div")
  wrap.id = "ss-wrap"

  // LEFT: thumbnails — existing tiles (no duplicate cam tile)
  const thumbs = document.createElement("div")
  thumbs.id = "ss-thumbs"
  tileStore.forEach(tile => { tile.classList.add("ss-thumb"); thumbs.appendChild(tile) })

  // RIGHT: screen
  const main = document.createElement("div")
  main.id = "ss-main"

  const vid = makeVideoEl(true)
  vid.id = "ss-screen-vid"
  vid.srcObject = screenSrc
  safePlay(vid)
  main.appendChild(vid)

  const lbl = document.createElement("div")
  lbl.className = "ss-badge"
  lbl.textContent = `${sharerName || usernames[sharerId] || "Someone"} is presenting`
  main.appendChild(lbl)

  // Blank overlay (shown when sharer's tab is focused — tab capture would show the meeting)
  const blank = document.createElement("div")
  blank.id = "ss-blank"
  blank.innerHTML = `<div class="ss-blank-box">${SVG.share}<p class="ss-blank-title">Screen paused</p><p class="ss-blank-sub">Switch to another window so<br>participants can see your screen</p></div>`
  main.appendChild(blank)

  wrap.appendChild(thumbs)
  wrap.appendChild(main)

  const controls = videoArea.querySelector(".controls")
  videoArea.insertBefore(wrap, controls)
  videoGrid.style.display = "none"

  if (sharerId === "local") {
    const syncBlank = () => blank.classList.toggle("ss-blank--visible", !document.hidden)
    syncBlank()
    document.addEventListener("visibilitychange", syncBlank)
    _ssVisCleanup = () => document.removeEventListener("visibilitychange", syncBlank)
  }
}

function exitPresentationMode() {
  if (_ssVisCleanup) { _ssVisCleanup(); _ssVisCleanup = null }
  document.querySelector(".video-area")?.classList.remove("ss-active")
  const wrap = document.getElementById("ss-wrap")
  if (wrap) {
    tileStore.forEach(tile => { tile.classList.remove("ss-thumb"); videoGrid.appendChild(tile) })
    wrap.remove()
  }
  videoGrid.style.display = ""
  updateGridLayout()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Panels
// ─────────────────────────────────────────────────────────────────────────────
function togglePanel(name) {
  if (activePanel === name) { closePanel(); return }
  activePanel = name
  document.getElementById("side-panel").classList.add("open")
  document.querySelector(".meeting-container")?.classList.add("panel-open")
  document.getElementById("panel-participants").style.display = name === "participants" ? "flex" : "none"
  document.getElementById("panel-chat").style.display         = name === "chat"         ? "flex" : "none"
  document.getElementById("panel-notes").style.display        = name === "notes"        ? "flex" : "none"
  document.getElementById("btn-people").classList.toggle("ctrl-btn--active", name === "participants")
  document.getElementById("btn-chat").classList.toggle("ctrl-btn--active",   name === "chat")
  document.getElementById("btn-notes").classList.toggle("ctrl-btn--active",  name === "notes")
  if (name === "chat") {
    chatUnread = 0
    const badge = document.getElementById("chat-badge")
    if (badge) badge.style.display = "none"
  }
  if (name === "notes") {
    const area = document.getElementById("notes-area")
    if (area && notesContent) area.value = notesContent
  }
}

function closePanel() {
  document.getElementById("side-panel").classList.remove("open")
  document.querySelector(".meeting-container")?.classList.remove("panel-open")
  activePanel = null
  document.getElementById("btn-people").classList.remove("ctrl-btn--active")
  document.getElementById("btn-chat").classList.remove("ctrl-btn--active")
  document.getElementById("btn-notes")?.classList.remove("ctrl-btn--active")
}

// ─────────────────────────────────────────────────────────────────────────────
//  Participants panel — icon buttons, admit in panel, waiting list
// ─────────────────────────────────────────────────────────────────────────────
let lastParticipantList = []

function rerenderParticipants(list) {
  if (list) lastParticipantList = list
  const ul    = document.getElementById("participants-list")
  const count = document.getElementById("participant-count")
  if (!ul) return

  const self = { id: myPeerId || "local", username: username || "You", micOn: !isMuted, camOn: !isCameraOff, isSelf: true }
  const map  = {}
  lastParticipantList.forEach(p => { map[p.id] = { ...p, isSelf: false } })
  map[self.id] = self

  const all = Object.values(map)
  count.textContent = all.length + Object.keys(waitingList).length
  ul.innerHTML = ""

  // Waiting users (host only)
  if (amHost && Object.keys(waitingList).length > 0) {
    const wh = document.createElement("li")
    wh.className = "panel-section-header"
    wh.textContent = `Waiting (${Object.keys(waitingList).length})`
    ul.appendChild(wh)

    Object.entries(waitingList).forEach(([wId, wName]) => {
      const li = document.createElement("li")
      li.className = "participant-item"
      li.innerHTML = `
        <div class="p-row">
          <div class="p-avatar" style="background:${avatarColor(wName)}">${(wName[0]||"?").toUpperCase()}</div>
          <div class="p-info"><span class="p-name">${escapeHtml(wName)}</span><span class="p-sub">Waiting…</span></div>
          <div class="p-actions">
            <button class="icon-btn icon-btn--green" title="Admit">${SVG.check}</button>
            <button class="icon-btn icon-btn--red"   title="Deny">${SVG.xmark}</button>
          </div>
        </div>`
      li.querySelector(".icon-btn--green").onclick = () => { socket.emit("approve-user", wId); delete waitingList[wId]; rerenderParticipants() }
      li.querySelector(".icon-btn--red").onclick   = () => { socket.emit("deny-user",    wId); delete waitingList[wId]; rerenderParticipants() }
      ul.appendChild(li)
    })

    const dv = document.createElement("li")
    dv.className = "panel-section-header"
    dv.textContent = "In meeting"
    ul.appendChild(dv)
  }

  all.forEach(p => {
    const isHost = p.id === hostId
    const li = document.createElement("li")
    li.className = "participant-item"
    const micIco = `<span class="p-icon ${p.micOn?"p-icon--on":"p-icon--off"}">${p.micOn?SVG.micOn:SVG.micOff}</span>`
    const camIco = `<span class="p-icon ${p.camOn?"p-icon--on":"p-icon--off"}">${p.camOn?SVG.camOn:SVG.camOff}</span>`

    li.innerHTML = `
      <div class="p-row">
        <div class="p-avatar" style="background:${avatarColor(p.username)}">${(p.username[0]||"?").toUpperCase()}</div>
        <div class="p-info">
          <span class="p-name">${escapeHtml(p.username)}${p.isSelf?' <em>(You)</em>':""}${isHost?' <span class="host-crown">👑</span>':""}</span>
          <span class="p-icons-row">${micIco}${camIco}</span>
        </div>
        ${amHost && !p.isSelf ? `<div class="p-actions" id="hc-${p.id}"></div>` : ""}
      </div>`

    if (amHost && !p.isSelf) {
      const ad = li.querySelector(`#hc-${p.id}`)
      const mb = document.createElement("button")
      mb.className = "icon-btn"; mb.title = p.micOn?"Mute":"Unmute"; mb.innerHTML = p.micOn?SVG.micOn:SVG.micOff
      mb.onclick = () => socket.emit(p.micOn?"host-mute-user":"host-unmute-user", p.id)
      const cb = document.createElement("button")
      cb.className = "icon-btn"; cb.title = p.camOn?"Stop cam":"Start cam"; cb.innerHTML = p.camOn?SVG.camOn:SVG.camOff
      cb.onclick = () => socket.emit(p.camOn?"host-cam-off":"host-cam-on", p.id)
      const kb = document.createElement("button")
      kb.className = "icon-btn icon-btn--red"; kb.title = "Remove"; kb.innerHTML = SVG.kick
      kb.onclick = () => confirm(`Remove ${p.username}?`) && socket.emit("kick-user", p.id)
      ad.append(mb, cb, kb)
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
function showWaitingScreen() {
  document.getElementById("name-modal").style.display = "none"
  let el = document.getElementById("waiting-screen")
  if (!el) {
    el = document.createElement("div"); el.id = "waiting-screen"
    el.innerHTML = `<div class="waiting-box"><div class="waiting-spinner"></div><h3>Waiting for host</h3><p>The host will admit you shortly…</p></div>`
    document.body.appendChild(el)
  }
  el.style.display = "flex"
}
function hideWaitingScreen() {
  const el = document.getElementById("waiting-screen")
  if (el) el.style.display = "none"
}

function showAdmitCard(id, name) {
  let c = document.getElementById("admit-container")
  if (!c) { c = document.createElement("div"); c.id = "admit-container"; document.body.appendChild(c) }
  if (c.querySelector(`[data-uid="${id}"]`)) return
  const card = document.createElement("div")
  card.className = "admit-card"; card.dataset.uid = id
  card.innerHTML = `
    <div class="admit-info">
      <div class="admit-avatar">${(name[0]||"?").toUpperCase()}</div>
      <span><strong>${escapeHtml(name)}</strong> wants to join</span>
    </div>
    <div class="admit-btns">
      <button class="admit-deny">Deny</button>
      <button class="admit-allow">Admit</button>
    </div>`
  card.querySelector(".admit-allow").onclick = () => { socket.emit("approve-user", id); delete waitingList[id]; card.remove(); rerenderParticipants() }
  card.querySelector(".admit-deny").onclick  = () => { socket.emit("deny-user",    id); delete waitingList[id]; card.remove(); rerenderParticipants() }
  c.appendChild(card)
}

function showActionPrompt(message, btnLabel, action) {
  const d = document.createElement("div"); d.className = "action-prompt"
  d.innerHTML = `<p>${message}</p><div class="ap-btns"><button class="ap-dismiss">Dismiss</button><button class="ap-action">${btnLabel}</button></div>`
  d.querySelector(".ap-action").onclick  = () => { action(); d.remove() }
  d.querySelector(".ap-dismiss").onclick = () => d.remove()
  document.body.appendChild(d)
  setTimeout(() => d.remove(), 15000)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chat — public + private
// ─────────────────────────────────────────────────────────────────────────────
let chatMode = "public"  // "public" | "private"
let privateUnread = {}   // peerId -> count

function switchChatTab(mode) {
  chatMode = mode
  document.getElementById("tab-public").classList.toggle("active", mode === "public")
  document.getElementById("tab-private").classList.toggle("active", mode === "private")
  document.getElementById("messages").style.display         = mode === "public"  ? "flex" : "none"
  document.getElementById("private-messages").style.display = mode === "private" ? "flex" : "none"
  document.getElementById("private-recipient-wrap").style.display = mode === "private" ? "flex" : "none"
  const inp = document.getElementById("chat_message")
  if (inp) inp.placeholder = mode === "public" ? "Message everyone…" : "Private message…"
  if (mode === "private") {
    const sel = document.getElementById("private-recipient")
    const pid = sel?.value
    if (pid && privateUnread[pid]) {
      privateUnread[pid] = 0
      _refreshPrivateBadge()
    }
  }
  closeEmojiPicker()
}

function sendMessage() {
  const inp = document.getElementById("chat_message")
  const msg = inp.value.trim()
  if (!msg) return

  if (chatMode === "private") {
    const sel = document.getElementById("private-recipient")
    const targetId = sel?.value
    if (!targetId) { showToast("Select a person to message privately", "info"); return }
    socket.emit("private-message", targetId, msg)
    appendPrivateMessage(username, msg, true, targetId)
  } else {
    socket.emit("chat-message", roomId, msg, username)
    appendMessage(username, msg, true)
  }
  inp.value = ""
  closeEmojiPicker()
}

function appendMessage(sender, text, isSelf) {
  const ul = document.getElementById("messages")
  if (!ul) return
  const li = document.createElement("li")
  li.classList.add("msg-item", isSelf ? "msg-self" : "msg-other")
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  li.innerHTML = `<span class="msg-sender">${isSelf?"You":escapeHtml(sender)}</span><span class="msg-text">${escapeHtml(text)}</span><span class="msg-time">${time}</span>`
  ul.appendChild(li)
  ul.scrollTop = ul.scrollHeight
}

function appendPrivateMessage(sender, text, isSelf, peerId) {
  const ul = document.getElementById("private-messages")
  if (!ul) return
  const li = document.createElement("li")
  li.classList.add("msg-item", isSelf ? "msg-self" : "msg-other", "msg-private")
  li.dataset.peer = peerId
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const peerLabel = isSelf
    ? ("→ " + escapeHtml(usernames[peerId] || "?"))
    : ("🔒 " + escapeHtml(sender))
  li.innerHTML = `<span class="msg-sender">${peerLabel}</span><span class="msg-text">${escapeHtml(text)}</span><span class="msg-time">${time}</span>`
  ul.appendChild(li)
  // Show all if no filter, or if matches selected peer
  const sel = document.getElementById("private-recipient")
  const filterId = sel?.value
  li.style.display = (!filterId || filterId === peerId) ? "" : "none"
  ul.scrollTop = ul.scrollHeight
}

// Filter private messages when recipient changes
document.addEventListener("change", e => {
  if (e.target.id !== "private-recipient") return
  const pid = e.target.value
  document.querySelectorAll("#private-messages .msg-private").forEach(li => {
    li.style.display = (!pid || li.dataset.peer === pid) ? "" : "none"
  })
  if (pid && privateUnread[pid]) {
    privateUnread[pid] = 0
    _refreshPrivateBadge()
  }
})

socket.on("private-message", (message, senderId, senderName) => {
  usernames[senderId] = senderName
  appendPrivateMessage(senderName, message, false, senderId)
  if (activePanel !== "chat" || chatMode !== "private") {
    privateUnread[senderId] = (privateUnread[senderId] || 0) + 1
    _refreshPrivateBadge()
    if (activePanel !== "chat") {
      chatUnread++
      const badge = document.getElementById("chat-badge")
      if (badge) { badge.textContent = chatUnread; badge.style.display = "flex" }
    }
    showToast(`🔒 Private: ${senderName}`, "info", 2500)
  }
})

function _refreshPrivateBadge() {
  const total = Object.values(privateUnread).reduce((a,b)=>a+b,0)
  const btn = document.getElementById("tab-private")
  if (btn) btn.dataset.badge = total > 0 ? total : ""
  btn?.classList.toggle("has-badge", total > 0)
}

function updatePrivateRecipientList() {
  const sel = document.getElementById("private-recipient")
  if (!sel) return
  const prev = sel.value
  sel.innerHTML = '<option value="">— Select person —</option>'
  Object.entries(usernames).forEach(([id, name]) => {
    if (id === myPeerId || id === "local") return
    const opt = document.createElement("option")
    opt.value = id; opt.textContent = name
    sel.appendChild(opt)
  })
  if (prev) sel.value = prev
}

// Emoji picker
function toggleEmojiPicker() {
  const p = document.getElementById("emoji-picker")
  if (!p) return
  const open = p.style.display !== "none"
  p.style.display = open ? "none" : "flex"
}
function closeEmojiPicker() {
  const p = document.getElementById("emoji-picker")
  if (p) p.style.display = "none"
}
function insertEmoji(emoji) {
  const inp = document.getElementById("chat_message")
  if (!inp) return
  const pos = inp.selectionStart ?? inp.value.length
  inp.value = inp.value.slice(0, pos) + emoji + inp.value.slice(pos)
  inp.focus()
  inp.selectionStart = inp.selectionEnd = pos + emoji.length
  closeEmojiPicker()
}

function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
}
// ─────────────────────────────────────────────────────────────────────────────
function showToast(message, type = "info", duration = 3000) {
  const t = document.getElementById("toast")
  if (!t) return
  t.textContent = message
  t.className = `toast--show toast--${type}`
  if (duration > 0) setTimeout(() => { t.className = "" }, duration)
}

function copyRoomCode() {
  navigator.clipboard.writeText(roomId).then(() => showToast("Room code copied!", "success"))
}

function startTimer() {
  callStartTime = Date.now()
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000)
    const el = document.getElementById("call-timer")
    if (el) el.textContent = `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`
  }, 1000)
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOMContentLoaded — wire SVG icons into control buttons
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const display = document.getElementById("room-code-display")
  if (display) display.textContent = `Code: ${roomId}`

  document.getElementById("name-input")?.addEventListener("keydown", e => e.key === "Enter" && enterRoom())
  document.getElementById("chat_message")?.addEventListener("keydown", e => e.key === "Enter" && sendMessage())

  // Inject SVG icons into control buttons
  const btnCfg = {
    "btn-mute":   { svg: SVG.micOn,  active: true  },
    "btn-camera": { svg: SVG.camOn,  active: true  },
    "btn-screen": { svg: SVG.share,  active: false },
    "btn-people": { svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`, active: false },
    "btn-chat":   { svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`, active: false },
    "btn-notes":  { svg: SVG.notes, active: false },
  }
  Object.entries(btnCfg).forEach(([id, cfg]) => {
    const btn = document.getElementById(id)
    if (!btn) return
    const ic = btn.querySelector(".ctrl-icon")
    if (ic) ic.innerHTML = cfg.svg
    if (cfg.active) btn.classList.add("ctrl-btn--active")
  })
  const leaveBtn = document.querySelector(".leave-btn .ctrl-icon")
  if (leaveBtn) leaveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`

  // Start camera/mic preview in the modal
  initPreview()

  // Notes textarea — save locally, no broadcast
  document.getElementById("notes-area")?.addEventListener("input", () => {
    notesContent = document.getElementById("notes-area").value
  })
})
