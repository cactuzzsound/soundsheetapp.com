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
// Defaults to production. Set the CK_ENV var to "development" to read the
// CloudKit development database (e.g. when testing with an Xcode build, whose
// data goes to development). Remove/blank it for production releases.
const DEFAULT_ENV = "production";

// ── Firestore (Android app) fallback ──────────────────────────────────────────
// The iOS app publishes gear pages to CloudKit; the Android app publishes the
// same data to Firebase Firestore at public_gear/{slug}. When CloudKit has no
// page for a slug we fall back to Firestore so both platforms render here.
// The API key is the public Firebase web key (safe to expose); reads are gated
// by the Firestore rule:  match /public_gear/{doc} { allow read: if true; }
const FIRESTORE_PROJECT = "soundsheet";
const FIRESTORE_KEY = "AIzaSyBp_4nkd5Kex5bNBmQ4MUvof-9z9cLjIQ8";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Block internal/dev files that may have ended up in the asset bundle ──
    if (/^\/(\.git|\.wrangler|node_modules)(\/|$)/.test(url.pathname)
        || url.pathname.endsWith("/worker.js")
        || url.pathname.endsWith("/wrangler.jsonc")
        || url.pathname.endsWith(".pem")) {
      return new Response("Not found", { status: 404 });
    }

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

  // 1. Try CloudKit (iOS-published pages) if a server key is configured.
  if (env.CK_KEY_ID && env.CK_PRIVATE_KEY) {
    try {
      const pageRes = await ckQuery(env, "GearPage", [
        { fieldName: "slug", comparator: "EQUALS", fieldValue: { value: slug, type: "STRING" } },
      ]);
      const page = pageRes.records?.[0];
      if (page) {
        const ownerName   = page.fields.ownerName?.value   || "Sound Professional";
        const isPublished = (page.fields.isPublished?.value ?? 0) ? true : false;
        const lastUpdated = page.fields.lastUpdated?.value || null;

        if (!isPublished) {
          return json({ found: true, isPublished: false, ownerName });
        }

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
      }
      // No CloudKit page → fall through to Firestore.
    } catch (err) {
      // CloudKit failed → try Firestore before giving up.
      const fs = await firestoreGear(slug).catch(() => null);
      if (fs) return json(fs);
      return json({ error: String(err && err.message || err) }, 502);
    }
  }

  // 2. Firestore fallback (Android-published pages).
  const fs = await firestoreGear(slug).catch(() => null);
  if (fs) return json(fs);

  return json({ found: false }, 404);
}

// ── Firestore read (Android app: public_gear/{slug}) ──────────────────────────
async function firestoreGear(slug) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}`
    + `/databases/(default)/documents/public_gear/${encodeURIComponent(slug)}`
    + `?key=${FIRESTORE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;               // 404 / 403 → treat as "no page here"
  const doc = await res.json();
  const f = doc.fields;
  if (!f) return null;

  const fv = (v) => v == null ? undefined
    : (v.stringValue ?? (v.integerValue != null ? Number(v.integerValue) : undefined)
       ?? v.booleanValue ?? v.doubleValue);

  const ownerName   = fv(f.ownerName) || "Sound Professional";
  const isPublished = fv(f.isPublished) ? true : false;
  const lastUpdated = fv(f.updatedAt) ?? null;

  if (!isPublished) return { found: true, isPublished: false, ownerName };

  const raw = f.items?.arrayValue?.values || [];
  const items = raw
    .map((v) => v.mapValue?.fields || {})
    .map((mf) => ({
      name:          fv(mf.name)          || "",
      brand:         fv(mf.brand)         || "",
      category:      fv(mf.category)      || "",
      itemType:      fv(mf.itemType)      || "",
      quantityOwned: fv(mf.quantityOwned) || 1,
      sortOrder:     fv(mf.sortOrder)     || 0,
      photoURL:      fv(mf.photoURL)      || null,
    }))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  return { found: true, isPublished: true, ownerName, lastUpdated, items };
}

// ── CloudKit signed query ─────────────────────────────────────────────────────
async function ckQuery(env, recordType, filterBy, sortBy) {
  const ckEnv = env.CK_ENV || DEFAULT_ENV;
  // Server-to-Server Key IDs are per-environment. Use the dev key ID when
  // querying development (if provided), otherwise the production one.
  const keyID = (ckEnv === "development" && env.CK_KEY_ID_DEV)
    ? env.CK_KEY_ID_DEV
    : env.CK_KEY_ID;
  const subpath = `/database/1/${CONTAINER}/${ckEnv}/public/records/query`;
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
      "X-Apple-CloudKit-Request-KeyID": keyID,
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
