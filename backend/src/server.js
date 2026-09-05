import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
const app = express();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://cafe:cafe_password@localhost:5432/cafe_pos',
});

const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error('JWT_SECRET environment variable is required');
}

const port = process.env.PORT || 4000;

// PB1 (pajak restoran) — 10% of subtotal, added on top for the
// grand total. Rounded to the nearest rupiah.
const TAX_RATE = 0.1;

// Atomic per-day sequence for the printed receipt number
// (IDC + YYYYMMDD + 4-digit counter) — a single UPSERT means two
// tills creating orders at the same instant can never collide.
async function nextOrderNo(client) {
  const { rows } = await client.query(
    `
      INSERT INTO order_sequences (seq_date, counter)
      VALUES (CURRENT_DATE, 1)
      ON CONFLICT (seq_date) DO UPDATE SET counter = order_sequences.counter + 1
      RETURNING counter, seq_date::text AS seq_date
    `
  );

  const { counter, seq_date: seqDate } = rows[0];
  const compact = seqDate.replace(/-/g, '');

  return `IDC${compact}${String(counter).padStart(4, '0')}`;
}

// ============================================================
// Middleware
// ============================================================

app.use(cors());
app.use(express.json());

// ============================================================
// Helpers
// ============================================================

const auth = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.replace('Bearer ', '').trim();

    req.user = jwt.verify(token, secret);

    next();
  } catch {
    res.status(401).json({
      error: 'Unauthorized',
    });
  }
};

const allow = (...roles) => (req, res, next) => {
  if (roles.includes(req.user.role)) {
    return next();
  }

  return res.status(403).json({
    error: 'Forbidden',
  });
};

async function q(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

// ============================================================
// PIN Hashing (scrypt, salted — never plaintext, never compared
// with ===)
// ============================================================

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;

  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const candidate = crypto.scryptSync(String(pin), salt, expected.length);

  return (
    candidate.length === expected.length &&
    crypto.timingSafeEqual(candidate, expected)
  );
}

// ============================================================
// Business Accounts (bookkeeping dimension, not login users)
// ============================================================

// A user belongs to exactly ONE business account, fixed at creation
// by ADMIN — never a client-provided or JWT-derived value. Throws if
// the user has no account (should never happen for CASHIER/
// HEAD_CASHIER/ADMIN once created via the Admin user-management UI).
async function resolveAccountId(userId, client = pool) {
  const result = await client.query(
    'SELECT account_id FROM users WHERE id = $1',
    [userId]
  );

  const accountId = result.rows[0]?.account_id;

  if (!accountId) {
    throw new Error('User tidak memiliki akun bisnis yang ditetapkan');
  }

  return accountId;
}

// ============================================================
// Health Check
// ============================================================

app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
  });
});

// ============================================================
// Authentication
// ============================================================

app.post('/api/auth/login', async (req, res) => {
  const { username, pin } = req.body;

  const users = await q(
    `
      SELECT
        u.id,
        u.username,
        u.pin_hash,
        u.display_name,
        u.role,
        u.is_active,
        a.code AS account_code,
        a.name AS account_name
      FROM users u
      LEFT JOIN accounts a ON a.id = u.account_id
      WHERE u.username = $1
    `,
    [username]
  );

  const user = users[0];

  if (!user || !user.is_active || !verifyPin(pin, user.pin_hash)) {
    return res.status(401).json({
      error: 'Invalid credentials',
    });
  }

  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      name: user.display_name,
      role: user.role,
    },
    secret,
    {
      expiresIn: '12h',
    }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.display_name,
      role: user.role,
      accountCode: user.account_code,
      accountName: user.account_name,
    },
  });
});

// Always resolved fresh from the database (role, active status,
// account) — never trusts the JWT payload beyond identifying who's
// asking, since an ADMIN could deactivate/reassign mid-session.
app.get('/api/me', auth, async (req, res) => {
  const rows = await q(
    `
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.role,
        u.is_active,
        a.code AS account_code,
        a.name AS account_name
      FROM users u
      LEFT JOIN accounts a ON a.id = u.account_id
      WHERE u.id = $1
    `,
    [req.user.id]
  );

  const user = rows[0];

  if (!user || !user.is_active) {
    return res.status(401).json({
      error: 'Unauthorized',
    });
  }

  res.json({
    id: user.id,
    username: user.username,
    name: user.display_name,
    role: user.role,
    accountCode: user.account_code,
    accountName: user.account_name,
  });
});

// ============================================================
// Menus
// ============================================================

app.get('/api/menus', auth, async (req, res) => {
  const rows = await q(`
    SELECT
      m.*,

      CASE
        WHEN m.pos_out_of_stock THEN 0
        ELSE m.pos_stock_qty
      END AS available_qty

    FROM menus m

    WHERE m.active = true

    ORDER BY m.id
  `);

  res.json(rows);
});

// ============================================================
// Menu Management (ADMIN only — add new items, edit name/price/
// category/station/active). Separate from POS Stock below, which
// HEAD_CASHIER can also touch but only for quantity/out-of-stock.
// ============================================================

// KASIR: items needing no Bar/Kitchen prep at all (e.g. bottled
// drinks) — never appears in either station's ticket queue.
const VALID_STATIONS = ['BAR', 'KITCHEN', 'KASIR'];

// All menus regardless of active status — the Cashier-facing
// GET /api/menus above only ever returns active ones.
app.get('/api/admin/menus', auth, allow('ADMIN'), async (_, res) => {
  const rows = await q(`SELECT * FROM menus ORDER BY id`);
  res.json(rows);
});

