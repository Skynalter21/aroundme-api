const path = require("path");
const multer = require("multer");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");
const prisma = require("./src/prisma");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(cors());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const fileName = `${Date.now()}-${file.originalname}`;
    cb(null, fileName);
  },
});

const upload = multer({ storage });
app.use(express.json());

io.on("connection", (socket) => {
  console.log("Usuário conectado:", socket.id);

  socket.on("disconnect", () => {
    console.log("Usuário desconectado:", socket.id);
  });
});

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

app.get("/", (req, res) => {
  res.json({ message: "AroundMe API rodando" });
});

app.post("/users", async (req, res) => {
  try {
    const { id, nickname } = req.body;

    const user = await prisma.user.upsert({
      where: { id },
      update: { nickname },
      create: { id, nickname },
    });

    res.status(201).json(user);
  } catch (error) {
    console.log(error);

    res.status(500).json({
      error: "Erro ao salvar usuário",
    });
  }
});

app.get("/messages", async (req, res) => {
  try {
    const { latitude, longitude, radius } = req.query;

    const userLat = Number(latitude);
    const userLng = Number(longitude);
    const userRadius = Number(radius || 5);

    const messages = await prisma.message.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    const nearbyMessages = messages
      .map((message) => {
        const distance = calculateDistanceKm(
          userLat,
          userLng,
          message.latitude,
          message.longitude
        );

        return {
          ...message,
          distance: Number(distance.toFixed(1)),
        };
      })
      .filter((message) => message.distance <= userRadius);

    res.json(nearbyMessages);
  } catch (error) {
    console.log(error);

    res.status(500).json({
      error: "Erro ao buscar mensagens",
    });
  }
});

app.post("/messages", async (req, res) => {
  try {
    const {
      userId,
      nickname,
      district,
      text,
      latitude,
      longitude,
    } = req.body;

    const message = await prisma.message.create({
      data: {
        id: uuid(),
        userId,
        nickname,
        district,
        type: "text",
        text,
        latitude,
        longitude,
      },
    });

    io.emit("new_message", message);

    res.status(201).json(message);
  } catch (error) {
    console.log(error);

    res.status(500).json({
      error: "Erro ao salvar mensagem",
    });
  }
});

app.delete("/messages/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    const message = await prisma.message.findUnique({
      where: { id },
    });

    if (!message) {
      return res.status(404).json({ error: "Mensagem não encontrada" });
    }

    if (message.userId !== userId) {
      return res.status(403).json({ error: "Você não pode apagar essa mensagem" });
    }

    await prisma.message.update({
      where: { id },
      data: {
        deletedAt: new Date(),
      },
    });

    io.emit("message_deleted", { id });

    res.json({ success: true });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      error: "Erro ao apagar mensagem",
    });
  }
});

app.post("/messages/media", upload.single("media"), async (req, res) => {
  try {
    const { userId, nickname, district, latitude, longitude, type } = req.body;

    const mediaUrl = `http://10.0.2.2:3333/uploads/${req.file.filename}`;

    const message = await prisma.message.create({
      data: {
        id: uuid(),
        userId,
        nickname,
        district,
        type,
        mediaUrl,
        latitude: Number(latitude),
        longitude: Number(longitude),
      },
    });

    io.emit("new_message", message);

    res.status(201).json(message);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Erro ao salvar mídia" });
  }
});

server.listen(3333, () => {
  console.log("AroundMe API rodando na porta 3333");
});