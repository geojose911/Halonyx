const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const { hashUSID, generateUSID } = require("./utils");
const WebSocket = require("ws");
const dgram = require("dgram");
const http = require("http");
const rateLimit = require("express-rate-limit");

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.set('trust proxy', 1);

<<<<<<< HEAD
// ── Serve Frontend ──
app.use(express.static(path.join(__dirname, "../frontend")));
=======
// Security Headers & Content Security Policy (T-11)
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob: data:; " +
    "connect-src 'self' ws: wss: https://cdn.jsdelivr.net wss://tracker.openwebtorrent.com wss://tracker.webtorrent.dev wss://tracker.files.fm:7073 wss://tracker.btorrent.xyz; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self';"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be

// Operational Database
const db = new sqlite3.Database(path.join(__dirname, "db", "app.db"));
// Identity Database (Metadata)
const idDb = new sqlite3.Database(path.join(__dirname, "db", "identity.db"));
const keyDb = new sqlite3.Database(path.join(__dirname, "db", "keys.db"));

// Initialize Databases
function initDb(database, schemaPath) {
  database.serialize(() => {
    const schema = fs.readFileSync(schemaPath, "utf8");
    const statements = schema.split(";").filter((stmt) => stmt.trim());
    statements.forEach((stmt) => {
      database.run(stmt);
    });
  });
}

initDb(db, path.join(__dirname, "db", "schema.sql"));
initDb(idDb, path.join(__dirname, "db", "identity_schema.sql"));
initDb(keyDb, path.join(__dirname, "db", "key_schema.sql"));

const crypto = require("crypto");
const JWT_SECRET_FILE = path.join(__dirname, "db", ".jwt_secret");

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      const stored = fs.readFileSync(JWT_SECRET_FILE, "utf8").trim();
      if (stored && stored.length >= 16) return stored;
    }
    const secret = crypto.randomBytes(32).toString("hex");
    const dbDir = path.join(__dirname, "db");
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret, "utf8");
    return secret;
  } catch (e) {
    return crypto.randomBytes(32).toString("hex");
  }
}
const JWT_SECRET = getJwtSecret();

const signupLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "Too many accounts created from this IP, please try again after 5 minutes" },
  validate: { trustProxy: false, xForwardedForHeader: false },
});

const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "Too many key uploads from this IP, please try again later" },
  validate: { trustProxy: false, xForwardedForHeader: false },
});

// Routes
app.post("/signup", signupLimiter, (req, res) => {
  const { name, email, publicKey } = req.body;
  if (!name || name.trim() === "")
    return res.status(400).json({ error: "Name is required" });
  if (!email || !email.includes("@"))
    return res.status(400).json({ error: "Valid email is required" });

  const emailValue = email.trim();
  const usid = generateUSID();
  const hashed = hashUSID(usid);
  // Use submitted public key if provided, otherwise fall back to placeholder
  const publicKeyBundle = JSON.stringify({
    identityKey: publicKey || "placeholder-public-key",
  });

  // Identity Registry Check
  idDb.get(
    "SELECT id, hashed_usid FROM users_metadata WHERE email = ?",
    [emailValue],
    (err, row) => {
      if (err)
        return res.status(500).json({ error: "Identity DB lookup failed" });

      if (row) {
        console.log(`[Signup] Identity RE-ENTRY: ${emailValue}`);
        const existingHashedUsid = row.hashed_usid;
        idDb.run(
          "UPDATE users_metadata SET name = ? WHERE id = ?",
          [name.trim(), row.id],
          (updateErr) => {
            if (updateErr)
              return res.status(500).json({ error: "Identity update failed" });
            db.run(
              "INSERT OR IGNORE INTO users (hashed_usid, public_key_bundle) VALUES (?, ?)",
              [existingHashedUsid, publicKeyBundle],
              () => {
                const jwtToken = jwt.sign({ userId: row.id, hashedUsid: existingHashedUsid }, JWT_SECRET);
                res.json({
                  message: "Identity re-verified",
                  usid: existingHashedUsid,
                  token: jwtToken,
                });
              },
            );
          },
        );
      } else {
        console.log(`[Signup] New Identity: ${emailValue}`);
        idDb.run(
          "INSERT INTO users_metadata (name, email, hashed_usid) VALUES (?, ?, ?)",
          [name.trim(), emailValue, hashed],
          function (err) {
            if (err)
              return res
                .status(500)
                .json({ error: "Identity creation failed" });
            const userId = this.lastID;
            db.run(
              "INSERT INTO users (hashed_usid, public_key_bundle) VALUES (?, ?)",
              [hashed, publicKeyBundle],
              function () {
                const jwtToken = jwt.sign({ userId, hashedUsid: hashed }, JWT_SECRET);
                res.json({ message: "Account created", usid: hashed, token: jwtToken });
              },
            );
          },
        );
      }
    },
  );
});