app.post('/api/menus', auth, allow('ADMIN'), async (req, res) => {
  const { name, category, price, station } = req.body;
  const priceNum = Number(price);

  if (!name?.trim() || !category?.trim() || !VALID_STATIONS.includes(station)) {
    return res.status(400).json({ error: 'Field wajib belum lengkap' });
  }

  if (!Number.isFinite(priceNum) || priceNum < 0) {
    return res.status(400).json({ error: 'Harga harus berupa angka >= 0' });
  }

  try {
    const rows = await q(
      `
        INSERT INTO menus (name, category, price, station)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [name.trim(), category.trim(), priceNum, station]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Nama menu sudah dipakai' });
    }

    res.status(400).json({ error: error.message });
  }
});

app.put('/api/menus/:id', auth, allow('ADMIN'), async (req, res) => {
  const { name, category, price, station, active } = req.body;
  const priceNum = Number(price);

  if (!name?.trim() || !category?.trim() || !VALID_STATIONS.includes(station)) {
    return res.status(400).json({ error: 'Field wajib belum lengkap' });
  }

  if (!Number.isFinite(priceNum) || priceNum < 0) {
    return res.status(400).json({ error: 'Harga harus berupa angka >= 0' });
  }

  try {
    const rows = await q(
      `
        UPDATE menus
        SET name = $1, category = $2, price = $3, station = $4, active = $5
        WHERE id = $6
        RETURNING *
      `,
      [name.trim(), category.trim(), priceNum, station, Boolean(active), req.params.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Menu tidak ditemukan' });
    }

    res.json(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Nama menu sudah dipakai' });
    }

    res.status(400).json({ error: error.message });
  }
});

// ============================================================
// POS Stock (manual, independent from warehouse inventory)
// ============================================================

app.put(
  '/api/menus/:id/pos-stock',
  auth,
  allow('HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const { pos_stock_qty, pos_out_of_stock } = req.body;

    if (pos_stock_qty !== undefined) {
      const qty = Number(pos_stock_qty);

      if (!Number.isFinite(qty) || qty < 0) {
        return res.status(400).json({
          error: 'pos_stock_qty harus berupa angka >= 0',
        });
      }
    }

    const rows = await q(
      `
        UPDATE menus
        SET
          pos_stock_qty = COALESCE($1, pos_stock_qty),
          pos_out_of_stock = COALESCE($2, pos_out_of_stock)
        WHERE id = $3
        RETURNING
          *,
          CASE
            WHEN pos_out_of_stock THEN 0
            ELSE pos_stock_qty
          END AS available_qty
      `,
      [
        pos_stock_qty === undefined ? null : Number(pos_stock_qty),
        pos_out_of_stock === undefined ? null : Boolean(pos_out_of_stock),
        req.params.id,
      ]
    );

    if (!rows[0]) {
      return res.status(404).json({
        error: 'Menu tidak ditemukan',
      });
    }

    res.json(rows[0]);
  }
);

// ============================================================
// Inventory
// ============================================================

app.get(
  '/api/inventory',
  auth,
  allow('WAREHOUSE', 'ADMIN'),
  async (req, res) => {
    const rows = await q(`
      SELECT *
      FROM ingredients
      ORDER BY name
    `);

    res.json(rows);
  }
);

app.put(
  '/api/inventory/:id',
  auth,
  allow('WAREHOUSE', 'ADMIN'),
  async (req, res) => {
    const { stock, min_stock } = req.body;

    const rows = await q(
      `
        UPDATE ingredients
        SET
          stock = $1,
          min_stock = COALESCE($2, min_stock),
          updated_at = now()
        WHERE id = $3
        RETURNING *
      `,
      [stock, min_stock, req.params.id]
    );

    res.json(rows[0]);
  }
);

// ============================================================
// Orders - Create
// ============================================================

app.post(
  '/api/orders',
  auth,
  allow('CASHIER', 'HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const {
        customerName,
        pax,
        tableNo,
        salesMode,
        paymentMethod,
        items,
      } = req.body;

      if (!items?.length) {
        throw new Error('Order kosong');
      }

      // --------------------------------------------------------
      // CASHIER/HEAD_CASHIER must have an open shift to sell. ADMIN
      // is exempt — Admin doesn't work shifts, it's a control role.
      // The order's till comes from that open shift — chosen once at
      // Mulai Shift, never from the client on a per-order basis.
      // --------------------------------------------------------

      let tillId = null;

      if (['CASHIER', 'HEAD_CASHIER'].includes(req.user.role)) {
        const openShift = await client.query(
          `SELECT id, till_id FROM shifts WHERE user_id = $1 AND ended_at IS NULL`,
          [req.user.id]
        );

        if (!openShift.rows[0]) {
          throw new Error('Mulai shift terlebih dahulu sebelum membuat order');
        }

        tillId = openShift.rows[0].till_id;
      }

      const orderNo = await nextOrderNo(client);

      let subtotal = 0;

      // --------------------------------------------------------
      // Resolve the cashier's fixed business account fresh from the
      // database — never from the JWT or a client-provided value.
      // --------------------------------------------------------

      const accountId = await resolveAccountId(req.user.id, client);

      // --------------------------------------------------------
      // Load active menus
      // --------------------------------------------------------

      const menuResult = await client.query(`
        SELECT *
        FROM menus
        WHERE active = true
      `);

      const menuMap = new Map(
        menuResult.rows.map((menu) => [menu.id, menu])
      );

      // --------------------------------------------------------
      // Validate items & POS stock
      // --------------------------------------------------------

      for (const item of items) {
        const menu = menuMap.get(item.menuId);

        if (!menu) {
          throw new Error('Menu tidak ditemukan');
        }

        subtotal += menu.price * item.qty;

        const available = menu.pos_out_of_stock
          ? 0
          : Number(menu.pos_stock_qty);

        if (available < item.qty) {
          throw new Error(`Stok ${menu.name} tidak cukup`);
        }
      }

      const taxAmount = Math.round(subtotal * TAX_RATE);
      const total = subtotal + taxAmount;

      // --------------------------------------------------------
      // Create order
      // --------------------------------------------------------

      const orderResult = await client.query(
        `
          INSERT INTO orders (
            order_no,
            cashier_id,
            account_id,
            till_id,
            customer_name,
            pax,
            table_no,
            sales_mode,
            payment_method,
            subtotal,
            tax_amount,
            total
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12
          )
          RETURNING *
        `,
        [
          orderNo,
          req.user.id,
          accountId,
          tillId,
          customerName || 'Walk-in Customer',
          pax,
          tableNo || null,
          salesMode,
          paymentMethod,
          subtotal,
          taxAmount,
          total,
        ]
      );

      const order = orderResult.rows[0];

      // --------------------------------------------------------
      // Create order items
      // --------------------------------------------------------

      for (const item of items) {
        const menu = menuMap.get(item.menuId);

        await client.query(
          `
            INSERT INTO order_items (
              order_id,
              menu_id,
              qty,
              unit_price,
              station,
              modifiers,
              note
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7
            )
          `,
          [
            order.id,
            menu.id,
            item.qty,
            menu.price,
            menu.station,
            item.modifiers || {},
            item.note || '',
          ]
        );

        // Manual POS stock is decremented on sale — availability now
        // reflects actual remaining stock, not just an admin-set
        // ceiling. Set Stok / Tandai Habis remain the tools to
        // restock or force out-of-stock.
        await client.query(
          `UPDATE menus SET pos_stock_qty = pos_stock_qty - $1 WHERE id = $2`,
          [item.qty, menu.id]
        );
      }

      await client.query('COMMIT');

      res.status(201).json(
        await orderById(order.id, client)
      );
    } catch (error) {
      await client.query('ROLLBACK');

      res.status(400).json({
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// Order Helper
// ============================================================

async function orderById(id, client = pool) {
  const result = await client.query(
    `
      SELECT
        o.*,
        u.display_name AS cashier,

        COALESCE(
          json_agg(
            json_build_object(
              'id', oi.id,
              'menuId', oi.menu_id,
              'name', m.name,
              'qty', oi.qty,
              'unitPrice', oi.unit_price,
              'station', oi.station,
              'modifiers', oi.modifiers,
              'note', oi.note,
              'stationStatus', oi.station_status
            )
          ) FILTER (
            WHERE oi.id IS NOT NULL
          ),
          '[]'
        ) AS items

      FROM orders o

      JOIN users u
        ON u.id = o.cashier_id

      LEFT JOIN order_items oi
        ON oi.order_id = o.id

      LEFT JOIN menus m
        ON m.id = oi.menu_id

      WHERE o.id = $1

      GROUP BY
        o.id,
        u.display_name
    `,
    [id]
  );

  return result.rows[0];
}

// ============================================================
// Orders - List
// ============================================================

app.get('/api/orders', auth, async (req, res) => {
  const params = [];
  let where = '';

  // ----------------------------------------------------------
  // Cashier hanya bisa melihat order miliknya
  // ----------------------------------------------------------

  if (req.user.role === 'CASHIER') {
    params.push(req.user.id);
    where = 'WHERE o.cashier_id = $1';
  }

  // ----------------------------------------------------------
  // Filter payment
  // ----------------------------------------------------------

  if (req.query.payment) {
    params.push(req.query.payment);

    where += where ? ' AND ' : 'WHERE ';
    where += `o.payment_method = $${params.length}`;
  }

  // ----------------------------------------------------------
  // Filter cashier untuk ADMIN
  // ----------------------------------------------------------

  if (req.query.cashier && ['ADMIN', 'HEAD_CASHIER'].includes(req.user.role)) {
    params.push(req.query.cashier);

    where += where ? ' AND ' : 'WHERE ';
    where += `o.cashier_id = $${params.length}`;
  }

  const rows = await q(
    `
      SELECT
        o.*,
        u.display_name AS cashier,

        COALESCE(
          json_agg(
            json_build_object(
              'menuId', oi.menu_id,
              'name', m.name,
              'qty', oi.qty,
              'unitPrice', oi.unit_price,
              'station', oi.station,
              'stationStatus', oi.station_status,
              'modifiers', oi.modifiers,
              'note', oi.note
            )
          ) FILTER (
            WHERE oi.id IS NOT NULL
          ),
          '[]'
        ) AS items

      FROM orders o

      JOIN users u
        ON u.id = o.cashier_id

      LEFT JOIN order_items oi
        ON oi.order_id = o.id

      LEFT JOIN menus m
        ON m.id = oi.menu_id

      ${where}

      GROUP BY
        o.id,
        u.display_name

      ORDER BY o.created_at DESC

      LIMIT 500
    `,
    params
  );

  res.json(rows);
});

// ============================================================
// Orders - Update
// ============================================================

app.put(
  '/api/orders/:id',
  auth,
  allow('HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // --------------------------------------------------------
      // Get existing order
      // --------------------------------------------------------

      const oldResult = await client.query(
        `
          SELECT *
          FROM orders
          WHERE id = $1
          FOR UPDATE
        `,
        [req.params.id]
      );

      const oldOrder = oldResult.rows[0];

      if (!oldOrder) {
        throw new Error('Receipt tidak ditemukan');
      }

      // --------------------------------------------------------
      // Give back the stock the old items held, then delete them —
      // the new items below get their own fresh decrement, so the
      // net effect is stock reflecting only the final item list.
      // --------------------------------------------------------

      await client.query(
        `
          UPDATE menus m
          SET pos_stock_qty = pos_stock_qty + oi.qty
          FROM order_items oi
          WHERE oi.order_id = $1 AND oi.menu_id = m.id
        `,
        [oldOrder.id]
      );

      await client.query(
        `
          DELETE FROM order_items
          WHERE order_id = $1
        `,
        [oldOrder.id]
      );

      const {
        items,
        paymentMethod,
        customerName,
        pax,
        tableNo,
        salesMode,
      } = req.body;

      let subtotal = 0;

      // --------------------------------------------------------
      // Validate new items & POS stock
      // --------------------------------------------------------

      for (const item of items) {
        const menuResult = await client.query(
          `
            SELECT *
            FROM menus
            WHERE id = $1
          `,
          [item.menuId]
        );

        const menu = menuResult.rows[0];

        if (!menu) {
          throw new Error('Menu tidak ditemukan');
        }

        subtotal += menu.price * item.qty;

        const available = menu.pos_out_of_stock
          ? 0
          : Number(menu.pos_stock_qty);

        if (available < item.qty) {
          throw new Error(`Stok ${menu.name} tidak cukup`);
        }
      }

      // --------------------------------------------------------
      // Insert new items
      // --------------------------------------------------------

      for (const item of items) {
        const menuResult = await client.query(
          `
            SELECT *
            FROM menus
            WHERE id = $1
          `,
          [item.menuId]
        );

        const menu = menuResult.rows[0];

        await client.query(
          `
            INSERT INTO order_items (
              order_id,
              menu_id,
              qty,
              unit_price,
              station,
              modifiers,
              note
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7
            )
          `,
          [
            oldOrder.id,
            menu.id,
            item.qty,
            menu.price,
            menu.station,
            item.modifiers || {},
            item.note || '',
          ]
        );

        await client.query(
          `UPDATE menus SET pos_stock_qty = pos_stock_qty - $1 WHERE id = $2`,
          [item.qty, menu.id]
        );
      }

      const taxAmount = Math.round(subtotal * TAX_RATE);
      const total = subtotal + taxAmount;

      // --------------------------------------------------------
      // Update order
      // --------------------------------------------------------

      const updatedResult = await client.query(
        `
          UPDATE orders
          SET
            customer_name = $1,
            pax = $2,
            table_no = $3,
            sales_mode = $4,
            payment_method = $5,
            subtotal = $6,
            tax_amount = $7,
            total = $8,
            updated_at = now()
          WHERE id = $9
          RETURNING *
        `,
        [
          customerName,
          pax,
          tableNo || null,
          salesMode,
          paymentMethod,
          subtotal,
          taxAmount,
          total,
          oldOrder.id,
        ]
      );

      const updatedOrder = updatedResult.rows[0];

      await client.query('COMMIT');

      res.json(
        await orderById(updatedOrder.id)
      );
    } catch (error) {
      await client.query('ROLLBACK');

      res.status(400).json({
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// Kitchen / Bar Station
// ============================================================

app.get('/api/station/:station', auth, async (req, res) => {
  const station = req.params.station.toUpperCase();

  const rows = await q(
    `
      SELECT
        o.order_no,
        o.customer_name,
        o.table_no,
        o.sales_mode,
        o.created_at,
        u.display_name AS cashier,

        json_agg(
          json_build_object(
            'id', oi.id,
            'name', m.name,
            'qty', oi.qty,
            'modifiers', oi.modifiers,
            'note', oi.note,
            'status', oi.station_status
          )
        ) AS items

      FROM orders o

      JOIN users u
        ON u.id = o.cashier_id

      JOIN order_items oi
        ON oi.order_id = o.id

      JOIN menus m
        ON m.id = oi.menu_id

      WHERE
        oi.station = $1
        AND oi.station_status <> 'READY'

      GROUP BY
        o.id,
        u.display_name

      ORDER BY o.created_at
    `,
    [station]
  );

  res.json(rows);
});

// ============================================================
// Order Item Status
// ============================================================

app.patch(
  '/api/order-items/:id/status',
  auth,
  allow('CASHIER', 'HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const rows = await q(
      `
        UPDATE order_items
        SET station_status = $1
        WHERE id = $2
        RETURNING *
      `,
      [req.body.status, req.params.id]
    );

    res.json(rows[0]);
  }
);

// ============================================================
// Shifts (CASHIER / HEAD_CASHIER only)
// ============================================================
//
// A cashier can work more than one distinct shift session in the
// same calendar day (24-hour operation: close out at 8am, come back
// at 11pm) — so closing never locks the rest of the day.
//
// "Istirahat" (break) — the shift's ended_at is set, but it's not
// settled: resuming via "Lanjut Shift" continues the same running
// session, no closing report is generated.
//
// "Tutup Shift" — ends the current shift AND writes a day_closings
// row settling everything since the last closing (or the start of
// today, if none yet). After that, the user is immediately free to
// start a brand new shift — even seconds later, even same day.

async function getShiftStatus(userId) {
  const openShift = (
    await q(
      `
        SELECT s.id, s.started_at, t.id AS till_id, t.code AS till_code, t.name AS till_name
        FROM shifts s
        LEFT JOIN tills t ON t.id = s.till_id
        WHERE s.user_id = $1 AND s.ended_at IS NULL
      `,
      [userId]
    )
  )[0];

  if (openShift) {
    return { state: 'ACTIVE', shift: openShift };
  }

  const lastShiftToday = (
    await q(
      `
        SELECT id, ended_at FROM shifts
        WHERE user_id = $1 AND started_at::date = CURRENT_DATE
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [userId]
    )
  )[0];

  if (!lastShiftToday) {
    return { state: 'NOT_STARTED', shift: null };
  }

  // If a closing happened at or after this shift ended, that session
  // was settled — the user is starting fresh, not resuming a break.
  const settledSince = (
    await q(
      `SELECT 1 FROM day_closings WHERE user_id = $1 AND closed_at >= $2`,
      [userId, lastShiftToday.ended_at]
    )
  )[0];

  return {
    state: settledSince ? 'NOT_STARTED' : 'ON_BREAK',
    shift: null,
  };
}

// Physical tills ("Kasir 1/2/3") — a dimension independent of user
// identity and business account, chosen once per shift.
app.get('/api/tills', auth, allow('CASHIER', 'HEAD_CASHIER', 'ADMIN'), async (_, res) => {
  const rows = await q('SELECT id, code, name FROM tills ORDER BY id');
  res.json(rows);
});

app.get(
  '/api/shifts/status',
  auth,
  allow('CASHIER', 'HEAD_CASHIER'),
  async (req, res) => {
    res.json(await getShiftStatus(req.user.id));
  }
);

app.post(
  '/api/shifts/start',
  auth,
  allow('CASHIER', 'HEAD_CASHIER'),
  async (req, res) => {
    const status = await getShiftStatus(req.user.id);

    if (status.state === 'ACTIVE') {
      return res.status(400).json({ error: 'Shift sudah berjalan' });
    }

    const till = (
      await q('SELECT id, name FROM tills WHERE id = $1', [req.body.tillId])
    )[0];

    if (!till) {
      return res.status(400).json({ error: 'Pilih Kasir (till) yang valid' });
    }

    // Only one open shift per till at a time — checked here for a
    // friendly, specific error naming who's on it, and enforced
    // again at the database level (idx_shifts_one_active_per_till)
    // as the real guarantee against two people racing to start on
    // the same till at the same moment.
    const holder = (
      await q(
        `
          SELECT u.display_name
          FROM shifts s
          JOIN users u ON u.id = s.user_id
          WHERE s.till_id = $1 AND s.ended_at IS NULL
        `,
        [till.id]
      )
    )[0];

    if (holder) {
      return res.status(400).json({
        error: `${till.name} sedang dipakai oleh ${holder.display_name}`,
      });
    }

    try {
      const rows = await q(
        `INSERT INTO shifts (user_id, till_id) VALUES ($1, $2) RETURNING id, started_at, till_id`,
        [req.user.id, till.id]
      );

      res.status(201).json(rows[0]);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(400).json({
          error: `${till.name} baru saja dipakai orang lain, pilih kasir lain`,
        });
      }

      throw error;
    }
  }
);

