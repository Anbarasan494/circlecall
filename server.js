// ________________________________________________________________________________
//  CircleCall — SERVER (FULL FIXED VERSION)
// ────────────────────────────────────────────────────────────────────────────
const express = require("express")
const app     = express()
const server  = require("http").createServer(app)

const io = require("socket.io")(server, {
  pingTimeout: 60000,
  pingInterval: 25000
})

const path = require("path")
const { ExpressPeerServer } = require("peer")

// ── PeerJS server ─────────────────────────────────────────────────────────────
app.use("/peerjs", ExpressPeerServer(server, { debug: true }))

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static("public", { maxAge: 0 }))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/home.html"))
})

app.get("/room/:room", (req, res) => {
  res.sendFile(path.join(__dirname, "public/room.html"))
})

// ── Room structure ────────────────────────────────────────────────────────────
/*
rooms = {
  roomId: {
    host: peerId,
    members: {
      peerId: { socketId, username, micOn, camOn }
    },
    waiting: {
      peerId: { socketId, username }
    }
  }
}
*/
const rooms = {}

// ── Helper: broadcast participants ────────────────────────────────────────────
function broadcastParticipants(roomId) {
  if (!rooms[roomId]) return

  const list = Object.entries(rooms[roomId].members).map(([id, m]) => ({
    id,
    username: m.username,
    micOn: m.micOn,
    camOn: m.camOn
  }))

  io.to(roomId).emit("participants-update", list, rooms[roomId].host)
}

// ─────────────────────────────────────────────────────────────────────────────
//  SOCKET CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
io.on("connection", socket => {

  // ── JOIN ROOM ───────────────────────────────────────────────────────────────
  socket.on("join-room", (roomId, userId, username) => {

    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: userId,
        members: {},
        waiting: {}
      }
    }

    socket.userId = userId
    socket.roomId = roomId

    // ── HOST ──────────────────────────────────────────────────────────────────
    if (rooms[roomId].host === userId) {

      rooms[roomId].members[userId] = {
        socketId: socket.id,
        username,
        micOn: true,
        camOn: true
      }

      socket.join(roomId)

      socket.emit("existing-users", [], true, userId)

      broadcastParticipants(roomId)
    }

    // ── NON-HOST → WAITING ROOM ────────────────────────────────────────────────
    else {
      rooms[roomId].waiting[userId] = {
        socketId: socket.id,
        username
      }

      socket.emit("waiting")

      const host = rooms[roomId].members[rooms[roomId].host]
      if (host) {
        io.to(host.socketId).emit("user-waiting", userId, username)
      }
    }
  })

  // ── APPROVE USER ────────────────────────────────────────────────────────────
  socket.on("approve-user", targetId => {
    const { roomId, userId } = socket

    if (!rooms[roomId] || rooms[roomId].host !== userId) return

    const target = rooms[roomId].waiting[targetId]
    if (!target) return

    io.to(target.socketId).emit("approved")
  })

  // ── DENY USER ───────────────────────────────────────────────────────────────
  socket.on("deny-user", targetId => {
    const { roomId, userId } = socket

    if (!rooms[roomId] || rooms[roomId].host !== userId) return

    const target = rooms[roomId].waiting[targetId]
    if (!target) return

    io.to(target.socketId).emit("denied")
    delete rooms[roomId].waiting[targetId]
  })

  // ── AFTER APPROVAL (JOIN ACTUAL ROOM) ───────────────────────────────────────
  socket.on("approved", () => {
    const { roomId, userId } = socket

    if (!rooms[roomId]) return

    const user = rooms[roomId].waiting[userId]
    if (!user) return

    rooms[roomId].members[userId] = {
      ...user,
      micOn: true,
      camOn: true
    }

    delete rooms[roomId].waiting[userId]

    socket.join(roomId)

    // Send existing users to new user
    const existing = Object.entries(rooms[roomId].members)
      .filter(([id]) => id !== userId)
      .map(([id, m]) => ({
        id,
        username: m.username,
        micOn: m.micOn,
        camOn: m.camOn
      }))

    socket.emit("existing-users", existing, false, rooms[roomId].host)

    // Notify others
    socket.to(roomId).emit("user-connected", userId, user.username)

    broadcastParticipants(roomId)
  })

  // ── MEDIA STATE UPDATE ──────────────────────────────────────────────────────
  socket.on("media-state", (micOn, camOn) => {
    const { roomId, userId } = socket

    if (!rooms[roomId]?.members[userId]) return

    rooms[roomId].members[userId].micOn = micOn
    rooms[roomId].members[userId].camOn = camOn

    broadcastParticipants(roomId)
  })

  // ── SCREEN SHARE (FIXED) ────────────────────────────────────────────────────
  socket.on("screen-share-started", () => {
    const { roomId, userId } = socket
    if (!rooms[roomId]) return

    socket.to(roomId).emit("screen-share-started", userId)
  })

  socket.on("screen-share-stopped", () => {
    const { roomId, userId } = socket
    if (!rooms[roomId]) return

    socket.to(roomId).emit("screen-share-stopped", userId)
  })

  // ── CHAT ────────────────────────────────────────────────────────────────────
  socket.on("chat-message", (roomId, message, username) => {
    socket.to(roomId).emit("chat-message", message, username)
  })

  // ── HOST: MIC CONTROL ──────────────────────────────────────────────────────
  socket.on("host-mute-user", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return
    const m = rooms[roomId].members[targetId]
    if (!m) return
    m.micOn = false
    io.to(m.socketId).emit("force-mute")
    broadcastParticipants(roomId)
  })

  socket.on("host-unmute-user", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return
    const m = rooms[roomId].members[targetId]
    if (!m) return
    io.to(m.socketId).emit("request-unmute")   // polite — user must accept
  })

  // ── HOST: CAMERA CONTROL ────────────────────────────────────────────────────
  socket.on("host-cam-off", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return
    const m = rooms[roomId].members[targetId]
    if (!m) return
    m.camOn = false
    io.to(m.socketId).emit("force-cam-off")
    broadcastParticipants(roomId)
  })

  socket.on("host-cam-on", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return
    const m = rooms[roomId].members[targetId]
    if (!m) return
    io.to(m.socketId).emit("request-cam-on")   // polite — user must accept
  })

  // ── KICK USER ───────────────────────────────────────────────────────────────
  socket.on("kick-user", targetId => {
    const { roomId, userId } = socket

    if (!rooms[roomId] || rooms[roomId].host !== userId) return

    const user = rooms[roomId].members[targetId]
    if (!user) return

    io.to(user.socketId).emit("you-were-kicked")

    delete rooms[roomId].members[targetId]

    socket.to(roomId).emit("user-disconnected", targetId)

    broadcastParticipants(roomId)
  })

  // ── DISCONNECT ──────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const { roomId, userId } = socket

    if (!roomId || !rooms[roomId]) return

    const wasHost = rooms[roomId].host === userId

    delete rooms[roomId].members[userId]
    delete rooms[roomId].waiting[userId]

    if (wasHost) {
      io.to(roomId).emit("meeting-ended")
      delete rooms[roomId]
    } else {
      socket.to(roomId).emit("user-disconnected", userId)
      broadcastParticipants(roomId)
    }
  })

})

// ─────────────────────────────────────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT)
})