app.post("/connect", (req, res) => {
  const { usid, email } = req.body;
  if ((!usid || !usid.trim()) && (!email || !email.includes("@"))) {
    return res.status(400).json({ error: "USID or valid Email is required to connect" });
  }

  if (usid && usid.trim()) {
    const cleanUsid = usid.trim();
    const hashed = hashUSID(cleanUsid);

    idDb.get(
      "SELECT id, name, email, hashed_usid FROM users_metadata WHERE hashed_usid = ? OR hashed_usid = ?",
      [cleanUsid, hashed],
      (err, row) => {
        if (err) return res.status(500).json({ error: "Identity DB lookup failed" });
        if (!row) return res.status(404).json({ error: "Identity not found. Please sign up first." });

        const jwtToken = jwt.sign({ userId: row.id, hashedUsid: row.hashed_usid }, JWT_SECRET);
        res.json({
          message: "Connected successfully",
          usid: row.hashed_usid,
          name: row.name,
          email: row.email,
          token: jwtToken,
        });
      }
    );
  } else {
    idDb.get(
      "SELECT id, name, email, hashed_usid FROM users_metadata WHERE email = ?",
      [email.trim()],
      (err, row) => {
        if (err) return res.status(500).json({ error: "Identity DB lookup failed" });
        if (!row) return res.status(404).json({ error: "Identity not found. Please sign up first." });

        const jwtToken = jwt.sign({ userId: row.id, hashedUsid: row.hashed_usid }, JWT_SECRET);
        res.json({
          message: "Connected successfully",
          usid: row.hashed_usid,
          name: row.name,
          email: row.email,
          token: jwtToken,
        });
      }
    );
  }
});

function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });
    req.user = decoded;
    next();
  });
}

app.post("/add-contact", authenticate, (req, res) => {
  const { usid } = req.body;

  if (!usid || usid.trim() === "") {
    return res.status(400).json({ error: "USID is required" });
  }

  const cleanUsid = usid.trim().toLowerCase().replace(/^0x/, "");
  const hashedCandidates = [...new Set([cleanUsid, hashUSID(cleanUsid)])];
  const userHashedUsid = req.user.hashedUsid;

  if (hashedCandidates.includes(userHashedUsid)) {
    return res
      .status(400)
      .json({ error: "You cannot add yourself as a contact" });
  }

  idDb.get(
    "SELECT name, hashed_usid FROM users_metadata WHERE hashed_usid IN (?, ?)",
    hashedCandidates,
    (err, row) => {
      if (err || !row) {
        return res
          .status(404)
          .json({ error: "USID not found in identity registry" });
      }

      const hashed = row.hashed_usid;

      db.get(
        "SELECT id FROM contacts WHERE user_id = ? AND contact_hashed_usid = ?",
        [req.user.userId, hashed],
        (err, existing) => {
          if (err) {
            return res.status(500).json({ error: "Database error" });
          }

          const addContactFresh = () => {
            db.run(
              "INSERT INTO contacts (user_id, contact_hashed_usid) VALUES (?, ?)",
              [req.user.userId, hashed],
              function (err) {
                if (err)
                  return res.status(500).json({ error: "Failed to add contact" });
                res.json({ message: "Contact added", name: row.name, usid: hashed });
              }
            );
          };

          if (existing) {
            db.run(
              "DELETE FROM contacts WHERE user_id = ? AND contact_hashed_usid = ?",
              [req.user.userId, hashed],
              addContactFresh
            );
          } else {
            addContactFresh();
          }
        }
      );
    }
<<<<<<< HEAD
=======
  });
});

