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
// The Firebase web key is read from the FIRESTORE_KEY Cloudflare var (kept out
// of source control); reads are gated by the Firestore rule:
//   match /public_gear/{doc} { allow read: if true; }
const FIRESTORE_PROJECT = "soundsheet";

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

    // ── API: collaborative checklists ─────────────────────────────────────────
    // Read-write shared kit lists in Firestore under shared_checklists/{code}.
    // Serves the web tick-off page and the iOS/macOS apps (which have no Firebase
    // SDK); the Android app talks to Firestore directly.
    if (url.pathname.startsWith("/api/checklist")) {
      return handleChecklistApi(request, url, env);
    }

    // ── Collaborative checklist viewer page (/c/<code>) ───────────────────────
    if (/^\/c\/[^/]+\/?$/.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL("/c/", url), request));
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
  const fs = await firestoreGear(slug, env).catch(() => null);
  if (fs) return json(fs);

  return json({ found: false }, 404);
}

// ── Firestore read (Android app: public_gear/{slug}) ──────────────────────────
async function firestoreGear(slug, env) {
  const key = env.FIRESTORE_KEY;
  if (!key) return null;                    // not configured → skip Firestore fallback
  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}`
    + `/databases/(default)/documents/public_gear/${encodeURIComponent(slug)}`
    + `?key=${encodeURIComponent(key)}`;
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

// ── Collaborative checklists ──────────────────────────────────────────────────
//
// Firestore layout (capability model: the unguessable code IS the doc id):
//   shared_checklists/{code}                 { title, ownerName, updatedAt }
//   shared_checklists/{code}/items/{itemId}  { name, category, quantity, order,
//                                              checked, checkedBy, addedBy,
//                                              isRequest, note, updatedAt }
// Firestore rule needed (add in the Firebase console):
//   match /shared_checklists/{code} {
//     allow read, write: if true;
//     match /items/{itemId} { allow read, write: if true; }
//   }

const CHECKLIST_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no easily-confused chars

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function handleChecklistApi(request, url, env) {
  if (!env.FIRESTORE_KEY) return json({ error: "not_configured" }, 503);
  // /api/checklist            → collection ops (POST create)
  // /api/checklist/:code      → GET
  // /api/checklist/:code/items→ POST add
  // /api/checklist/:code/items/:id → PATCH / DELETE
  const parts = url.pathname.replace(/^\/api\/checklist\/?/, "").split("/").filter(Boolean);
  const method = request.method;
  try {
    if (parts.length === 0 && method === "POST") return checklistCreate(request, env);
    const code = parts[0];
    if (!code) return json({ error: "bad_request" }, 400);
    if (parts.length === 1 && method === "GET") return checklistGet(code, env);
    if (parts[1] === "items" && parts.length === 2 && method === "POST") {
      return checklistAddItem(code, request, env);
    }
    if (parts[1] === "items" && parts.length === 3) {
      const id = parts[2];
      if (method === "PATCH") return checklistPatchItem(code, id, request, env);
      if (method === "DELETE") return checklistDeleteItem(code, id, env);
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
}

async function checklistCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = Array.from({ length: 8 },
    () => CHECKLIST_ALPHABET[Math.floor(Math.random() * CHECKLIST_ALPHABET.length)]).join("");
  const now = new Date().toISOString();
  await fsSet(env, `shared_checklists/${code}`, {
    title: String(body.title || "Kit checklist"),
    ownerName: String(body.ownerName || ""),
    updatedAt: { t: now },
  });
  const items = Array.isArray(body.items) ? body.items : [];
  await Promise.all(items.map((it, i) => fsSet(env,
    `shared_checklists/${code}/items/${crypto.randomUUID()}`, {
      name: String(it.name || ""),
      category: String(it.category || ""),
      quantity: Number(it.quantity || 1),
      order: Number(it.order != null ? it.order : i),
      checked: false,
      checkedBy: "",
      addedBy: String(body.ownerName || ""),
      isRequest: false,
      note: "",
      updatedAt: { t: now },
    })));
  return json({ code });
}

async function checklistGet(code, env) {
  const meta = await fsGet(env, `shared_checklists/${code}`);
  if (!meta) return json({ found: false }, 404);
  const items = await fsListItems(env, code);
  return json({ found: true, code, ...meta, items });
}

async function checklistAddItem(code, request, env) {
  const meta = await fsGet(env, `shared_checklists/${code}`);
  if (!meta) return json({ found: false }, 404);
  const body = await request.json().catch(() => ({}));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await fsSet(env, `shared_checklists/${code}/items/${id}`, {
    name: String(body.name || ""),
    category: String(body.category || ""),
    quantity: Number(body.quantity || 1),
    order: Number(body.order || 9999),
    checked: false,
    checkedBy: "",
    addedBy: String(body.addedBy || ""),
    isRequest: body.isRequest !== false, // items added after creation default to a request
    note: String(body.note || ""),
    updatedAt: { t: now },
  });
  await fsTouch(env, code);
  return json({ id });
}

async function checklistPatchItem(code, id, request, env) {
  const body = await request.json().catch(() => ({}));
  const fields = {};
  if ("checked" in body) { fields.checked = !!body.checked; fields.checkedBy = String(body.checkedBy || ""); }
  if ("name" in body) fields.name = String(body.name);
  if ("quantity" in body) fields.quantity = Number(body.quantity);
  if ("note" in body) fields.note = String(body.note);
  if (Object.keys(fields).length === 0) return json({ error: "no_fields" }, 400);
  fields.updatedAt = { t: new Date().toISOString() };
  await fsPatch(env, `shared_checklists/${code}/items/${id}`, fields);
  await fsTouch(env, code);
  return json({ ok: true });
}

async function checklistDeleteItem(code, id, env) {
  await fsDelete(env, `shared_checklists/${code}/items/${id}`);
  await fsTouch(env, code);
  return json({ ok: true });
}

async function fsTouch(env, code) {
  await fsPatch(env, `shared_checklists/${code}`, { updatedAt: { t: new Date().toISOString() } });
}

// ── Firestore REST value (de)serialisation ────────────────────────────────────
// A plain JS value maps to a Firestore typed value. `{ t: iso }` is our marker
// for a timestamp so callers don't have to spell out timestampValue.
function fsEncodeValue(v) {
  if (v && typeof v === "object" && "t" in v) return { timestampValue: v.t };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v == null ? "" : String(v) };
}
function fsEncodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = fsEncodeValue(v);
  return { fields };
}
function fsDecodeValue(v) {
  if (v == null) return undefined;
  if (v.stringValue != null) return v.stringValue;
  if (v.booleanValue != null) return v.booleanValue;
  if (v.integerValue != null) return Number(v.integerValue);
  if (v.doubleValue != null) return v.doubleValue;
  if (v.timestampValue != null) return v.timestampValue;
  return undefined;
}
function fsDecodeFields(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fsDecodeValue(v);
  return out;
}

function fsBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;
}
async function fsSet(env, path, obj) {
  // PATCH with no updateMask creates or fully replaces the document.
  const res = await fetch(`${fsBase(env)}/${path}?key=${encodeURIComponent(env.FIRESTORE_KEY)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fsEncodeFields(obj)),
  });
  if (!res.ok) throw new Error(`fsSet ${path}: ${res.status}`);
}
async function fsPatch(env, path, obj) {
  const mask = Object.keys(obj).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const res = await fetch(
    `${fsBase(env)}/${path}?key=${encodeURIComponent(env.FIRESTORE_KEY)}&${mask}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fsEncodeFields(obj)),
  });
  if (!res.ok) throw new Error(`fsPatch ${path}: ${res.status}`);
}
async function fsGet(env, path) {
  const res = await fetch(`${fsBase(env)}/${path}?key=${encodeURIComponent(env.FIRESTORE_KEY)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fsGet ${path}: ${res.status}`);
  return fsDecodeFields(await res.json());
}
async function fsDelete(env, path) {
  const res = await fetch(`${fsBase(env)}/${path}?key=${encodeURIComponent(env.FIRESTORE_KEY)}`,
    { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`fsDelete ${path}: ${res.status}`);
}
async function fsListItems(env, code) {
  const res = await fetch(
    `${fsBase(env)}/shared_checklists/${code}/items?key=${encodeURIComponent(env.FIRESTORE_KEY)}&pageSize=300`);
  if (!res.ok) return [];
  const data = await res.json();
  const docs = data.documents || [];
  return docs.map((d) => {
    const f = fsDecodeFields(d);
    f.id = d.name.split("/").pop();
    return f;
  }).sort((a, b) => (a.order || 0) - (b.order || 0));
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
