const express = require("express")
const app     = express()
const http    = require("http").createServer(app)
const path    = require("path")

// Required: tell Express it's behind Render's HTTPS reverse proxy
app.set("trust proxy", 1)

// Socket.IO — polling FIRST, then upgrade to websocket
// This is critical for Render — websocket-first fails on their proxy
const { Server } = require("socket.io")
const io = new Server(http, {
  pingTimeout:       60000,
  pingInterval:      25000,
  upgradeTimeout:    30000,
  allowEIO3:         true,
  transports:        ["polling", "websocket"],
  allowUpgrades:     true,
  cors: {
    origin:      "*",
    methods:     ["GET", "POST"],
    credentials: false
  }
})

// PeerJS server — proxied:true required behind Render
const { ExpressPeerServer } = require("peer")
app.use("/peerjs", ExpressPeerServer(http, {
  debug:   false,
  proxied: true
}))

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }))
app.get("/",           (_req, res) => res.sendFile(path.join(__dirname, "public/home.html")))
app.get("/room/:room", (_req, res) => res.sendFile(path.join(__dirname, "public/room.html")))

// ── Room state ────────────────────────────────────────────────────────────────
const rooms = {}

function broadcastParticipants(roomId) {
  if (!rooms[roomId]) return
  const list = Object.entries(rooms[roomId].members).map(([id, m]) => ({
    id, username: m.username, micOn: m.micOn, camOn: m.camOn
  }))
  io.to(roomId).emit("participants-update", list, rooms[roomId].host)
}

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on("connection", socket => {
  console.log("socket connected:", socket.id, "| transport:", socket.conn.transport.name)

  socket.conn.on("upgrade", transport => {
    console.log("socket upgraded to:", transport.name)
  })

  // JOIN
  socket.on("join-room", (roomId, userId, username) => {
    if (!rooms[roomId])
      rooms[roomId] = { host: userId, members: {}, waiting: {} }

    socket.userId = userId
    socket.roomId = roomId

    if (rooms[roomId].host === userId) {
      rooms[roomId].members[userId] = { socketId: socket.id, username, micOn: true, camOn: true }
      socket.join(roomId)
      socket.emit("existing-users", [], true, userId)
      broadcastParticipants(roomId)
    } else {
      rooms[roomId].waiting[userId] = { socketId: socket.id, username }
      socket.emit("waiting")
      const host = rooms[roomId].members[rooms[roomId].host]
      if (host) io.to(host.socketId).emit("user-waiting", userId, username)
    }
  })

  // APPROVE / DENY
  socket.on("approve-user", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return
    const target = rooms[roomId].waiting[targetId]
    if (target) io.to(target.socketId).emit("approved")
  })

  socket.on("deny-user", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return
    const target = rooms[roomId].waiting[targetId]
    if (!target) return
    io.to(target.socketId).emit("denied")
    delete rooms[roomId].waiting[targetId]
  })

  socket.on("approved", () => {
    const { roomId, userId } = socket
    if (!rooms[roomId]) return
    const user = rooms[roomId].waiting[userId]
    if (!user) return
    rooms[roomId].members[userId] = { ...user, micOn: true, camOn: true }
    delete rooms[roomId].waiting[userId]
    socket.join(roomId)
    const existing = Object.entries(rooms[roomId].members)
      .filter(([id]) => id !== userId)
      .map(([id, m]) => ({ id, username: m.username, micOn: m.micOn, camOn: m.camOn }))
    socket.emit("existing-users", existing, false, rooms[roomId].host)
    socket.to(roomId).emit("user-connected", userId, user.username)
    broadcastParticipants(roomId)
  })

  // MEDIA STATE
  socket.on("media-state", (micOn, camOn) => {
    const { roomId, userId } = socket
    if (!rooms[roomId]?.members[userId]) return
    rooms[roomId].members[userId].micOn = micOn
    rooms[roomId].members[userId].camOn = camOn
    broadcastParticipants(roomId)
  })

  // HOST MIC CONTROL
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
    if (m) io.to(m.socketId).emit("request-unmute")
  })

  // HOST CAM CONTROL
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
    if (m) io.to(m.socketId).emit("request-cam-on")
  })

  // SCREEN SHARE
  socket.on("screen-share-started", () => {
    const { roomId, userId } = socket
    if (rooms[roomId]) socket.to(roomId).emit("screen-share-started", userId)
  })
  socket.on("screen-share-stopped", () => {
    const { roomId, userId } = socket
    if (rooms[roomId]) socket.to(roomId).emit("screen-share-stopped", userId)
  })

  // CHAT
  socket.on("chat-message", (roomId, message, username) => {
    socket.to(roomId).emit("chat-message", message, username)
  })

  // KICK
  socket.on("kick-user", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return
    const m = rooms[roomId].members[targetId]
    if (!m) return
    io.to(m.socketId).emit("you-were-kicked")
    delete rooms[roomId].members[targetId]
    io.to(roomId).emit("user-disconnected", targetId)
    broadcastParticipants(roomId)
  })

  // DISCONNECT
  socket.on("disconnect", reason => {
    console.log("socket disconnected:", socket.id, "| reason:", reason)
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

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
http.listen(PORT, "0.0.0.0", () => {
  console.log(`CircleCall server running on port ${PORT}`)
})
