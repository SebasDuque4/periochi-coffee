const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'periochi.db');
const db = new Database(DB_PATH);
const JWT_SECRET = process.env.JWT_SECRET || 'periochi-tierra-2026';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'periochi-admin-setup';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
//  SCHEMA
// ──────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    email      TEXT    UNIQUE NOT NULL,
    password   TEXT    NOT NULL,
    points     INTEGER DEFAULT 0,
    is_admin   INTEGER DEFAULT 0,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    slug            TEXT    UNIQUE NOT NULL,
    description     TEXT,
    long_desc       TEXT,
    price           INTEGER NOT NULL,
    points_per_unit INTEGER DEFAULT 0,
    category        TEXT    DEFAULT 'cafe',
    weight_g        INTEGER,
    tasting_notes   TEXT,
    available       INTEGER DEFAULT 1,
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    total         INTEGER NOT NULL,
    subtotal      INTEGER NOT NULL,
    points_earned INTEGER DEFAULT 0,
    points_used   INTEGER DEFAULT 0,
    discount      INTEGER DEFAULT 0,
    status        TEXT    DEFAULT 'pendiente',
    address       TEXT,
    city          TEXT,
    phone         TEXT,
    notes         TEXT,
    created_at    TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL,
    product_id   INTEGER NOT NULL,
    product_name TEXT    NOT NULL,
    quantity     INTEGER NOT NULL,
    unit_price   INTEGER NOT NULL,
    points_each  INTEGER DEFAULT 0,
    FOREIGN KEY(order_id)   REFERENCES orders(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS points_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    delta        INTEGER NOT NULL,
    balance_after INTEGER,
    reason       TEXT,
    ref_order_id INTEGER,
    created_at   TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ──────────────────────────────────────────────
//  SEED CONFIG & PRODUCTS
// ──────────────────────────────────────────────
const upsertCfg = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
upsertCfg.run('points_per_unit_label', 'Puntos por producto');
upsertCfg.run('points_redeem_value',   '100');  // 100 puntos = $1.000 COP de descuento
upsertCfg.run('welcome_points',        '50');   // puntos de bienvenida al registrarse
upsertCfg.run('program_name',          'Puntos Periochi');

if (db.prepare('SELECT COUNT(*) as c FROM products').get().c === 0) {
  const ins = db.prepare(`
    INSERT INTO products (name, slug, description, long_desc, price, points_per_unit, weight_g, tasting_notes, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  ins.run('Tradición', 'tradicion',
    'Notas dulces, cuerpo balanceado y aroma floral.',
    'Nuestro café de entrada al origen. Cultivado en las faldas del Macizo Colombiano, este café narra la historia de las familias caficultoras que llevan generaciones en la tierra.',
    28000, 50, 250, 'Durazno · Panela · Flores blancas', 'cafe');
  ins.run('Reserva', 'reserva',
    'Notas a chocolate, caramelo y frutos secos.',
    'Selección especial de los mejores lotes de la cosecha. Procesado en miel para realzar su dulzor natural, con un perfil que conquista desde el primer sorbo.',
    38000, 80, 250, 'Chocolate oscuro · Caramelo · Avellana', 'cafe');
  ins.run('Especial', 'especial',
    'Notas frutales, acidez vibrante y final prolongado.',
    'La cumbre de nuestra selección. Granos de microlotes de altura, procesado natural, para quienes buscan lo extraordinario en cada taza.',
    48000, 120, 250, 'Frutos rojos · Maracuyá · Té negro', 'cafe');
  ins.run('Origen 500g', 'origen-500',
    'Mezcla insignia en formato familiar.',
    'El sabor auténtico de nuestras montañas en el formato perfecto para la familia. La mezcla que resume todo lo que somos.',
    52000, 100, 500, 'Panela · Cacao · Almendra', 'cafe');
  ins.run('Gift Box Periochi', 'gift-box',
    'Los 3 cafés Periochi en una caja especial.',
    'La experiencia completa de Periochi en una caja diseñada para sorprender. Incluye Tradición, Reserva y Especial con una tarjeta de origen firmada.',
    95000, 200, 750, 'Los tres perfiles reunidos', 'gift');
}

// ──────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────
function getCfg(key) {
  const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return r ? r.value : null;
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida' });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Solo administradores' });
    next();
  });
}

function addPoints(userId, delta, reason, orderId = null) {
  db.prepare('UPDATE users SET points = MAX(0, points + ?) WHERE id = ?').run(delta, userId);
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  db.prepare('INSERT INTO points_log (user_id, delta, balance_after, reason, ref_order_id) VALUES (?, ?, ?, ?, ?)')
    .run(userId, delta, user.points, reason, orderId);
}

// ──────────────────────────────────────────────
//  AUTH
// ──────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password)
    return res.status(400).json({ error: 'Nombre, correo y contraseña son requeridos' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name.trim(), email.trim().toLowerCase(), hash);

    const welcomePts = parseInt(getCfg('welcome_points') || '0');
    if (welcomePts > 0) addPoints(r.lastInsertRowid, welcomePts, '¡Bienvenido a Periochi!');

    const user = db.prepare('SELECT id, name, email, points, is_admin FROM users WHERE id = ?').get(r.lastInsertRowid);
    const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '14d' });
    res.json({ user, token });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Este correo ya está registrado' });
    console.error(e);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });

  const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '14d' });
  const { password: _, ...safe } = user;
  res.json({ user: safe, token });
});

// ──────────────────────────────────────────────
//  PRODUCTS (public)
// ──────────────────────────────────────────────
app.get('/api/products', (_, res) => {
  res.json(db.prepare('SELECT * FROM products WHERE available = 1 ORDER BY id').all());
});

app.get('/api/products/:slug', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE slug = ? AND available = 1').get(req.params.slug);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(p);
});

// ──────────────────────────────────────────────
//  ORDERS
// ──────────────────────────────────────────────
app.post('/api/orders', auth, (req, res) => {
  const { items, address, city, phone, notes, usePoints } = req.body || {};
  if (!items?.length) return res.status(400).json({ error: 'El carrito está vacío' });
  if (!address?.trim()) return res.status(400).json({ error: 'La dirección es requerida' });

  let subtotal = 0;
  const enriched = [];
  for (const item of items) {
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND available = 1').get(item.productId);
    if (!p) return res.status(400).json({ error: `Producto no disponible` });
    subtotal += p.price * item.quantity;
    enriched.push({ ...item, product: p });
  }

  const totalPointsEarned = enriched.reduce((s, i) => s + i.product.points_per_unit * i.quantity, 0);

  const redeemValue = parseInt(getCfg('points_redeem_value') || '100');
  let pointsUsed = 0;
  let discount = 0;

  if (usePoints) {
    const { points } = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    pointsUsed = Math.min(points, Math.ceil(subtotal / 1000) * redeemValue);
    discount = Math.floor(pointsUsed / redeemValue) * 1000;
    discount = Math.min(discount, subtotal);
    pointsUsed = Math.ceil(discount / 1000) * redeemValue;
  }

  const total = subtotal - discount;

  const tx = db.transaction(() => {
    const ord = db.prepare(`
      INSERT INTO orders (user_id, total, subtotal, points_earned, points_used, discount, address, city, phone, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, total, subtotal, totalPointsEarned, pointsUsed, discount, address, city || '', phone || '', notes || '');

    const oid = ord.lastInsertRowid;

    for (const i of enriched) {
      db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, points_each)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(oid, i.productId, i.product.name, i.quantity, i.product.price, i.product.points_per_unit);
    }

    if (totalPointsEarned > 0) addPoints(req.user.id, totalPointsEarned, `Compra #${oid}`, oid);
    if (pointsUsed > 0) addPoints(req.user.id, -pointsUsed, `Redención en compra #${oid}`, oid);

    return oid;
  });

  const orderId = tx();
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);

  res.json({ orderId, total, subtotal, discount, pointsEarned: totalPointsEarned, pointsUsed, newBalance: user.points });
});

