console.log("🚀 Server file started");

import "dotenv/config";
import express from "express";
import http from "http";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// Keep the instance for now so code doesn't break, but we will comment out the 'emits'
const io = new Server(server, { cors: { origin: "*" } });

// --- UPDATED CORS FOR VERCEL ---
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---------------- MongoDB ----------------
mongoose.connect(process.env.MONGO_URI, {
  // These options help prevent buffering timeouts in serverless environments
  connectTimeoutMS: 10000, 
  socketTimeoutMS: 45000,
})
.then(() => console.log("✅ MongoDB Connected Successfully"))
.catch(err => console.error("❌ MongoDB Connection Error:", err));

// Add this line to handle the "buffering" issue directly
mongoose.set('bufferCommands', false);

// ---------------- Multer ----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// ---------------- Models ----------------
const User = mongoose.model(
  "User",
  new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    avatar: String
  })
);

const Message = mongoose.model(
  "Message",
  new mongoose.Schema({
    senderEmail: String,
    senderName: String,
    receiver: String, 
    text: String,
    file: String,
    isRoom: Boolean,
    time: { type: Date, default: Date.now }
  })
);

const Room = mongoose.model(
  "Room",
  new mongoose.Schema({
    name: { type: String, unique: true },
    creator: String,
    members: [String],
    joinRequests: [String]
  })
);

// ---------------- AUTH ----------------
// ---------------- AUTH ----------------
// server.js - Backend
app.post("/register", async (req, res) => { // Removed upload.single("avatar")
  try {
    const { name, email, password } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ msg: "User already exists" });

    const hash = await bcrypt.hash(password, 10);
    const newUser = await User.create({ name, email, password: hash, avatar: "" });
    
    res.json({ msg: "Registered successfully" });
  } catch (err) {
    // This sends the SPECIFIC error back to your frontend
    res.status(500).json({ msg: "Register error", details: err.message });
  }
});
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "User not found" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ msg: "Wrong password" });

    // FIX: Include the secret key from .env
    const token = jwt.sign({ email }, process.env.JWT_SECRET || "secret");
    
    res.json({
      token,
      email: user.email,
      name: user.name,
      avatar: user.avatar || "" // Ensure this isn't undefined
    });
  } catch (err) {
    res.status(500).json({ msg: "Login error" });
  }
});

// ---------------- Users ----------------
app.get("/users", async (req, res) => {
  const users = await User.find({}, "name email avatar");
  res.json(users);
});

// ---------------- Rooms ----------------
app.get("/rooms", async (req, res) => {
  const rooms = await Room.find();
  res.json(rooms);
});

app.post("/createRoom", async (req, res) => {
  try {
    const { name, creator } = req.body;
    const exists = await Room.findOne({ name });
    if (exists) return res.status(400).json({ msg: "Room exists" });

    const room = await Room.create({ name, creator, members: [creator], joinRequests: [] });
    
    // --- SOCKET DISABLED FOR VERCEL TESTING ---
    // io.emit("newRoomCreated", room);
    
    res.json({ msg: "Room created" });
  } catch (err) {
    res.status(500).json({ msg: "Room creation error" });
  }
});

app.post("/requestJoinRoom", async (req, res) => {
  try {
    const { roomName, email } = req.body;
    const room = await Room.findOne({ name: roomName });
    if (!room) return res.status(404).json({ msg: "Room not found" });

    if (!room.joinRequests.includes(email) && !room.members.includes(email)) {
      room.joinRequests.push(email);
      await room.save();
      // --- SOCKET DISABLED FOR VERCEL TESTING ---
      // io.emit("requestUpdate", { roomName: roomName });
    }
    res.json({ msg: "Request sent" });
  } catch (err) {
    res.status(500).json({ msg: "Request error" });
  }
});

app.post("/approveJoin", async (req, res) => {
  try {
    const { roomName, email } = req.body;
    const room = await Room.findOne({ name: roomName });
    if (!room) return res.status(404).json({ msg: "Room not found" });

    room.joinRequests = room.joinRequests.filter((e) => e !== email);
    if (!room.members.includes(email)) room.members.push(email);
    await room.save();
    
    // --- SOCKET DISABLED FOR VERCEL TESTING ---
    // io.emit("roomUpdated", { roomName, members: room.members });
    
    res.json({ msg: "Approved" });
  } catch (err) {
    res.status(500).json({ msg: "Approve error" });
  }
});

app.delete("/deleteRoom/:name", async (req, res) => {
  await Room.deleteOne({ name: req.params.name });
  await Message.deleteMany({ receiver: req.params.name, isRoom: true });
  res.json({ msg: "Room deleted" });
});

// ---------------- FILE UPLOAD ----------------
app.post("/upload", upload.single("file"), (req, res) => {
  res.json({ path: `/uploads/${req.file.filename}` });
});

// ---------------- SOCKET.IO (DISABLED FOR VERCEL) ----------------
/*
io.on("connection", (socket) => {
  console.log("🔌 User connected");

  socket.on("joinPrivate", async ({ me, other }) => {
    socket.join(me);
    socket.join(other);
    const msgs = await Message.find({
      isRoom: false,
      $or: [
        { senderEmail: me, receiver: other },
        { senderEmail: other, receiver: me }
      ]
    }).sort({ time: 1 });
    socket.emit("oldPrivateMessages", msgs);
  });

  socket.on("privateMessage", async (data) => {
    const msg = await Message.create({ ...data, isRoom: false });
    io.to(data.senderEmail).to(data.receiver).emit("privateMessage", msg);
  });

  socket.on("joinRoom", async ({ room, email }) => {
    const r = await Room.findOne({ name: room });
    if (!r || !r.members.includes(email)) return;
    socket.join(room);
    const msgs = await Message.find({ receiver: room, isRoom: true }).sort({ time: 1 });
    socket.emit("oldRoomMessages", msgs);
  });

  socket.on("roomMessage", async (data) => {
    const msg = await Message.create({ ...data, isRoom: true });
    io.to(data.room).emit("roomMessage", msg);
  });

  socket.on("disconnect", () => console.log("❌ User disconnected"));
});
*/

const PORT = process.env.PORT || 5000; 
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));