app.post(
  '/api/shifts/end',
  auth,
  allow('CASHIER', 'HEAD_CASHIER'),
  async (req, res) => {
    const rows = await q(
      `
        UPDATE shifts
        SET ended_at = now()
        WHERE user_id = $1 AND ended_at IS NULL
        RETURNING id, started_at, ended_at
      `,
      [req.user.id]
    );

    if (!rows[0]) {
      return res.status(400).json({ error: 'Tidak ada shift yang aktif' });
    }

    res.json(rows[0]);
  }
);

app.post(
  '/api/shifts/close-shift',
  auth,
  allow('CASHIER', 'HEAD_CASHIER'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Till comes from whichever shift is open right now (or, if on
      // a break, the most recent shift today) — that's what this
      // closing gets attributed to.
      const tillRow = (
        await client.query(
          `
            SELECT till_id FROM shifts
            WHERE user_id = $1 AND started_at::date = CURRENT_DATE
            ORDER BY started_at DESC
            LIMIT 1
          `,
          [req.user.id]
        )
      ).rows[0];

      await client.query(
        `
          UPDATE shifts
          SET ended_at = now()
          WHERE user_id = $1 AND ended_at IS NULL
        `,
        [req.user.id]
      );

      // Settle everything since the LAST closing (any date — will
      // naturally be today's, or none) up to now, bounded to today.
      // This is what makes 24-hour operation work: closing at 8am
      // and again at 11pm the same day each only covers its own
      // session, never double-counting or requiring a new calendar
      // date to start fresh again.
      const lastClosing = await client.query(
        `SELECT closed_at FROM day_closings WHERE user_id = $1 ORDER BY closed_at DESC LIMIT 1`,
        [req.user.id]
      );
      const since = lastClosing.rows[0]?.closed_at || null;

      const orders = await client.query(
        `
          SELECT o.id, o.total, o.payment_method,
            (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS items
          FROM orders o
          WHERE o.cashier_id = $1
            AND o.created_at::date = CURRENT_DATE
            AND ($2::timestamptz IS NULL OR o.created_at > $2)
        `,
        [req.user.id, since]
      );

      const paymentBreakdown = {};
      let grossSales = 0;
      let itemsSold = 0;

      for (const order of orders.rows) {
        const method = order.payment_method || 'UNKNOWN';
        paymentBreakdown[method] = (paymentBreakdown[method] || 0) + Number(order.total);
        grossSales += Number(order.total);
        itemsSold += Number(order.items);
      }

      const closing = await client.query(
        `
          INSERT INTO day_closings
            (user_id, closing_date, till_id, transactions, gross_sales, items_sold, payment_breakdown)
          VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
          RETURNING *
        `,
        [
          req.user.id,
          tillRow?.till_id || null,
          orders.rows.length,
          grossSales,
          itemsSold,
          JSON.stringify(paymentBreakdown),
        ]
      );

      await client.query('COMMIT');
      res.status(201).json(closing.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  }
);

app.get(
  '/api/shifts/closings',
  auth,
  allow('CASHIER', 'HEAD_CASHIER'),
  async (req, res) => {
    const rows = await q(
      `
        SELECT dc.*, t.code AS till_code, t.name AS till_name
        FROM day_closings dc
        LEFT JOIN tills t ON t.id = dc.till_id
        WHERE dc.user_id = $1
        ORDER BY dc.closing_date DESC
        LIMIT 30
      `,
      [req.user.id]
    );

    res.json(rows);
  }
);

// Combined, per-cashier closing view for a single date — HEAD_CASHIER
// (scoped to accounts they're permitted to report on) / ADMIN (all
// accounts). Every cashier who closed their day on that date shows
// up individually with their own cash/EDC breakdown, followed by a
// grand total across all of them — meant for the end-of-day print.
app.get(
  '/api/shifts/closings/combined',
  auth,
  allow('HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const isAdmin = req.user.role === 'ADMIN';
    const isValidDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');

    // Same date-range filter as the main report (dateFrom/dateTo) —
    // one control for the whole reporting page. Defaults to today
    // (WIB) when neither is given; a single date sent as both means
    // one specific day, exactly like the main report.
    const today = (
      await q(`SELECT CURRENT_DATE::text AS d`)
    )[0].d;
    const dateFrom = isValidDate(req.query.dateFrom) ? req.query.dateFrom : today;
    const dateTo = isValidDate(req.query.dateTo) ? req.query.dateTo : today;

    const permittedAccounts = isAdmin
      ? await q('SELECT id, code FROM accounts')
      : await q(
          `
            SELECT a.id, a.code
            FROM report_account_permissions p
            JOIN accounts a ON a.id = p.account_id
            WHERE p.user_id = $1
          `,
          [req.user.id]
        );

    let scopedAccountIds = permittedAccounts.map((a) => a.id);

    // Same account filter as the main report — must resolve to one
    // of the accounts this user is permitted to see, never silently
    // ignored or widened to "all permitted" when a specific one was
    // asked for.
    if (req.query.account) {
      const requested = permittedAccounts.find(
        (a) => a.code === req.query.account
      );

      if (!requested) {
        return res.status(403).json({
          error: 'Tidak memiliki akses ke akun ini',
        });
      }

      scopedAccountIds = [requested.id];
    }

    if (scopedAccountIds.length === 0) {
      return res.json({ dateFrom, dateTo, cashiers: [], byTill: [], total: null });
    }

    const rows = await q(
      `
        SELECT
          dc.user_id,
          u.display_name AS name,
          a.code AS account_code,
          a.name AS account_name,
          t.code AS till_code,
          t.name AS till_name,
          dc.closing_date,
          dc.transactions,
          dc.gross_sales,
          dc.items_sold,
          dc.payment_breakdown
        FROM day_closings dc
        JOIN users u ON u.id = dc.user_id
        JOIN accounts a ON a.id = u.account_id
        LEFT JOIN tills t ON t.id = dc.till_id
        WHERE dc.closing_date BETWEEN $1 AND $2 AND u.account_id = ANY($3)
        ORDER BY dc.closing_date, u.display_name
      `,
      [dateFrom, dateTo, scopedAccountIds]
    );

    const total = {
      transactions: 0,
      grossSales: 0,
      itemsSold: 0,
      paymentBreakdown: {},
    };

    const byTillMap = {};

    for (const row of rows) {
      total.transactions += row.transactions;
      total.grossSales += row.gross_sales;
      total.itemsSold += row.items_sold;

      for (const [method, amount] of Object.entries(row.payment_breakdown || {})) {
        total.paymentBreakdown[method] = (total.paymentBreakdown[method] || 0) + Number(amount);
      }

      const tillKey = row.till_code || 'UNKNOWN';
      byTillMap[tillKey] ??= {
        tillCode: tillKey,
        tillName: row.till_name || 'Tanpa Kasir',
        transactions: 0,
        grossSales: 0,
        itemsSold: 0,
        paymentBreakdown: {},
      };
      byTillMap[tillKey].transactions += row.transactions;
      byTillMap[tillKey].grossSales += row.gross_sales;
      byTillMap[tillKey].itemsSold += row.items_sold;

      for (const [method, amount] of Object.entries(row.payment_breakdown || {})) {
        byTillMap[tillKey].paymentBreakdown[method] =
          (byTillMap[tillKey].paymentBreakdown[method] || 0) + Number(amount);
      }
    }

    res.json({
      dateFrom,
      dateTo,
      cashiers: rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        accountCode: row.account_code,
        accountName: row.account_name,
        tillCode: row.till_code,
        tillName: row.till_name,
        closingDate: row.closing_date,
        transactions: row.transactions,
        grossSales: row.gross_sales,
        itemsSold: row.items_sold,
        paymentBreakdown: row.payment_breakdown,
      })),
      byTill: Object.values(byTillMap),
      total: rows.length ? total : null,
    });
  }
);

