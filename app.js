/*
 * DiTz Store - Simple Online Shop with QRIS Payment Integration
 *
 * This Node.js application implements a very basic e‑commerce website with
 * dynamic QRIS payment generation using the QRIS.PW API (and an example call
 * for ClaidexPay). It does not depend on any third‑party npm packages – it
 * relies only on Node’s built‑in modules. As a result you can run it in
 * restricted environments without installing additional dependencies. Data
 * about products, orders and admin credentials are stored in a JSON file
 * (data.json) located in the root of the project.
 *
 * Features:
 *  - Public storefront showing products with the ability to add them to a cart.
 *  - Cart and checkout pages. When checking out, the server requests a
 *    dynamic QR code from QRIS.PW and shows it to the customer.
 *  - Webhook endpoint to receive payment notifications from QRIS.PW and
 *    automatically mark orders as paid.
 *  - Simple admin panel with login, product management, and order statistics.
 *
 * IMPORTANT: Before running this application you must set your QRIS.PW API
 * credentials in the `.env` file at the root of the project. See
 * README.md for details.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');

// Load environment variables from .env if available
function loadEnv() {
  try {
    const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envText.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        process.env[key] = value;
      }
    });
  } catch (err) {
    // No .env file – ignore
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

// Read and write data from the JSON database
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { products: [], orders: [], admin: { username: 'admin', password: 'password' } };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Session management: simple in‑memory store
const sessions = {};
function createSession(username) {
  const token = crypto.randomBytes(16).toString('hex');
  sessions[token] = { username, createdAt: Date.now() };
  return token;
}
function getSession(token) {
  return sessions[token];
}

// Utility to render HTML templates with placeholders
function renderTemplate(templateName, variables = {}) {
  const filePath = path.join(VIEWS_DIR, templateName);
  let html = fs.readFileSync(filePath, 'utf8');
  Object.keys(variables).forEach((key) => {
    const value = variables[key];
    // Escape special regex characters in key
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\{\\{\\s*' + escapedKey + '\\s*\\}\\}', 'g');
    html = html.replace(regex, value);
  });
  return html;
}

// Serve static files from the public directory
function serveStatic(req, res) {
  const reqPath = url.parse(req.url).pathname;
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// Helper to send JSON responses
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Generate an order ID
function generateOrderId() {
  return 'ORDER-' + Date.now();
}

// Generate a QRIS payment via QRIS.PW API
function createQrisPayment(amount, orderId, callbackUrl, cb) {
  const apiKey = process.env.QRIS_API_KEY;
  const apiSecret = process.env.QRIS_API_SECRET;
  if (!apiKey || !apiSecret) {
    return cb(new Error('QRIS API credentials not configured'));
  }
  const postData = JSON.stringify({
    amount: amount,
    order_id: orderId,
    callback_url: callbackUrl
  });
  const options = {
    hostname: 'qris.pw',
    port: 443,
    path: '/api/create-payment.php',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'X-API-Key': apiKey,
      'X-API-Secret': apiSecret
    }
  };
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.success) {
          cb(null, result);
        } else {
          cb(new Error(result.error || 'QRIS API error'));
        }
      } catch (err) {
        cb(err);
      }
    });
  });
  req.on('error', (err) => cb(err));
  req.write(postData);
  req.end();
}

// Check QRIS payment status via QRIS.PW API
function checkQrisPayment(transactionId, cb) {
  const apiKey = process.env.QRIS_API_KEY;
  const apiSecret = process.env.QRIS_API_SECRET;
  if (!apiKey || !apiSecret) {
    return cb(new Error('QRIS API credentials not configured'));
  }
  const pathUrl = '/api/check-payment.php?transaction_id=' + encodeURIComponent(transactionId);
  const options = {
    hostname: 'qris.pw',
    port: 443,
    path: pathUrl,
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
      'X-API-Secret': apiSecret
    }
  };
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        cb(null, result);
      } catch (err) {
        cb(err);
      }
    });
  });
  req.on('error', (err) => cb(err));
  req.end();
}

// Example: Create payment via ClaidexPay SNAP API
function createClaidexPayment(amount, merchantTradeNo, cb) {
  const clientKey = process.env.CLAIDEX_CLIENT_KEY;
  const clientSecret = process.env.CLAIDEX_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    return cb(new Error('Claidex API credentials not configured'));
  }
  // Signature creation: simple example using HMAC SHA256 of amount + merchantTradeNo
  const signature = crypto
    .createHmac('sha256', clientSecret)
    .update(amount + merchantTradeNo)
    .digest('hex');
  const postData = JSON.stringify({ amount, merchantTradeNo, currency: 'IDR' });
  const options = {
    hostname: 'api.claidexpayment.host',
    port: 443,
    path: '/snap/v1/qris',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CLIENT-KEY': clientKey,
      'X-SIGNATURE': signature,
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        cb(null, result);
      } catch (err) {
        cb(err);
      }
    });
  });
  req.on('error', (err) => cb(err));
  req.write(postData);
  req.end();
}

// HTTP request handler
function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  // Serve static assets
  if (pathname.startsWith('/public/')) {
    return serveStatic(req, res);
  }
  // Parse cookies for session management
  const cookies = {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach((cookie) => {
      const parts = cookie.trim().split('=');
      cookies[parts[0]] = decodeURIComponent(parts[1]);
    });
  }
  // ROUTES
  if (req.method === 'GET' && pathname === '/') {
    const data = readData();
    const productsHtml = data.products
      .map((p) => {
        return `\n          <div class="product">\n            <img src="/public/images/${p.image}" alt="${p.name}" />\n            <h3>${p.name}</h3>\n            <p>${p.description || ''}</p>\n            <p class="price">Rp ${p.price.toLocaleString('id-ID')}</p>\n            <form method="POST" action="/add-to-cart">\n              <input type="hidden" name="productId" value="${p.id}" />\n              <button type="submit">Tambah ke Keranjang</button>\n            </form>\n          </div>`;
      })
      .join('');
    const html = renderTemplate('index.html', {
      products: productsHtml,
      storeName: 'DiTz Store',
      supportEmail: 'ditzstoreofficial@gmail.com',
      supportPhone: '087739435496'
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // Handle add to cart
  if (req.method === 'POST' && pathname === '/add-to-cart') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const params = querystring.parse(body);
      const productId = parseInt(params.productId, 10);
      let cart = [];
      if (cookies.cart) {
        try {
          cart = JSON.parse(cookies.cart);
        } catch (err) {}
      }
      cart.push(productId);
      // Set cart cookie
      res.writeHead(302, {
        Location: '/cart',
        'Set-Cookie': 'cart=' + encodeURIComponent(JSON.stringify(cart)) + '; Path=/'
      });
      res.end();
    });
    return;
  }
  // Cart page
  if (req.method === 'GET' && pathname === '/cart') {
    const data = readData();
    let cart = [];
    if (cookies.cart) {
      try {
        cart = JSON.parse(cookies.cart);
      } catch (err) {
        cart = [];
      }
    }
    const items = cart.map((id) => data.products.find((p) => p.id === id)).filter(Boolean);
    const total = items.reduce((sum, p) => sum + p.price, 0);
    const itemsHtml = items
      .map((p, idx) => {
        return `\n          <tr>\n            <td>${idx + 1}</td>\n            <td>${p.name}</td>\n            <td>Rp ${p.price.toLocaleString('id-ID')}</td>\n          </tr>`;
      })
      .join('');
    const html = renderTemplate('cart.html', {
      items: itemsHtml || '<tr><td colspan="3">Keranjang kosong</td></tr>',
      total: 'Rp ' + total.toLocaleString('id-ID')
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // Checkout page
  if (req.method === 'GET' && pathname === '/checkout') {
    // Show summary and confirm button
    let cart = [];
    if (cookies.cart) {
      try {
        cart = JSON.parse(cookies.cart);
      } catch (err) {}
    }
    const data = readData();
    const items = cart.map((id) => data.products.find((p) => p.id === id)).filter(Boolean);
    const total = items.reduce((sum, p) => sum + p.price, 0);
    if (total === 0) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    const html = renderTemplate('checkout.html', {
      total: 'Rp ' + total.toLocaleString('id-ID'),
      count: items.length
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // Handle checkout POST – create order and payment
  if (req.method === 'POST' && pathname === '/checkout') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let cart = [];
      if (cookies.cart) {
        try {
          cart = JSON.parse(cookies.cart);
        } catch (err) {}
      }
      const data = readData();
      const items = cart.map((id) => data.products.find((p) => p.id === id)).filter(Boolean);
      const amount = items.reduce((sum, p) => sum + p.price, 0);
      if (amount === 0) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      const orderId = generateOrderId();
      // Create order record with status pending
      const order = {
        id: orderId,
        items: items.map((p) => ({ id: p.id, name: p.name, price: p.price })),
        amount: amount,
        status: 'pending',
        transaction_id: null,
        created_at: new Date().toISOString(),
        paid_at: null
      };
      data.orders.push(order);
      writeData(data);
      // Choose payment provider: default to QRIS.PW; could be changed to Claidex
      const callbackUrl = `https://${req.headers.host}/webhook`;
      createQrisPayment(amount, orderId, callbackUrl, (err, result) => {
        if (err) {
          // On error, show message
          const msg = `<p>Gagal membuat pembayaran: ${err.message}</p>`;
          res.writeHead(500, { 'Content-Type': 'text/html' });
          return res.end(msg);
        }
        // Store transaction id
        const data2 = readData();
        const orderRef = data2.orders.find((o) => o.id === orderId);
        if (orderRef) {
          orderRef.transaction_id = result.transaction_id;
          writeData(data2);
        }
        // Show payment page with QR image and string
        const html = renderTemplate('payment.html', {
          amount: 'Rp ' + amount.toLocaleString('id-ID'),
          qrisUrl: result.qris_url,
          qrisString: result.qris_string,
          orderId: orderId,
          transactionId: result.transaction_id
        });
        // Clear cart cookie
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'cart=; Path=/; Max-Age=0'
        });
        res.end(html);
      });
    });
    return;
  }
  // Payment status page: check status and show result
  if (req.method === 'GET' && pathname === '/payment-status') {
    const transactionId = parsedUrl.query.transaction_id;
    if (!transactionId) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end('<p>Transaction ID tidak ditemukan.</p>');
    }
    checkQrisPayment(transactionId, (err, result) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        return res.end('<p>Gagal mengecek status pembayaran.</p>');
      }
      // Update order status if paid
      if (result.status === 'paid') {
        const data = readData();
        const order = data.orders.find((o) => o.transaction_id === transactionId);
        if (order && order.status !== 'paid') {
          order.status = 'paid';
          order.paid_at = new Date().toISOString();
          writeData(data);
        }
      }
      let message;
      if (result.status === 'paid') {
        message = 'Terima kasih, pembayaran Anda telah berhasil.';
      } else if (result.status === 'pending') {
        message = 'Pembayaran belum selesai. Silakan cek kembali nanti.';
      } else if (result.status === 'expired') {
        message = 'QR code telah expired. Silakan lakukan checkout ulang.';
      } else {
        message = 'Status pembayaran: ' + result.status;
      }
      const html = renderTemplate('payment_status.html', {
        status: result.status,
        transactionId: transactionId,
        orderId: result.order_id,
        message: message
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }
  // Webhook endpoint to handle asynchronous payment notifications from QRIS.PW
  if (req.method === 'POST' && pathname === '/webhook') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const data = readData();
        const order = data.orders.find((o) => o.id === payload.order_id);
        if (order) {
          order.status = payload.status;
          if (payload.status === 'paid') {
            order.paid_at = new Date().toISOString();
          }
          writeData(data);
        }
      } catch (err) {
        // ignore invalid JSON
      }
      res.writeHead(200);
      res.end('OK');
    });
    return;
  }
  // Admin login page
  if (req.method === 'GET' && pathname === '/admin/login') {
    const errorMessage = parsedUrl.query.error ? '<p class="error">Login gagal. Periksa username atau password.</p>' : '';
    const html = renderTemplate('admin/login.html', {
      errorMessage: errorMessage
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // Handle admin login
  if (req.method === 'POST' && pathname === '/admin/login') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const params = querystring.parse(body);
      const username = params.username;
      const password = params.password;
      const data = readData();
      if (
        username === data.admin.username &&
        password === data.admin.password
      ) {
        const token = createSession(username);
        res.writeHead(302, {
          Location: '/admin/dashboard',
          'Set-Cookie': 'session=' + token + '; Path=/'
        });
        res.end();
      } else {
        res.writeHead(302, { Location: '/admin/login?error=1' });
        res.end();
      }
    });
    return;
  }
  // Middleware: require admin session
  function requireAdmin(req, res) {
    const token = cookies.session;
    if (!token || !getSession(token)) {
      res.writeHead(302, { Location: '/admin/login' });
      res.end();
      return false;
    }
    return true;
  }
  // Admin dashboard
  if (req.method === 'GET' && pathname === '/admin/dashboard') {
    if (!requireAdmin(req, res)) return;
    const data = readData();
    const totalOrders = data.orders.length;
    const totalRevenue = data.orders
      .filter((o) => o.status === 'paid')
      .reduce((sum, o) => sum + o.amount, 0);
    const html = renderTemplate('admin/dashboard.html', {
      totalOrders: totalOrders,
      totalRevenue: 'Rp ' + totalRevenue.toLocaleString('id-ID')
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // Admin orders list
  if (req.method === 'GET' && pathname === '/admin/orders') {
    if (!requireAdmin(req, res)) return;
    const data = readData();
    const rows = data.orders
      .map((o) => {
        return `\n          <tr>\n            <td>${o.id}</td>\n            <td>${o.amount}</td>\n            <td>${o.status}</td>\n            <td>${o.transaction_id || '-'}</td>\n            <td>${o.paid_at || '-'}</td>\n          </tr>`;
      })
      .join('');
    const html = renderTemplate('admin/orders.html', { orders: rows });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // Admin products list
  if (req.method === 'GET' && pathname === '/admin/products') {
    if (!requireAdmin(req, res)) return;
    const data = readData();
    const rows = data.products
      .map((p) => {
        return `\n          <tr>\n            <td>${p.id}</td>\n            <td>${p.name}</td>\n            <td>${p.price}</td>\n            <td>\n              <form method="POST" action="/admin/products/delete" onsubmit="return confirm('Hapus produk ini?');">\n                <input type="hidden" name="id" value="${p.id}" />\n                <button type="submit">Hapus</button>\n              </form>\n            </td>\n          </tr>`;
      })
      .join('');
    const html = renderTemplate('admin/products.html', { products: rows });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  // Handle add product
  if (req.method === 'POST' && pathname === '/admin/products/add') {
    if (!requireAdmin(req, res)) return;
    let body
