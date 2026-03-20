// ─────────────────────────────────────────────────────────
//  CircleCall — CLIENT (FULLY FIXED FOR RENDER)
// ─────────────────────────────────────────────────────────

const socket = io()
const videoGrid = document.getElementById("video-grid")
const roomId = window.location.pathname.split("/")[2]

let myStream
let myPeerId
let peers = {}
let username = "Guest"

// 🔥 PeerJS config (PRODUCTION READY)
const myPeer = new Peer(undefined, {
  path: "/peerjs",
  host: location.hostname,
  port: location.port || (location.protocol === "https:" ? 443 : 80),
  secure: location.protocol === "https:",
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject"
      }
    ]
  }
})

// ─────────────────────────────────────────
// JOIN FLOW
// ─────────────────────────────────────────

function enterRoom() {
  const input = document.getElementById("name-input")
  const name = input.value.trim()

  if (!name) {
    input.style.border = "2px solid red"
    return
  }

  username = name

  document.getElementById("name-modal").style.display = "none"
  document.getElementById("meeting-ui").style.display = "block"

  start()
}

// 🔥 Make function global (IMPORTANT)
window.enterRoom = enterRoom

// ─────────────────────────────────────────
// PEER READY
// ─────────────────────────────────────────

myPeer.on("open", id => {
  myPeerId = id
})

// ─────────────────────────────────────────
// START STREAM
// ─────────────────────────────────────────

function start() {
  navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  }).then(stream => {

    myStream = stream
    addVideo(stream, username, true)

    // 🔥 JOIN ROOM
    socket.emit("join-room", roomId, myPeerId, username)

    // 🔥 RECEIVE CALL
    myPeer.on("call", call => {
      call.answer(stream)

      const video = createVideo()

      call.on("stream", userVideoStream => {
        addVideoStream(video, userVideoStream, call.peer)
      })

      call.on("close", () => removeVideo(call.peer))

      peers[call.peer] = call
    })

    // 🔥 NEW USER CONNECTED
    socket.on("user-connected", userId => {
      connectToUser(userId, stream)
    })

  }).catch(err => {
    alert("Camera/Mic permission denied")
    console.error(err)
  })
}

// ─────────────────────────────────────────
// CONNECT TO NEW USER
// ─────────────────────────────────────────

function connectToUser(userId, stream) {
  if (peers[userId]) return

  const call = myPeer.call(userId, stream)
  const video = createVideo()

  call.on("stream", userVideoStream => {
    addVideoStream(video, userVideoStream, userId)
  })

  call.on("close", () => removeVideo(userId))

  peers[userId] = call
}

// ─────────────────────────────────────────
// VIDEO HANDLING
// ─────────────────────────────────────────

function createVideo() {
  const video = document.createElement("video")
  video.autoplay = true
  video.playsInline = true
  return video
}

function addVideo(stream, name = "", muted = false) {
  const video = createVideo()
  video.srcObject = stream
  video.muted = muted

  const wrapper = document.createElement("div")
  wrapper.dataset.id = "local"

  wrapper.appendChild(video)

  if (name) {
    const label = document.createElement("p")
    label.innerText = name
    wrapper.appendChild(label)
  }

  videoGrid.appendChild(wrapper)
}

function addVideoStream(video, stream, id) {
  if (document.querySelector(`[data-id="${id}"]`)) return

  video.srcObject = stream

  const wrapper = document.createElement("div")
  wrapper.dataset.id = id
  wrapper.appendChild(video)

  videoGrid.appendChild(wrapper)
}

function removeVideo(id) {
  document.querySelector(`[data-id="${id}"]`)?.remove()
  if (peers[id]) peers[id].close()
  delete peers[id]
}

// ─────────────────────────────────────────
// DISCONNECT
// ─────────────────────────────────────────

socket.on("user-disconnected", userId => {
  removeVideo(userId)
})

// ─────────────────────────────────────────
// CONTROLS (BASIC)
// ─────────────────────────────────────────

function toggleMute() {
  const enabled = myStream.getAudioTracks()[0].enabled
  myStream.getAudioTracks()[0].enabled = !enabled
}

function toggleCamera() {
  const enabled = myStream.getVideoTracks()[0].enabled
  myStream.getVideoTracks()[0].enabled = !enabled
}

function leave() {
  window.location.href = "/"
}

// 🔥 Make controls global
window.toggleMute = toggleMute
window.toggleCamera = toggleCamera
window.leave = leave