// ──────────────────────────────────────────────
//  ACCOUNT
// ──────────────────────────────────────────────
app.get('/api/account/me', auth, (req, res) => {
  const u = db.prepare('SELECT id, name, email, points, is_admin, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(u);
});

app.get('/api/account/orders', auth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*,
      (SELECT json_group_array(json_object(
        'name', oi.product_name, 'qty', oi.quantity,
        'price', oi.unit_price, 'pts', oi.points_each
      )) FROM order_items oi WHERE oi.order_id = o.id) as items_json
    FROM orders o WHERE o.user_id = ?
    ORDER BY o.created_at DESC
  `).all(req.user.id);
  res.json(orders.map(o => ({ ...o, items: JSON.parse(o.items_json || '[]'), items_json: undefined })));
});

app.get('/api/account/points', auth, (req, res) => {
  const logs = db.prepare(`
    SELECT * FROM points_log WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 30
  `).all(req.user.id);
  const { points } = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
  res.json({ balance: points, history: logs });
});

// ──────────────────────────────────────────────
//  ADMIN
// ──────────────────────────────────────────────
app.post('/api/admin/setup', (req, res) => {
  const { name, email, password, secret } = req.body || {};
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Clave incorrecta' });
  if (db.prepare('SELECT id FROM users WHERE is_admin = 1').get())
    return res.status(400).json({ error: 'Ya existe un administrador' });

  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare('INSERT INTO users (name, email, password, is_admin) VALUES (?, ?, ?, 1)').run(name, email.toLowerCase(), hash);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.get('/api/admin/stats', adminAuth, (_, res) => {
  const users   = db.prepare("SELECT COUNT(*) c FROM users WHERE is_admin = 0").get().c;
  const orders  = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev, COALESCE(SUM(points_earned),0) pts FROM orders").get();
  const products= db.prepare("SELECT COUNT(*) c FROM products WHERE available = 1").get().c;
  res.json({ users, orders: orders.c, revenue: orders.rev, pointsIssued: orders.pts, products });
});

app.get('/api/admin/users', adminAuth, (_, res) => {
  res.json(db.prepare('SELECT id, name, email, points, is_admin, created_at FROM users ORDER BY created_at DESC').all());
});

app.put('/api/admin/users/:id/points', adminAuth, (req, res) => {
  const { delta, reason } = req.body || {};
  if (typeof delta !== 'number') return res.status(400).json({ error: 'delta requerido (número)' });
  addPoints(parseInt(req.params.id), delta, reason || 'Ajuste manual por administrador');
  const u = db.prepare('SELECT id, name, email, points FROM users WHERE id = ?').get(req.params.id);
  res.json(u);
});

app.get('/api/admin/products', adminAuth, (_, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY id').all());
});

app.post('/api/admin/products', adminAuth, (req, res) => {
  const { name, slug, description, long_desc, price, points_per_unit, weight_g, tasting_notes, category } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio requeridos' });
  const s = slug || name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-');
  const r = db.prepare(`
    INSERT INTO products (name, slug, description, long_desc, price, points_per_unit, weight_g, tasting_notes, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, s, description, long_desc, price, points_per_unit || 0, weight_g || null, tasting_notes || '', category || 'cafe');
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/admin/products/:id', adminAuth, (req, res) => {
  const { name, description, long_desc, price, points_per_unit, weight_g, tasting_notes, available, category } = req.body || {};
  db.prepare(`
    UPDATE products SET name=?, description=?, long_desc=?, price=?, points_per_unit=?,
    weight_g=?, tasting_notes=?, available=?, category=? WHERE id=?
  `).run(name, description, long_desc, price, points_per_unit, weight_g, tasting_notes, available ? 1 : 0, category, req.params.id);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

app.get('/api/admin/orders', adminAuth, (_, res) => {
  res.json(db.prepare(`
    SELECT o.*, u.name user_name, u.email user_email
    FROM orders o JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC LIMIT 200
  `).all());
});

app.put('/api/admin/orders/:id/status', adminAuth, (req, res) => {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/config', adminAuth, (_, res) => {
  const rows = db.prepare('SELECT * FROM config').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.put('/api/admin/config', adminAuth, (req, res) => {
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(updates)) stmt.run(k, String(v));
  res.json({ ok: true });
});

// ──────────────────────────────────────────────
//  START
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n☕ Periochi server → http://localhost:${PORT}`);
  console.log(`   Admin setup → POST /api/admin/setup (secret: ${ADMIN_SECRET})\n`);
});
