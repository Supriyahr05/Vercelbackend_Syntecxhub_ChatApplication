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

// Keep the instance for now so code doesn't break
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors({
  origin: "*", 
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---------------- MongoDB Connection Logic ----------------
// 1. Connection state tracker
let isConnected = false; 

const connectDB = async () => {
  // If already connected, don't reconnect
  if (isConnected) return;

  try {
    const db = await mongoose.connect(process.env.MONGO_URI, {
      connectTimeoutMS: 10000, 
      socketTimeoutMS: 45000,
    });
    
    isConnected = db.connections[0].readyState;
    console.log("✅ MongoDB Connected Successfully");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
    throw err; // Throw so the route knows it failed
  }
};

// Handle buffering issues globally
mongoose.set('bufferCommands', false);

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

// ---------------- AUTH ROUTES (UPDATED) ----------------
app.post("/register", async (req, res) => {
  try {
    // 2. Ensure DB is connected before doing ANY operation
    await connectDB();

    const { name, email, password } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ msg: "User already exists" });

    const hash = await bcrypt.hash(password, 10);
    const newUser = await User.create({ name, email, password: hash, avatar: "" });
    
    res.json({ msg: "Registered successfully" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ msg: "Register error", details: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    // 3. Ensure DB is connected before login
    await connectDB();

    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "User not found" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ msg: "Wrong password" });

    const token = jwt.sign({ email }, process.env.JWT_SECRET || "secret");
    
    res.json({
      token,
      email: user.email,
      name: user.name,
      avatar: user.avatar || "" 
    });
  } catch (err) {
    res.status(500).json({ msg: "Login error", details: err.message });
  }
});

// ---------------- Users & Rooms (Added safety) ----------------
app.get("/users", async (req, res) => {
  await connectDB();
  const users = await User.find({}, "name email avatar");
  res.json(users);
});

app.get("/rooms", async (req, res) => {
  await connectDB();
  const rooms = await Room.find();
  res.json(rooms);
});

// ---------------- Multer (Kept for local, but note Vercel deletes files) ----------------
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

app.post("/upload", upload.single("file"), (req, res) => {
  res.json({ path: `/uploads/${req.file.filename}` });
});

// --- ADD THESE NEW ROUTES TO YOUR server.js ---

// 1. Route to GET messages (polling)
app.get("/messages/:type/:id", async (req, res) => {
  try {
    await connectDB();
    const { type, id } = req.params;
    const { me } = req.query; // Used to identify the sender for private chats

    let query;
    if (type === "room") {
      query = { receiver: id, isRoom: true };
    } else {
      query = {
        isRoom: false,
        $or: [
          { senderEmail: me, receiver: id },
          { senderEmail: id, receiver: me }
        ]
      };
    }

    const messages = await Message.find(query).sort({ time: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ msg: "Error fetching messages" });
  }
});

// 2. Route to SEND a message (replacing socket.emit)
app.post("/messages", async (req, res) => {
  try {
    await connectDB();
    const { senderEmail, senderName, receiver, text, file, isRoom } = req.body;
    const newMessage = await Message.create({
      senderEmail,
      senderName,
      receiver,
      text,
      file,
      isRoom
    });
    res.json(newMessage);
  } catch (err) {
    res.status(500).json({ msg: "Error sending message" });
  }
});

// 3. Update createRoom to ensure connectDB is called
app.post("/createRoom", async (req, res) => {
  try {
    await connectDB();
    const { name, creator } = req.body;
    const exists = await Room.findOne({ name });
    if (exists) return res.status(400).json({ msg: "Room exists" });

    await Room.create({ name, creator, members: [creator], joinRequests: [] });
    res.json({ msg: "Room created" });
  } catch (err) {
    res.status(500).json({ msg: "Room creation error" });
  }
});

// 1. ROUTE: User clicks "Request Join"
app.post("/requestJoinRoom", async (req, res) => {
  try {
    await connectDB();
    const { roomName, email } = req.body;
    
    // Add email to joinRequests array if it's not already there
    await Room.findOneAndUpdate(
      { name: roomName },
      { $addToSet: { joinRequests: email } } 
    );
    
    res.json({ msg: "Request sent" });
  } catch (err) {
    res.status(500).json({ msg: "Error requesting join" });
  }
});

// 2. ROUTE: Creator clicks "Approve" (or "Add")
app.post("/approveJoin", async (req, res) => {
  try {
    await connectDB();
    const { roomName, email } = req.body;

    await Room.findOneAndUpdate(
      { name: roomName },
      { 
        $addToSet: { members: email }, // Add to members
        $pull: { joinRequests: email } // Remove from requests
      }
    );

    res.json({ msg: "User approved" });
  } catch (err) {
    res.status(500).json({ msg: "Error approving user" });
  }
});
// ... existing Room routes (createRoom, requestJoinRoom, etc.) ...
// Remember to add 'await connectDB()' inside them if you see more timeout errors!

const PORT = process.env.PORT || 5000; 
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));