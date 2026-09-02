import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

async function api(path, opt = {}) {
  const token = localStorage.getItem('token');

  const response = await fetch(API + path, {
    ...opt,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opt.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.message || 'Request failed');
  }

  return data;
}

const roles = {
  CASHIER: ['cashier', 'bar', 'kitchen', 'report'],
  WAREHOUSE: ['stock'],
  ADMIN: ['cashier', 'bar', 'kitchen', 'stock', 'report', 'settings'],
};

const names = {
  cashier: 'Kasir',
  bar: 'Bar',
  kitchen: 'Kitchen',
  stock: 'Warehouse',
  report: 'Reporting',
  settings: 'Settings',
};

/* =========================
   LOGIN
========================= */

function Login({ onLogin }) {
  const [username, setUsername] = useState('gary');
  const [password, setPassword] = useState('1234');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
        }),
      });

      localStorage.setItem('token', data.token);
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login">
      <form className="loginbox" onSubmit={submit}>
        <div className="logo">☕</div>

        <h1>Café POS</h1>

        <p>Login menentukan akses berdasarkan role.</p>

        <label>User</label>

        <select
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        >
          <option value="gary">Gary — Cashier</option>
          <option value="warehouse">Warehouse — Warehouse</option>
          <option value="admin">Admin — Admin</option>
        </select>

        <label>Password</label>

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
        />

        <button type="submit" disabled={loading}>
          {loading ? 'Loading...' : 'Login'}
        </button>

        {error && <div className="error">{error}</div>}

        <small>Demo password: 1234</small>
      </form>
    </div>
  );
}

/* =========================
   APP
========================= */

function App({ user, onLogout }) {
  const role = String(user?.role || '').toUpperCase();
  const availableTabs = roles[role] || [];

  const [tab, setTab] = useState(availableTabs[0] || 'report');

  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(tab)) {
      setTab(availableTabs[0]);
    }
  }, [role]);

  return (
    <>
      <header>
        <b>☕ Café POS</b>

        <span>
          {user?.name || user?.username || 'User'} · {role}

          <button type="button" onClick={onLogout}>
            Logout
          </button>
        </span>
      </header>

      <nav>
        {availableTabs.map((item) => (
          <button
            type="button"
            key={item}
            className={tab === item ? 'active' : ''}
            onClick={() => setTab(item)}
          >
            {names[item]}
          </button>
        ))}
      </nav>

      {tab === 'cashier' && <Cashier user={user} />}

      {tab === 'bar' && <Station station="BAR" />}

      {tab === 'kitchen' && <Station station="KITCHEN" />}

      {tab === 'stock' && <Stock />}

      {tab === 'report' && <Report user={user} />}

      {tab === 'settings' && <Settings />}
    </>
  );
}

/* =========================
   CASHIER
========================= */

