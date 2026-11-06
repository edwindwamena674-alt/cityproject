const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = path.join(__dirname, "citymega.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log("Connected to SQLite database.");
  }
});

app.use(express.json());
app.use(express.static(__dirname));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      balance REAL NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      from_name TEXT NOT NULL,
      to_line TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      note TEXT,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
    if (err) return;

    if (row.count === 0) {
      const seedUsers = [
        ["Admin User", "admin@city.com", "1234", "admin", 0],
        ["Edwin Mensah", "edwin@city.com", "1234", "user", 2500],
        ["Cecelia Owusu", "cecelia@city.com", "1234", "user", 1800]
      ];

      const insertUser = db.prepare(`
        INSERT INTO users (name, email, password, role, balance)
        VALUES (?, ?, ?, ?, ?)
      `);

      seedUsers.forEach(([name, email, password, role, balance]) => {
        insertUser.run(name, email, password, role, balance);
      });

      insertUser.finalize();
    }
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "CITY MEGA CHURCH API is running" });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required." });
  }

  db.get(
    "SELECT * FROM users WHERE email = ? AND password = ?",
    [email.trim().toLowerCase(), password],
    (err, user) => {
      if (err) {
        return res.status(500).json({ success: false, message: "Could not log in." });
      }

      if (!user) {
        return res.status(401).json({ success: false, message: "Invalid email or password." });
      }

      const safeUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        balance: user.balance
      };

      return res.json({ success: true, user: safeUser });
    }
  );
});

app.post("/api/register", (req, res) => {
  const { name, email, password, role } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanRole = role === "admin" ? "admin" : "user";

  db.get("SELECT id FROM users WHERE email = ?", [cleanEmail], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Could not register account." });
    }

    if (row) {
      return res.status(409).json({ success: false, message: "Email already exists." });
    }

    db.run(
      "INSERT INTO users (name, email, password, role, balance) VALUES (?, ?, ?, ?, ?)",
      [name.trim(), cleanEmail, password, cleanRole, cleanRole === "admin" ? 0 : 1000],
      function (insertErr) {
        if (insertErr) {
          return res.status(500).json({ success: false, message: "Registration failed." });
        }

        const newUser = {
          id: this.lastID,
          name: name.trim(),
          email: cleanEmail,
          role: cleanRole,
          balance: cleanRole === "admin" ? 0 : 1000
        };

        return res.status(201).json({ success: true, user: newUser });
      }
    );
  });
});

app.get("/api/users", (req, res) => {
  db.all("SELECT * FROM users ORDER BY id ASC", (err, users) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Could not fetch users." });
    }

    return res.json(users);
  });
});

app.get("/api/transactions", (req, res) => {
  const { userId } = req.query;

  let query = `
    SELECT t.*, u.name as user_name
    FROM transactions t
    LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.id DESC
  `;

  let params = [];

  if (userId) {
    query = `
      SELECT t.*, u.name as user_name
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
      WHERE t.user_id = ?
      ORDER BY t.id DESC
    `;
    params = [userId];
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Could not fetch transactions." });
    }

    return res.json(rows.map((tx) => ({
      id: tx.id,
      email: tx.user_name ? tx.user_name : null,
      user_id: tx.user_id,
      from: tx.from_name,
      to: tx.to_line,
      amount: Number(tx.amount),
      reason: tx.reason,
      note: tx.note || "",
      method: tx.method,
      status: tx.status,
      date: tx.created_at,
      fixedLine: tx.to_line,
      user_name: tx.user_name
    })));
  });
});

app.post("/api/payments", (req, res) => {
  const { userId, amount, reason, method, note } = req.body || {};

  if (!userId || !amount || !reason || !method) {
    return res.status(400).json({ success: false, message: "Missing payment fields." });
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ success: false, message: "Amount must be greater than zero." });
  }

  db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Could not load user." });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (user.role === "admin") {
      return res.status(403).json({ success: false, message: "Admin cannot make payments." });
    }

    if (numericAmount > user.balance) {
      const failedTx = {
        user_id: user.id,
        from_name: user.name,
        to_line: "0594531070",
        amount: numericAmount,
        reason,
        note: note || reason,
        method,
        status: "Failed",
        created_at: new Date().toLocaleString()
      };

      db.run(
        `INSERT INTO transactions (user_id, from_name, to_line, amount, reason, note, method, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          failedTx.user_id,
          failedTx.from_name,
          failedTx.to_line,
          failedTx.amount,
          failedTx.reason,
          failedTx.note,
          failedTx.method,
          failedTx.status,
          failedTx.created_at
        ],
        function (insertErr) {
          if (insertErr) {
            return res.status(500).json({ success: false, message: "Payment failed to record." });
          }

          return res.status(200).json({
            success: false,
            message: "Insufficient funds.",
            transaction: {
              ...failedTx,
              id: this.lastID
            }
          });
        }
      );

      return;
    }

    const updatedBalance = user.balance - numericAmount;

    db.run(
      "UPDATE users SET balance = ? WHERE id = ?",
      [updatedBalance, user.id],
      (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ success: false, message: "Could not update balance." });
        }

        const tx = {
          user_id: user.id,
          from_name: user.name,
          to_line: "0594531070",
          amount: numericAmount,
          reason,
          note: note || reason,
          method,
          status: "Successful",
          created_at: new Date().toLocaleString()
        };

        db.run(
          `INSERT INTO transactions (user_id, from_name, to_line, amount, reason, note, method, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tx.user_id,
            tx.from_name,
            tx.to_line,
            tx.amount,
            tx.reason,
            tx.note,
            tx.method,
            tx.status,
            tx.created_at
          ],
          function (insertErr) {
            if (insertErr) {
              return res.status(500).json({ success: false, message: "Could not save transaction." });
            }

            return res.status(201).json({
              success: true,
              message: "Payment successful.",
              transaction: {
                ...tx,
                id: this.lastID
              },
              user: {
                ...user,
                balance: updatedBalance
              }
            });
          }
        );
      }
    );
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`CITY MEGA CHURCH app running on http://localhost:${PORT}`);
});