// ============================================================
// Reports
// ============================================================

app.get(
  '/api/reports',
  auth,
  allow('CASHIER', 'HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    // ----------------------------------------------------------
    // Date range + pagination — shared by both branches below.
    // Default (no explicit range) is TODAY ONLY: with potentially
    // thousands of orders a day, an unbounded all-time query is both
    // slow and unreadable. An explicit ?dateFrom/?dateTo widens the
    // window for real historical lookups; ?page/?pageSize paginate
    // the transaction list specifically — summary/sales/performance/
    // accounts are always computed over the FULL filtered range, not
    // just the current page.
    // ----------------------------------------------------------

    const isValidDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
    const hasExplicitRange =
      isValidDate(req.query.dateFrom) || isValidDate(req.query.dateTo);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(req.query.pageSize, 10) || 50)
    );

    // "Sales by Menu" category filter — narrows which items count
    // toward that breakdown specifically. Doesn't touch transactions/
    // summary/performance, since one order can mix categories.
    const categoryFilter = req.query.category || null;
    const categories = (
      await q('SELECT DISTINCT category FROM menus ORDER BY category')
    ).map((row) => row.category);

    // ----------------------------------------------------------
    // CASHIER: no account-level visibility at all. Always their own
    // orders only — never influenced by ?account=/?cashier=. The
    // default (no explicit date) live view shows today's orders
    // SINCE THE LAST CLOSING — same boundary "Tutup Shift" itself
    // settles against — so a cashier can close, reopen a new shift,
    // and immediately see fresh figures instead of a blanked-out
    // view for the rest of the calendar day.
    // ----------------------------------------------------------

    if (req.user.role === 'CASHIER') {
      let sinceLastClosing = null;

      if (!hasExplicitRange) {
        const lastClosing = await q(
          `SELECT closed_at FROM day_closings WHERE user_id = $1 ORDER BY closed_at DESC LIMIT 1`,
          [req.user.id]
        );

        sinceLastClosing = lastClosing[0]?.closed_at || null;
      }

      const params = [req.user.id];
      let where = 'WHERE o.cashier_id = $1';

      if (isValidDate(req.query.dateFrom)) {
        params.push(req.query.dateFrom);
        where += ` AND o.created_at::date >= $${params.length}`;
      }

      if (isValidDate(req.query.dateTo)) {
        params.push(req.query.dateTo);
        where += ` AND o.created_at::date <= $${params.length}`;
      }

      if (!hasExplicitRange) {
        where += ' AND o.created_at::date = CURRENT_DATE';

        if (sinceLastClosing) {
          params.push(sinceLastClosing);
          where += ` AND o.created_at > $${params.length}`;
        }
      }

      if (req.query.payment) {
        params.push(req.query.payment);
        where += ` AND o.payment_method = $${params.length}`;
      }

      const rows = await q(
        `
          SELECT
            o.id,
            o.order_no,
            o.total,
            o.payment_method,
            o.created_at,
            u.display_name AS cashier,

            json_agg(
              json_build_object(
                'name', m.name,
                'category', m.category,
                'qty', oi.qty,
                'unitPrice', oi.unit_price
              )
            ) AS items

          FROM orders o
          JOIN users u ON u.id = o.cashier_id
          JOIN order_items oi ON oi.order_id = o.id
          JOIN menus m ON m.id = oi.menu_id

          ${where}

          GROUP BY o.id, u.display_name
          ORDER BY o.created_at DESC
        `,
        params
      );

      const sales = {};

      for (const order of rows) {
        for (const item of order.items) {
          if (categoryFilter && item.category !== categoryFilter) continue;

          sales[item.name] ??= { qty: 0, revenue: 0 };
          sales[item.name].qty += item.qty;
          sales[item.name].revenue += item.qty * item.unitPrice;
        }
      }

      const summary = {
        transactions: rows.length,
        grossSales: rows.reduce((sum, order) => sum + order.total, 0),
        itemsSold: rows.reduce(
          (sum, order) =>
            sum + order.items.reduce((s, item) => s + item.qty, 0),
          0
        ),
      };

      const start = (page - 1) * pageSize;

      return res.json({
        transactions: rows.slice(start, start + pageSize),
        transactionsTotal: rows.length,
        sales: Object.entries(sales).map(([name, value]) => ({
          name,
          ...value,
        })),
        categories,
        performance: [],
        accounts: [],
        permittedAccounts: [],
        summary,
      });
    }

    const isAdmin = req.user.role === 'ADMIN';

    // ----------------------------------------------------------
    // Which accounts this user may report on. ADMIN: all of them.
    // HEAD_CASHIER: only accounts explicitly granted via
    // report_account_permissions — never inferred from their own
    // account_id or role. No permissions granted = no data, not an
    // error, and never a generic "all accounts" fallback.
    // ----------------------------------------------------------

    const permittedAccounts = isAdmin
      ? await q('SELECT id, code, name FROM accounts ORDER BY id')
      : await q(
          `
            SELECT a.id, a.code, a.name
            FROM report_account_permissions p
            JOIN accounts a ON a.id = p.account_id
            WHERE p.user_id = $1
            ORDER BY a.id
          `,
          [req.user.id]
        );

    const permittedIds = permittedAccounts.map((a) => a.id);

    if (permittedIds.length === 0) {
      return res.json({
        transactions: [],
        transactionsTotal: 0,
        sales: [],
        categories,
        performance: [],
        accounts: [],
        permittedAccounts: [],
        summary: { transactions: 0, grossSales: 0, itemsSold: 0 },
      });
    }

    const params = [permittedIds];
    let where = 'WHERE o.account_id = ANY($1)';

    // ----------------------------------------------------------
    // Business account filter — must resolve to one of the accounts
    // this user is permitted to see; a code outside that set is
    // rejected rather than silently ignored or widened.
    // ----------------------------------------------------------

    if (req.query.account) {
      const requested = permittedAccounts.find(
        (a) => a.code === req.query.account
      );

      if (!requested) {
        return res.status(403).json({
          error: 'Tidak memiliki akses ke akun ini',
        });
      }

      params.push(requested.id);
      where += ` AND o.account_id = $${params.length}`;
    }

    // ----------------------------------------------------------
    // Cashier filter
    // ----------------------------------------------------------

    if (req.query.cashier) {
      params.push(req.query.cashier);
      where += ` AND o.cashier_id = $${params.length}`;
    }

    // ----------------------------------------------------------
    // Payment filter
    // ----------------------------------------------------------

    if (req.query.payment) {
      params.push(req.query.payment);
      where += ` AND o.payment_method = $${params.length}`;
    }

    // ----------------------------------------------------------
    // Date range — defaults to today so a HEAD_CASHIER/ADMIN report
    // never silently pulls in the entire lifetime order history;
    // an explicit range covers real historical lookups instead.
    // ----------------------------------------------------------

    if (isValidDate(req.query.dateFrom)) {
      params.push(req.query.dateFrom);
      where += ` AND o.created_at::date >= $${params.length}`;
    }

    if (isValidDate(req.query.dateTo)) {
      params.push(req.query.dateTo);
      where += ` AND o.created_at::date <= $${params.length}`;
    }

    if (!hasExplicitRange) {
      where += ' AND o.created_at::date = CURRENT_DATE';
    }

    // ----------------------------------------------------------
    // Get transactions
    // ----------------------------------------------------------

    const rows = await q(
      `
        SELECT
          o.id,
          o.order_no,
          o.customer_name,
          o.pax,
          o.table_no,
          o.sales_mode,
          o.total,
          o.payment_method,
          o.created_at,
          u.display_name AS cashier,
          a.code AS account_code,
          a.name AS account_name,

          json_agg(
            json_build_object(
              'menuId', oi.menu_id,
              'name', m.name,
              'category', m.category,
              'qty', oi.qty,
              'unitPrice', oi.unit_price,
              'modifiers', oi.modifiers,
              'note', oi.note
            )
          ) AS items

        FROM orders o

        JOIN users u
          ON u.id = o.cashier_id

        JOIN accounts a
          ON a.id = o.account_id

        JOIN order_items oi
          ON oi.order_id = o.id

        JOIN menus m
          ON m.id = oi.menu_id

        ${where}

        GROUP BY
          o.id,
          u.display_name,
          a.code,
          a.name

        ORDER BY o.created_at DESC
      `,
      params
    );

    // ----------------------------------------------------------
    // Calculate sales per menu
    // ----------------------------------------------------------

    const sales = {};

    for (const order of rows) {
      for (const item of order.items) {
        if (categoryFilter && item.category !== categoryFilter) continue;

        sales[item.name] ??= {
          qty: 0,
          revenue: 0,
        };

        sales[item.name].qty += item.qty;
        sales[item.name].revenue +=
          item.qty * item.unitPrice;
      }
    }

    // ----------------------------------------------------------
    // Performance per cashier
    // ----------------------------------------------------------

    const performanceMap = {};
    for (const order of rows) {
      const name = order.cashier || 'Unknown';
      performanceMap[name] ??= { transactions: 0, grossSales: 0, itemsSold: 0 };
      performanceMap[name].transactions += 1;
      performanceMap[name].grossSales += Number(order.total || 0);
      performanceMap[name].itemsSold += (order.items || []).reduce(
        (sum, item) => sum + Number(item.qty || 0),
        0
      );
    }

    // ----------------------------------------------------------
    // Sales by business account — scoped to whatever accounts this
    // user is permitted to see (all of them for ADMIN, only granted
    // ones for HEAD_CASHIER), never a wider "all accounts" view.
    // ----------------------------------------------------------

    const accountMap = {};

    for (const order of rows) {
      const code = order.account_code || 'UNKNOWN';
      accountMap[code] ??= {
        code,
        name: order.account_name || code,
        transactions: 0,
        grossSales: 0,
      };
      accountMap[code].transactions += 1;
      accountMap[code].grossSales += Number(order.total || 0);
    }

    const start = (page - 1) * pageSize;
    const transactions = rows.slice(start, start + pageSize);

    // ----------------------------------------------------------
    // Summary
    // ----------------------------------------------------------

    const summary = {
      transactions: rows.length,

      grossSales: rows.reduce(
        (sum, order) => sum + order.total,
        0
      ),

      itemsSold: rows.reduce(
        (sum, order) =>
          sum +
          order.items.reduce(
            (itemSum, item) => itemSum + item.qty,
            0
          ),
        0
      ),
    };

    res.json({
      transactions,
      transactionsTotal: rows.length,

      sales: Object.entries(sales).map(
        ([name, value]) => ({
          name,
          ...value,
        })
      ),
      categories,

      performance: Object.entries(performanceMap).map(
        ([name, value]) => ({ name, ...value })
      ),

      accounts: Object.values(accountMap),
      permittedAccounts: permittedAccounts.map(({ code, name }) => ({
        code,
        name,
      })),

      summary,
    });
  }
);