// GET /keys/:hashedUsid — fetch a peer's public key bundle (and dispense one OPK if available)
app.get("/keys/:hashedUsid", (req, res) => {
  const rawParam = req.params.hashedUsid || "";
  const clean = rawParam.trim().toLowerCase().replace(/^0x/, "");
  const candidates = [...new Set([clean, hashUSID(clean)])];

  keyDb.get(
    "SELECT bundle, hashed_usid FROM key_bundles WHERE hashed_usid IN (?, ?)",
    candidates,
    (err, row) => {
      if (err || !row)
        return res.status(404).json({ error: "Key bundle not found" });
      try {
        const bundle = JSON.parse(row.bundle);
        let opk = null;
        if (Array.isArray(bundle.preKeys) && bundle.preKeys.length > 0) {
          opk = bundle.preKeys.shift();
          const now = Date.now();
          keyDb.run(
            "UPDATE key_bundles SET bundle = ?, updated_at = ? WHERE hashed_usid = ?",
            [JSON.stringify(bundle), now, row.hashed_usid],
            (updateErr) => {
              if (updateErr) console.error("[Keys] Failed to consume OPK:", updateErr);
            }
          );
        }
        res.json({ bundle, opk });
      } catch (e) {
        res.status(500).json({ error: "Failed to parse key bundle" });
      }
    },
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be
  );
});

// WebSocket setup
const wss = new WebSocket.Server({ server });
const clients = new Map(); // hashed_usid -> WebSocket

wss.on("connection", (ws, req) => {
  console.log("[WS] New connection");

<<<<<<< HEAD
  ws.on("message", (data) => {
=======
// Helper: Normalize identifier to 64-character canonical SHA-256 hashed USID
function resolveCanonicalUsid(targetUsid) {
  if (!targetUsid || typeof targetUsid !== "string") return "";
  const clean = targetUsid.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length === 64) return clean;
  return hashUSID(clean);
}

// Helper: Resilient lookup of active WebSocket connection by direct, normalized, or hashed USID
function resolveRecipientWs(targetUsid) {
  if (!targetUsid || typeof targetUsid !== "string") return null;
  const clean = targetUsid.trim().toLowerCase().replace(/^0x/, "");
  if (!clean) return null;

  // 1. Direct clean lookup
  let targetWs = clients.get(clean);
  if (targetWs && targetWs.readyState === WebSocket.OPEN) return targetWs;

  // 2. Hash lookup (in case sender routed via unhashed raw USID)
  const hashed = hashUSID(clean);
  targetWs = clients.get(hashed);
  if (targetWs && targetWs.readyState === WebSocket.OPEN) return targetWs;

  // 3. Scan active clients for case-insensitive / prefixed match
  for (const [key, clientSocket] of clients.entries()) {
    if (clientSocket && clientSocket.readyState === WebSocket.OPEN) {
      const cleanKey = key.trim().toLowerCase().replace(/^0x/, "");
      if (cleanKey === clean || cleanKey === hashed) {
        return clientSocket;
      }
    }
  }

  return null;
}

// Keep-Alive Heartbeat: send periodic WebSocket protocol ping to prevent cloud reverse proxy idle drop
const PING_INTERVAL_MS = 25000;
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[WS] Terminating inactive socket (heartbeat timeout)");
      return ws.terminate();
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      ws.terminate();
    }
  });
}, PING_INTERVAL_MS);

if (pingInterval.unref) pingInterval.unref();

