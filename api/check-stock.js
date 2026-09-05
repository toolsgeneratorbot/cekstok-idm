const https = require("https");
const axios = require("axios");
const crypto = require("crypto");

const client = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 20000,
  validateStatus: () => true
});

const DID = crypto.randomUUID(); // Device ID

function uuid() {
  return crypto.randomUUID();
}

async function getToken() {
  try {
    const res = await client.get("https://api.sam-arif.org/klik/getToken");
    if (res.data?.status === "00" && res.data?.data?.refreshToken) {
      console.log("✅ Token dari API");
      return res.data.data.refreshToken;
    }
  } catch (error) {
    console.log("⚠ Gagal ambil token dari API:", error.message);
  }
  throw new Error("Gagal ambil token");
}

async function getWafToken() {
  try {
    const res = await client.get("http://141.11.25.151:3000/api/waf", { timeout: 5000 });
    if (res.data?.ok) return res.data.token;
  } catch (error) {
    console.log("⚠ Gagal ambil WAF token:", error.message);
  }
  return null;
}

async function getBestWaf() {
  try {
    return await getWafToken();
  } catch (error) {
    return null;
  }
}

function headers(token, waf) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    authorization: `Bearer ${token}`,
    "x-correlation-id": uuid(),
    "x-aws-waf-token": waf || "",
    origin: "https://www.klikindomaret.com",
    referer: "https://www.klikindomaret.com/",
    apps: JSON.stringify({
      app_version: "web",
      device_class: "desktop|browser",
      device_family: "chrome",
      device_id: DID,
      os_name: "Windows",
      os_version: "10"
    })
  };
}

async function clearCart(store, token, waf) {
  try {
    await client.post(
      "https://ap-mc.klikindomaret.com/assets-klikidmorder/api/post/cart-xpress/api/webapp/cart/update-cart",
      {
        storeCode: store,
        latitude: -6.1763897,
        longitude: 106.82667,
        mode: "PICKUP",
        districtId: "141100100",
        products: []
      },
      { headers: headers(token, waf), timeout: 10000 }
    );
  } catch (error) {}
}

async function addToCart(plu, qty, store, token, waf) {
  const payload = {
    storeCode: store,
    latitude: -6.1763897,
    longitude: 106.82667,
    mode: "PICKUP",
    districtId: "141100100",
    products: [{ plu, qty }]
  };

  try {
    const res = await client.post(
      "https://ap-mc.klikindomaret.com/assets-klikidmcore/api/post/cart-xpress/api/webapp/cart/add-to-cart",
      payload,
      { headers: headers(token, waf), timeout: 15000 }
    );
    if (typeof res.data !== "string") return res.data;
  } catch (error) {}
  return null;
}

function parseStock(data) {
  if (data?.status !== "00") return { ok: false, stock: 0 };
  const toast = (data?.data?.toastMessage || []).join(" ").toLowerCase();
  if (toast.includes("stok")) {
    const match = toast.match(/\d+/);
    if (match) return { ok: false, stock: parseInt(match[0]) };
    return { ok: false, stock: 0 };
  }
  return { ok: true };
}

function extractInfo(data, plu) {
  const found = (data?.data?.products || []).find(p => String(p.plu) === String(plu));
  const store = data?.data?.selectedStore || {};
  return {
    name: found?.productName || plu,
    price: found?.price || 0,
    storeCode: store.physicalStoreCode || store.storeCode || "-",
    storeName: store.storeName || "-",
    address: store.address || "-"
  };
}

async function checkRealStock(plu, store, token, waf) {
  await clearCart(store, token, waf);

  let low = 1;
  let high = 999;
  let info = { name: plu, price: 0, storeCode: "-", storeName: "-", address: "-" };

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const data = await addToCart(plu, mid, store, token, waf);

    if (!data || typeof data === "string") {
      return { ...info, stock: 0 };
    }

    info = extractInfo(data, plu);
    const result = parseStock(data);

    if (!result.ok && result.stock > 0) {
      await clearCart(store, token, waf);
      return { ...info, stock: result.stock };
    }

    if (result.ok) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  await clearCart(store, token, waf);
  return { ...info, stock: high };
}

// ====================== ENDPOINT ======================
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ status: "error", message: "Method Not Allowed" });
  }

  try {
    const { plu, toko } = req.query;

    if (!plu || !toko) {
      return res.status(400).json({
        status: "error",
        message: "Parameter 'plu' dan 'toko' diperlukan"
      });
    }

    const storeCode = toko.toUpperCase();
    const pluList = plu.split(",").map(x => x.trim()).filter(Boolean);

    console.log(`\n🔍 Mencari stok: ${pluList.join(", ")} di toko: ${storeCode}`);

    const token = await getToken();
    const waf = await getBestWaf();

    const products = [];
    let storeInfo = null;

    for (const itemPlu of pluList) {
      console.log(`⏳ Cek stok ${itemPlu}...`);
      const checkResult = await checkRealStock(itemPlu, storeCode, token, waf);

      if (!storeInfo && checkResult.storeCode !== "-") {
        storeInfo = {
          physicalStoreCode: checkResult.storeCode,
          storeName: checkResult.storeName,
          address: checkResult.address
        };
      }

      products.push({
        final_price: checkResult.price > 0 ? checkResult.price : null,
        name: checkResult.name,
        plu: itemPlu,
        price: checkResult.price,
        stock: checkResult.stock
      });
    }

    if (!storeInfo) {
      storeInfo = {
        address: "-",
        physicalStoreCode: storeCode,
        storeName: "-"
      };
    }

    return res.json({
      status: "success",
      data: {
        products,
        store_info: storeInfo
      }
    });

  } catch (error) {
    console.error("❌ Error:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
};
