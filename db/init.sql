CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('CASHIER','HEAD_CASHIER','WAREHOUSE','ADMIN')), created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS ingredients (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, stock NUMERIC(12,3) NOT NULL DEFAULT 0, min_stock NUMERIC(12,3) NOT NULL DEFAULT 0, warehouse TEXT NOT NULL DEFAULT 'Main Warehouse', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS menus (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL, station TEXT NOT NULL CHECK(station IN ('BAR','KITCHEN')), active BOOLEAN DEFAULT true);
CREATE TABLE IF NOT EXISTS recipes (menu_id INTEGER REFERENCES menus(id) ON DELETE CASCADE, ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE CASCADE, qty NUMERIC(12,3) NOT NULL, PRIMARY KEY(menu_id,ingredient_id));
CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, order_no TEXT UNIQUE NOT NULL, cashier_id INTEGER REFERENCES users(id), customer_name TEXT, pax INTEGER NOT NULL, table_no INTEGER, sales_mode TEXT NOT NULL, payment_method TEXT, status TEXT NOT NULL DEFAULT 'PROCESSING', total INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE, menu_id INTEGER REFERENCES menus(id), qty INTEGER NOT NULL, unit_price INTEGER NOT NULL, station TEXT NOT NULL, modifiers JSONB NOT NULL DEFAULT '{}'::jsonb, note TEXT DEFAULT '', station_status TEXT NOT NULL DEFAULT 'NEW');
CREATE INDEX IF NOT EXISTS idx_orders_cashier ON orders(cashier_id,created_at); CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
INSERT INTO users(username,password_hash,display_name,role) VALUES ('gary','demo','Gary','CASHIER'),('headcashier','demo','Head Cashier','HEAD_CASHIER'),('warehouse','demo','Warehouse','WAREHOUSE'),('admin','demo','Admin','ADMIN') ON CONFLICT DO NOTHING;
INSERT INTO ingredients(code,name,unit,stock,min_stock) VALUES ('COFFEE_BEANS','Coffee Beans','kg',8.5,2),('MILK','Fresh Milk','L',24,5),('MATCHA','Matcha Powder','kg',2.4,.7),('CHOCOLATE','Chocolate Powder','kg',3.2,.8),('SUGAR','Sugar','kg',10,2),('ICE','Ice','kg',35,8),('BREAD','Bread','pcs',42,10),('CROISSANT','Croissant','pcs',28,8),('BANANA','Banana','kg',12,3),('RICE','Rice','kg',25,5),('CHICKEN','Chicken','kg',18,4),('POTATO','Potato','kg',20,4) ON CONFLICT DO NOTHING;
INSERT INTO menus(name,category,price,station) VALUES ('Iced Americano','COFFEE',20000,'BAR'),('Hot Cappuccino','COFFEE',20000,'BAR'),('Cafe Latte','COFFEE',25000,'BAR'),('Matcha Latte','NON COFFEE',28000,'BAR'),('Chocolate','NON COFFEE',26000,'BAR'),('Ginger Bread','FOOD',25000,'KITCHEN'),('Croissant','FOOD',22000,'KITCHEN'),('Banana Sticky Rice','FOOD',26000,'KITCHEN'),('Chicken Rice','FOOD',35000,'KITCHEN'),('French Fries','FOOD',18000,'KITCHEN') ON CONFLICT DO NOTHING;
INSERT INTO recipes(menu_id,ingredient_id,qty) SELECT m.id,i.id,v.qty FROM (VALUES ('Iced Americano','COFFEE_BEANS',.018),('Iced Americano','ICE',.18),('Iced Americano','SUGAR',.008),('Hot Cappuccino','COFFEE_BEANS',.018),('Hot Cappuccino','MILK',.18),('Hot Cappuccino','SUGAR',.008),('Cafe Latte','COFFEE_BEANS',.018),('Cafe Latte','MILK',.22),('Cafe Latte','SUGAR',.008),('Matcha Latte','MATCHA',.012),('Matcha Latte','MILK',.22),('Matcha Latte','SUGAR',.012),('Matcha Latte','ICE',.15),('Chocolate','CHOCOLATE',.02),('Chocolate','MILK',.22),('Chocolate','SUGAR',.01),('Chocolate','ICE',.15),('Ginger Bread','BREAD',1),('Croissant','CROISSANT',1),('Banana Sticky Rice','BANANA',.12),('Banana Sticky Rice','RICE',.12),('Banana Sticky Rice','SUGAR',.01),('Chicken Rice','CHICKEN',.15),('Chicken Rice','RICE',.15),('French Fries','POTATO',.18)) v(menu,code,qty) JOIN menus m ON m.name=v.menu JOIN ingredients i ON i.code=v.code ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_logs (id SERIAL PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, entity_ref TEXT, reason TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('CASHIER','HEAD_CASHIER','WAREHOUSE','ADMIN'));

