/**
 * db.js — GitHub-backed JSON storage
 * อ่าน/เขียน data/orders.json และ data/sales.json ผ่าน GitHub Contents API
 * SHA caching + retry on 409 conflict
 */
const DB = (() => {
  const shaCache = {};

  function cfg() {
    return {
      user:  localStorage.getItem('gh_user')  || '',
      repo:  localStorage.getItem('gh_repo')  || '',
      token: localStorage.getItem('gh_token') || ''
    };
  }

  function saveConfig(user, repo, token) {
    localStorage.setItem('gh_user',  user.trim());
    localStorage.setItem('gh_repo',  repo.trim());
    localStorage.setItem('gh_token', token.trim());
  }

  function isReady() {
    const c = cfg();
    return !!(c.user && c.repo && c.token);
  }

  function apiUrl(file) {
    const c = cfg();
    return `https://api.github.com/repos/${c.user}/${c.repo}/contents/data/${file}`;
  }

  function authHeaders() {
    return {
      'Authorization': `Bearer ${cfg().token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
  }

  function encode(obj) {
    // btoa ที่รองรับ Unicode (ภาษาไทย)
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
  }

  function decode(b64) {
    return JSON.parse(decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))));
  }

  async function readFile(file) {
    const res = await fetch(apiUrl(file), { headers: authHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.message || `read ${file} failed`), { status: res.status });
    }
    const d = await res.json();
    shaCache[file] = d.sha;
    return decode(d.content);
  }

  async function writeFile(file, data) {
    const sha = shaCache[file];
    const body = { message: `update ${file}`, content: encode(data) };
    if (sha) body.sha = sha;

    const res = await fetch(apiUrl(file), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.message || `write ${file} failed`), { status: res.status });
    }
    const d = await res.json();
    shaCache[file] = d.content.sha;
  }

  // Read → transform → write with conflict retry (409)
  async function update(file, transformFn, retries = 3) {
    for (let i = 0; i < retries; i++) {
      const current = await readFile(file);
      const next = transformFn(current);
      try {
        await writeFile(file, next);
        return next;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && i < retries - 1) {
          await new Promise(r => setTimeout(r, 400 * (i + 1)));
          delete shaCache[file]; // force re-read
          continue;
        }
        throw e;
      }
    }
  }

  // --- Convenience helpers ---

  async function getOrders()  { return readFile('orders.json'); }
  async function getSales()   { return readFile('sales.json'); }

  async function addOrder(order) {
    return update('orders.json', orders => [...orders, order]);
  }

  async function patchOrder(id, patch) {
    return update('orders.json', orders =>
      orders.map(o => o.id === id ? { ...o, ...patch } : o)
    );
  }

  async function deleteOrder(id) {
    return update('orders.json', orders => orders.filter(o => o.id !== id));
  }

  // ชำระเงิน: ย้าย orders ของโต๊ะ → sales, ลบออกจาก orders
  async function checkoutTable(tableNum) {
    const orders = await readFile('orders.json');
    const tableOrders = orders.filter(o => String(o.table) === String(tableNum));
    if (tableOrders.length === 0) throw new Error('ไม่มีออเดอร์ในโต๊ะนี้');

    const session = {
      id: 'sale_' + Date.now(),
      table: tableNum,
      orders: tableOrders,
      total: tableOrders.reduce((s, o) => s + o.total, 0),
      paidAt: new Date().toLocaleString('th-TH'),
      timestamp: Date.now()
    };

    // บันทึก sales ก่อน แล้วค่อยลบ orders (ถ้า sales fail จะไม่สูญข้อมูล)
    await update('sales.json', sales => [...sales, session]);
    await update('orders.json', ords => ords.filter(o => String(o.table) !== String(tableNum)));
    return session;
  }

  async function clearAllOrders() {
    await writeFile('orders.json', []);
  }

  return {
    cfg, saveConfig, isReady,
    readFile, writeFile, update,
    getOrders, getSales,
    addOrder, patchOrder, deleteOrder,
    checkoutTable, clearAllOrders
  };
})();
