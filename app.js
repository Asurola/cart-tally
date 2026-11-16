'use strict';

/* Cart Tally: scan items into the cart, keep a running total against a budget.
   Everything is stored on this phone (localStorage). Money is held in fils
   (1 AED = 100 fils) as whole numbers so totals never drift. */

const KEY = 'cart-tally-v1';
const MAX_TRIPS = 36;
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- State ----------

const blank = () => ({ v: 1, budget: 0, products: {}, cart: [], trips: [] });

const toFils = (n) => (Number.isFinite(+n) && +n >= 0 ? Math.round(+n) : 0);
const toText = (s, fallback = 'Item') => (String(s ?? '').trim().slice(0, 120) || fallback);

// Accepts saved data or a backup file and returns a clean state. Throws if it isn't ours.
function normalise(d) {
  if (!d || typeof d !== 'object' || typeof d.products !== 'object' || !Array.isArray(d.cart)) {
    throw new Error('Not a Cart Tally backup');
  }
  const out = blank();
  out.budget = toFils(d.budget);
  for (const [code, p] of Object.entries(d.products || {})) {
    if (!p || typeof p !== 'object') continue;
    out.products[String(code)] = {
      name: toText(p.name),
      price: toFils(p.price),
      weighed: !!p.weighed,
      updated: String(p.updated || ''),
    };
  }
  const line = (i) => ({
    id: String(i.id || newId()),
    barcode: i.barcode ? String(i.barcode) : null,
    name: toText(i.name),
    price: toFils(i.price),
    qty: Math.max(1, Math.round(+i.qty) || 1),
    weighed: !!i.weighed,
  });
  out.cart = d.cart.filter((i) => i && typeof i === 'object').map(line);
  out.trips = (Array.isArray(d.trips) ? d.trips : [])
    .filter((t) => t && typeof t === 'object')
    .slice(0, MAX_TRIPS)
    .map((t) => ({
      date: String(t.date || ''),
      total: toFils(t.total),
      budget: toFils(t.budget),
      items: (Array.isArray(t.items) ? t.items : []).filter((i) => i && typeof i === 'object').map(line),
    }));
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalise(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not read saved data', e);
  }
  return blank();
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save. The phone may be out of space.');
  }
}

let state = load();

// ---------- Helpers ----------

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (fils) =>
  (fils / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const today = () => new Date().toISOString().slice(0, 10);

// Arabic-Indic and Persian digits to 0-9, so either keyboard works.
function latinDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x06f0)
    .replace(/٫/g, '.');
}

// "12.5", "12,50", "AED 12.50" -> fils. Returns null if it isn't a price.
function parseMoney(text) {
  const s = latinDigits(text).replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (!s || (s.match(/\./g) || []).length > 1) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n > 1e7) return null;
  return Math.round(n * 100);
}

const cartTotal = () => state.cart.reduce((sum, i) => sum + i.price * i.qty, 0);
const cartCount = () => state.cart.reduce((sum, i) => sum + i.qty, 0);

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

// A yes/no question. Resolves true or false.
function ask(message, yesLabel = 'OK') {
  const dlg = $('#askDlg');
  $('#askMsg').textContent = message;
  $('#askYes').textContent = yesLabel;
  return new Promise((resolve) => {
    const done = (answer) => {
      $('#askYes').onclick = $('#askNo').onclick = dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(answer);
    };
    $('#askYes').onclick = () => done(true);
    $('#askNo').onclick = () => done(false);
    dlg.onclose = () => done(false);
    dlg.showModal();
  });
}

// ---------- Barcodes ----------