-- Manual POS sellable stock, independent from warehouse ingredients/recipes.
ALTER TABLE menus ADD COLUMN IF NOT EXISTS pos_stock_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS pos_out_of_stock BOOLEAN NOT NULL DEFAULT false;

-- One-time snapshot on fresh init: seed POS stock from the previous recipe-based
-- calculation so first boot behaves like before the manual-stock switchover.
UPDATE menus m
SET pos_stock_qty = COALESCE(sub.available, 0)
FROM (
  SELECT r.menu_id, FLOOR(MIN(i.stock / r.qty)) AS available
  FROM recipes r
  JOIN ingredients i ON i.id = r.ingredient_id
  GROUP BY r.menu_id
) sub
WHERE sub.menu_id = m.id;

-- ============================================================
-- Business accounts (bookkeeping dimension, NOT login users)
-- ============================================================

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- No threshold: account reassignment is always a manual, deliberate
-- admin action — never an automated calculation.
ALTER TABLE accounts DROP COLUMN IF EXISTS sales_threshold;

INSERT INTO accounts(code, name) VALUES
  ('THE_DAUN', 'The Daun'),
  ('PT_THE_DAUN', 'PT The Daun')
ON CONFLICT (code) DO NOTHING;

-- Stamped once at order creation; never changed by editing an order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id);

UPDATE orders o
SET account_id = (SELECT id FROM accounts WHERE code = 'THE_DAUN')
WHERE account_id IS NULL;

ALTER TABLE orders ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, created_at);

-- ============================================================
-- PIN-based auth + one fixed business account per user
-- ============================================================
--
-- A user belongs to exactly ONE business account, set at creation by
-- ADMIN. There is no "active account" a cashier can switch at runtime
-- (that model — active_account_id — is replaced here). To operate a
-- different account, the same physical person is given a second,
-- separate user identity with its own username/PIN.

-- Drop the old switchable-assignment column and its PT-specific
-- reassignment mechanism (no longer applicable).
ALTER TABLE users DROP COLUMN IF EXISTS active_account_id;

-- Rename password_hash -> pin_hash: same purpose (a securely hashed
-- credential), renamed because auth is now username+PIN, not password.
ALTER TABLE users RENAME COLUMN password_hash TO pin_hash;

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Fixed account assignment for existing seed users (all onto THE_DAUN
-- by default; reassign via the Admin Settings UI as needed).
UPDATE users
SET account_id = (SELECT id FROM accounts WHERE code = 'THE_DAUN')
WHERE role IN ('CASHIER','HEAD_CASHIER','ADMIN') AND account_id IS NULL;

-- Dev seed PIN "1234" for all seed users, properly hashed
-- (scrypt, format "<salt-hex>:<hash-hex>") — never plaintext.
UPDATE users
SET pin_hash = '489358c190b707cb38670a4d32a851dc:ca56c640ce4cdd1cf2374708676bdb6f4921f0b49acb4998e5333584ab25e2b18b9b96a2178feb84c217e74d00dc70e4b72d6e2c68790f0c89bc9dd3cab3a08e'
WHERE username IN ('gary','headcashier','warehouse','admin');

-- Explicit per-account report-viewing permission for HEAD_CASHIER users.
-- Separate from role and from account_id — granted individually by ADMIN.
CREATE TABLE IF NOT EXISTS report_account_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);

-- ============================================================
-- Shifts (CASHIER / HEAD_CASHIER only — gates POS access)
-- ============================================================
--
-- A user must have an OPEN shift (ended_at IS NULL) to create orders.
-- "End Shift" is a break — ended_at is set, but they can start a new
-- shift again later the same day. "Tutup Hari" additionally writes a
-- day_closings row, which permanently blocks starting another shift
-- for that user on that calendar date.

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id, started_at);

CREATE TABLE IF NOT EXISTS day_closings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  closing_date DATE NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  transactions INTEGER NOT NULL,
  gross_sales INTEGER NOT NULL,
  items_sold INTEGER NOT NULL,
  payment_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, closing_date)
);