wss.on("connection", (ws) => {
  let userHashedUsid = null;
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  console.log("[WS] New raw connection established");

  ws.on("message", (message) => {
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be
    try {
      const msg = JSON.parse(data);

<<<<<<< HEAD
      if (msg.type === "register" && msg.usid) {
        const userHashedUsid = msg.usid;
        clients.set(userHashedUsid, ws);
        ws.userHashedUsid = userHashedUsid;
        console.log(`[WS] Registered: ${userHashedUsid.substring(0, 8)}...`);

        // Deliver any queued offline messages
        db.all(
          "SELECT * FROM mailbox WHERE recipient_hashed_usid = ? ORDER BY timestamp ASC",
          [userHashedUsid],
          (err, rows) => {
            if (err || !rows || rows.length === 0) return;
            rows.forEach((row) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "message",
                    from: row.sender_hashed_usid,
                    payload: row.content,
                  })
                );
                db.run("DELETE FROM mailbox WHERE id = ?", [row.id]);
              }
            });
            console.log(`[WS] Delivered ${rows.length} queued message(s) to ${userHashedUsid.substring(0, 8)}...`);
          }
        );

      } else if (msg.type === "message" && msg.to && (msg.payload || msg.content)) {
        const userHashedUsid = ws.userHashedUsid || null;
        const to = msg.to;
        const encrypted = msg.payload || null;
=======
      // Application-level keepalive heartbeat
      if (data.type === "ping") {
        ws.isAlive = true;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        }
        return;
      }
      if (data.type === "pong") {
        ws.isAlive = true;
        return;
      }

      if (data.type === "register") {
        const { token } = data;
        if (!token) {
          console.log("[WS] Registration REJECTED: Missing authentication token");
          ws.send(JSON.stringify({ type: "error", message: "Authentication token required" }));
          return;
        }

        jwt.verify(token, JWT_SECRET, (jwtErr, decoded) => {
          if (jwtErr || !decoded || !decoded.hashedUsid) {
            console.log("[WS] Registration REJECTED: Invalid or expired JWT token");
            ws.send(JSON.stringify({ type: "error", message: "Authentication failed: invalid token" }));
            return;
          }

          const tokenHashedUsid = decoded.hashedUsid;

          // Helper that completes registration once JWT is verified
          function finaliseRegistration(row, canonicalHashedUsid) {
            userHashedUsid = canonicalHashedUsid;

            // Gracefully supersede any existing connection for this identity to prevent split-brain
            const prevWs = clients.get(userHashedUsid);
            if (prevWs && prevWs !== ws && prevWs.readyState === WebSocket.OPEN) {
              try { prevWs.close(1000, "Superseded by new session"); } catch (_) {}
            }

            clients.set(userHashedUsid, ws);
            console.log(`[WS] User Registered: ${row.name} (${userHashedUsid.substring(0, 8)}...)`);

            const registeredMsg = { type: "registered", success: true };
            ws.send(JSON.stringify(registeredMsg));

            // ── Offline Mailbox Flush (T-14: with TTL expiry) ──────────
            const MAILBOX_TTL_DAYS = 7;
            db.all(
              "SELECT * FROM mailbox WHERE recipient_hashed_usid = ? AND timestamp >= datetime('now', '-7 days') ORDER BY timestamp ASC",
              [canonicalHashedUsid],
              (mbErr, pending) => {
                if (mbErr || !pending || pending.length === 0) return;
                console.log(`[Mailbox] Flushing ${pending.length} queued message(s) to ${canonicalHashedUsid.substring(0, 8)}...`);
                pending.forEach((m) => {
                  let parsed = null;
                  try { parsed = JSON.parse(m.content); } catch (e) { }
                  if (parsed && parsed.type === "x3dh_init") {
                    ws.send(JSON.stringify({
                      ...parsed,
                      from: m.sender_hashed_usid,
                    }));
                  } else {
                    ws.send(JSON.stringify({
                      type: "message",
                      from: m.sender_hashed_usid,
                      encrypted: parsed !== null ? parsed : m.content,
                      timestamp: m.timestamp,
                    }));
                  }
                });
                db.run(
                  "DELETE FROM mailbox WHERE recipient_hashed_usid = ?",
                  [canonicalHashedUsid],
                  (delErr) => {
                    if (delErr) console.error("[Mailbox] Failed to purge mailbox:", delErr);
                    else console.log(`[Mailbox] Purged ${pending.length} message(s) for ${canonicalHashedUsid.substring(0, 8)}...`);
                  }
                );
              }
            );

            // Clean expired mailbox messages beyond TTL
            db.run("DELETE FROM mailbox WHERE timestamp < datetime('now', '-7 days')");
            // ──────────────────────────────────────────────────────────
          }

          idDb.get(
            "SELECT name, hashed_usid FROM users_metadata WHERE hashed_usid = ?",
            [tokenHashedUsid],
            (dbErr, row) => {
              if (!dbErr && row) {
                return finaliseRegistration(row, row.hashed_usid);
              }

              console.log(`[WS] Registration REJECTED: ${tokenHashedUsid.substring(0, 8)}... (Not in Identity DB)`);
              ws.send(JSON.stringify({ type: "error", message: "Identity not verified" }));
            }
          );
        });
        return;
      }

      if (data.type === "message") {
        const { to, content, encrypted } = data;
        if (!userHashedUsid || !to) return;

        // Plaintext content is strictly rejected on the relay (T-08 / E2EE enforcement)
        if (content !== undefined && content !== null) {
          ws.send(JSON.stringify({ type: "error", message: "Plaintext content is not permitted" }));
          return;
        }

        if (!encrypted) {
          ws.send(JSON.stringify({ type: "error", message: "Only encrypted messages are permitted" }));
          return;
        }

        const canonicalTo = resolveCanonicalUsid(to);
        if (canonicalTo === userHashedUsid) return; // Prevent self-loopback
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be

        console.log(
          `[WS] Message: ${userHashedUsid ? userHashedUsid.substring(0, 8) : "?"}... → ${to ? to.substring(0, 8) : "?"}...`
        );

        const recipientWs = clients.get(to) && clients.get(to).readyState === WebSocket.OPEN
          ? clients.get(to)
          : resolveRecipientWs(to);

        if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
          recipientWs.send(
<<<<<<< HEAD
            JSON.stringify({ type: "message", from: userHashedUsid, payload: encrypted || msg.content })
=======
            JSON.stringify({
              type: "message",
              from: userHashedUsid,
              encrypted: encrypted,
              timestamp: new Date().toISOString(),
            }),
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be
          );
        } else {
<<<<<<< HEAD
          // Recipient is offline — queue in mailbox (encrypted blobs only)
          if (!encrypted) {
            console.log("[WS] Only encrypted messages are queued for offline delivery");
            return;
          }
          db.run(
            "INSERT INTO mailbox (recipient_hashed_usid, sender_hashed_usid, content) VALUES (?, ?, ?)",
            [to, userHashedUsid, encrypted],
            (err) => {
              if (err) {
                console.error("[WS] Mailbox insert error:", err.message);
              } else {
                console.log(`[WS] Queued message for offline recipient ${to.substring(0, 8)}...`);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "queued" }));
                }
              }
