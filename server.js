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

  // Cliente pode entrar na sala da sua célula S2
  socket.on("join_cell", (cellKey) => {
    if (cellKey) {
      socket.join(`s2_${cellKey}`);
    }
  });

  // Canais específicos para salas de bate-papo
  socket.on("join_room_channel", (roomId) => {
    if (roomId) {
      socket.join(`room_${roomId}`);
      console.log(`Socket ${socket.id} entrou no canal da sala room_${roomId}`);
    }
  });

  socket.on("leave_room_channel", (roomId) => {
    if (roomId) {
      socket.leave(`room_${roomId}`);
      console.log(`Socket ${socket.id} saiu do canal da sala room_${roomId}`);
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
      console.log(`[S2 Geometry] Backfill: ${unindexed.length} mensagens indexadas.`);
    }
  } catch (err) {
    console.log("Erro no backfill S2:", err?.message);
  }
}
backfillS2Cells();

// Dispara notificações push via Expo Push API para mensagens globais
async function sendPushNotifications(message) {
  try {
    const recipients = await prisma.user.findMany({
      where: {
        id: { not: message.userId },
        pushToken: { not: null },
      },
    });

    if (!recipients || recipients.length === 0) return;

    const validTokens = [];
    for (const recipient of recipients) {
      if (
        !recipient.pushToken ||
        !recipient.pushToken.startsWith("ExponentPushToken")
      ) {
        continue;
      }

      if (
        typeof recipient.latitude === "number" &&
        typeof recipient.longitude === "number" &&
        typeof message.latitude === "number" &&
        typeof message.longitude === "number"
      ) {
        const dist = calculateDistanceKm(
          recipient.latitude,
          recipient.longitude,
          message.latitude,
          message.longitude
        );
        if (dist > 25) continue;
      }

      validTokens.push(recipient.pushToken);
    }

    if (validTokens.length === 0) return;

    let bodyText = "Nova mensagem no seu raio";
    if (message.type === "image") {
      bodyText = message.text ? `📷 ${message.text}` : "📷 Enviou uma foto";
    } else if (message.type === "video") {
      bodyText = message.text ? `🎥 ${message.text}` : "🎥 Enviou um vídeo";
    } else if (message.text) {
      bodyText = message.text;
    }

    const title = `AroundMe · ${message.nickname}${
      message.district ? ` (${message.district})` : ""
    }`;

    const payload = validTokens.map((to) => ({
      to,
      sound: "default",
      title,
      body: bodyText,
      data: {
        messageId: message.id,
        userId: message.userId,
      },
      channelId: "messages",
      priority: "high",
    }));

    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (pushErr) {
    console.error("[Push Global] Erro ao enviar:", pushErr?.message || pushErr);
  }
}

// Dispara notificações push para mensagens dentro de uma sala
async function sendPushNotificationsForRoom(roomId, message) {
  try {
    const room = await prisma.room.findUnique({
      where: { id: roomId },
    });
    if (!room) return;

    const members = await prisma.roomMember.findMany({
      where: {
        roomId,
        userId: { not: message.userId },
      },
      include: {
        user: true,
      },
    });

    const validTokens = members
      .map((m) => m.user?.pushToken)
      .filter((token) => token && token.startsWith("ExponentPushToken"));

    if (validTokens.length === 0) return;

    let bodyText = "Nova mensagem na sala";
    if (message.type === "image") {
      bodyText = message.text ? `📷 ${message.text}` : "📷 Enviou uma foto";
    } else if (message.type === "video") {
      bodyText = message.text ? `🎥 ${message.text}` : "🎥 Enviou um vídeo";
    } else if (message.text) {
      bodyText = message.text;
    }

    const payload = validTokens.map((to) => ({
      to,
      sound: "default",
      title: `[${room.name}] · ${message.nickname}`,
      body: bodyText,
      data: {
        roomId: room.id,
        messageId: message.id,
      },
      channelId: "messages",
      priority: "high",
    }));

    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[Push Room] Erro:", err?.message || err);
  }
}

app.get("/", (req, res) => {
  res.json({
    message: "AroundMe API rodando com Google S2 Geometry, Push & Salas",
    time: new Date(),
  });
});

app.post("/users", async (req, res) => {
  try {
    const { id, nickname, pushToken, latitude, longitude } = req.body;

    const dataToUpdate = { nickname };
    if (pushToken) dataToUpdate.pushToken = pushToken;
    if (typeof latitude === "number") dataToUpdate.latitude = latitude;
    if (typeof longitude === "number") dataToUpdate.longitude = longitude;

    const user = await prisma.user.upsert({
      where: { id },
      update: dataToUpdate,
      create: {
        id,
        nickname: nickname || "Anônimo",
        pushToken: pushToken || null,
        latitude: typeof latitude === "number" ? latitude : null,
        longitude: typeof longitude === "number" ? longitude : null,
      },
    });

    res.status(201).json(user);
  } catch (error) {
    console.error("Erro ao salvar usuário:", error);
    res.status(500).json({ error: "Erro ao salvar usuário" });
  }
});

// ==========================================
// ROTAS DE MENSAGENS GLOBAIS (FEED LIVRE)
// ==========================================

app.get("/messages", async (req, res) => {
  try {
    const { latitude, longitude, radius } = req.query;

    const userLat = Number(latitude);
    const userLng = Number(longitude);
    const userRadius = Number(radius || 5);

    if (isNaN(userLat) || isNaN(userLng)) {
      return res.status(400).json({ error: "Coordenadas inválidas" });
    }

    const { level, cells } = getCoverageCells(userLat, userLng, userRadius);

    let whereCondition = { deletedAt: null };

    if (level === 13) {
      whereCondition = {
        deletedAt: null,
        OR: [{ s2Cell: { in: cells } }, { s2Cell: null }],
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
      orderBy: { createdAt: "asc" },
    });

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

app.post("/messages", async (req, res) => {
  try {
    const { userId, nickname, district, text, latitude, longitude } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Texto da mensagem é obrigatório" });
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    const s2Cell = getS2CellKey(lat, lng, 13);

    await prisma.user.upsert({
      where: { id: userId },
      update: { nickname, latitude: lat, longitude: lng },
      create: { id: userId, nickname, latitude: lat, longitude: lng },
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
      if (known) finalDistrict = known.district;
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
    sendPushNotifications(message);

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
      data: { deletedAt: new Date() },
    });

    io.emit("message_deleted", { id });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao apagar mensagem:", error);
    res.status(500).json({ error: "Erro ao apagar mensagem" });
  }
});

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
      update: { nickname, latitude: lat, longitude: lng },
      create: { id: userId, nickname, latitude: lat, longitude: lng },
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
      if (known) finalDistrict = known.district;
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
    sendPushNotifications(message);

    res.status(201).json(message);
  } catch (error) {
    console.error("Erro ao salvar mídia:", error);
    res.status(500).json({ error: "Erro ao salvar mídia" });
  }
});

// ==========================================
// ROTAS DE SALAS DE BATE-PAPO (ROOMS)
// ==========================================

// 1. Listar salas próximas
app.get("/rooms", async (req, res) => {
  try {
    const { latitude, longitude, radius } = req.query;

    const userLat = Number(latitude);
    const userLng = Number(longitude);
    const userRadius = Number(radius || 20);

    if (isNaN(userLat) || isNaN(userLng)) {
      return res.status(400).json({ error: "Coordenadas inválidas" });
    }

    const { level, cells } = getCoverageCells(userLat, userLng, userRadius);

    let whereCondition = { deletedAt: null };
    if (level === 13) {
      whereCondition = {
        deletedAt: null,
        OR: [{ s2Cell: { in: cells } }, { s2Cell: null }],
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

    const candidateRooms = await prisma.room.findMany({
      where: whereCondition,
      include: {
        _count: {
          select: { members: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const nearbyRooms = candidateRooms
      .map((room) => {
        const distance = calculateDistanceKm(
          userLat,
          userLng,
          room.latitude,
          room.longitude
        );

        return {
          id: room.id,
          name: room.name,
          description: room.description,
          category: room.category,
          isProtected: Boolean(room.password),
          maxMembers: room.maxMembers,
          membersCount: room._count.members,
          ownerId: room.ownerId,
          district: room.district,
          distance: Number(distance.toFixed(1)),
          createdAt: room.createdAt,
        };
      })
      .filter((r) => r.distance <= userRadius);

    res.json(nearbyRooms);
  } catch (error) {
    console.error("Erro ao buscar salas:", error);
    res.status(500).json({ error: "Erro ao buscar salas" });
  }
});

// 2. Criar nova sala
app.post("/rooms", async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      password,
      maxMembers,
      ownerId,
      nickname,
      latitude,
      longitude,
      district,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Nome da sala é obrigatório" });
    }

    if (!ownerId) {
      return res.status(400).json({ error: "ownerId é obrigatório" });
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    const s2Cell = getS2CellKey(lat, lng, 13);

    await prisma.user.upsert({
      where: { id: ownerId },
      update: { nickname, latitude: lat, longitude: lng },
      create: { id: ownerId, nickname: nickname || "Anônimo", latitude: lat, longitude: lng },
    });

    const room = await prisma.room.create({
      data: {
        id: uuid(),
        name: name.trim(),
        description: description ? description.trim() : null,
        category: category || "Geral",
        password: password ? String(password).trim() : null,
        maxMembers: Number(maxMembers) || 50,
        ownerId,
        latitude: lat,
        longitude: lng,
        district: district || "Local próximo",
        s2Cell,
        members: {
          create: {
            id: uuid(),
            userId: ownerId,
            role: "owner",
          },
        },
      },
      include: {
        _count: {
          select: { members: true },
        },
      },
    });

    const roomSummary = {
      id: room.id,
      name: room.name,
      description: room.description,
      category: room.category,
      isProtected: Boolean(room.password),
      maxMembers: room.maxMembers,
      membersCount: room._count.members,
      ownerId: room.ownerId,
      district: room.district,
      distance: 0,
      createdAt: room.createdAt,
    };

    io.emit("new_room", roomSummary);

    res.status(201).json(roomSummary);
  } catch (error) {
    console.error("Erro ao criar sala:", error);
    res.status(500).json({ error: "Erro ao criar sala" });
  }
});

// 3. Entrar na sala
app.post("/rooms/:id/join", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, nickname, password } = req.body;

    const room = await prisma.room.findUnique({
      where: { id },
      include: {
        _count: { select: { members: true } },
      },
    });

    if (!room || room.deletedAt) {
      return res.status(404).json({ error: "Sala não encontrada" });
    }

    if (room.password) {
      if (!password || String(password).trim() !== String(room.password).trim()) {
        return res.status(401).json({ error: "Senha incorreta para esta sala." });
      }
    }

    const existingMember = await prisma.roomMember.findUnique({
      where: {
        roomId_userId: { roomId: id, userId },
      },
    });

    if (!existingMember && room._count.members >= room.maxMembers) {
      return res.status(400).json({ error: "Esta sala já atingiu a capacidade máxima." });
    }

    await prisma.user.upsert({
      where: { id: userId },
      update: { nickname },
      create: { id: userId, nickname: nickname || "Anônimo" },
    });

    const memberRole = existingMember
      ? existingMember.role
      : room.ownerId === userId
      ? "owner"
      : "member";

    const member = await prisma.roomMember.upsert({
      where: {
        roomId_userId: { roomId: id, userId },
      },
      update: {},
      create: {
        id: uuid(),
        roomId: id,
        userId,
        role: memberRole,
      },
    });

    io.to(`room_${id}`).emit("room_member_joined", {
      roomId: id,
      user: { id: userId, nickname, role: member.role },
    });

    res.json({ success: true, role: member.role });
  } catch (error) {
    console.error("Erro ao entrar na sala:", error);
    res.status(500).json({ error: "Erro ao entrar na sala" });
  }
});

// 4. Listar membros da sala
app.get("/rooms/:id/members", async (req, res) => {
  try {
    const { id } = req.params;

    const members = await prisma.roomMember.findMany({
      where: { roomId: id },
      include: {
        user: {
          select: { id: true, nickname: true },
        },
      },
      orderBy: { joinedAt: "asc" },
    });

    res.json(
      members.map((m) => ({
        id: m.userId,
        nickname: m.user?.nickname || "Membro",
        role: m.role,
        joinedAt: m.joinedAt,
      }))
    );
  } catch (error) {
    console.error("Erro ao listar membros:", error);
    res.status(500).json({ error: "Erro ao listar membros" });
  }
});

// 5. Promover a moderador
app.post("/rooms/:id/moderators", async (req, res) => {
  try {
    const { id } = req.params;
    const { ownerId, targetUserId } = req.body;

    const room = await prisma.room.findUnique({ where: { id } });
    if (!room) return res.status(404).json({ error: "Sala não encontrada" });

    if (room.ownerId !== ownerId) {
      return res.status(403).json({ error: "Apenas o criador da sala pode nomear moderadores." });
    }

    const updated = await prisma.roomMember.update({
      where: { roomId_userId: { roomId: id, userId: targetUserId } },
      data: { role: "moderator" },
    });

    io.to(`room_${id}`).emit("room_role_updated", {
      roomId: id,
      userId: targetUserId,
      role: "moderator",
    });

    res.json({ success: true, member: updated });
  } catch (error) {
    console.error("Erro ao promover moderador:", error);
    res.status(500).json({ error: "Erro ao promover moderador" });
  }
});

// 6. Expulsar membro
app.post("/rooms/:id/kick", async (req, res) => {
  try {
    const { id } = req.params;
    const { actorUserId, targetUserId } = req.body;

    const room = await prisma.room.findUnique({ where: { id } });
    if (!room) return res.status(404).json({ error: "Sala não encontrada" });

    if (targetUserId === room.ownerId) {
      return res.status(400).json({ error: "Não é possível expulsar o criador da sala." });
    }

    const actorMember = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: id, userId: actorUserId } },
    });

    if (!actorMember || (actorMember.role !== "owner" && actorMember.role !== "moderator")) {
      return res.status(403).json({ error: "Permissão insuficiente para expulsar membros." });
    }

    const targetMember = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: id, userId: targetUserId } },
    });

    if (targetMember && targetMember.role === "moderator" && actorMember.role !== "owner") {
      return res.status(403).json({ error: "Apenas o dono pode expulsar outro moderador." });
    }

    await prisma.roomMember.delete({
      where: { roomId_userId: { roomId: id, userId: targetUserId } },
    });

    io.to(`room_${id}`).emit("room_member_kicked", {
      roomId: id,
      userId: targetUserId,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao expulsar membro:", error);
    res.status(500).json({ error: "Erro ao expulsar membro" });
  }
});