-- ============================================================
-- Tills (physical registers — "Kasir 1/2/3") — a dimension
-- independent from user identity and business account. Chosen once
-- per shift (at Mulai Shift), so cash/EDC settlement can be
-- reconciled per physical till even when different employees rotate
-- through the same till across different shifts.
-- ============================================================

CREATE TABLE IF NOT EXISTS tills (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO tills(code, name) VALUES
  ('KASIR_1', 'Kasir 1'),
  ('KASIR_2', 'Kasir 2'),
  ('KASIR_3', 'Kasir 3')
ON CONFLICT (code) DO NOTHING;

-- Chosen at Mulai Shift, never inferred/trusted from the client
-- afterward — every order stamps the till of whichever shift is
-- currently open for that cashier.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS till_id INTEGER REFERENCES tills(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS till_id INTEGER REFERENCES tills(id);
ALTER TABLE day_closings ADD COLUMN IF NOT EXISTS till_id INTEGER REFERENCES tills(id);

-- Allow a third station value: items that need no Bar/Kitchen prep
-- at all (e.g. bottled drinks) and should never appear in either
-- ticket queue — handled straight from the register.
ALTER TABLE menus DROP CONSTRAINT IF EXISTS menus_station_check;
ALTER TABLE menus ADD CONSTRAINT menus_station_check CHECK(station IN ('BAR','KITCHEN','KASIR'));

-- Enforced at the database level (not just app-level checks) so two
-- people can never both hold an open shift on the same till, even
-- under a race — only one row per till_id may have ended_at IS NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_active_per_till
  ON shifts(till_id)
  WHERE ended_at IS NULL AND till_id IS NOT NULL;

-- ============================================================
-- Business timezone
-- ============================================================
--
-- The database defaults to UTC. Every "today"/date-range concept in
-- this app (report defaults, shift/day-closing boundaries, ::date
-- casts) needs to mean the café's actual calendar day, not whatever
-- timezone the server happens to run in — so the database itself is
-- pinned to WIB. The frontend mirrors this by always formatting
-- dates with timeZone: 'Asia/Jakarta' rather than the viewer's
-- device timezone, so filtering and display never disagree about
-- which day an order falls on.
ALTER DATABASE cafe_pos SET timezone TO 'Asia/Jakarta';

-- ============================================================
-- Multiple closings per user per day (24-hour operation support)
-- ============================================================
--
-- A cashier may work more than one distinct shift session in the
-- same calendar day (e.g. close out at 8am, come back at 11pm) —
-- "Tutup Shift" settles the CURRENT session only, it no longer locks
-- the rest of the calendar day. So this can no longer be unique per
-- (user, date); a user may have several closings on the same date.
ALTER TABLE day_closings DROP CONSTRAINT IF EXISTS day_closings_user_id_closing_date_key;

-- ============================================================
-- PB1 tax (10%) + structured receipt numbering
-- ============================================================
--
-- `total` remains the grand total actually charged/settled (used
-- everywhere already — reports, closings, cash reconciliation).
-- `subtotal`/`tax_amount` are added purely for a proper itemized
-- receipt (Subtotal / PB1 / Grand Total). Historical orders predate
-- tax being calculated at all, so they're backfilled as
-- subtotal=total, tax_amount=0 — not retroactively taxed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount INTEGER NOT NULL DEFAULT 0;
UPDATE orders SET subtotal = total WHERE subtotal IS NULL;
ALTER TABLE orders ALTER COLUMN subtotal SET NOT NULL;

-- Atomic daily sequence for the printed receipt number
-- (IDC + YYYYMMDD + 4-digit counter, e.g. IDC202609040008) — a
-- single UPSERT per order avoids any race between tills creating
-- orders at the same moment.
CREATE TABLE IF NOT EXISTS order_sequences (
  seq_date DATE PRIMARY KEY,
  counter INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- Configurable payment methods
-- ============================================================
--
-- Previously a hardcoded CASH/CARD/QRIS list on the frontend.
-- ADMIN and HEAD_CASHIER can now add or retire methods themselves.
-- orders.payment_method stays a free TEXT column (unchanged) so
-- retiring a method here never touches historical orders.
CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO payment_methods (name, sort_order) VALUES
  ('CASH', 1),
  ('CARD', 2),
  ('QRIS / BANK', 3)
ON CONFLICT (name) DO NOTHING;
