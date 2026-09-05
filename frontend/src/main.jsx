import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import daunLogo from './assets/daun-logo.png';
import daunLogoLight from './assets/daun-logo-light.png';

// Fixed shop info printed on every receipt — same physical café
// regardless of which business account (The Daun / PT The Daun)
// processed the sale, so this isn't derived per-order.
const SHOP = {
  name: 'THE DAUN',
  address: 'PUNCAK - BOGOR\nJl. Pasir Panjang - Cisarua',
  contact: 'IG: @thedaun.official / TikTok: thedaun.official',
  footer1: 'Terima Kasih atas Kunjungan Anda.',
  footer2: 'Selamat Datang Kembali.',
  wifi: 'Wifi: The Daun Wifi / Password: tersimpankenangan',
  tagline: 'Di Setiap Daun Tersimpan Kenangan',
};

const TAX_RATE = 0.1; // PB1 restaurant tax, 10% of subtotal — mirrors backend/src/server.js

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

async function deleteOrder(order, afterDelete) {
  const confirmed = window.confirm(
    `Hapus transaksi ${order.order_no}?`
  );
  if (!confirmed) return;

  const reason = window.prompt(
    'Masukkan alasan penghapusan transaksi (minimal 5 karakter):'
  );
  if (!reason || reason.trim().length < 5) {
    alert('Penghapusan dibatalkan. Alasan minimal 5 karakter wajib diisi.');
    return;
  }

  try {
    await api('/orders/' + order.id, {
      method: 'DELETE',
      body: JSON.stringify({ reason: reason.trim() }),
    });
    if (afterDelete) await afterDelete();
    alert(`Transaksi ${order.order_no} berhasil dihapus.`);
  } catch (err) {
    alert(err.message);
  }
}

const roles = {
  CASHIER: ['cashier', 'report'],
  HEAD_CASHIER: ['cashier', 'report'],
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

const tabIcons = {
  cashier: '🧾',
  bar: '🍹',
  kitchen: '🍳',
  stock: '📦',
  report: '📊',
  settings: '⚙️',
};

const menuEmoji = {
  'Iced Americano': '🥤',
  'Hot Cappuccino': '☕',
  'Cafe Latte': '☕',
  'Matcha Latte': '🍵',
  'Chocolate': '🍫',
  'Ginger Bread': '🍪',
  'Croissant': '🥐',
  'Banana Sticky Rice': '🍌',
  'Chicken Rice': '🍗',
  'French Fries': '🍟',
};

const categoryEmoji = {
  COFFEE: '☕',
  'NON COFFEE': '🍵',
  FOOD: '🍽️',
};

function menuIcon(menu) {
  return menuEmoji[menu.name] || categoryEmoji[menu.category] || '🍽️';
}

/* =========================
   NUMERIC KEYPAD (touchscreen)
========================= */

function NumericKeypad({ title, initialValue, min = 0, onConfirm, onCancel }) {
  const [value, setValue] = useState(
    initialValue === null || initialValue === undefined ? '' : String(initialValue)
  );

  function press(digit) {
    setValue((current) => (current === '0' ? String(digit) : current + String(digit)));
  }

  function backspace() {
    setValue((current) => current.slice(0, -1));
  }

  function confirm() {
    const num = Number(value);

    if (value === '' || !Number.isFinite(num) || num < min) {
      alert(`Masukkan angka >= ${min}`);
      return;
    }

    onConfirm(num);
  }

  return (
    <div className="modalbackdrop" onClick={onCancel}>
      <div className="modal keypadmodal" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>

        <div className="keypaddisplay">{value === '' ? '0' : value}</div>

        <div className="keypadgrid">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
            <button type="button" key={digit} onClick={() => press(digit)}>
              {digit}
            </button>
          ))}

          <button type="button" onClick={() => setValue('')}>
            C
          </button>

          <button type="button" onClick={() => press(0)}>
            0
          </button>

          <button type="button" onClick={backspace}>
            ⌫
          </button>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>

          <button type="button" className="primary" onClick={confirm}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================
   PIN PAD (masked, preserves leading zeros — distinct from
   NumericKeypad, which is unsuitable for a secret PIN because it
   Number()-converts and displays the raw value)
========================= */

function PinPad({ title, onConfirm, onCancel, error }) {
  const [value, setValue] = useState('');
  const maxLength = 6;

  function press(digit) {
    setValue((current) =>
      current.length >= maxLength ? current : current + String(digit)
    );
  }

  function backspace() {
    setValue((current) => current.slice(0, -1));
  }

  function confirm() {
    if (!value) return;
    onConfirm(value);
  }

  return (
    <div className="modalbackdrop" onClick={onCancel}>
      <div className="modal keypadmodal" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>

        <div className="keypaddisplay pindisplay">
          {value ? '•'.repeat(value.length) : '—'}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="keypadgrid">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
            <button type="button" key={digit} onClick={() => press(digit)}>
              {digit}
            </button>
          ))}

          <button type="button" onClick={() => setValue('')}>
            C
          </button>

          <button type="button" onClick={() => press(0)}>
            0
          </button>

          <button type="button" onClick={backspace}>
            ⌫
          </button>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>

          <button type="button" className="primary" onClick={confirm}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================
   LOGIN