// ============================================================
// Delete Order
// ============================================================

app.delete(
  '/api/orders/:id',
  auth,
  allow('HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const reason = String(req.body?.reason || '').trim();
      if (reason.length < 5) {
        throw new Error('Alasan penghapusan wajib diisi minimal 5 karakter');
      }

      const orderResult = await client.query(
        `SELECT o.*, u.display_name AS cashier
         FROM orders o
         LEFT JOIN users u ON u.id = o.cashier_id
         WHERE o.id = $1
         FOR UPDATE OF o`,
        [req.params.id]
      );
      const order = orderResult.rows[0];
      if (!order) throw new Error('Transaksi tidak ditemukan');

      // Deleting a sale gives its stock back — mirrors the decrement
      // that happened when the order was created.
      await client.query(
        `
          UPDATE menus m
          SET pos_stock_qty = pos_stock_qty + oi.qty
          FROM order_items oi
          WHERE oi.order_id = $1 AND oi.menu_id = m.id
        `,
        [order.id]
      );

      await client.query('DELETE FROM orders WHERE id = $1', [order.id]);

      await client.query(
        `INSERT INTO audit_logs
          (actor_id, action, entity_type, entity_id, entity_ref, reason, metadata)
         VALUES ($1, 'DELETE', 'ORDER', $2, $3, $4, $5)`,
        [
          req.user.id,
          order.id,
          order.order_no,
          reason,
          JSON.stringify({
            cashierId: order.cashier_id,
            cashierName: order.cashier,
            total: order.total,
            paymentMethod: order.payment_method,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({ success: true, message: `Transaksi ${order.order_no} dihapus` });
    } catch (error) {
      await client.query('ROLLBACK');
      const status = error.message === 'Transaksi tidak ditemukan' ? 404 : 400;
      res.status(status).json({ error: error.message });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// Audit Logs
// ============================================================

app.get(
  '/api/audit-logs',
  auth,
  allow('HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const rows = await q(`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.entity_ref,
             a.reason, a.metadata, a.created_at,
             u.display_name AS actor
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  }
);

// ============================================================
// Cashiers (for the Report cashier filter)
// ============================================================

app.get(
  '/api/cashiers',
  auth,
  allow('ADMIN', 'HEAD_CASHIER'),
  async (req, res) => {
    // Anyone who actually sells (CASHIER, HEAD_CASHIER) is a valid
    // "kasir" filter option — ADMIN is excluded, since Admin doesn't
    // work shifts or sell, it's a control-only role. ADMIN sees
    // everyone who sells (full access to all accounts). A
    // HEAD_CASHIER only sees people whose fixed account is one
    // they've been explicitly granted report access to — otherwise
    // this filter dropdown would leak the existence of a cashier
    // operating under an account they're not permitted to see.
    const rows =
      req.user.role === 'ADMIN'
        ? await q(`
            SELECT id, display_name AS name
            FROM users
            WHERE role IN ('CASHIER', 'HEAD_CASHIER') AND is_active = true
            ORDER BY display_name
          `)
        : await q(
            `
              SELECT u.id, u.display_name AS name
              FROM users u
              JOIN report_account_permissions p
                ON p.account_id = u.account_id
                AND p.user_id = $1
              WHERE u.role IN ('CASHIER', 'HEAD_CASHIER') AND u.is_active = true
              ORDER BY u.display_name
            `,
            [req.user.id]
          );

    res.json(rows);
  }
);

// ============================================================
// Business Accounts — plain list, for ADMIN user-management UI
// (assigning a user's account, granting report permissions).
// ============================================================

app.get(
  '/api/accounts',
  auth,
  allow('ADMIN'),
  async (_, res) => {
    const rows = await q(`
      SELECT id, code, name
      FROM accounts
      ORDER BY id
    `);

    res.json(rows);
  }
);

// ============================================================
// User Management — ADMIN only. Creating/editing users, resetting
// PINs, and assigning accounts/roles all live here; HEAD_CASHIER has
// none of this capability.
// ============================================================

// ADMIN is intentionally excluded — there is only ever one Admin
// (seeded directly in the database), and that role can neither be
// granted to another user nor revoked through this API.
const CREATABLE_ROLES = ['CASHIER', 'HEAD_CASHIER', 'WAREHOUSE'];
const ACCOUNT_REQUIRED_ROLES = ['CASHIER', 'HEAD_CASHIER', 'ADMIN'];

app.get('/api/users', auth, allow('ADMIN'), async (_, res) => {
  const rows = await q(`
    SELECT
      u.id,
      u.username,
      u.display_name,
      u.role,
      u.is_active,
      u.account_id,
      a.code AS account_code,
      a.name AS account_name
    FROM users u
    LEFT JOIN accounts a ON a.id = u.account_id
    ORDER BY u.role, u.display_name
  `);

  res.json(rows);
});

app.post('/api/users', auth, allow('ADMIN'), async (req, res) => {
  const { username, displayName, pin, role, accountId } = req.body;

  if (!username?.trim() || !displayName?.trim() || !pin || !role) {
    return res.status(400).json({ error: 'Field wajib belum lengkap' });
  }

  if (!CREATABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Role tidak valid' });
  }

  if (ACCOUNT_REQUIRED_ROLES.includes(role) && !accountId) {
    return res.status(400).json({
      error: 'Akun bisnis wajib dipilih untuk role ini',
    });
  }

  try {
    const rows = await q(
      `
        INSERT INTO users (username, pin_hash, display_name, role, account_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, username, display_name, role, account_id, is_active
      `,
      [
        username.trim(),
        hashPin(pin),
        displayName.trim(),
        role,
        accountId || null,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username sudah digunakan' });
    }

    res.status(400).json({ error: error.message });
  }
});

app.put('/api/users/:id', auth, allow('ADMIN'), async (req, res) => {
  const { displayName, role, accountId, isActive } = req.body;

  const existing = await q('SELECT role FROM users WHERE id = $1', [
    req.params.id,
  ]);

  if (!existing[0]) {
    return res.status(404).json({ error: 'User tidak ditemukan' });
  }

  // The Admin role is fixed — there is only ever one, and it can
  // neither be handed to someone else nor taken away here.
  if (existing[0].role === 'ADMIN' || role === 'ADMIN') {
    return res.status(400).json({
      error: 'Role Admin tidak bisa dibuat atau diubah lewat Settings',
    });
  }

  if (role && !CREATABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Role tidak valid' });
  }

  if (role && ACCOUNT_REQUIRED_ROLES.includes(role) && !accountId) {
    return res.status(400).json({
      error: 'Akun bisnis wajib dipilih untuk role ini',
    });
  }

  const rows = await q(
    `
      UPDATE users
      SET
        display_name = $1,
        role = $2,
        account_id = $3,
        is_active = $4
      WHERE id = $5
      RETURNING id, username, display_name, role, account_id, is_active
    `,
    [displayName, role, accountId || null, isActive, req.params.id]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'User tidak ditemukan' });
  }

  res.json(rows[0]);
});

app.put('/api/users/:id/pin', auth, allow('ADMIN'), async (req, res) => {
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ error: 'PIN wajib diisi' });
  }

  const rows = await q(
    `UPDATE users SET pin_hash = $1 WHERE id = $2 RETURNING id`,
    [hashPin(pin), req.params.id]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'User tidak ditemukan' });
  }

  res.json({ success: true });
});

