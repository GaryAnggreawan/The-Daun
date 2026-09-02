# Café POS v3

Perubahan utama:
- Login berdasarkan role: Gary/Cashier, Warehouse, Admin.
- Hak akses tab:
  - Cashier: Kasir, Bar, Kitchen, Reporting.
  - Warehouse: Warehouse.
  - Admin: semua tab.
- Ketersediaan menu kasir dihitung dari recipe + stok warehouse; kartu menu menampilkan "Sisa X menu" dan otomatis disabled jika stok tidak cukup.
- Receipt/transaksi dapat diedit oleh kasir untuk transaksi miliknya. Admin dapat mengedit transaksi mana pun.
- Saat edit receipt, stok lama dikembalikan terlebih dahulu lalu stok baru dikurangi saat receipt disimpan.
- Reporting kasir hanya menampilkan transaksi kasir yang sedang login.
- Reporting bisa difilter berdasarkan payment method; Admin juga bisa memilih kasir.
- Sales by Menu menampilkan jumlah terjual dan total uang per menu. Contoh 11 Chicken Rice akan menjadi Qty 11 dan Total Uang Rp385.000.
- Bar dan Kitchen tetap menerima item dari transaksi seluruh kasir.

Catatan:
Prototype masih menggunakan localStorage/sessionStorage di browser. Untuk multi-device real-time, gunakan backend + database + authentication/authorization server-side.
