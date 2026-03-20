// ─────────────────────────────────────────────────────────
//  CircleCall — CLIENT (RENDER FIXED)
// ─────────────────────────────────────────────────────────

const socket = io()
const videoGrid = document.getElementById("video-grid")
const roomId = window.location.pathname.split("/")[2]

let myStream
let myPeerId
let peers = {}

// 🔥 FIXED PeerJS (IMPORTANT)
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

myPeer.on("open", id => {
  myPeerId = id
  start()
})

function start() {
  navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  }).then(stream => {

    myStream = stream
    addVideo(stream, "You")

    socket.emit("join-room", roomId, myPeerId, "User")

    myPeer.on("call", call => {
      call.answer(stream)

      call.on("stream", userVideoStream => {
        addVideo(userVideoStream)
      })
    })

    socket.on("user-connected", userId => {
      connectToUser(userId, stream)
    })

  })
}

function connectToUser(userId, stream) {
  const call = myPeer.call(userId, stream)

  call.on("stream", userVideoStream => {
    addVideo(userVideoStream)
  })

  peers[userId] = call
}

function addVideo(stream, name = "") {
  const video = document.createElement("video")
  video.srcObject = stream
  video.autoplay = true
  video.playsInline = true

  const div = document.createElement("div")
  div.appendChild(video)

  if (name) {
    const label = document.createElement("p")
    label.innerText = name
    div.appendChild(label)
  }

  videoGrid.appendChild(div)
}

socket.on("user-disconnected", userId => {
  if (peers[userId]) peers[userId].close()
})