// Permanently removes a user — only when they have no real history
// (no orders, shifts, day closings, or audit-log entries). A user
// tied to any of that stays deactivate-only (is_active=false via
// PUT), since deleting them would either violate the orders FK or,
// worse, silently sever a financial record from who created it.
app.delete('/api/users/:id', auth, allow('ADMIN'), async (req, res) => {
  const target = await q('SELECT role FROM users WHERE id = $1', [
    req.params.id,
  ]);

  if (!target[0]) {
    return res.status(404).json({ error: 'User tidak ditemukan' });
  }

  if (target[0].role === 'ADMIN') {
    return res.status(400).json({ error: 'Admin tidak bisa dihapus' });
  }

  const [orders, shifts, closings, auditLogs] = await Promise.all([
    q('SELECT 1 FROM orders WHERE cashier_id = $1 LIMIT 1', [req.params.id]),
    q('SELECT 1 FROM shifts WHERE user_id = $1 LIMIT 1', [req.params.id]),
    q('SELECT 1 FROM day_closings WHERE user_id = $1 LIMIT 1', [
      req.params.id,
    ]),
    q('SELECT 1 FROM audit_logs WHERE actor_id = $1 LIMIT 1', [
      req.params.id,
    ]),
  ]);

  if (orders[0] || shifts[0] || closings[0] || auditLogs[0]) {
    return res.status(400).json({
      error:
        'User ini punya histori transaksi/shift — nonaktifkan saja, jangan dihapus',
    });
  }

  await q('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Explicit per-account report-viewing permission for a HEAD_CASHIER
// user — separate from role and from account_id, granted individually.
app.get(
  '/api/users/:id/report-permissions',
  auth,
  allow('ADMIN'),
  async (req, res) => {
    const rows = await q(
      `SELECT account_id FROM report_account_permissions WHERE user_id = $1`,
      [req.params.id]
    );

    res.json(rows.map((row) => row.account_id));
  }
);

app.put(
  '/api/users/:id/report-permissions',
  auth,
  allow('ADMIN'),
  async (req, res) => {
    const { accountIds } = req.body;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        'DELETE FROM report_account_permissions WHERE user_id = $1',
        [req.params.id]
      );

      for (const accountId of accountIds || []) {
        await client.query(
          `
            INSERT INTO report_account_permissions
              (user_id, account_id, granted_by)
            VALUES ($1, $2, $3)
          `,
          [req.params.id, accountId, req.user.id]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// Payment Methods — the selectable list on the payment screen and
// order filters. ADMIN and HEAD_CASHIER can add new ones or retire
// old ones; nothing else needs write access. Deactivating (not
// deleting) keeps historical orders that used a retired method
// intact, same pattern as user deactivation.
// ============================================================

app.get('/api/payment-methods', auth, async (_, res) => {
  const rows = await q(`
    SELECT id, name
    FROM payment_methods
    WHERE is_active = true
    ORDER BY sort_order, id
  `);

  res.json(rows);
});

app.get(
  '/api/payment-methods/all',
  auth,
  allow('ADMIN', 'HEAD_CASHIER'),
  async (_, res) => {
    const rows = await q(`
      SELECT id, name, is_active, sort_order
      FROM payment_methods
      ORDER BY sort_order, id
    `);

    res.json(rows);
  }
);

app.post(
  '/api/payment-methods',
  auth,
  allow('ADMIN', 'HEAD_CASHIER'),
  async (req, res) => {
    const name = String(req.body.name || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'Nama metode pembayaran wajib diisi' });
    }

    try {
      const [row] = await q(
        `
          INSERT INTO payment_methods (name, sort_order)
          VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM payment_methods))
          RETURNING id, name, is_active, sort_order
        `,
        [name]
      );

      res.status(201).json(row);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Metode pembayaran ini sudah ada' });
      }

      throw err;
    }
  }
);

app.put(
  '/api/payment-methods/:id',
  auth,
  allow('ADMIN', 'HEAD_CASHIER'),
  async (req, res) => {
    const { name, isActive } = req.body;

    try {
      const [row] = await q(
        `
          UPDATE payment_methods
          SET
            name = COALESCE($1, name),
            is_active = COALESCE($2, is_active)
          WHERE id = $3
          RETURNING id, name, is_active, sort_order
        `,
        [name ? String(name).trim() : null, isActive, req.params.id]
      );

      if (!row) {
        return res.status(404).json({ error: 'Metode pembayaran tidak ditemukan' });
      }

      res.json(row);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Metode pembayaran ini sudah ada' });
      }

      throw err;
    }
  }
);

// ============================================================
// Start Server
// ============================================================

app.listen(port, () => {
  console.log(`API listening on ${port}`);
});