// 7. Buscar histórico de mensagens da sala
app.get("/rooms/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;

    const messages = await prisma.roomMessage.findMany({
      where: {
        roomId: id,
        deletedAt: null,
      },
      orderBy: { createdAt: "asc" },
    });

    res.json(messages);
  } catch (error) {
    console.error("Erro ao carregar mensagens da sala:", error);
    res.status(500).json({ error: "Erro ao carregar mensagens da sala" });
  }
});

// 8. Enviar mensagem de texto na sala
app.post("/rooms/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, nickname, district, text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Texto da mensagem é obrigatório" });
    }

    const isMember = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: id, userId } },
    });

    if (!isMember) {
      return res.status(403).json({ error: "Você não faz parte desta sala ou foi removido." });
    }

    const message = await prisma.roomMessage.create({
      data: {
        id: uuid(),
        roomId: id,
        userId,
        nickname,
        district: district || null,
        type: "text",
        text: text.trim(),
      },
    });

    io.to(`room_${id}`).emit("new_room_message", message);
    sendPushNotificationsForRoom(id, message);

    res.status(201).json(message);
  } catch (error) {
    console.error("Erro ao enviar mensagem na sala:", error);
    res.status(500).json({ error: "Erro ao enviar mensagem na sala" });
  }
});

// 9. Enviar mídia na sala
app.post("/rooms/:id/messages/media", upload.single("media"), async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, nickname, district, type, text } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado" });
    }

    const isMember = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: id, userId } },
    });

    if (!isMember) {
      return res.status(403).json({ error: "Você não faz parte desta sala." });
    }

    const mediaUrl = `/uploads/${req.file.filename}`;

    const message = await prisma.roomMessage.create({
      data: {
        id: uuid(),
        roomId: id,
        userId,
        nickname,
        district: district || null,
        type: type || (req.file.mimetype.startsWith("video/") ? "video" : "image"),
        text: text ? String(text).trim() : null,
        mediaUrl,
      },
    });

    io.to(`room_${id}`).emit("new_room_message", message);
    sendPushNotificationsForRoom(id, message);

    res.status(201).json(message);
  } catch (error) {
    console.error("Erro ao enviar mídia na sala:", error);
    res.status(500).json({ error: "Erro ao enviar mídia na sala" });
  }
});

// 10. Apagar mensagem na sala (Autor, Dono ou Moderador)
app.delete("/rooms/:id/messages/:msgId", async (req, res) => {
  try {
    const { id, msgId } = req.params;
    const { userId } = req.body;

    const message = await prisma.roomMessage.findUnique({
      where: { id: msgId },
    });

    if (!message || message.roomId !== id) {
      return res.status(404).json({ error: "Mensagem não encontrada" });
    }

    const room = await prisma.room.findUnique({ where: { id } });
    const member = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: id, userId } },
    });

    const isAuthor = message.userId === userId;
    const isOwner = room?.ownerId === userId || member?.role === "owner";
    const isModerator = member?.role === "moderator";

    if (!isAuthor && !isOwner && !isModerator) {
      return res.status(403).json({ error: "Você não tem permissão para apagar esta mensagem." });
    }

    await prisma.roomMessage.update({
      where: { id: msgId },
      data: { deletedAt: new Date() },
    });

    io.to(`room_${id}`).emit("room_message_deleted", { roomId: id, messageId: msgId });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao apagar mensagem da sala:", error);
    res.status(500).json({ error: "Erro ao apagar mensagem da sala" });
  }
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`AroundMe API rodando na porta ${PORT} em 0.0.0.0`);
});