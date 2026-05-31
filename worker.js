// worker.js
// ─────────────────────────────────────────────────────────────────────────────
// SoundSheet website Worker.
//
// Serves the static site AND proxies gear-page data from CloudKit's public
// database using a CloudKit *Server-to-Server* key (ECDSA P-256 / SHA-256
// signed requests). The private key never reaches the browser — only this
// Worker holds it (as a Cloudflare secret).
//
// Required Cloudflare environment variables (set in the dashboard or via
// `wrangler secret put`):
//   CK_KEY_ID       – the Server-to-Server Key ID from CloudKit Console
//   CK_PRIVATE_KEY  – the EC private key in PKCS#8 PEM
//                     (-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----)
//
// Endpoint exposed to the frontend:
//   GET /api/gear/:slug  →  { ownerName, isPublished, lastUpdated, items: [...] }
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER = "iCloud.cactuzzsound.SoundSheet";
const ENV       = "production";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── API: gear data ──────────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/gear/")) {
      return handleGearApi(url, env);
    }

    // ── Gear viewer page (any /gear/<slug> except the static example) ────────
    // Serve the viewer's index.html while keeping the browser URL on the slug.
    // We fetch "/gear/" (not "/gear/index.html") because Cloudflare 307-redirects
    // *.../index.html to the directory, which would strip the slug.
    if (/^\/gear\/[^/]+\/?$/.test(url.pathname) && !url.pathname.startsWith("/gear/example")) {
      return env.ASSETS.fetch(new Request(new URL("/gear/", url), request));
    }

    // ── Everything else: static assets ───────────────────────────────────────
    return env.ASSETS.fetch(request);
  },
};

// ── Gear API handler ──────────────────────────────────────────────────────────
async function handleGearApi(url, env) {
  const slug = decodeURIComponent(url.pathname.replace("/api/gear/", "").replace(/\/$/, ""));
  if (!slug) return json({ error: "missing slug" }, 400);

  if (!env.CK_KEY_ID || !env.CK_PRIVATE_KEY) {
    return json({ error: "Server not configured (missing CloudKit key)." }, 500);
  }

  try {
    // 1. GearPage for this slug
    const pageRes = await ckQuery(env, "GearPage", [
      { fieldName: "slug", comparator: "EQUALS", fieldValue: { value: slug, type: "STRING" } },
    ]);
    const page = pageRes.records?.[0];
    if (!page) return json({ found: false }, 404);

    const ownerName   = page.fields.ownerName?.value   || "Sound Professional";
    const isPublished = (page.fields.isPublished?.value ?? 0) ? true : false;
    const lastUpdated = page.fields.lastUpdated?.value || null;

    if (!isPublished) {
      return json({ found: true, isPublished: false, ownerName });
    }

    // 2. PublicGearItem records for this slug
    const itemsRes = await ckQuery(env, "PublicGearItem",
      [{ fieldName: "pageSlug", comparator: "EQUALS", fieldValue: { value: slug, type: "STRING" } }],
      [{ fieldName: "sortOrder", ascending: true }]
    );

    const items = (itemsRes.records || []).map((r) => ({
      name:          r.fields.name?.value          || "",
      brand:         r.fields.brand?.value         || "",
      category:      r.fields.category?.value       || "",
      itemType:      r.fields.itemType?.value       || "",
      quantityOwned: r.fields.quantityOwned?.value  || 1,
      photoURL:      r.fields.photoAsset?.value?.downloadURL || null,
    }));

    return json({ found: true, isPublished: true, ownerName, lastUpdated, items });
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 502);
  }
}

// ── CloudKit signed query ─────────────────────────────────────────────────────
async function ckQuery(env, recordType, filterBy, sortBy) {
  const subpath = `/database/1/${CONTAINER}/${ENV}/public/records/query`;
  const query = { recordType, filterBy };
  if (sortBy) query.sortBy = sortBy;
  const body = JSON.stringify({ query });

  const date    = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); // seconds precision
  const bodyB64 = await sha256Base64(body);
  const message = `${date}:${bodyB64}:${subpath}`;
  const signature = await signMessage(env.CK_PRIVATE_KEY, message);

  const res = await fetch(`https://api.apple-cloudkit.com${subpath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Apple-CloudKit-Request-KeyID": env.CK_KEY_ID,
      "X-Apple-CloudKit-Request-ISO8601Date": date,
      "X-Apple-CloudKit-Request-SignatureV1": signature,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CloudKit ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Crypto helpers (Web Crypto) ───────────────────────────────────────────────

async function sha256Base64(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToBase64(new Uint8Array(buf));
}

let cachedKey = null;
async function importPrivateKey(pem) {
  if (cachedKey) return cachedKey;
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = base64ToBytes(b64);
  cachedKey = await crypto.subtle.importKey(
    "pkcs8", der.buffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  return cachedKey;
}

async function signMessage(pem, message) {
  const key = await importPrivateKey(pem);
  const raw = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(message)
  );
  // Web Crypto returns raw r||s; CloudKit wants DER-encoded, base64'd.
  const der = rawToDer(new Uint8Array(raw));
  return bytesToBase64(der);
}

// Convert a raw (r||s) P-256 ECDSA signature to DER.
function rawToDer(raw) {
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  const encodeInt = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let b = bytes.slice(i);
    if (b[0] & 0x80) {
      const tmp = new Uint8Array(b.length + 1);
      tmp[0] = 0x00; tmp.set(b, 1); b = tmp;
    }
    const out = new Uint8Array(b.length + 2);
    out[0] = 0x02; out[1] = b.length; out.set(b, 2);
    return out;
  };
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const seq = new Uint8Array(rEnc.length + sEnc.length + 2);
  seq[0] = 0x30; seq[1] = rEnc.length + sEnc.length;
  seq.set(rEnc, 2); seq.set(sEnc, 2 + rEnc.length);
  return seq;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── JSON response helper ──────────────────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
