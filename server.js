const fs = require("fs");
const path = require("path");
const multer = require("multer");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");
const prisma = require("./src/prisma");
const {
  getS2CellKey,
  getCoverageCells,
  calculateDistanceKm,
} = require("./src/s2Service");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(cors());

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext =
      path.extname(file.originalname) ||
      (file.mimetype.startsWith("video/") ? ".mp4" : ".jpg");
    const cleanBase = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 30);
    const fileName = `${Date.now()}-${uuid().slice(0, 8)}-${cleanBase || "media"}${ext}`;
    cb(null, fileName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
});

app.use(express.json());

// Logger de requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

io.on("connection", (socket) => {
  console.log("Usuário conectado:", socket.id);

  // Cliente pode entrar na sala da sua célula S2 para otimização futura
  socket.on("join_cell", (cellKey) => {
    if (cellKey) {
      socket.join(`s2_${cellKey}`);
    }
  });

  socket.on("disconnect", () => {
    console.log("Usuário desconectado:", socket.id);
  });
});

// Backfill automático de mensagens antigas sem s2Cell
async function backfillS2Cells() {
  try {
    const unindexed = await prisma.message.findMany({
      where: { s2Cell: null },
      take: 500,
    });
    for (const msg of unindexed) {
      if (typeof msg.latitude === "number" && typeof msg.longitude === "number") {
        const cell = getS2CellKey(msg.latitude, msg.longitude, 13);
        await prisma.message.update({
          where: { id: msg.id },
          data: { s2Cell: cell },
        });
      }
    }
    if (unindexed.length > 0) {
      console.log(`[S2 Geometry] Backfill: ${unindexed.length} mensagens indexadas com sucesso.`);
    }
  } catch (err) {
    console.log("Erro no backfill S2:", err?.message);
  }
}
backfillS2Cells();

app.get("/", (req, res) => {
  res.json({
    message: "AroundMe API rodando com Google S2 Geometry",
    time: new Date(),
  });
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
    console.error("Erro ao salvar usuário:", error);
    res.status(500).json({ error: "Erro ao salvar usuário" });
  }
});

// Busca mensagens no raio otimizada pelo Google S2 Geometry
app.get("/messages", async (req, res) => {
  try {
    const { latitude, longitude, radius } = req.query;

    const userLat = Number(latitude);
    const userLng = Number(longitude);
    const userRadius = Number(radius || 5);

    if (isNaN(userLat) || isNaN(userLng)) {
      return res.status(400).json({ error: "Coordenadas inválidas" });
    }

    // 1. Fase 1: Cobertura de Células S2 Geometry
    const { level, cells, centerKey } = getCoverageCells(userLat, userLng, userRadius);

    let whereCondition = { deletedAt: null };

    if (level === 13) {
      whereCondition = {
        deletedAt: null,
        OR: [
          { s2Cell: { in: cells } },
          { s2Cell: null }, // Suporte a mensagens antigas
        ],
      };
    } else {
      whereCondition = {
        deletedAt: null,
        OR: [
          ...cells.map((prefix) => ({ s2Cell: { startsWith: prefix } })),
          { s2Cell: null },
        ],
      };
    }

    const candidateMessages = await prisma.message.findMany({
      where: whereCondition,
      orderBy: {
        createdAt: "asc",
      },
    });

    // 2. Fase 2: Refinamento de distância exata com Haversine
    const nearbyMessages = candidateMessages
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
    console.error("Erro ao buscar mensagens com S2:", error);
    res.status(500).json({ error: "Erro ao buscar mensagens" });
  }
});

// Envio de mensagem de texto com S2 e Aprendizado de Bairro
app.post("/messages", async (req, res) => {
  try {
    const { userId, nickname, district, text, latitude, longitude } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Texto da mensagem é obrigatório" });
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    const s2Cell = getS2CellKey(lat, lng, 13);

    // Garante que o usuário existe
    await prisma.user.upsert({
      where: { id: userId },
      update: { nickname },
      create: { id: userId, nickname },
    });

    // Aprende ou recupera o bairro da célula S2
    let finalDistrict = district;
    if (district && district !== "Local próximo") {
      await prisma.cellDistrict
        .upsert({
          where: { s2Cell },
          update: { district },
          create: { s2Cell, district },
        })
        .catch(() => {});
    } else {
      const known = await prisma.cellDistrict.findUnique({
        where: { s2Cell },
      });
      if (known) {
        finalDistrict = known.district;
      }
    }

    const message = await prisma.message.create({
      data: {
        id: uuid(),
        userId,
        nickname,
        district: finalDistrict || "Local próximo",
        type: "text",
        text: text.trim(),
        latitude: lat,
        longitude: lng,
        s2Cell,
      },
    });

    io.emit("new_message", message);

    res.status(201).json(message);
  } catch (error) {
    console.error("Erro ao salvar mensagem:", error);
    res.status(500).json({ error: "Erro ao salvar mensagem" });
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
    console.error("Erro ao apagar mensagem:", error);
    res.status(500).json({ error: "Erro ao apagar mensagem" });
  }
});

// Envio de mídia com S2 e Aprendizado de Bairro
app.post("/messages/media", upload.single("media"), async (req, res) => {
  try {
    const { userId, nickname, district, latitude, longitude, type, text } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado" });
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    const s2Cell = getS2CellKey(lat, lng, 13);
    const mediaUrl = `/uploads/${req.file.filename}`;

    await prisma.user.upsert({
      where: { id: userId },
      update: { nickname },
      create: { id: userId, nickname },
    });

    let finalDistrict = district;
    if (district && district !== "Local próximo") {
      await prisma.cellDistrict
        .upsert({
          where: { s2Cell },
          update: { district },
          create: { s2Cell, district },
        })
        .catch(() => {});
    } else {
      const known = await prisma.cellDistrict.findUnique({
        where: { s2Cell },
      });
      if (known) {
        finalDistrict = known.district;
      }
    }

    const message = await prisma.message.create({
      data: {
        id: uuid(),
        userId,
        nickname,
        district: finalDistrict || "Local próximo",
        type: type || (req.file.mimetype.startsWith("video/") ? "video" : "image"),
        text: text ? String(text).trim() : null,
        mediaUrl,
        latitude: lat,
        longitude: lng,
        s2Cell,
      },
    });

    io.emit("new_message", message);

    res.status(201).json(message);
  } catch (error) {
    console.error("Erro ao salvar mídia:", error);
    res.status(500).json({ error: "Erro ao salvar mídia" });
  }
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`AroundMe API com Google S2 rodando na porta ${PORT} em 0.0.0.0`);
});
