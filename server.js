// ─────────────────────────────────────────────────────────
//  CircleCall — SERVER (RENDER READY)
// ─────────────────────────────────────────────────────────

const express = require("express")
const app = express()
const server = require("http").createServer(app)

const io = require("socket.io")(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
})

const path = require("path")
const { ExpressPeerServer } = require("peerjs")

// PeerJS server
app.use("/peerjs", ExpressPeerServer(server, { debug: true }))

// Static files
app.use(express.static("public"))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/home.html"))
})

app.get("/room/:room", (req, res) => {
  res.sendFile(path.join(__dirname, "public/room.html"))
})

// Rooms
const rooms = {}

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

io.on("connection", socket => {

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
    } else {
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

  socket.on("approve-user", targetId => {
    const { roomId, userId } = socket
    if (!rooms[roomId] || rooms[roomId].host !== userId) return

    const target = rooms[roomId].waiting[targetId]
    if (!target) return

    io.to(target.socketId).emit("approved")
  })

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

    const existing = Object.entries(rooms[roomId].members)
      .filter(([id]) => id !== userId)
      .map(([id, m]) => ({
        id,
        username: m.username,
        micOn: m.micOn,
        camOn: m.camOn
      }))

    socket.emit("existing-users", existing, false, rooms[roomId].host)
    socket.to(roomId).emit("user-connected", userId, user.username)

    broadcastParticipants(roomId)
  })

  socket.on("user-disconnected", id => {
    socket.to(socket.roomId).emit("user-disconnected", id)
  })

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

// Start server
const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT)
})