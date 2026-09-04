import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import pg from 'pg';

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
  const { username, password } = req.body;

  const users = await q(
    `
      SELECT
        id,
        username,
        password_hash,
        display_name,
        role
      FROM users
      WHERE username = $1
    `,
    [username]
  );

  const user = users[0];

  if (!user || password !== user.password_hash) {
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
    },
  });
});

app.get('/api/me', auth, (req, res) => {
  res.json(req.user);
});

// ============================================================
// Menus
// ============================================================

app.get('/api/menus', auth, async (req, res) => {
  const rows = await q(`
    SELECT
      m.*,

      COALESCE(
        json_agg(
          json_build_object(
            'ingredient_id', r.ingredient_id,
            'code', ing.code,
            'qty', r.qty
          )
        ) FILTER (
          WHERE r.ingredient_id IS NOT NULL
        ),
        '[]'
      ) AS recipe,

      COALESCE(
        FLOOR(MIN(ing.stock / r.qty)),
        0
      ) AS available_qty

    FROM menus m

    LEFT JOIN recipes r
      ON r.menu_id = m.id

    LEFT JOIN ingredients ing
      ON ing.id = r.ingredient_id

    WHERE m.active = true

    GROUP BY m.id

    ORDER BY m.id
  `);

  res.json(rows);
});

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

      const orderNo = `ORD-${Date.now().toString().slice(-8)}`;

      let total = 0;

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
      // Validate items & stock
      // --------------------------------------------------------

      for (const item of items) {
        const menu = menuMap.get(item.menuId);

        if (!menu) {
          throw new Error('Menu tidak ditemukan');
        }

        total += menu.price * item.qty;

        const stockResult = await client.query(
          `
            SELECT
              FLOOR(MIN(i.stock / r.qty)) AS available
            FROM recipes r
            JOIN ingredients i
              ON i.id = r.ingredient_id
            WHERE r.menu_id = $1
          `,
          [menu.id]
        );

        const available = Number(stockResult.rows[0].available);

        if (available < item.qty) {
          throw new Error(`Stok ${menu.name} tidak cukup`);
        }
      }

      // --------------------------------------------------------
      // Create order
      // --------------------------------------------------------

      const orderResult = await client.query(
        `
          INSERT INTO orders (
            order_no,
            cashier_id,
            customer_name,
            pax,
            table_no,
            sales_mode,
            payment_method,
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
            $8
          )
          RETURNING *
        `,
        [
          orderNo,
          req.user.id,
          customerName || 'Walk-in Customer',
          pax,
          tableNo || null,
          salesMode,
          paymentMethod,
          total,
        ]
      );

      const order = orderResult.rows[0];

      // --------------------------------------------------------
      // Create order items & reduce inventory
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

        const recipeResult = await client.query(
          `
            SELECT
              ingredient_id,
              qty
            FROM recipes
            WHERE menu_id = $1
          `,
          [menu.id]
        );

        for (const recipe of recipeResult.rows) {
          await client.query(
            `
              UPDATE ingredients
              SET
                stock = stock - $1,
                updated_at = now()
              WHERE id = $2
            `,
            [
              Number(recipe.qty) * item.qty,
              recipe.ingredient_id,
            ]
          );
        }
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
  allow('CASHIER', 'HEAD_CASHIER', 'ADMIN'),
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

      // Cashier hanya boleh edit transaksi sendiri
      if (
        req.user.role === 'CASHIER' &&
        oldOrder.cashier_id !== req.user.id
      ) {
        throw new Error(
          'Tidak boleh edit transaksi kasir lain'
        );
      }

      // --------------------------------------------------------
      // Restore old inventory
      // --------------------------------------------------------

      const oldItemsResult = await client.query(
        `
          SELECT *
          FROM order_items
          WHERE order_id = $1
        `,
        [oldOrder.id]
      );

      for (const item of oldItemsResult.rows) {
        const recipes = await client.query(
          `
            SELECT
              ingredient_id,
              qty
            FROM recipes
            WHERE menu_id = $1
          `,
          [item.menu_id]
        );

        for (const recipe of recipes.rows) {
          await client.query(
            `
              UPDATE ingredients
              SET stock = stock + $1
              WHERE id = $2
            `,
            [
              Number(recipe.qty) * item.qty,
              recipe.ingredient_id,
            ]
          );
        }
      }

      // --------------------------------------------------------
      // Delete old order items
      // --------------------------------------------------------

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

      let total = 0;

      // --------------------------------------------------------
      // Validate new items
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

        total += menu.price * item.qty;

        const stockResult = await client.query(
          `
            SELECT
              FLOOR(MIN(i.stock / r.qty)) AS available
            FROM recipes r
            JOIN ingredients i
              ON i.id = r.ingredient_id
            WHERE r.menu_id = $1
          `,
          [menu.id]
        );

        const available = Number(
          stockResult.rows[0].available
        );

        if (available < item.qty) {
          throw new Error(`Stok ${menu.name} tidak cukup`);
        }
      }

      // --------------------------------------------------------
      // Insert new items & reduce inventory
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

        const recipes = await client.query(
          `
            SELECT
              ingredient_id,
              qty
            FROM recipes
            WHERE menu_id = $1
          `,
          [menu.id]
        );

        for (const recipe of recipes.rows) {
          await client.query(
            `
              UPDATE ingredients
              SET stock = stock - $1
              WHERE id = $2
            `,
            [
              Number(recipe.qty) * item.qty,
              recipe.ingredient_id,
            ]
          );
        }
      }

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
            total = $6,
            updated_at = now()
          WHERE id = $7
          RETURNING *
        `,
        [
          customerName,
          pax,
          tableNo || null,
          salesMode,
          paymentMethod,
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
// Reports
// ============================================================

app.get(
  '/api/reports',
  auth,
  allow('CASHIER', 'HEAD_CASHIER', 'ADMIN'),
  async (req, res) => {
    const params = [];
    let where = '';

    // ----------------------------------------------------------
    // Cashier restriction
    // ----------------------------------------------------------

    if (req.user.role === 'CASHIER') {
      params.push(req.user.id);
      where = 'WHERE o.cashier_id = $1';
    }

    // ----------------------------------------------------------
    // Admin cashier filter
    // ----------------------------------------------------------

    else if (req.query.cashier) {
      params.push(req.query.cashier);
      where = 'WHERE o.cashier_id = $1';
    }

    // ----------------------------------------------------------
    // Payment filter
    // ----------------------------------------------------------

    if (req.query.payment) {
      params.push(req.query.payment);

      where += where ? ' AND ' : 'WHERE ';
      where += `o.payment_method = $${params.length}`;
    }

    // ----------------------------------------------------------
    // Get transactions
    // ----------------------------------------------------------

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
              'qty', oi.qty,
              'unitPrice', oi.unit_price
            )
          ) AS items

        FROM orders o

        JOIN users u
          ON u.id = o.cashier_id

        JOIN order_items oi
          ON oi.order_id = o.id

        JOIN menus m
          ON m.id = oi.menu_id

        ${where}

        GROUP BY
          o.id,
          u.display_name

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
      transactions: rows,

      sales: Object.entries(sales).map(
        ([name, value]) => ({
          name,
          ...value,
        })
      ),

      performance: Object.entries(performanceMap).map(
        ([name, value]) => ({ name, ...value })
      ),

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
         FOR UPDATE`,
        [req.params.id]
      );
      const order = orderResult.rows[0];
      if (!order) throw new Error('Transaksi tidak ditemukan');

      const itemsResult = await client.query(
        `SELECT oi.menu_id, oi.qty, r.ingredient_id, r.qty AS recipe_qty
         FROM order_items oi
         LEFT JOIN recipes r ON r.menu_id = oi.menu_id
         WHERE oi.order_id = $1`,
        [order.id]
      );

      for (const item of itemsResult.rows) {
        if (!item.ingredient_id) continue;
        await client.query(
          `UPDATE ingredients SET stock = stock + $1, updated_at = now() WHERE id = $2`,
          [Number(item.recipe_qty) * Number(item.qty), item.ingredient_id]
        );
      }

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
      res.json({ success: true, message: `Transaksi ${order.order_no} dihapus dan stok dikembalikan` });
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
// Cashiers
// ============================================================

app.get(
  '/api/cashiers',
  auth,
  allow('ADMIN', 'HEAD_CASHIER'),
  async (_, res) => {
    const rows = await q(`
      SELECT
        id,
        display_name AS name
      FROM users
      WHERE role = 'CASHIER'
      ORDER BY display_name
    `);

    res.json(rows);
  }
);

// ============================================================
// Start Server
// ============================================================

app.listen(port, () => {
  console.log(`API listening on ${port}`);
});