// EAN-13 / EAN-8 / UPC-A check digit.
function checksumOk(code) {
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

// Returns a normalised code, or '' if it isn't a valid retail barcode.
// A 12-digit UPC-A becomes a 13-digit EAN with a leading 0, so both match.
function cleanCode(raw) {
  const code = latinDigits(raw).replace(/\D/g, '');
  if (![8, 12, 13].includes(code.length) || !checksumOk(code)) return '';
  return code.length === 12 ? '0' + code : code;
}

// Store-printed labels for weighed items start with 2. The number changes with
// the weight, so the price is asked each time and only the name is remembered.
const isWeighed = (code) => code.length === 13 && code[0] === '2';
const weighedKey = (code) => 'w:' + code.slice(0, 7);

// ---------- Rendering ----------

function render() {
  const total = cartTotal();
  const budget = state.budget;
  const n = cartCount();
  const items = `${n} ${n === 1 ? 'item' : 'items'}`;
  const sum = $('#summary');

  sum.classList.toggle('over', budget > 0 && total > budget);
  sum.classList.toggle('near', budget > 0 && total <= budget && total >= budget * 0.85);

  if (budget > 0) {
    $('#sumLabel').textContent = total > budget ? 'Over budget by' : 'Left to spend';
    $('#sumAmount').textContent = fmt(Math.abs(budget - total));
    $('#sumSub').textContent = `Spent ${fmt(total)} of ${fmt(budget)} · ${items}`;
    $('#bar').style.width = Math.min(100, (total / budget) * 100) + '%';
  } else {
    $('#sumLabel').textContent = 'Total so far';
    $('#sumAmount').textContent = fmt(total);
    $('#sumSub').textContent = `No budget set (tap to set one) · ${items}`;
    $('#bar').style.width = '0%';
  }

  $('#empty').hidden = state.cart.length > 0;
  // Newest first, so the item just scanned is at the top.
  $('#cart').innerHTML = state.cart
    .slice()
    .reverse()
    .map(
      (i) => `
      <li data-id="${esc(i.id)}">
        <button type="button" class="item-info" data-act="edit">
          <span class="item-name" dir="auto">${esc(i.name)}</span>
          <span class="item-unit">AED ${fmt(i.price)}${i.weighed ? ' (weighed)' : ' each'} · tap to change</span>
        </button>
        <div class="qty">
          <button type="button" data-act="minus" aria-label="One less">&minus;</button>
          <span>${i.qty}</span>
          <button type="button" data-act="plus" aria-label="One more">+</button>
        </div>
        <div class="item-line">${fmt(i.price * i.qty)}</div>
      </li>`
    )
    .join('');
}

function commit() {
  save();
  render();
}

// ---------- Cart ----------

function addLine({ barcode = null, name, price, weighed = false }) {
  const before = cartTotal();
  const same = !weighed && barcode ? state.cart.find((i) => i.barcode === barcode && !i.weighed) : null;
  if (same) {
    same.qty += 1;
    same.price = price;
    same.name = name;
    // Show it at the top again.
    state.cart.splice(state.cart.indexOf(same), 1);
    state.cart.push(same);
  } else {
    state.cart.push({ id: newId(), barcode, name, price, qty: 1, weighed });
  }
  commit();
  const after = cartTotal();
  if (state.budget > 0 && after > state.budget) {
    toast(`Over budget by AED ${fmt(after - state.budget)}`);
  } else if (state.budget > 0 && before < state.budget * 0.85 && after >= state.budget * 0.85) {
    toast(`Careful: only AED ${fmt(state.budget - after)} left`);
  } else {
    toast(`Added ${name}`);
  }
}

$('#cart').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const item = state.cart.find((i) => i.id === btn.closest('li').dataset.id);
  if (!item) return;

  if (btn.dataset.act === 'plus') {
    item.qty += 1;
    commit();
  } else if (btn.dataset.act === 'minus') {
    if (item.qty > 1) {
      item.qty -= 1;
      commit();
    } else if (await ask(`Remove ${item.name} from the cart?`, 'Remove')) {
      state.cart = state.cart.filter((i) => i !== item);
      commit();
    }
  } else if (btn.dataset.act === 'edit') {
    openItem({
      title: 'Change item',
      hint: item.weighed ? '' : 'The new price is remembered for next time.',
      name: item.name,
      price: fmt(item.price),
      okLabel: 'Save',
      dangerLabel: 'Remove from cart',
      onOk: ({ name, price }) => {
        item.name = name;
        item.price = price;
        rememberProduct(item.barcode, name, price, item.weighed);
        commit();
      },
      onDanger: () => {
        state.cart = state.cart.filter((i) => i !== item);
        commit();
      },
    });
  }
});

