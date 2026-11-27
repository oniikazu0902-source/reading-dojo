// Web Push の送信（RFC 8291 の暗号化 aes128gcm と RFC 8292 の VAPID）。外部ライブラリなし、WebCrypto だけで書く。
const te = new TextEncoder();

export const b64u = {
  enc(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  },
};

const concat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF（出力は32バイト以下なので Expand は1ブロック）
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

/* 公開鍵（65バイトの非圧縮点）と秘密鍵 d から、ECDH 用・ECDSA 用の CryptoKey を作る */
function jwkFromRaw(pub, d) {
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true };
  if (d) jwk.d = b64u.enc(d);
  return jwk;
}

/* RFC 8291：ペイロードを受信側の鍵で暗号化し、送る本文（ヘッダ＋暗号文）を返す。
   テスト用に、送信側の鍵ペアと salt を外から渡せる */
export async function encryptPayload(payload, p256dhB64, authB64, opts = {}) {
  const uaPublic = b64u.dec(p256dhB64), authSecret = b64u.dec(authB64);
  let asPublic, asPrivKey;
  if (opts.asPublic && opts.asPrivate) {
    asPublic = opts.asPublic;
    asPrivKey = await crypto.subtle.importKey('jwk', jwkFromRaw(opts.asPublic, opts.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    asPrivKey = kp.privateKey;
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivKey, 256));
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const plain = concat(typeof payload === 'string' ? te.encode(payload) : payload, new Uint8Array([2])); // 2 = 最後のレコード
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, plain));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // rs
  header[20] = 65;                                 // idlen
  header.set(asPublic, 21);                        // keyid = 送信側の公開鍵
  return concat(header, ct);
}

/* VAPID の鍵ペアを作る（初回だけ）。公開鍵は65バイトの非圧縮点、秘密鍵は d（32バイト）を base64url で返す */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = concat(new Uint8Array([4]), b64u.dec(jwk.x), b64u.dec(jwk.y));
  return { publicKey: b64u.enc(pub), privateKey: jwk.d };
}

/* RFC 8292：Authorization ヘッダ（vapid t=JWT, k=公開鍵）を作る */
export async function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.enc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...jwkFromRaw(b64u.dec(vapid.publicKey), b64u.dec(vapid.privateKey)), key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + body)));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

/* 1件送る。戻り値は HTTP ステータス（404・410 は購読が無効になったという意味） */
export async function sendPush(sub, payload, vapid, subject, { ttl = 4 * 3600, urgency = 'high', topic } = {}) {
  const body = await encryptPayload(payload, sub.p256dh, sub.auth);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidHeader(sub.endpoint, vapid, subject),
  };
  if (topic) headers.Topic = topic; // 同じ topic の未配達メッセージは新しいもので置き換わる
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return res.status;
}