function Cashier({ user }) {
  const [menus, setMenus] = useState([]);
  const [cart, setCart] = useState([]);
  const [orders, setOrders] = useState([]);

  const [mode, setMode] = useState('DINE IN');
  const [table, setTable] = useState(1);
  const [customer, setCustomer] = useState('Walk-in Customer');
  const [pax, setPax] = useState(1);
  const [payment, setPayment] = useState('CASH');

  const [edit, setEdit] = useState(null);
  const [category, setCategory] = useState('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [customizeMenu, setCustomizeMenu] = useState(null);
  const [sweetness, setSweetness] = useState('100%');
  const [note, setNote] = useState('');

  async function load() {
    try {
      const [menuData, orderData] = await Promise.all([
        api('/menus'),
        api('/orders'),
      ]);

      setMenus(Array.isArray(menuData) ? menuData : []);
      setOrders(Array.isArray(orderData) ? orderData : []);
    } catch (err) {
      alert(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filteredMenus = useMemo(() => {
    const query = search.toLowerCase().trim();

    return menus.filter((menu) => {
      const matchesCategory =
        category === 'ALL' || menu.category === category;

      const matchesSearch =
        !query ||
        String(menu.name || '').toLowerCase().includes(query);

      return matchesCategory && matchesSearch;
    });
  }, [menus, category, search]);

  const total = cart.reduce((sum, item) => {
    const menu = menus.find((m) => m.id === item.menuId);
    const price = Number(menu?.price || 0);

    return sum + item.qty * price;
  }, 0);

  function openMenu(menu) {
    const currentQty = cart
      .filter((item) => item.menuId === menu.id)
      .reduce((sum, item) => sum + item.qty, 0);

    const available = Number(menu.available_qty || 0);

    if (currentQty >= available) return;

    setCustomizeMenu(menu);
    setSweetness('100%');
    setNote('');
  }

  function addCustomizedMenu() {
    if (!customizeMenu) return;

    const menu = customizeMenu;
    const currentQty = cart
      .filter((item) => item.menuId === menu.id)
      .reduce((sum, item) => sum + item.qty, 0);
    const available = Number(menu.available_qty || 0);

    if (currentQty >= available) return;

    const modifiers = menu.category === 'FOOD'
      ? {}
      : { sweetness };
    const cleanNote = note.trim();

    setCart((current) => {
      const existing = current.find(
        (item) =>
          item.menuId === menu.id &&
          JSON.stringify(item.modifiers || {}) === JSON.stringify(modifiers) &&
          (item.note || '') === cleanNote
      );

      if (existing) {
        return current.map((item) =>
          item === existing ? { ...item, qty: item.qty + 1 } : item
        );
      }

      return [
        ...current,
        {
          menuId: menu.id,
          name: menu.name,
          qty: 1,
          modifiers,
          note: cleanNote,
        },
      ];
    });

    setCustomizeMenu(null);
    setNote('');
    setSweetness('100%');
  }

  function increaseItem(index) {
    setCart((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, qty: item.qty + 1 } : item
      )
    );
  }

  function decreaseItem(index) {
    setCart((current) =>
      current.flatMap((item, itemIndex) => {
        if (itemIndex !== index) return [item];
        if (item.qty > 1) return [{ ...item, qty: item.qty - 1 }];
        return [];
      })
    );
  }

  function startEdit(order) {
    setEdit(order);

    setCustomer(order.customer_name || 'Walk-in Customer');
    setPax(Number(order.pax || 1));
    setTable(Number(order.table_no || 1));
    setMode(order.sales_mode || 'DINE IN');
    setPayment(order.payment_method || 'CASH');

    setCart(
      Array.isArray(order.items)
        ? order.items.map((item) => ({
            menuId: item.menuId,
            name: item.name,
            qty: Number(item.qty || 1),
            modifiers: item.modifiers || {},
            note: item.note || '',
          }))
        : []
    );
  }

  function resetOrder() {
    setCart([]);
    setEdit(null);
    setCustomer('Walk-in Customer');
    setPax(1);
    setTable(1);
    setMode('DINE IN');
    setPayment('CASH');
  }

  async function saveOrder() {
    if (!cart.length) {
      return;
    }

    setLoading(true);

    try {
      const body = {
        customerName: customer,
        pax: Number(pax),
        tableNo: mode === 'DINE IN' ? Number(table) : null,
        salesMode: mode,
        paymentMethod: payment,
        items: cart,
      };

      if (edit) {
        await api('/orders/' + edit.id, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await api('/orders', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }

      resetOrder();
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid">
      <section className="panel">
        <div className="toolbar">
          <input
            placeholder="Cari menu..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />

          {['ALL', 'COFFEE', 'NON COFFEE', 'FOOD'].map((item) => (
            <button
              type="button"
              key={item}
              className={category === item ? 'sel' : ''}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="menus">
          {filteredMenus.map((menu) => {
            const selectedQty = cart
              .filter((item) => item.menuId === menu.id)
              .reduce((sum, item) => sum + item.qty, 0);

            const available = Number(menu.available_qty || 0);
            const soldOut = available <= 0;
            const limitReached = selectedQty >= available;

            return (
              <button
                type="button"
                key={menu.id}
                disabled={soldOut || limitReached}
                onClick={() => openMenu(menu)}
                className="menu"
              >
                <strong>{menu.name}</strong>

                <span>
                  {menu.station} · Rp
                  {Number(menu.price || 0).toLocaleString('id-ID')}
                </span>

                <small>
                  {available > 0
                    ? `Sisa ${available} menu`
                    : 'Habis'}
                </small>
              </button>
            );
          })}
        </div>

        <div className="history">
          <h3>Transaksi Kasir</h3>

          {orders.slice(0, 10).map((order) => (
            <div
              className="historyrow"
              key={order.id || order.order_no}
            >
              <span>
                {order.order_no}

                <small>
                  {order.payment_method || '-'}
                </small>
              </span>

              <b>
                Rp
                {Number(order.total || 0).toLocaleString('id-ID')}
              </b>

              <button
                type="button"
                onClick={() => startEdit(order)}
              >
                Edit Receipt
              </button>
            </div>
          ))}
        </div>
      </section>

      <aside className="panel cart">
        <h3>
          {edit
            ? `✏️ Edit ${edit.order_no}`
            : 'New Order'}
        </h3>

        <input
          value={customer}
          onChange={(event) => setCustomer(event.target.value)}
          placeholder="Customer"
        />

        <div className="line">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="DINE IN">DINE IN</option>
            <option value="TAKE AWAY">TAKE AWAY</option>
          </select>

          {mode === 'DINE IN' && (
            <select
              value={table}
              onChange={(event) =>
                setTable(Number(event.target.value))
              }
            >
              {Array.from({ length: 12 }, (_, index) => (
                <option
                  key={index + 1}
                  value={index + 1}
                >
                  Table {index + 1}
                </option>
              ))}
            </select>
          )}

          <select
            value={pax}
            onChange={(event) =>
              setPax(Number(event.target.value))
            }
          >
            {[1, 2, 3, 4, 5, 6].map((value) => (
              <option key={value} value={value}>
                {value} Pax
              </option>
            ))}
          </select>
        </div>

        {cart.length === 0 ? (
          <p className="empty">Belum ada item</p>
        ) : (
          cart.map((item) => {
            const menu = menus.find(
              (m) => m.id === item.menuId
            );

            const price = Number(menu?.price || 0);

            return (
              <div
                className="cartitem"
                key={item.menuId + '-' + index}
              >
                <span>
                  {item.name}

                  <small>
                    {item.qty} × Rp
                    {price.toLocaleString('id-ID')}
                  </small>

                  {item.modifiers?.sweetness && (
                    <small>Sweetness: {item.modifiers.sweetness}</small>
                  )}

                  {item.note && (
                    <small>Note: {item.note}</small>
                  )}
                </span>

                <div>
                  <button
                    type="button"
                    onClick={() => increaseItem(index)}
                  >
                    +
                  </button>

                  <button
                    type="button"
                    onClick={() => decreaseItem(index)}
                  >
                    −
                  </button>
                </div>
              </div>
            );
          })
        )}

        <hr />

        <div className="total">
          <span>Total</span>

          <b>
            Rp{total.toLocaleString('id-ID')}
          </b>
        </div>

        {customizeMenu && (
          <div className="modalbackdrop" onClick={() => setCustomizeMenu(null)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h3>{customizeMenu.name}</h3>

              {customizeMenu.category !== 'FOOD' && (
                <>
                  <label>Sweetness</label>
                  <div className="sweetness-options">
                    {['0%', '25%', '50%', '75%', '100%'].map((value) => (
                      <button
                        type="button"
                        key={value}
                        className={sweetness === value ? 'sel' : ''}
                        onClick={() => setSweetness(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <label>Notes</label>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Contoh: less ice, no onion, extra sauce..."
                rows={3}
              />

              <div className="modal-actions">
                <button type="button" onClick={() => setCustomizeMenu(null)}>Cancel</button>
                <button type="button" className="primary" onClick={addCustomizedMenu}>
                  Tambah ke Order
                </button>
              </div>
            </div>
          </div>
        )}

        <select
          value={payment}
          onChange={(event) =>
            setPayment(event.target.value)
          }
        >
          <option value="CASH">CASH</option>
          <option value="CARD">CARD</option>
          <option value="QRIS / BANK">
            QRIS / BANK
          </option>
        </select>

        <button
          type="button"
          className="primary"
          disabled={!cart.length || loading}
          onClick={saveOrder}
        >
          {loading
            ? 'Processing...'
            : edit
            ? 'Simpan Receipt'
            : 'Payment'}
        </button>

        {edit && (
          <button
            type="button"
            onClick={resetOrder}
          >
            Cancel Edit
          </button>
        )}
      </aside>
    </main>
  );
}

/* =========================
   BAR / KITCHEN
========================= */

function Station({ station }) {
  const [data, setData] = useState([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      setError('');

      const result = await api(
        '/station/' + station
      );

      setData(Array.isArray(result) ? result : []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();

    const interval = setInterval(load, 2500);

    return () => clearInterval(interval);
  }, [station]);

  async function advance(id, status) {
    try {
      await api(
        '/order-items/' + id + '/status',
        {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        }
      );

      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <main className="page">
      <h2>
        {station === 'BAR'
          ? '🍹 Bar'
          : '🍳 Kitchen'}
      </h2>

      {error && (
        <div className="error">
          {error}
        </div>
      )}

      <div className="tickets">
        {data.map((order) => (
          <div
            className="ticket"
            key={order.order_no || order.id}
          >
            <b>{order.order_no}</b>

            <small>
              {order.customer_name || 'Walk-in'} ·{' '}
              {order.cashier || '-'}
            </small>

            {(order.items || []).map((item) => (
              <div
                className="ticketitem"
                key={item.id}
              >
                <b>
                  {item.qty}× {item.name}
                </b>

                {item.modifiers?.sweetness && (
                  <small>Sweetness: {item.modifiers.sweetness}</small>
                )}

                {item.note && (
                  <small>Note: {item.note}</small>
                )}

                <small>{item.status}</small>

                {item.status !== 'READY' && (
                  <button
                    type="button"
                    onClick={() =>
                      advance(
                        item.id,
                        item.status === 'NEW'
                          ? 'PREPARING'
                          : 'READY'
                      )
                    }
                  >
                    {item.status === 'NEW'
                      ? 'Mulai'
                      : 'Ready'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}

/* =========================
   WAREHOUSE
========================= */

function Stock() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    try {
      const result = await api('/inventory');

      setData(Array.isArray(result) ? result : []);
    } catch (err) {
      alert(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function editStock(item) {
    const value = prompt(
      'Stock baru',
      item.stock
    );

    if (value === null) {
      return;
    }

    const stock = Number(value);

    if (!Number.isFinite(stock) || stock < 0) {
      alert('Stock harus berupa angka >= 0');
      return;
    }

    setLoading(true);

    try {
      await api(
        '/inventory/' + item.id,
        {
          method: 'PUT',
          body: JSON.stringify({ stock }),
        }
      );

      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <h2>📦 Warehouse</h2>

      <p>
        Stok warehouse menjadi sumber
        perhitungan ketersediaan menu di kasir.
      </p>

      <table>
        <thead>
          <tr>
            <th>Ingredient</th>
            <th>Stock</th>
            <th>Min</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>

        <tbody>
          {data.map((item) => {
            const stock = Number(item.stock || 0);
            const minStock = Number(
              item.min_stock || 0
            );

            const status =
              stock <= 0
                ? 'OUT'
                : stock <= minStock
                ? 'LOW'
                : 'AVAILABLE';

            return (
              <tr key={item.id}>
                <td>{item.name}</td>

                <td>
                  {stock} {item.unit}
                </td>

                <td>
                  {minStock} {item.unit}
                </td>

                <td>{status}</td>

                <td>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() =>
                      editStock(item)
                    }
                  >
                    Update
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

/* =========================
   REPORT
========================= */

function Report({ user }) {
  const [payment, setPayment] = useState('');
  const [cashier, setCashier] = useState('');
  const [data, setData] = useState(null);
  const [cashiers, setCashiers] = useState([]);
  const [error, setError] = useState('');

  const role = String(
    user?.role || ''
  ).toUpperCase();

  async function load() {
    try {
      setError('');

      const params = new URLSearchParams();

      if (payment) {
        params.set('payment', payment);
      }

      if (cashier) {
        params.set('cashier', cashier);
      }

      const result = await api(
        '/reports?' + params.toString()
      );

      setData(result);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();

    if (role === 'ADMIN') {
      api('/cashiers')
        .then((result) => {
          setCashiers(
            Array.isArray(result)
              ? result
              : []
          );
        })
        .catch(() => {
          setCashiers([]);
        });
    }
  }, [payment, cashier, role]);

  return (
    <main className="page">
      <h2>📊 Reporting</h2>

      <p>
        {role === 'ADMIN'
          ? 'Semua kasir'
          : `Transaksi ${
              user?.name || ''
            }`}
      </p>

      {error && (
        <div className="error">
          {error}
        </div>
      )}

      <div className="filters">
        <select
          value={payment}
          onChange={(event) =>
            setPayment(event.target.value)
          }
        >
          <option value="">
            Semua Payment
          </option>

          <option value="CASH">CASH</option>

          <option value="CARD">CARD</option>

          <option value="QRIS / BANK">
            QRIS / BANK
          </option>
        </select>

        {role === 'ADMIN' && (
          <select
            value={cashier}
            onChange={(event) =>
              setCashier(event.target.value)
            }
          >
            <option value="">
              Semua Kasir
            </option>

            {cashiers.map((item) => (
              <option
                key={item.id}
                value={item.id}
              >
                {item.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {data && (
        <>
          <div className="stats">
            <div>
              Transactions
              <b>
                {Number(
                  data.summary?.transactions || 0
                )}
              </b>
            </div>

            <div>
              Gross Sales
              <b>
                Rp
                {Number(
                  data.summary?.grossSales || 0
                ).toLocaleString('id-ID')}
              </b>
            </div>

            <div>
              Items Sold
              <b>
                {Number(
                  data.summary?.itemsSold || 0
                )}
              </b>
            </div>
          </div>

          <h3>Sales by Menu</h3>

          <table>
            <thead>
              <tr>
                <th>Menu</th>
                <th>Qty</th>
                <th>Total Uang</th>
              </tr>
            </thead>

            <tbody>
              {(data.sales || []).map((item) => (
                <tr key={item.id || item.name}>
                  <td>{item.name}</td>

                  <td>{item.qty}</td>

                  <td>
                    Rp
                    {Number(
                      item.revenue || 0
                    ).toLocaleString('id-ID')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}

/* =========================
   SETTINGS
========================= */

function Settings() {
  return (
    <main className="page">
      <h2>⚙️ Settings</h2>

      <div className="cards">
        <div>
          Master Menu
          <br />
          <small>
            Menu, price, recipe, station
          </small>
        </div>

        <div>
          Master User
          <br />
          <small>
            Cashier, Warehouse, Admin
          </small>
        </div>

        <div>
          Payment
          <br />
          <small>
            CASH, CARD, QRIS / BANK
          </small>
        </div>

        <div>
          End of Day
          <br />
          <small>
            Closing dan rekap
          </small>
        </div>
      </div>
    </main>
  );
}

/* =========================
   ROOT
========================= */

function Root() {
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] =
    useState(true);

  useEffect(() => {
    const token =
      localStorage.getItem('token');

    if (!token) {
      setCheckingAuth(false);
      return;
    }

    api('/me')
      .then((currentUser) => {
        setUser(currentUser);
      })
      .catch(() => {
        localStorage.removeItem('token');
        setUser(null);
      })
      .finally(() => {
        setCheckingAuth(false);
      });
  }, []);

  if (checkingAuth) {
    return (
      <div className="login">
        <div className="loginbox">
          <div className="logo">☕</div>
          <h1>Café POS</h1>
          <p>Checking login...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <App
      user={user}
      onLogout={() => {
        localStorage.removeItem('token');
        setUser(null);
      }}
    />
  );
}

createRoot(
  document.getElementById('root')
).render(<Root />);