=======
          // Offline mailbox — enforce per-recipient cap and TTL (T-14)
          const MAILBOX_CAP = parseInt(process.env.MAILBOX_CAP || "200", 10);

          // Clean expired messages
          db.run("DELETE FROM mailbox WHERE timestamp < datetime('now', '-7 days')");

          // Check recipient mailbox capacity
          db.get(
            "SELECT COUNT(*) AS count FROM mailbox WHERE recipient_hashed_usid = ?",
            [canonicalTo],
            (countErr, countRow) => {
              if (countErr) {
                ws.send(JSON.stringify({ type: "error", message: "Mailbox store check failed" }));
                return;
              }

              if (countRow && countRow.count >= MAILBOX_CAP) {
                console.log(`[Mailbox] Cap exceeded for recipient ${canonicalTo.substring(0, 8)} (${countRow.count}/${MAILBOX_CAP})`);
                ws.send(JSON.stringify({ type: "error", message: "Recipient mailbox is full (cap reached)" }));
                return;
              }

              const storeContent = typeof encrypted === 'string' ? encrypted : JSON.stringify(encrypted);
              db.run(
                "INSERT INTO mailbox (recipient_hashed_usid, sender_hashed_usid, content) VALUES (?, ?, ?)",
                [canonicalTo, userHashedUsid, storeContent],
                (mbErr) => {
                  if (mbErr) {
                    ws.send(
                      JSON.stringify({
                        type: "error",
                        message: "Mailbox store failed",
                      }),
                    );
                  } else {
                    ws.send(
                      JSON.stringify({
                        type: "queued",
                        recipient: to,
                        message: "Recipient offline — message queued",
                      }),
                    );
                  }
                },
              );
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be
            }
          );
        }

<<<<<<< HEAD
      } else if (msg.type === "broadcast") {
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({ type: "broadcast", from: ws.userHashedUsid, payload: msg.payload })
            );
          }