========================= */

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [showPinPad, setShowPinPad] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function openPinPad(event) {
    event.preventDefault();

    if (!username.trim()) {
      setError('Masukkan username terlebih dahulu');
      return;
    }

    setError('');
    setShowPinPad(true);
  }

  async function submitPin(pin) {
    setError('');
    setLoading(true);

    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          pin,
        }),
      });

      localStorage.setItem('token', data.token);
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
      setShowPinPad(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login">
      <form className="loginbox" onSubmit={openPinPad}>
        <img src={daunLogo} className="brandlogo" alt="The Daun" />

        <h1>POS System</h1>

        <p>Masukkan username, lalu PIN.</p>

        <label>Username</label>

        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Username"
          autoFocus
        />

        <button type="submit" disabled={loading}>
          {loading ? 'Loading...' : 'Lanjut'}
        </button>

        {error && !showPinPad && <div className="error">{error}</div>}
      </form>

      {showPinPad && (
        <PinPad
          title={`PIN — ${username}`}
          error={error}
          onConfirm={submitPin}
          onCancel={() => {
            setShowPinPad(false);
            setError('');
          }}
        />
      )}
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
  const [barCount, setBarCount] = useState(0);
  const [kitchenCount, setKitchenCount] = useState(0);
  const [now, setNow] = useState(new Date());
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(tab)) {
      setTab(availableTabs[0]);
    }
  }, [role]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const hasBar = availableTabs.includes('bar');
    const hasKitchen = availableTabs.includes('kitchen');

    if (!hasBar && !hasKitchen) return;

    async function pollStations() {
      try {
        if (hasBar) {
          const result = await api('/station/BAR');
          setBarCount(Array.isArray(result) ? result.length : 0);
        }

        if (hasKitchen) {
          const result = await api('/station/KITCHEN');
          setKitchenCount(Array.isArray(result) ? result.length : 0);
        }
      } catch {
        // silent — badge just won't update this cycle
      }
    }

    pollStations();

    const interval = setInterval(pollStations, 2500);

    return () => clearInterval(interval);
  }, [role]);

  return (
    <>
      <header>
        <img src={daunLogoLight} className="headerlogo" alt="The Daun" />

        <span>
          {formatTime(now)} ·{' '}
          {user?.name || user?.username || 'User'} · {role}

          <button type="button" onClick={() => setShowLogoutConfirm(true)}>
            Logout
          </button>
        </span>
      </header>

      {showLogoutConfirm && (
        <div className="modalbackdrop" onClick={() => setShowLogoutConfirm(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Logout?</h3>
            <p>Kamu akan keluar dari sesi ini. Pastikan pekerjaanmu sudah tersimpan.</p>

            <div className="modal-actions">
              <button type="button" onClick={() => setShowLogoutConfirm(false)}>
                Batal
              </button>
              <button type="button" className="danger" onClick={onLogout}>
                Ya, Logout
              </button>
            </div>
          </div>
        </div>
      )}

      <nav>
        {availableTabs.map((item) => (
          <button
            type="button"
            key={item}
            className={tab === item ? 'active' : ''}
            onClick={() => setTab(item)}
          >
            {tabIcons[item]} {names[item]}

            {item === 'bar' && barCount > 0 && (
              <span className="badge">{barCount}</span>
            )}

            {item === 'kitchen' && kitchenCount > 0 && (
              <span className="badge">{kitchenCount}</span>
            )}
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

  const [mode, setMode] = useState('DINE IN');
  const [table, setTable] = useState(null);
  const [customer, setCustomer] = useState('');
  const [pax, setPax] = useState(1);
  const [payment, setPayment] = useState('CASH');

  const [orderStarted, setOrderStarted] = useState(false);
  const [showNewOrderModal, setShowNewOrderModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  const [edit, setEdit] = useState(null);
  const [category, setCategory] = useState('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [editingCartItem, setEditingCartItem] = useState(null);
  const [sweetness, setSweetness] = useState('100%');
  const [note, setNote] = useState('');
  const [qtyKeypadIndex, setQtyKeypadIndex] = useState(null);
  const [stockKeypadMenu, setStockKeypadMenu] = useState(null);
  const [paymentMethods, setPaymentMethods] = useState(['CASH', 'CARD', 'QRIS / BANK']);

  const usesShifts = user?.role === 'CASHIER' || user?.role === 'HEAD_CASHIER';
  const [shiftStatus, setShiftStatus] = useState(null);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [closingReport, setClosingReport] = useState(null);
  const [receiptData, setReceiptData] = useState(null);
  const [tills, setTills] = useState([]);
  const [showTillPicker, setShowTillPicker] = useState(false);
  const [showCloseDayConfirm, setShowCloseDayConfirm] = useState(false);

  async function load() {
    try {
      const menuData = await api('/menus');

      setMenus(Array.isArray(menuData) ? menuData : []);
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadShiftStatus() {
    if (!usesShifts) return;

    try {
      setShiftStatus(await api('/shifts/status'));
    } catch {
      // silent — shift bar just won't update this cycle
    }
  }

  useEffect(() => {
    load();
    loadShiftStatus();

    if (usesShifts) {
      api('/tills')
        .then((result) => setTills(Array.isArray(result) ? result : []))
        .catch(() => setTills([]));
    }

    api('/payment-methods')
      .then((result) => {
        const names = Array.isArray(result) ? result.map((m) => m.name) : [];
        if (names.length) setPaymentMethods(names);
      })
      .catch(() => {
        // silent — falls back to the default CASH/CARD/QRIS list
      });
  }, []);

  async function confirmStartShift(tillId) {
    setShowTillPicker(false);
    setShiftLoading(true);

    try {
      await api('/shifts/start', {
        method: 'POST',
        body: JSON.stringify({ tillId }),
      });
      await loadShiftStatus();
    } catch (err) {
      alert(err.message);
    } finally {
      setShiftLoading(false);
    }
  }

  async function endShift() {
    const confirmed = window.confirm(
      'Istirahat sekarang? Kamu masih bisa mulai shift lagi nanti hari ini.'
    );
    if (!confirmed) return;

    setShiftLoading(true);

    try {
      await api('/shifts/end', { method: 'POST' });
      await loadShiftStatus();
    } catch (err) {
      alert(err.message);
    } finally {
      setShiftLoading(false);
    }
  }

  async function confirmCloseDay() {
    setShowCloseDayConfirm(false);
    setShiftLoading(true);

    const tillName = shiftStatus?.shift?.till_name;

    try {
      const closing = await api('/shifts/close-shift', { method: 'POST' });
      setClosingReport({ ...closing, tillName, cashierName: user?.name });
      await loadShiftStatus();
    } catch (err) {
      alert(err.message);
    } finally {
      setShiftLoading(false);
    }
  }

  function printRecap() {
    // Only one print-only block should ever be in the DOM at once —
    // clear the other kind so a stale one can't also turn visible.
    setReceiptData(null);
    setTimeout(() => window.print(), 50);
  }

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

  const subtotal = cart.reduce((sum, item) => {
    const menu = menus.find((m) => m.id === item.menuId);
    const price = Number(menu?.price || 0);

    return sum + item.qty * price;
  }, 0);
  const taxAmount = Math.round(subtotal * TAX_RATE);
  const total = subtotal + taxAmount;

  function openStockKeypad(menu, event) {
    event.stopPropagation();
    setStockKeypadMenu(menu);
  }

  async function submitStockKeypad(qty) {
    const menu = stockKeypadMenu;
    setStockKeypadMenu(null);

    try {
      await api('/menus/' + menu.id + '/pos-stock', {
        method: 'PUT',
        body: JSON.stringify({
          pos_stock_qty: qty,
          pos_out_of_stock: false,
        }),
      });

      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function toggleOutOfStock(menu, event) {
    event.stopPropagation();

    try {
      await api('/menus/' + menu.id + '/pos-stock', {
        method: 'PUT',
        body: JSON.stringify({
          pos_out_of_stock: !menu.pos_out_of_stock,
        }),
      });

      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  function openNewOrder() {
    setCustomer('');
    setPax(1);
    setMode('DINE IN');
    setTable(null);
    setShowNewOrderModal(true);
  }

  function startOrder() {
    if (!customer.trim()) {
      alert('Nama customer wajib diisi');
      return;
    }

    if (!table) {
      alert('Pilih nomor pager terlebih dahulu');
      return;
    }

    setOrderStarted(true);
    setShowNewOrderModal(false);
  }

  function addMenuToCart(menu) {
    if (!orderStarted && !edit) {
      alert('Klik "+ New Order" terlebih dahulu');
      return;
    }

    const currentQty = cart
      .filter((item) => item.menuId === menu.id)
      .reduce((sum, item) => sum + item.qty, 0);

    const available = Number(menu.available_qty || 0);

    if (currentQty >= available) return;

    const modifiers = menu.category === 'FOOD' ? {} : { sweetness: '100%' };

    setCart((current) => {
      const existing = current.find(
        (item) =>
          item.menuId === menu.id &&
          JSON.stringify(item.modifiers || {}) === JSON.stringify(modifiers) &&
          !item.note
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
          note: '',
        },
      ];
    });
  }

  function openEditCartItem(index) {
    const item = cart[index];
    const menu = menus.find((m) => m.id === item.menuId);

    setEditingCartItem({ index, category: menu?.category });
    setSweetness(item.modifiers?.sweetness || '100%');
    setNote(item.note || '');
  }

  function saveCartItemEdit() {
    if (!editingCartItem) return;

    const modifiers =
      editingCartItem.category === 'FOOD' ? {} : { sweetness };
    const cleanNote = note.trim();

    setCart((current) =>
      current.map((item, index) =>
        index === editingCartItem.index
          ? { ...item, modifiers, note: cleanNote }
          : item
      )
    );

    setEditingCartItem(null);
    setNote('');
    setSweetness('100%');
  }

  function removeCartItem(index) {
    setCart((current) => current.filter((_, i) => i !== index));
    setEditingCartItem(null);
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

  function submitQtyKeypad(qty) {
    setCart((current) =>
      current.flatMap((item, index) => {
        if (index !== qtyKeypadIndex) return [item];
        if (qty <= 0) return [];
        return [{ ...item, qty }];
      })
    );

    setQtyKeypadIndex(null);
  }

  function resetOrder() {
    setCart([]);
    setEdit(null);
    setOrderStarted(false);
    setCustomer('');
    setPax(1);
    setTable(null);
    setMode('DINE IN');
    setPayment('CASH');
  }

  async function confirmPayment(method) {
    setPayment(method);
    setShowPaymentModal(false);
    await saveOrder(method);
  }

  async function saveOrder(paymentMethod) {
    if (!cart.length) {
      return;
    }

    setLoading(true);

    try {
      const body = {
        customerName: customer,
        pax: Number(pax),
        tableNo: Number(table),
        salesMode: mode,
        paymentMethod: paymentMethod || payment,
        items: cart,
      };

      if (edit) {
        await api('/orders/' + edit.id, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        const created = await api('/orders', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        // Only one print-only block should ever be in the DOM at
        // once — clear the other kind so a stale one can't also
        // turn visible during this print.
        setClosingReport(null);
        setReceiptData(created);
        setTimeout(() => window.print(), 150);
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

        {usesShifts && shiftStatus && (
          <div className={`shiftbar shift-${shiftStatus.state.toLowerCase()}`}>
            {shiftStatus.state === 'NOT_STARTED' && (
              <>
                <span>Shift belum dimulai</span>
                <button
                  type="button"
                  className="primary"
                  disabled={shiftLoading}
                  onClick={() => setShowTillPicker(true)}
                >
                  ▶ Mulai Shift
                </button>
              </>
            )}

            {shiftStatus.state === 'ACTIVE' && (
              <>
                <span>
                  🟢 {shiftStatus.shift.till_name || 'Shift'} aktif sejak{' '}
                  {formatTime(shiftStatus.shift.started_at)}
                </span>
                <button type="button" disabled={shiftLoading} onClick={endShift}>
                  ⏸ Istirahat
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={shiftLoading}
                  onClick={() => setShowCloseDayConfirm(true)}
                >
                  🔒 Tutup Shift
                </button>
              </>
            )}

            {shiftStatus.state === 'ON_BREAK' && (
              <>
                <span>⏸ Sedang istirahat</span>
                <button
                  type="button"
                  className="primary"
                  disabled={shiftLoading}
                  onClick={() => setShowTillPicker(true)}
                >
                  ▶ Lanjut Shift
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={shiftLoading}
                  onClick={() => setShowCloseDayConfirm(true)}
                >
                  🔒 Tutup Shift
                </button>
              </>
            )}
          </div>
        )}

        {showTillPicker && (
          <div className="modalbackdrop" onClick={() => setShowTillPicker(false)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h3>Pakai Kasir Berapa?</h3>
              <p>Pilih nomor kasir/till yang kamu pakai untuk shift ini.</p>

              <div className="tillpicker">
                {tills.map((till) => (
                  <button
                    type="button"
                    key={till.id}
                    disabled={shiftLoading}
                    onClick={() => confirmStartShift(till.id)}
                  >
                    {till.name}
                  </button>
                ))}
              </div>

              <div className="modal-actions">
                <button type="button" onClick={() => setShowTillPicker(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {showCloseDayConfirm && (
          <div className="modalbackdrop" onClick={() => setShowCloseDayConfirm(false)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h3>🔒 Tutup Shift?</h3>
              <p>
                Shift ini akan ditutup dan disettle (rekap cash/EDC dibuat). Kamu{' '}
                <b>tetap bisa mulai shift baru kapan saja</b>, termasuk hari ini juga —
                ini cuma menutup sesi kerja saat ini, bukan mengunci seharian. Pastikan
                semua transaksi sesi ini sudah benar.
              </p>

              <div className="modal-actions">
                <button type="button" onClick={() => setShowCloseDayConfirm(false)}>
                  Batal
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={shiftLoading}
                  onClick={confirmCloseDay}
                >
                  Ya, Tutup Shift Sekarang
                </button>
              </div>
            </div>
          </div>
        )}

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

          {!orderStarted && !edit && (
            <button
              type="button"
              className="secondary"
              disabled={usesShifts && shiftStatus?.state !== 'ACTIVE'}
              onClick={openNewOrder}
            >
              ＋ New Order
            </button>
          )}
        </div>

        <div className="menus">
          {filteredMenus.map((menu) => {
            const selectedQty = cart
              .filter((item) => item.menuId === menu.id)
              .reduce((sum, item) => sum + item.qty, 0);

            const available = Number(menu.available_qty || 0);
            const soldOut = available <= 0;
            const limitReached = selectedQty >= available;
            const availabilityClass = soldOut
              ? 'unavailable'
              : available <= 3
              ? 'limited'
              : 'available';

            return (
              <div className="menuwrap" key={menu.id}>
                <button
                  type="button"
                  disabled={soldOut || limitReached}
                  onClick={() => addMenuToCart(menu)}
                  className="menu"
                >
                  <div className="menuicon">{menuIcon(menu)}</div>

                  <strong className="menuname">{menu.name}</strong>

                  <div className="menumeta">
                    <span className="menuprice">
                      Rp{Number(menu.price || 0).toLocaleString('id-ID')}
                    </span>

                    <span className="menustation">{menu.station}</span>
                  </div>

                  <small className={`availability ${availabilityClass}`}>
                    {available > 0
                      ? `Sisa ${available} menu`
                      : 'Habis'}
                  </small>
                </button>

                {(user?.role === 'HEAD_CASHIER' || user?.role === 'ADMIN') && (
                  <div className="menustock">
                    <button
                      type="button"
                      onClick={(event) => openStockKeypad(menu, event)}
                    >
                      Set Stok
                    </button>

                    <button
                      type="button"
                      onClick={(event) => toggleOutOfStock(menu, event)}
                    >
                      {menu.pos_out_of_stock ? 'Tandai Tersedia' : 'Tandai Habis'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </section>

      <aside className="panel cart">
        {!orderStarted && !edit ? (
          <>
            <h3>Belum ada order</h3>
            <p className="empty">
              Klik "＋ New Order" untuk mulai
            </p>
          </>
        ) : (
          <>
            <h3>
              {edit
                ? `✏️ Edit ${edit.order_no}`
                : 'New Order'}
            </h3>

            <div className="ordermeta">
              {customer || '-'} · {mode}
              {table ? ` · Pager ${table}` : ''} · {pax} Pax
            </div>
          </>
        )}

        {(orderStarted || edit) && (
        <>
        {cart.length === 0 ? (
          <p className="empty">Belum ada item</p>
        ) : (
          cart.map((item, index) => {
            const menu = menus.find(
              (m) => m.id === item.menuId
            );

            const price = Number(menu?.price || 0);

            return (
              <div
                className="cartitem"
                key={item.menuId + '-' + index}
              >
                <div className="cartiteminfo">
                  <button
                    type="button"
                    className="cartitemname"
                    onClick={() => openEditCartItem(index)}
                  >
                    {item.name}
                  </button>

                  <small>Rp{price.toLocaleString('id-ID')}</small>

                  {item.modifiers?.sweetness && (
                    <small>Sweetness: {item.modifiers.sweetness}</small>
                  )}

                  {item.note && (
                    <small>Note: {item.note}</small>
                  )}
                </div>

                <div className="qtystepper">
                  <button
                    type="button"
                    onClick={() => decreaseItem(index)}
                  >
                    −
                  </button>

                  <span
                    className="qtytap"
                    onClick={() => setQtyKeypadIndex(index)}
                  >
                    {item.qty}
                  </span>

                  <button
                    type="button"
                    onClick={() => increaseItem(index)}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })
        )}

        <hr />

        <div className="total">
          <span>Subtotal</span>
          <b>Rp{subtotal.toLocaleString('id-ID')}</b>
        </div>

        <div className="total">
          <span>PB1 (10%)</span>
          <b>Rp{taxAmount.toLocaleString('id-ID')}</b>
        </div>

        <div className="total">
          <span>Grand Total</span>

          <b>
            Rp{total.toLocaleString('id-ID')}
          </b>
        </div>
        </>
        )}

        {editingCartItem && (
          <div className="modalbackdrop" onClick={() => setEditingCartItem(null)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h3>{cart[editingCartItem.index]?.name}</h3>

              <label>Jumlah</label>
              <div className="qtystepper large">
                <button
                  type="button"
                  onClick={() => decreaseItem(editingCartItem.index)}
                >
                  −
                </button>

                <span
                  className="qtytap"
                  onClick={() => setQtyKeypadIndex(editingCartItem.index)}
                >
                  {cart[editingCartItem.index]?.qty}
                </span>

                <button
                  type="button"
                  onClick={() => increaseItem(editingCartItem.index)}
                >
                  +
                </button>
              </div>

              {editingCartItem.category !== 'FOOD' && (
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
                <button
                  type="button"
                  className="danger"
                  onClick={() => removeCartItem(editingCartItem.index)}
                >
                  Hapus Item
                </button>
                <button type="button" className="primary" onClick={saveCartItemEdit}>
                  Simpan
                </button>
              </div>
            </div>
          </div>
        )}

        {qtyKeypadIndex !== null && (
          <NumericKeypad
            title={`Jumlah — ${cart[qtyKeypadIndex]?.name || ''}`}
            initialValue={cart[qtyKeypadIndex]?.qty}
            min={0}
            onConfirm={submitQtyKeypad}
            onCancel={() => setQtyKeypadIndex(null)}
          />
        )}

        {stockKeypadMenu && (
          <NumericKeypad
            title={`Stok POS — ${stockKeypadMenu.name}`}
            initialValue={stockKeypadMenu.pos_stock_qty}
            min={0}
            onConfirm={submitStockKeypad}
            onCancel={() => setStockKeypadMenu(null)}
          />
        )}

        {showNewOrderModal && (
          <div className="modalbackdrop" onClick={() => setShowNewOrderModal(false)}>
            <div className="modal large" onClick={(event) => event.stopPropagation()}>
              <h3>New Order</h3>

              <label>
                Customer Name{' '}
                <span className="required">(wajib diisi)</span>
              </label>
              <input
                value={customer}
                onChange={(event) => setCustomer(event.target.value)}
                placeholder="Contoh: Budi"
              />

              <label>Number of Pax</label>
              <div className="segment">
                {[1, 2, 3, 4, 5, 6].map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={pax === value ? 'selected' : ''}
                    onClick={() => setPax(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>

              <label>Sales Mode</label>
              <div className="segment">
                <button
                  type="button"
                  className={mode === 'DINE IN' ? 'selected' : ''}
                  onClick={() => setMode('DINE IN')}
                >
                  DINE IN
                </button>
                <button
                  type="button"
                  className={mode === 'TAKE AWAY' ? 'selected' : ''}
                  onClick={() => setMode('TAKE AWAY')}
                >
                  TAKE AWAY
                </button>
              </div>

              <label>
                No. Pager{' '}
                <span className="required">(wajib dipilih)</span>
              </label>
              <div className="tables">
                {Array.from({ length: 100 }, (_, index) => index + 1).map(
                  (value) => (
                    <button
                      type="button"
                      key={value}
                      className={table === value ? 'selected' : ''}
                      onClick={() => setTable(value)}
                    >
                      {value}
                    </button>
                  )
                )}
              </div>

              <div className="modal-actions">
                <button type="button" onClick={() => setShowNewOrderModal(false)}>
                  Cancel
                </button>
                <button type="button" className="primary" onClick={startOrder}>
                  Start Order
                </button>
              </div>
            </div>
          </div>
        )}

        {showPaymentModal && (
          <div className="modalbackdrop" onClick={() => setShowPaymentModal(false)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h3>Konfirmasi Pembayaran</h3>

              <div className="ordermeta">
                Subtotal: Rp{subtotal.toLocaleString('id-ID')} · PB1: Rp{taxAmount.toLocaleString('id-ID')}
                <br />
                <b>Grand Total: Rp{total.toLocaleString('id-ID')}</b>
              </div>

              <div className="payment">
                {paymentMethods.map((method) => (
                  <button
                    type="button"
                    key={method}
                    className={payment === method ? 'selected' : ''}
                    disabled={loading}
                    onClick={() => confirmPayment(method)}
                  >
                    {method}
                  </button>
                ))}
              </div>

              <div className="modal-actions">
                <button type="button" onClick={() => setShowPaymentModal(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {closingReport && (
          <div className="modalbackdrop" onClick={() => setClosingReport(null)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h3>📋 Laporan Tutup Shift</h3>
              {closingReport.tillName && <p>{closingReport.tillName}</p>}

              <div className="stats">
                <div>
                  Transaksi
                  <b>{closingReport.transactions}</b>
                </div>

                <div>
                  Omzet
                  <b>Rp{Number(closingReport.gross_sales).toLocaleString('id-ID')}</b>
                </div>

                <div>
                  Item Terjual
                  <b>{closingReport.items_sold}</b>
                </div>
              </div>

              <h4>Breakdown Payment</h4>
              <table>
                <thead>
                  <tr>
                    <th>Metode</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(closingReport.payment_breakdown || {}).map(
                    ([method, amount]) => (
                      <tr key={method}>
                        <td>{method}</td>
                        <td>Rp{Number(amount).toLocaleString('id-ID')}</td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>

              <div className="modal-actions">
                <button type="button" onClick={printRecap}>
                  🖨️ Print Rekap
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setClosingReport(null)}
                >
                  Tutup
                </button>
              </div>
            </div>
          </div>
        )}

        {(orderStarted || edit) && (
          <>
            <button
              type="button"
              className="primary"
              disabled={!cart.length || loading}
              onClick={() => setShowPaymentModal(true)}
            >
              {loading
                ? 'Processing...'
                : edit
                ? 'Simpan Receipt'
                : 'Payment'}
            </button>

            <button
              type="button"
              className="cancelbtn"
              onClick={resetOrder}
            >
              ✕ {edit ? 'Cancel Edit' : 'Batalkan Order'}
            </button>
          </>
        )}
      </aside>

      {receiptData && (
        <div className="receiptprint">
          <img src={daunLogo} className="receiptlogo" alt="The Daun" />

          <div className="receiptshopinfo">
            {SHOP.address.split('\n').map((line) => (
              <div key={line}>{line}</div>
            ))}
            <div>{SHOP.contact}</div>
          </div>

          <hr />

          <div className="receiptkv">
            <span>No</span>
            <span>{receiptData.order_no}</span>
          </div>
          <div className="receiptkv">
            <span>Date</span>
            <span>{formatReceiptDate(receiptData.created_at)}</span>
          </div>
          <div className="receiptkv">
            <span>Info</span>
            <span>{receiptData.customer_name}</span>
          </div>
          <div className="receiptkv">
            <span>Purpose</span>
            <span>{receiptData.sales_mode}</span>
          </div>
          <div className="receiptkv">
            <span>Cashier</span>
            <span>{receiptData.cashier}</span>
          </div>

          <hr />

          {(receiptData.items || []).map((item, index) => (
            <div key={item.id || index}>
              <div className="receiptitemname">{item.name.toUpperCase()}</div>
              <div className="receiptitem">
                <div>
                  {item.qty}x @{Number(item.unitPrice).toLocaleString('id-ID')}
                </div>
                <div>{(item.qty * item.unitPrice).toLocaleString('id-ID')}</div>
              </div>
              {item.note && <div className="receiptitemnote">{item.note}</div>}
            </div>
          ))}

          <hr />

          <div>
            {(receiptData.items || []).reduce((sum, item) => sum + item.qty, 0)} items
          </div>
          <div className="receiptkv">
            <span>Subtotal</span>
            <span>{Number(receiptData.subtotal || 0).toLocaleString('id-ID')}</span>
          </div>
          <div className="receiptkv">
            <span>PB1</span>
            <span>{Number(receiptData.tax_amount || 0).toLocaleString('id-ID')}</span>
          </div>

          <hr />

          <div className="receipttotal">
            <span>Grand Total</span>
            <span>{Number(receiptData.total || 0).toLocaleString('id-ID')}</span>
          </div>
          <div className="receipttotal">
            <span>{PAYMENT_LABELS[receiptData.payment_method] || receiptData.payment_method}</span>
            <span>{Number(receiptData.total || 0).toLocaleString('id-ID')}</span>
          </div>

          <hr />

          <div className="receiptfooter">
            <p>{SHOP.footer1}</p>
            <p>{SHOP.footer2}</p>
            <p>{SHOP.wifi}</p>
            <p className="receipttagline">{SHOP.tagline}</p>
          </div>
        </div>
      )}

      {!receiptData && closingReport && (
        <div className="receiptprint">
          <img src={daunLogo} className="receiptlogo" alt="The Daun" />
          <h3>{SHOP.name}</h3>
          <div className="receiptshopinfo">
            <div>Rekap Tutup Shift</div>
          </div>

          <hr />

          <div className="receiptmeta">
            <div>Kasir: {closingReport.cashierName}</div>
            {closingReport.tillName && <div>{closingReport.tillName}</div>}
            <div>{formatDateTime(closingReport.closed_at)}</div>
          </div>

          <hr />

          <div className="receiptitem">
            <div>Transaksi</div>
            <div>{closingReport.transactions}</div>
          </div>
          <div className="receiptitem">
            <div>Item Terjual</div>
            <div>{closingReport.items_sold}</div>
          </div>

          <hr />

          {Object.entries(closingReport.payment_breakdown || {}).map(
            ([method, amount]) => (
              <div className="receiptitem" key={method}>
                <div>{method}</div>
                <div>Rp{Number(amount).toLocaleString('id-ID')}</div>
              </div>
            )
          )}

          <hr />

          <div className="receipttotal">
            <span>TOTAL</span>
            <span>Rp{Number(closingReport.gross_sales).toLocaleString('id-ID')}</span>
          </div>

          <hr />

          <div className="receiptfooter">
            <p>Cash dihitung fisik: ___________________</p>
            <p>Selisih: ___________________</p>
            <p>Tanda tangan: ___________________</p>
          </div>
        </div>
      )}
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

  async function markDone(id) {
    try {
      await api(
        '/order-items/' + id + '/status',
        {
          method: 'PATCH',
          body: JSON.stringify({ status: 'READY' }),
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

      <p>Log pesanan masuk — tandai selesai untuk menghapus dari daftar.</p>

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

                {item.status !== 'READY' && (
                  <button
                    type="button"
                    className="donebtn"
                    onClick={() => markDone(item.id)}
                  >
                    ✓ Selesai
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

// The café operates in one timezone (WIB) — every date-range default
// and displayed date/time uses it explicitly, never the viewing
// device's local timezone, so what's shown always matches what the
// backend (also pinned to Asia/Jakarta) considers "that day".
const BUSINESS_TIMEZONE = 'Asia/Jakarta';

function todayIsoDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE }).format(
    new Date()
  );
}

function formatDateTime(value) {
  return new Date(value).toLocaleString('id-ID', { timeZone: BUSINESS_TIMEZONE });
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('id-ID', { timeZone: BUSINESS_TIMEZONE });
}

// DD-MM-YYYY HH:mm, matching the shop's existing printed receipt
// format exactly (not the "5/9/2026, 08.50" style used elsewhere).
function formatReceiptDate(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value));

  const get = (type) => parts.find((p) => p.type === type)?.value;

  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}`;
}

const PAYMENT_LABELS = {
  CASH: 'CASH',
  CARD: 'EDC',
  'QRIS / BANK': 'QRIS',
};

function Report({ user }) {
  const [payment, setPayment] = useState('');
  const [cashier, setCashier] = useState('');
  const [account, setAccount] = useState('');
  const [category, setCategory] = useState('');
  const [data, setData] = useState(null);
  const [cashiers, setCashiers] = useState([]);
  const [error, setError] = useState('');

  const [closing, setClosing] = useState(null);
  const [closingError, setClosingError] = useState('');

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dateRangeMode, setDateRangeMode] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const [editingOrder, setEditingOrder] = useState(null);

  const [paymentMethods, setPaymentMethods] = useState(['CASH', 'CARD', 'QRIS / BANK']);
  const [allPaymentMethods, setAllPaymentMethods] = useState([]);
  const [newPaymentMethodName, setNewPaymentMethodName] = useState('');
  const [showPaymentMethods, setShowPaymentMethods] = useState(false);

  const [showClosingHistory, setShowClosingHistory] = useState(false);
  const [closingHistory, setClosingHistory] = useState([]);
  const [historyPrintRow, setHistoryPrintRow] = useState(null);

  const role = String(
    user?.role || ''
  ).toUpperCase();
  const usesShifts = role === 'CASHIER' || role === 'HEAD_CASHIER';
  const managesPaymentMethods = role === 'ADMIN' || role === 'HEAD_CASHIER';

  function openEditOrder(order) {
    setEditingOrder({
      id: order.id,
      orderNo: order.order_no,
      customerName: order.customer_name || '',
      pax: Number(order.pax || 1),
      tableNo: order.table_no || null,
      salesMode: order.sales_mode || 'DINE IN',
      paymentMethod: order.payment_method || 'CASH',
      items: (order.items || []).map((item) => ({
        menuId: item.menuId,
        name: item.name,
        qty: Number(item.qty || 1),
        unitPrice: Number(item.unitPrice || 0),
        modifiers: item.modifiers || {},
        note: item.note || '',
      })),
    });
  }

  function adjustEditingItemQty(index, delta) {
    setEditingOrder((current) => ({
      ...current,
      items: current.items
        .map((item, i) =>
          i === index ? { ...item, qty: item.qty + delta } : item
        )
        .filter((item) => item.qty > 0),
    }));
  }

  async function saveEditedOrder() {
    if (!editingOrder || !editingOrder.items.length) {
      alert('Order harus punya minimal 1 item');
      return;
    }

    try {
      await api('/orders/' + editingOrder.id, {
        method: 'PUT',
        body: JSON.stringify({
          customerName: editingOrder.customerName,
          pax: editingOrder.pax,
          tableNo: editingOrder.tableNo,
          salesMode: editingOrder.salesMode,
          paymentMethod: editingOrder.paymentMethod,
          items: editingOrder.items.map((item) => ({
            menuId: item.menuId,
            qty: item.qty,
            modifiers: item.modifiers,
            note: item.note,
          })),
        }),
      });

      setEditingOrder(null);
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  function printCombinedRecap() {
    // Only one print-only block should ever be in the DOM at once —
    // clear the other kind so a stale one can't also turn visible.
    setHistoryPrintRow(null);
    setTimeout(() => window.print(), 50);
  }

  async function openClosingHistory() {
    setShowClosingHistory(true);

    try {
      const rows = await api('/shifts/closings');
      setClosingHistory(Array.isArray(rows) ? rows : []);
    } catch (err) {
      alert(err.message);
    }
  }

  function printClosingRecap(row) {
    setHistoryPrintRow(row);
    setTimeout(() => window.print(), 50);
  }

  async function loadPaymentMethods() {
    try {
      const rows = await api('/payment-methods');
      const names = Array.isArray(rows) ? rows.map((m) => m.name) : [];
      if (names.length) setPaymentMethods(names);
    } catch {
      // silent — falls back to the default CASH/CARD/QRIS list
    }
  }

  async function openPaymentMethods() {
    setShowPaymentMethods(true);

    try {
      setAllPaymentMethods(await api('/payment-methods/all'));
    } catch (err) {
      alert(err.message);
    }
  }

  async function addPaymentMethod(event) {
    event.preventDefault();

    if (!newPaymentMethodName.trim()) return;

    try {
      await api('/payment-methods', {
        method: 'POST',
        body: JSON.stringify({ name: newPaymentMethodName.trim() }),
      });

      setNewPaymentMethodName('');
      setAllPaymentMethods(await api('/payment-methods/all'));
      await loadPaymentMethods();
    } catch (err) {
      alert(err.message);
    }
  }

  async function togglePaymentMethodActive(method) {
    try {
      await api('/payment-methods/' + method.id, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !method.is_active }),
      });

      setAllPaymentMethods(await api('/payment-methods/all'));
      await loadPaymentMethods();
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadClosing() {
    setClosingError('');

    try {
      const params = new URLSearchParams();

      if (dateFrom) {
        params.set('dateFrom', dateFrom);
      }

      if (dateTo) {
        params.set('dateTo', dateTo);
      }

      if (account) {
        params.set('account', account);
      }

      setClosing(await api('/shifts/closings/combined?' + params.toString()));
    } catch (err) {
      setClosingError(err.message);
    }
  }

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

      if (account) {
        params.set('account', account);
      }

      if (category) {
        params.set('category', category);
      }

      if (dateFrom) {
        params.set('dateFrom', dateFrom);
      }

      if (dateTo) {
        params.set('dateTo', dateTo);
      }

      params.set('page', String(page));
      params.set('pageSize', String(pageSize));

      const result = await api(
        '/reports?' + params.toString()
      );

      setData(result);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadPaymentMethods();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [payment, cashier, account, category, dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [payment, cashier, account, category, dateFrom, dateTo, page]);

  useEffect(() => {
    if (role === 'ADMIN' || role === 'HEAD_CASHIER') {
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
  }, [role]);

  useEffect(() => {
    if (role === 'ADMIN' || role === 'HEAD_CASHIER') {
      loadClosing();
    }
  }, [dateFrom, dateTo, account, role]);

  return (
    <main className="page">
      <h2>📊 Reporting</h2>

      <p>
        {role === 'ADMIN' || role === 'HEAD_CASHIER'
          ? 'Semua kasir'
          : `Transaksi ${
              user?.name || ''
            }`}
      </p>

      {(usesShifts || managesPaymentMethods) && (
        <div className="reporttoolbar">
          {usesShifts && (
            <button type="button" onClick={openClosingHistory}>
              📜 Riwayat Tutup Shift
            </button>
          )}

          {managesPaymentMethods && (
            <button type="button" onClick={openPaymentMethods}>
              💳 Kelola Metode Pembayaran
            </button>
          )}
        </div>
      )}

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

          {paymentMethods.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>

        {(role === 'ADMIN' || role === 'HEAD_CASHIER') && (
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

        {(data?.permittedAccounts || []).length > 1 && (
          <select
            value={account}
            onChange={(event) => setAccount(event.target.value)}
          >
            <option value="">Semua Akun</option>
            {(data?.permittedAccounts || []).map((item) => (
              <option key={item.code} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        )}

        {!dateRangeMode ? (
          <>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value);
                setDateTo(event.target.value);
              }}
              title="Tanggal"
            />

            <button type="button" onClick={() => setDateRangeMode(true)}>
              + Rentang Tanggal
            </button>
          </>
        ) : (
          <>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              title="Dari tanggal"
            />

            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              title="Sampai tanggal"
            />

            <button
              type="button"
              onClick={() => {
                setDateRangeMode(false);
                setDateTo(dateFrom);
              }}
            >
              Tanggal Tunggal
            </button>
          </>
        )}

        {(dateFrom || dateTo) && (
          <button
            type="button"
            onClick={() => {
              setDateFrom('');
              setDateTo('');
              setDateRangeMode(false);
            }}
          >
            Reset ke Hari Ini
          </button>
        )}
      </div>

      {!dateFrom && !dateTo && (
        <p className="empty">Menampilkan data hari ini saja — pilih tanggal untuk melihat histori.</p>
      )}

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

          {(role === 'HEAD_CASHIER' || role === 'ADMIN') && (
            <>
              <h3>Performa Kasir</h3>
              <table>
                <thead>
                  <tr>
                    <th>Kasir</th>
                    <th>Transaksi</th>
                    <th>Omzet</th>
                    <th>Item Terjual</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.performance || []).map((item) => (
                    <tr key={item.name}>
                      <td>{item.name}</td>
                      <td>{item.transactions}</td>
                      <td>Rp{Number(item.grossSales || 0).toLocaleString('id-ID')}</td>
                      <td>{item.itemsSold}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {(role === 'HEAD_CASHIER' || role === 'ADMIN') && (
            <>
              <h3>Ringkasan Akun Bisnis</h3>
              <table>
                <thead>
                  <tr>
                    <th>Akun</th>
                    <th>Transaksi</th>
                    <th>Penjualan</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.accounts || []).map((item) => (
                    <tr key={item.code}>
                      <td>{item.name}</td>
                      <td>{item.transactions}</td>
                      <td>Rp{Number(item.grossSales || 0).toLocaleString('id-ID')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {(role === 'HEAD_CASHIER' || role === 'ADMIN') && (
            <>
              <div className="filters" style={{ marginTop: 24 }}>
                <h3 style={{ margin: 0, flex: '1 0 auto' }}>
                  Tutup Hari — Gabungan per Kasir
                </h3>

                {closing && closing.cashiers.length > 0 && (
                  <button type="button" onClick={printCombinedRecap}>
                    🖨️ Print Rekap Gabungan
                  </button>
                )}
              </div>

              {closingError && <div className="error">{closingError}</div>}

              {closing && closing.cashiers.length === 0 && (
                <p className="empty">
                  Belum ada kasir yang tutup hari di tanggal ini.
                </p>
              )}

              {closing && closing.cashiers.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      <th>Kasir</th>
                      <th>Nomor Kasir</th>
                      <th>Akun</th>
                      <th>Transaksi</th>
                      <th>Item</th>
                      {Object.keys(closing.total?.paymentBreakdown || {}).map(
                        (method) => (
                          <th key={method}>{method}</th>
                        )
                      )}
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closing.cashiers.map((row) => (
                      <tr key={row.userId + '-' + row.closingDate}>
                        <td>
                          {new Date(row.closingDate).toLocaleDateString('id-ID', {
                            timeZone: BUSINESS_TIMEZONE,
                          })}
                        </td>
                        <td>{row.name}</td>
                        <td>{row.tillName || '-'}</td>
                        <td>{row.accountName}</td>
                        <td>{row.transactions}</td>
                        <td>{row.itemsSold}</td>
                        {Object.keys(closing.total?.paymentBreakdown || {}).map(
                          (method) => (
                            <td key={method}>
                              Rp
                              {Number(
                                row.paymentBreakdown?.[method] || 0
                              ).toLocaleString('id-ID')}
                            </td>
                          )
                        )}
                        <td>
                          <b>Rp{Number(row.grossSales).toLocaleString('id-ID')}</b>
                        </td>
                      </tr>
                    ))}

                    {closing.total && (
                      <tr>
                        <td></td>
                        <td>
                          <b>Total Gabungan</b>
                        </td>
                        <td></td>
                        <td></td>
                        <td>
                          <b>{closing.total.transactions}</b>
                        </td>
                        <td>
                          <b>{closing.total.itemsSold}</b>
                        </td>
                        {Object.keys(closing.total.paymentBreakdown || {}).map(
                          (method) => (
                            <td key={method}>
                              <b>
                                Rp
                                {Number(
                                  closing.total.paymentBreakdown[method] || 0
                                ).toLocaleString('id-ID')}
                              </b>
                            </td>
                          )
                        )}
                        <td>
                          <b>Rp{Number(closing.total.grossSales).toLocaleString('id-ID')}</b>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}

              {closing && (closing.byTill || []).length > 0 && (
                <>
                  <h3>Ringkasan per Nomor Kasir</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Nomor Kasir</th>
                        <th>Transaksi</th>
                        <th>Item</th>
                        {Object.keys(closing.total?.paymentBreakdown || {}).map(
                          (method) => (
                            <th key={method}>{method}</th>
                          )
                        )}
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closing.byTill.map((row) => (
                        <tr key={row.tillCode}>
                          <td>{row.tillName}</td>
                          <td>{row.transactions}</td>
                          <td>{row.itemsSold}</td>
                          {Object.keys(closing.total?.paymentBreakdown || {}).map(
                            (method) => (
                              <td key={method}>
                                Rp
                                {Number(
                                  row.paymentBreakdown?.[method] || 0
                                ).toLocaleString('id-ID')}
                              </td>
                            )
                          )}
                          <td>
                            <b>Rp{Number(row.grossSales).toLocaleString('id-ID')}</b>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}

          <div className="filters" style={{ marginTop: 24 }}>
            <h3 style={{ margin: 0, flex: '1 0 auto' }}>Sales by Menu</h3>

            {(data.categories || []).length > 0 && (
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">Semua Kategori</option>
                {data.categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            )}
          </div>

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

          <h3>Daftar Transaksi</h3>
          <table>
            <thead>
              <tr>
                <th>No. Order</th>
                <th>Kasir</th>
                {(role === 'HEAD_CASHIER' || role === 'ADMIN') && <th>Akun</th>}
                <th>Total</th>
                <th>Payment</th>
                <th>Tanggal</th>
                {(role === 'HEAD_CASHIER' || role === 'ADMIN') && <th>Aksi</th>}
              </tr>
            </thead>
            <tbody>
              {(data.transactions || []).map((order) => (
                <tr key={order.id}>
                  <td>{order.order_no}</td>
                  <td>{order.cashier}</td>
                  {(role === 'HEAD_CASHIER' || role === 'ADMIN') && (
                    <td>{order.account_name || '-'}</td>
                  )}
                  <td>Rp{Number(order.total || 0).toLocaleString('id-ID')}</td>
                  <td>{order.payment_method || '-'}</td>
                  <td>{formatDateTime(order.created_at)}</td>
                  {(role === 'HEAD_CASHIER' || role === 'ADMIN') && (
                    <td>
                      <button type="button" onClick={() => openEditOrder(order)}>Edit</button>{' '}
                      <button type="button" onClick={() => deleteOrder(order, load)}>Hapus</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {(data.transactionsTotal || 0) > pageSize && (
            <div className="pagination">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Sebelumnya
              </button>

              <span>
                Halaman {page} dari{' '}
                {Math.max(1, Math.ceil((data.transactionsTotal || 0) / pageSize))}
                {' '}({data.transactionsTotal} transaksi)
              </span>

              <button
                type="button"
                disabled={page * pageSize >= (data.transactionsTotal || 0)}
                onClick={() => setPage((p) => p + 1)}
              >
                Selanjutnya →
              </button>
            </div>
          )}
        </>
      )}

      {editingOrder && (
        <div className="modalbackdrop" onClick={() => setEditingOrder(null)}>
          <div className="modal large" onClick={(event) => event.stopPropagation()}>
            <h3>✏️ Edit {editingOrder.orderNo}</h3>

            <label>Nama Customer</label>
            <input
              value={editingOrder.customerName}
              onChange={(event) =>
                setEditingOrder((current) => ({
                  ...current,
                  customerName: event.target.value,
                }))
              }
            />

            <label>Payment Method</label>
            <select
              value={editingOrder.paymentMethod}
              onChange={(event) =>
                setEditingOrder((current) => ({
                  ...current,
                  paymentMethod: event.target.value,
                }))
              }
            >
              {paymentMethods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>

            <label>Items</label>
            {editingOrder.items.map((item, index) => (
              <div className="cartitem" key={item.menuId + '-' + index}>
                <div className="cartiteminfo">
                  <span className="cartitemname">{item.name}</span>
                  <small>Rp{item.unitPrice.toLocaleString('id-ID')}</small>
                </div>

                <div className="qtystepper">
                  <button
                    type="button"
                    onClick={() => adjustEditingItemQty(index, -1)}
                  >
                    −
                  </button>
                  <span className="qtytap">{item.qty}</span>
                  <button
                    type="button"
                    onClick={() => adjustEditingItemQty(index, 1)}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}

            <div className="modal-actions">
              <button type="button" onClick={() => setEditingOrder(null)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={saveEditedOrder}>
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {showClosingHistory && (
        <div className="modalbackdrop" onClick={() => setShowClosingHistory(false)}>
          <div className="modal large" onClick={(event) => event.stopPropagation()}>
            <h3>📜 Riwayat Tutup Shift</h3>
            <p>30 penutupan shift terakhirmu — bisa dicetak ulang kapan saja.</p>

            {closingHistory.length === 0 && (
              <p className="empty">Belum ada riwayat tutup shift.</p>
            )}

            {closingHistory.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Tanggal</th>
                    <th>Kasir</th>
                    <th>Transaksi</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {closingHistory.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.closed_at)}</td>
                      <td>{row.till_name || '-'}</td>
                      <td>{row.transactions}</td>
                      <td>Rp{Number(row.gross_sales).toLocaleString('id-ID')}</td>
                      <td>
                        <button type="button" onClick={() => printClosingRecap(row)}>
                          🖨️ Print
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => setShowClosingHistory(false)}
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {showPaymentMethods && (
        <div className="modalbackdrop" onClick={() => setShowPaymentMethods(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>💳 Kelola Metode Pembayaran</h3>
            <p>Metode yang dinonaktifkan tidak akan muncul di layar pembayaran, tapi riwayat transaksi lama tidak berubah.</p>

            <table>
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {allPaymentMethods.map((method) => (
                  <tr key={method.id}>
                    <td>{method.name}</td>
                    <td>{method.is_active ? 'Aktif' : 'Nonaktif'}</td>
                    <td>
                      <button type="button" onClick={() => togglePaymentMethodActive(method)}>
                        {method.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <form onSubmit={addPaymentMethod} className="inlineform">
              <input
                placeholder="Nama metode baru (mis. GOPAY)"
                value={newPaymentMethodName}
                onChange={(event) => setNewPaymentMethodName(event.target.value)}
              />
              <button type="submit" className="primary">
                + Tambah
              </button>
            </form>

            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => setShowPaymentMethods(false)}
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {historyPrintRow && (
        <div className="receiptprint">
          <img src={daunLogo} className="receiptlogo" alt="The Daun" />
          <h3>{SHOP.name}</h3>
          <div className="receiptshopinfo">
            <div>Rekap Tutup Shift</div>
          </div>

          <hr />

          <div className="receiptmeta">
            <div>Kasir: {user?.name}</div>
            {historyPrintRow.till_name && <div>{historyPrintRow.till_name}</div>}
            <div>{formatDateTime(historyPrintRow.closed_at)}</div>
          </div>

          <hr />

          <div className="receiptitem">
            <div>Transaksi</div>
            <div>{historyPrintRow.transactions}</div>
          </div>
          <div className="receiptitem">
            <div>Item Terjual</div>
            <div>{historyPrintRow.items_sold}</div>
          </div>

          <hr />

          {Object.entries(historyPrintRow.payment_breakdown || {}).map(
            ([method, amount]) => (
              <div className="receiptitem" key={method}>
                <div>{method}</div>
                <div>Rp{Number(amount).toLocaleString('id-ID')}</div>
              </div>
            )
          )}

          <hr />

          <div className="receipttotal">
            <span>TOTAL</span>
            <span>Rp{Number(historyPrintRow.gross_sales).toLocaleString('id-ID')}</span>
          </div>

          <hr />

          <div className="receiptfooter">
            <p>Cash dihitung fisik: ___________________</p>
            <p>Selisih: ___________________</p>
            <p>Tanda tangan: ___________________</p>
          </div>
        </div>
      )}

      {!historyPrintRow && closing && closing.cashiers.length > 0 && (
        <div className="receiptprint">
          <img src={daunLogo} className="receiptlogo" alt="The Daun" />
          <h3>{SHOP.name}</h3>
          <div className="receiptshopinfo">
            <div>Rekap Gabungan</div>
            <div>
              {closing.dateFrom === closing.dateTo
                ? closing.dateFrom
                : `${closing.dateFrom} s/d ${closing.dateTo}`}
            </div>
          </div>

          <hr />

          {closing.cashiers.map((row) => (
            <div key={row.userId + '-' + row.closingDate}>
              <div className="receiptitem">
                <div>
                  <b>{row.name}</b>
                </div>
                <div>{row.tillName || '-'}</div>
              </div>
              <div className="receiptmeta">
                <div>{row.accountName}</div>
                <div>
                  Transaksi: {row.transactions} · Item: {row.itemsSold}
                </div>
                {Object.entries(row.paymentBreakdown || {}).map(([method, amount]) => (
                  <div key={method}>
                    {method}: Rp{Number(amount).toLocaleString('id-ID')}
                  </div>
                ))}
              </div>
              <div className="receipttotal">
                <span>TOTAL</span>
                <span>Rp{Number(row.grossSales).toLocaleString('id-ID')}</span>
              </div>
              <hr />
            </div>
          ))}

          <h3 style={{ fontSize: 13 }}>Ringkasan per Nomor Kasir</h3>
          {(closing.byTill || []).map((row) => (
            <div className="receiptitem" key={row.tillCode}>
              <div>{row.tillName}</div>
              <div>Rp{Number(row.grossSales).toLocaleString('id-ID')}</div>
            </div>
          ))}

          <hr />

          <div className="receiptmeta">
            <div>
              Total Transaksi: {closing.total?.transactions} · Total Item:{' '}
              {closing.total?.itemsSold}
            </div>
            {Object.entries(closing.total?.paymentBreakdown || {}).map(
              ([method, amount]) => (
                <div key={method}>
                  {method}: Rp{Number(amount).toLocaleString('id-ID')}
                </div>
              )
            )}
          </div>

          <div className="receipttotal">
            <span>TOTAL GABUNGAN</span>
            <span>Rp{Number(closing.total?.grossSales || 0).toLocaleString('id-ID')}</span>
          </div>
        </div>
      )}
    </main>
  );
}

/* =========================
   SETTINGS
========================= */

const ACCOUNT_REQUIRED_ROLES = ['CASHIER', 'HEAD_CASHIER', 'ADMIN'];
// Admin is fixed — only ever one, seeded directly in the database.
// It's never offered here as something to assign or change.
const CREATABLE_ROLES = ['CASHIER', 'HEAD_CASHIER', 'WAREHOUSE'];

function digitsOnly(value) {
  return value.replace(/\D/g, '');
}

function Settings() {
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);

  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newRole, setNewRole] = useState('CASHIER');
  const [newAccountId, setNewAccountId] = useState('');

  const [editingUser, setEditingUser] = useState(null);
  const [pinResetUser, setPinResetUser] = useState(null);
  const [resetPin, setResetPin] = useState('');
  const [permUser, setPermUser] = useState(null);
  const [permAccountIds, setPermAccountIds] = useState([]);

  const [menus, setMenus] = useState([]);
  const [newMenuName, setNewMenuName] = useState('');
  const [newMenuCategory, setNewMenuCategory] = useState('');
  const [newMenuCategoryCustom, setNewMenuCategoryCustom] = useState('');
  const [newMenuPrice, setNewMenuPrice] = useState('');
  const [newMenuStation, setNewMenuStation] = useState('BAR');
  const [editingMenu, setEditingMenu] = useState(null);
  const [editingMenuCategoryCustom, setEditingMenuCategoryCustom] = useState('');

  const NEW_CATEGORY = '__NEW__';
  const existingCategories = [...new Set(menus.map((m) => m.category))].sort();

  async function load() {
    try {
      const [usersData, accountsData, menusData] = await Promise.all([
        api('/users'),
        api('/accounts'),
        api('/admin/menus'),
      ]);

      setUsers(Array.isArray(usersData) ? usersData : []);
      setAccounts(Array.isArray(accountsData) ? accountsData : []);
      setMenus(Array.isArray(menusData) ? menusData : []);
    } catch (err) {
      alert(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetCreateForm() {
    setNewUsername('');
    setNewDisplayName('');
    setNewPin('');
    setNewRole('CASHIER');
    setNewAccountId('');
  }

  async function createUser(event) {
    event.preventDefault();

    if (!newUsername.trim() || !newDisplayName.trim() || !newPin) {
      alert('Username, nama, dan PIN wajib diisi');
      return;
    }

    if (ACCOUNT_REQUIRED_ROLES.includes(newRole) && !newAccountId) {
      alert('Akun bisnis wajib dipilih untuk role ini');
      return;
    }

    setLoading(true);

    try {
      await api('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername.trim(),
          displayName: newDisplayName.trim(),
          pin: newPin,
          role: newRole,
          accountId: newAccountId || null,
        }),
      });

      resetCreateForm();
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function deleteUser(user) {
    const confirmed = window.confirm(
      `Hapus user ${user.display_name} (${user.username}) secara permanen?`
    );
    if (!confirmed) return;

    try {
      await api('/users/' + user.id, { method: 'DELETE' });
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  function startEdit(user) {
    setEditingUser({
      id: user.id,
      displayName: user.display_name,
      role: user.role,
      accountId: user.account_id || '',
      isActive: user.is_active,
    });
  }

  async function saveEdit() {
    if (!editingUser) return;

    if (
      ACCOUNT_REQUIRED_ROLES.includes(editingUser.role) &&
      !editingUser.accountId
    ) {
      alert('Akun bisnis wajib dipilih untuk role ini');
      return;
    }

    setLoading(true);

    try {
      await api('/users/' + editingUser.id, {
        method: 'PUT',
        body: JSON.stringify({
          displayName: editingUser.displayName,
          role: editingUser.role,
          accountId: editingUser.accountId || null,
          isActive: editingUser.isActive,
        }),
      });

      setEditingUser(null);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function createMenu(event) {
    event.preventDefault();

    const category =
      newMenuCategory === NEW_CATEGORY
        ? newMenuCategoryCustom.trim()
        : newMenuCategory;

    if (!newMenuName.trim() || !category || !newMenuPrice) {
      alert('Nama, kategori, dan harga wajib diisi');
      return;
    }

    setLoading(true);

    try {
      await api('/menus', {
        method: 'POST',
        body: JSON.stringify({
          name: newMenuName.trim(),
          category,
          price: Number(newMenuPrice),
          station: newMenuStation,
        }),
      });

      setNewMenuName('');
      setNewMenuCategory('');
      setNewMenuCategoryCustom('');
      setNewMenuPrice('');
      setNewMenuStation('BAR');
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  function startEditMenu(menu) {
    setEditingMenu({
      id: menu.id,
      name: menu.name,
      category: menu.category,
      price: menu.price,
      station: menu.station,
      active: menu.active,
    });
  }

  async function saveMenuEdit() {
    if (!editingMenu) return;

    const category =
      editingMenu.category === NEW_CATEGORY
        ? editingMenuCategoryCustom.trim()
        : editingMenu.category;

    if (!category) {
      alert('Kategori wajib diisi');
      return;
    }

    setLoading(true);

    try {
      await api('/menus/' + editingMenu.id, {
        method: 'PUT',
        body: JSON.stringify({
          name: editingMenu.name,
          category,
          price: Number(editingMenu.price),
          station: editingMenu.station,
          active: editingMenu.active,
        }),
      });

      setEditingMenu(null);
      setEditingMenuCategoryCustom('');
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitPinReset() {
    if (!resetPin || !pinResetUser) return;

    setLoading(true);

    try {
      await api('/users/' + pinResetUser.id + '/pin', {
        method: 'PUT',
        body: JSON.stringify({ pin: resetPin }),
      });

      setPinResetUser(null);
      setResetPin('');
      alert(`PIN untuk ${pinResetUser.display_name} berhasil direset.`);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function openPermissions(user) {
    setPermUser(user);

    try {
      const ids = await api('/users/' + user.id + '/report-permissions');
      setPermAccountIds(Array.isArray(ids) ? ids : []);
    } catch (err) {
      alert(err.message);
      setPermUser(null);
    }
  }

  function togglePermAccount(accountId) {
    setPermAccountIds((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId]
    );
  }

  async function savePermissions() {
    if (!permUser) return;

    setLoading(true);

    try {
      await api('/users/' + permUser.id + '/report-permissions', {
        method: 'PUT',
        body: JSON.stringify({ accountIds: permAccountIds }),
      });

      setPermUser(null);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <h2>⚙️ Settings</h2>

      <h3>Buat User Baru</h3>

      <form className="userform" onSubmit={createUser}>
        <input
          placeholder="Username"
          value={newUsername}
          onChange={(event) => setNewUsername(event.target.value)}
        />

        <input
          placeholder="Nama Tampilan"
          value={newDisplayName}
          onChange={(event) => setNewDisplayName(event.target.value)}
        />

        <input
          type="password"
          placeholder="PIN"
          value={newPin}
          onChange={(event) => setNewPin(digitsOnly(event.target.value))}
        />

        <select value={newRole} onChange={(event) => setNewRole(event.target.value)}>
          {CREATABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>

        {ACCOUNT_REQUIRED_ROLES.includes(newRole) && (
          <select
            value={newAccountId}
            onChange={(event) => setNewAccountId(event.target.value)}
          >
            <option value="">Pilih Akun Bisnis</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        )}

        <button type="submit" className="primary" disabled={loading}>
          Buat User
        </button>
      </form>

      <h3>Daftar User</h3>

      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Nama</th>
            <th>Role</th>
            <th>Akun</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>

        <tbody>
          {users.filter((user) => user.role !== 'ADMIN').map((user) => (
            <tr key={user.id}>
              <td>{user.username}</td>
              <td>{user.display_name}</td>
              <td>{user.role}</td>
              <td>{user.account_name || '-'}</td>
              <td>{user.is_active ? 'Aktif' : 'Nonaktif'}</td>
              <td className="userrowactions">
                {user.role === 'ADMIN' ? (
                  <small>Admin utama — tidak bisa diubah</small>
                ) : (
                  <>
                    <button type="button" onClick={() => startEdit(user)}>
                      Edit
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPinResetUser(user);
                        setResetPin('');
                      }}
                    >
                      Reset PIN
                    </button>

                    {user.role === 'HEAD_CASHIER' && (
                      <button type="button" onClick={() => openPermissions(user)}>
                        Izin Laporan
                      </button>
                    )}

                    <button
                      type="button"
                      className="danger"
                      onClick={() => deleteUser(user)}
                    >
                      Hapus
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Tambah Menu Baru</h3>

      <form className="userform" onSubmit={createMenu}>
        <input
          placeholder="Nama Menu"
          value={newMenuName}
          onChange={(event) => setNewMenuName(event.target.value)}
        />

        <select
          value={newMenuCategory}
          onChange={(event) => setNewMenuCategory(event.target.value)}
        >
          <option value="">Pilih Kategori</option>
          {existingCategories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
          <option value={NEW_CATEGORY}>+ Kategori Baru...</option>
        </select>

        {newMenuCategory === NEW_CATEGORY && (
          <input
            placeholder="Nama Kategori Baru"
            value={newMenuCategoryCustom}
            onChange={(event) => setNewMenuCategoryCustom(event.target.value)}
          />
        )}

        <input
          type="number"
          placeholder="Harga"
          value={newMenuPrice}
          onChange={(event) => setNewMenuPrice(event.target.value)}
        />

        <select
          value={newMenuStation}
          onChange={(event) => setNewMenuStation(event.target.value)}
        >
          <option value="BAR">BAR</option>
          <option value="KITCHEN">KITCHEN</option>
          <option value="KASIR">KASIR (tanpa antrian dapur)</option>
        </select>

        <button type="submit" className="primary" disabled={loading}>
          Tambah Menu
        </button>
      </form>

      <h3>Daftar Menu</h3>

      <table>
        <thead>
          <tr>
            <th>Nama</th>
            <th>Kategori</th>
            <th>Harga</th>
            <th>Station</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>

        <tbody>
          {menus.map((menu) => (
            <tr key={menu.id}>
              <td>{menu.name}</td>
              <td>{menu.category}</td>
              <td>Rp{Number(menu.price).toLocaleString('id-ID')}</td>
              <td>{menu.station}</td>
              <td>{menu.active ? 'Aktif' : 'Nonaktif'}</td>
              <td className="userrowactions">
                <button type="button" onClick={() => startEditMenu(menu)}>
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editingMenu && (
        <div className="modalbackdrop" onClick={() => setEditingMenu(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Edit Menu</h3>

            <label>Nama Menu</label>
            <input
              value={editingMenu.name}
              onChange={(event) =>
                setEditingMenu((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />

            <label>Kategori</label>
            <select
              value={editingMenu.category}
              onChange={(event) =>
                setEditingMenu((current) => ({
                  ...current,
                  category: event.target.value,
                }))
              }
            >
              {existingCategories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
              <option value={NEW_CATEGORY}>+ Kategori Baru...</option>
            </select>

            {editingMenu.category === NEW_CATEGORY && (
              <input
                placeholder="Nama Kategori Baru"
                value={editingMenuCategoryCustom}
                onChange={(event) => setEditingMenuCategoryCustom(event.target.value)}
              />
            )}

            <label>Harga</label>
            <input
              type="number"
              value={editingMenu.price}
              onChange={(event) =>
                setEditingMenu((current) => ({
                  ...current,
                  price: event.target.value,
                }))
              }
            />

            <label>Station</label>
            <select
              value={editingMenu.station}
              onChange={(event) =>
                setEditingMenu((current) => ({
                  ...current,
                  station: event.target.value,
                }))
              }
            >
              <option value="BAR">BAR</option>
              <option value="KITCHEN">KITCHEN</option>
            </select>

            <label>
              <input
                type="checkbox"
                checked={editingMenu.active}
                onChange={(event) =>
                  setEditingMenu((current) => ({
                    ...current,
                    active: event.target.checked,
                  }))
                }
              />{' '}
              Aktif (tampil di POS)
            </label>

            <div className="modal-actions">
              <button type="button" onClick={() => setEditingMenu(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={loading}
                onClick={saveMenuEdit}
              >
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {editingUser && (
        <div className="modalbackdrop" onClick={() => setEditingUser(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Edit User</h3>

            <label>Nama Tampilan</label>
            <input
              value={editingUser.displayName}
              onChange={(event) =>
                setEditingUser((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
            />

            <label>Role</label>
            <select
              value={editingUser.role}
              onChange={(event) =>
                setEditingUser((current) => ({
                  ...current,
                  role: event.target.value,
                }))
              }
            >
              {CREATABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>

            {ACCOUNT_REQUIRED_ROLES.includes(editingUser.role) && (
              <>
                <label>Akun Bisnis</label>
                <select
                  value={editingUser.accountId}
                  onChange={(event) =>
                    setEditingUser((current) => ({
                      ...current,
                      accountId: event.target.value,
                    }))
                  }
                >
                  <option value="">Pilih Akun Bisnis</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </>
            )}

            <label>
              <input
                type="checkbox"
                checked={editingUser.isActive}
                onChange={(event) =>
                  setEditingUser((current) => ({
                    ...current,
                    isActive: event.target.checked,
                  }))
                }
              />{' '}
              Aktif
            </label>

            <div className="modal-actions">
              <button type="button" onClick={() => setEditingUser(null)}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={loading} onClick={saveEdit}>
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {pinResetUser && (
        <div className="modalbackdrop" onClick={() => setPinResetUser(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Reset PIN — {pinResetUser.display_name}</h3>

            <label>PIN Baru</label>
            <input
              type="password"
              value={resetPin}
              onChange={(event) => setResetPin(digitsOnly(event.target.value))}
              placeholder="PIN baru"
              autoFocus
            />

            <div className="modal-actions">
              <button type="button" onClick={() => setPinResetUser(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={loading || !resetPin}
                onClick={submitPinReset}
              >
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {permUser && (
        <div className="modalbackdrop" onClick={() => setPermUser(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Izin Laporan — {permUser.display_name}</h3>

            <p>Akun bisnis yang boleh dilihat laporannya oleh user ini.</p>

            {accounts.map((account) => (
              <label className="permcheck" key={account.id}>
                <input
                  type="checkbox"
                  checked={permAccountIds.includes(account.id)}
                  onChange={() => togglePermAccount(account.id)}
                />{' '}
                {account.name}
              </label>
            ))}

            <div className="modal-actions">
              <button type="button" onClick={() => setPermUser(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={loading}
                onClick={savePermissions}
              >
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}
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
          <img src={daunLogo} className="brandlogo" alt="The Daun" />
          <h1>POS System</h1>
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