function rememberProduct(barcode, name, price, weighed) {
  if (!barcode) return;
  if (weighed) {
    state.products[weighedKey(barcode)] = { name, price: 0, weighed: true, updated: today() };
  } else {
    state.products[barcode] = { name, price, weighed: false, updated: today() };
  }
}

// ---------- Item dialog (add / edit) ----------

let itemCfg = null;

function openItem(cfg) {
  itemCfg = cfg;
  $('#itemTitle').textContent = cfg.title;
  $('#itemHint').textContent = cfg.hint || '';
  $('#itemHint').hidden = !cfg.hint;
  $('#itemName').value = cfg.name || '';
  $('#itemPrice').value = cfg.price || '';
  $('#itemOk').textContent = cfg.okLabel || 'Add to cart';
  $('#itemErr').hidden = true;
  $('#itemDanger').hidden = !cfg.dangerLabel;
  $('#itemDanger').textContent = cfg.dangerLabel || '';
  $('#itemDlg').showModal();
  // Put the cursor where typing is needed. (On iPhone the keyboard only opens on a tap.)
  const target = !cfg.name ? $('#itemName') : !cfg.price ? $('#itemPrice') : $('#itemOk');
  target.focus();
}

$('#itemName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#itemPrice').focus();
  }
});

$('#itemForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#itemName').value.trim().slice(0, 120);
  const price = parseMoney($('#itemPrice').value);
  const err = $('#itemErr');
  if (!name) {
    err.textContent = 'Please type a name.';
    err.hidden = false;
    $('#itemName').focus();
    return;
  }
  if (price === null) {
    err.textContent = 'Please type the price, for example 12.50';
    err.hidden = false;
    $('#itemPrice').focus();
    return;
  }
  const cfg = itemCfg;
  $('#itemDlg').close();
  cfg.onOk({ name, price });
});

$('#itemDanger').addEventListener('click', () => {
  const cfg = itemCfg;
  $('#itemDlg').close();
  cfg.onDanger?.();
});

$('#itemDlg').addEventListener('close', () => (itemCfg = null));

$('#manualBtn').addEventListener('click', () => {
  openItem({
    title: 'Add by hand',
    hint: 'For anything without a barcode.',
    onOk: ({ name, price }) => addLine({ name, price }),
  });
});

// ---------- After a scan ----------

function handleCode(code) {
  if (isWeighed(code)) {
    const known = state.products[weighedKey(code)];
    openItem({
      title: 'Weighed item',
      hint: 'Type the price printed on the sticker.',
      name: known?.name || '',
      onOk: ({ name, price }) => {
        rememberProduct(code, name, price, true);
        addLine({ barcode: code, name, price, weighed: true });
      },
    });
    return;
  }

  const known = state.products[code];
  const onOk = ({ name, price }) => {
    rememberProduct(code, name, price, false);
    addLine({ barcode: code, name, price });
  };

  if (known) {
    openItem({
      title: 'Add to cart',
      hint: 'Check the price still matches the shelf.',
      name: known.name,
      price: fmt(known.price),
      onOk,
    });
  } else {
    openItem({
      title: 'New item',
      hint: 'Type the name and shelf price once. Next time you only scan it.',
      onOk,
    });
    lookupName(code);
  }
}