=======
      // X3DH handshake relay — forward to recipient so they can set up E2EE
      if (data.type === "x3dh_init") {
        const { to } = data;
        if (!userHashedUsid || !to) return;
        const recipientWs = clients.get(to) && clients.get(to).readyState === WebSocket.OPEN
          ? clients.get(to)
          : resolveRecipientWs(to);
        if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
          recipientWs.send(JSON.stringify({ ...data, from: userHashedUsid }));
          console.log(
            `[WS] X3DH init relayed: ${userHashedUsid.substring(0, 8)} → ${to.substring(0, 8)}`,
          );
        } else {
          // Recipient offline — queue x3dh_init in mailbox so peer can establish session upon reconnecting
          const canonicalTo = resolveCanonicalUsid(to);
          const storeContent = JSON.stringify({ ...data, from: userHashedUsid });
          db.run(
            "INSERT INTO mailbox (recipient_hashed_usid, sender_hashed_usid, content) VALUES (?, ?, ?)",
            [canonicalTo, userHashedUsid, storeContent],
            (mbErr) => {
              if (mbErr) console.error("[Mailbox] Failed to queue x3dh_init:", mbErr);
              else console.log(`[Mailbox] Queued x3dh_init for offline recipient ${canonicalTo.substring(0, 8)}`);
            }
          );
        }
      }

      if (data.type === "emergency_broadcast") {
        if (!userHashedUsid) {
          ws.send(JSON.stringify({ type: "error", message: "Not registered — cannot send emergency" }));
          return;
        }

        // --- WS→UDP rate limit: 1 emergency per 60s per user ---
        if (!wsEmergencyLimiter.allow(userHashedUsid)) {
          console.warn(`[WS->UDP] RATE-LIMITED emergency from ${userHashedUsid.substring(0, 8)}`);
          ws.send(JSON.stringify({ type: "error", message: "Emergency cooldown active — please wait before sending another" }));
          return;
        }

        // Sanitize content
        const emergencyContent = data.content && typeof data.content === "string"
          ? data.content.substring(0, UDP_MAX_CONTENT_LEN)
          : "EMERGENCY: Immediate assistance required!";

        console.log(
          `[WS->UDP] Emergency from ${userHashedUsid.substring(0, 8)}`,
        );
        const udpMessage = Buffer.from(
          JSON.stringify({
            content: emergencyContent,
            from: userHashedUsid,
            token: "INTERNAL_UDP_SECRET"
          }),
        );
        udpServer.send(udpMessage, UDP_PORT, "localhost", (err) => {
          if (err) console.error("[UDP] Bridge Error:", err);
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be
        });
      }
    } catch (e) {
      console.error("[WS] Parse error:", e.message);
    }
  });

  ws.on("close", () => {
<<<<<<< HEAD
    if (ws.userHashedUsid) {
      clients.delete(ws.userHashedUsid);
      console.log(`[WS] Disconnected: ${ws.userHashedUsid.substring(0, 8)}...`);
=======
    if (userHashedUsid) {
      if (clients.get(userHashedUsid) === ws) {
        clients.delete(userHashedUsid);
        console.log(
          `[WS] User Disconnected: ${userHashedUsid.substring(0, 8)}...`,
        );
      } else {
        console.log(
          `[WS] Stale socket closed for: ${userHashedUsid.substring(0, 8)}... (active socket retained)`,
        );
      }
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be
    }
  });
});

// Fallback: serve index.html for any non-API route (SPA support)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Halonyx] Server running on http://localhost:${PORT}`);
  console.log(`[Halonyx] Frontend served from ./frontend/`);
});
<<<<<<< HEAD
=======

udpServer.bind(UDP_PORT, "127.0.0.1");

// Disable all caching — must come BEFORE static middleware so browsers
// never serve stale JS/protocol files from cache.
app.use((req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// Serve protocol/ files at /protocol/*
app.use(
  "/protocol",
  express.static(path.join(__dirname, "..", "protocol"), { etag: false, lastModified: false }),
);

// Serve assets/ files at /assets/*
app.use(
  "/assets",
  express.static(path.join(__dirname, "..", "assets"), { etag: false, lastModified: false }),
);

app.use(express.static(path.join(__dirname, "..", "frontend"), { etag: false, lastModified: false }));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
>>>>>>> f360971d66e428dedbb99f038f3b53890c11e7be