// Best effort: ask Open Food Facts (a free public database) for the product
// name. Only the barcode number is sent. Silently does nothing when offline.
async function lookupName(code) {
  if (!navigator.onLine) return;
  const cfg = itemCfg;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,brands,quantity`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return;
    const p = (await res.json()).product;
    if (!p) return;
    const base = (p.product_name_en || p.product_name || '').trim();
    if (!base) return;
    const brand = (p.brands || '').split(',')[0].trim();
    const parts = [
      brand && !base.toLowerCase().includes(brand.toLowerCase()) ? brand : '',
      base,
      (p.quantity || '').trim(),
    ].filter(Boolean);
    // Only fill in if the same dialog is still open and nothing was typed meanwhile.
    if (itemCfg === cfg && cfg && !$('#itemName').value.trim()) {
      $('#itemName').value = parts.join(' ').slice(0, 120);
      $('#itemHint').textContent = 'Name found online. Check it, then type the shelf price.';
    }
  } catch (e) {
    /* offline or slow: she types the name */
  }
}

// ---------- Scanner ----------

const video = $('#video');
let stream = null;
let scanning = false;
let detector = null;
let lastHit = '';
let scanErrors = 0;
let wakeLock = null;
let audio = null;

function makeDetector() {
  const api = window.BarcodeDetectionAPI;
  // Load the decoder from our own folder, so scanning works offline.
  api.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? 'vendor/zxing_reader.wasm' : prefix + path),
    },
  });
  return new api.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
}

function beep() {
  try {
    if (!audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1000;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.12);
  } catch (e) {
    /* sound is optional */
  }
}

const setScanMsg = (msg) => ($('#scanMsg').textContent = msg);

async function openScanner() {
  // Sound can only be switched on from a tap, so do it here.
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.();
  } catch (e) {
    audio = null;
  }

  $('#scanner').hidden = false;
  setScanMsg('Starting the camera…');
  lastHit = '';
  scanErrors = 0;

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera support');
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if ($('#scanner').hidden) {
      // Closed while the permission question was showing.
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    video.srcObject = s;
    await video.play();
    detector ??= makeDetector();
    scanning = true;
    setScanMsg('Hold the barcode inside the box');
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch (e) {
      /* optional */
    }
    scanLoop();
  } catch (e) {
    console.warn('Camera failed', e);
    setScanMsg(
      e && e.name === 'NotAllowedError'
        ? 'The camera is not allowed for this app. Allow it in Settings, or type the number.'
        : 'The camera could not start. You can type the number instead.'
    );
  }
}

async function scanLoop() {
  if (!scanning) return;
  let wait = 140;
  try {
    if (video.readyState >= 2) {
      const found = await detector.detect(video);
      if (!scanning) return;
      const code = found.map((f) => cleanCode(f.rawValue)).find(Boolean);
      if (code) {
        // Two matching reads in a row, to rule out a misread.
        if (code === lastHit) {
          beep();
          closeScanner();
          handleCode(code);
          return;
        }
        lastHit = code;
        wait = 50;
      }
    }
  } catch (e) {
    console.warn('Scan failed', e);
    if (++scanErrors > 5) {
      scanning = false;
      setScanMsg('The scanner could not start. You can type the number instead.');
      return;
    }
  }
  setTimeout(scanLoop, wait);
}

function closeScanner() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $('#scanner').hidden = true;
}

$('#scanBtn').addEventListener('click', openScanner);
$('#scanClose').addEventListener('click', closeScanner);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !$('#scanner').hidden) closeScanner();
});

// Typing the number instead
$('#typeBtn').addEventListener('click', () => {
  $('#codeInput').value = '';
  $('#codeErr').hidden = true;
  $('#codeDlg').showModal();
  $('#codeInput').focus();
});

$('#codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = cleanCode($('#codeInput').value);
  if (!code) {
    $('#codeErr').textContent = 'That number does not look right. Check the digits and try again.';
    $('#codeErr').hidden = false;
    return;
  }
  $('#codeDlg').close();
  closeScanner();
  handleCode(code);
});

// ---------- Budget ----------

function openBudget() {
  $('#budgetInput').value = state.budget ? fmt(state.budget).replace(/,/g, '') : '';
  $('#budgetErr').hidden = true;
  $('#budgetDlg').showModal();
  $('#budgetInput').focus();
}

$('#summaryBtn').addEventListener('click', openBudget);

$('#budgetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#budgetInput').value.trim();
  const value = text ? parseMoney(text) : 0;
  if (value === null) {
    $('#budgetErr').textContent = 'Please type an amount, for example 1500';
    $('#budgetErr').hidden = false;
    return;
  }
  state.budget = value;
  $('#budgetDlg').close();
  commit();
});

// ---------- Menu ----------

$('#menuBtn').addEventListener('click', () => $('#menuDlg').showModal());

$('#menuDlg').addEventListener('click', (e) => {
  const action = e.target.closest('[data-menu]')?.dataset.menu;
  if (!action) return;
  $('#menuDlg').close();
  ({ budget: openBudget, finish: finishTrip, products: openProducts, trips: openTrips, backup, restore })[action]();
});

async function finishTrip() {
  if (!state.cart.length) {
    toast('The cart is already empty.');
    return;
  }
  const ok = await ask(
    `Finish this trip? The cart (AED ${fmt(cartTotal())}) will be saved to Past trips and cleared.`,
    'Finish trip'
  );
  if (!ok) return;
  state.trips.unshift({ date: new Date().toISOString(), total: cartTotal(), budget: state.budget, items: state.cart });
  state.trips = state.trips.slice(0, MAX_TRIPS);
  state.cart = [];
  commit();
  toast('Trip saved. Cart cleared.');
}

// Saved items
function renderProducts() {
  const q = $('#productSearch').value.trim().toLowerCase();
  const rows = Object.entries(state.products)
    .filter(([, p]) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('#productList').innerHTML = rows.length
    ? rows
        .map(
          ([code, p]) => `
        <li><button type="button" data-code="${esc(code)}">
          <span class="p-name" dir="auto">${esc(p.name)}</span>
          <span class="p-price">${p.weighed ? 'by weight' : 'AED ' + fmt(p.price)}</span>
        </button></li>`
        )
        .join('')
    : `<p class="none">${q ? 'Nothing matches.' : 'Nothing saved yet. Items are saved the first time you scan them.'}</p>`;
}

function openProducts() {
  $('#productSearch').value = '';
  renderProducts();
  $('#productsDlg').showModal();
}

$('#productSearch').addEventListener('input', renderProducts);

$('#productList').addEventListener('click', (e) => {
  const code = e.target.closest('[data-code]')?.dataset.code;
  const p = state.products[code];
  if (!p) return;
  openItem({
    title: 'Saved item',
    hint: p.weighed ? 'Weighed item: the price is asked each time, so it is not saved here.' : '',
    name: p.name,
    price: fmt(p.price),
    okLabel: 'Save',
    dangerLabel: 'Forget this item',
    onOk: ({ name, price }) => {
      state.products[code] = { ...p, name, price: p.weighed ? 0 : price, updated: today() };
      save();
      renderProducts();
    },
    onDanger: () => {
      delete state.products[code];
      save();
      renderProducts();
    },
  });
});

// Past trips
function openTrips() {
  const dateText = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? 'Trip' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  $('#tripList').innerHTML = state.trips.length
    ? state.trips
        .map(
          (t) => `
        <details>
          <summary><span>${esc(dateText(t.date))}</span><span>AED ${fmt(t.total)}</span></summary>
          <ul>
            ${t.budget ? `<li>Budget: AED ${fmt(t.budget)}</li>` : ''}
            ${t.items.map((i) => `<li>${i.qty} × ${esc(i.name)}: ${fmt(i.price * i.qty)}</li>`).join('')}
          </ul>
        </details>`
        )
        .join('')
    : '<p class="none">No trips yet. Use "Finish trip" at the end of a shop.</p>';
  $('#tripsDlg').showModal();
}

// Backup and restore
async function backup() {
  const name = `cart-tally-backup-${today()}.json`;
  const json = JSON.stringify(state, null, 1);
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Cart Tally backup' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // she closed the share sheet
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Backup saved to your downloads.');
}

function restore() {
  $('#restoreFile').value = '';
  $('#restoreFile').click();
}

$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let data;
  try {
    data = normalise(JSON.parse(await file.text()));
  } catch (err) {
    toast('That file is not a Cart Tally backup.');
    return;
  }
  const n = Object.keys(data.products).length;
  const ok = await ask(
    `Replace everything on this phone with the backup (${n} saved ${n === 1 ? 'item' : 'items'})?`,
    'Replace'
  );
  if (!ok) return;
  state = data;
  commit();
  toast('Backup restored.');
});

// ---------- Shared wiring and start-up ----------

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close();
});

// On an iPhone in Safari (not yet on the Home Screen), explain how to install.
// Safari can clear a website's data after a week without use; Home Screen apps are kept.
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isInstalled = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
if (isIos && !isInstalled) $('#installTip').hidden = false;
$('#installTipClose').addEventListener('click', () => ($('#installTip').hidden = true));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline support failed', e));
}
navigator.storage?.persist?.().catch(() => {});

render();
