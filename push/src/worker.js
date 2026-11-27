// dojo-push：リーディング道場のプッシュ通知サーバー（Cloudflare Workers ＋ Durable Objects）
// 端末ごとに「通知する時刻」と「今日の進み具合」を預かり、その時刻にまだ終わっていなければ Web Push を送る。
// 時刻どおりに起きるため、cron ではなく Durable Object の alarm を「次に送る時刻」に合わせる。
import { DurableObject } from 'cloudflare:workers';
import { sendPush, generateVapidKeys } from './webpush.js';

const DAY = 864e5;
const MAX_SUBS = 1000;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// プッシュサービスとして受け付けるホスト（任意のURLに送らせないため）
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

/* ---------- 時刻の計算（端末のタイムゾーンで） ---------- */
function tzOffset(tz, ms) { // その時点の UTC からのずれ（ミリ秒）
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// アプリと同じ「朝4時で日付が変わる」日番号
export function dayKey(tz, ms) { return Math.floor((ms + tzOffset(tz, ms) - 4 * 36e5) / DAY); }
// from より後で、その地域の時計が hh:mm になる最初の時刻（UTC ミリ秒）
export function nextAt(tz, time, from) {
  const [hh, mm] = time.split(':').map(Number);
  const localNow = from + tzOffset(tz, from);
  let local = Math.floor(localNow / DAY) * DAY + (hh * 60 + mm) * 6e4;
  for (let i = 0; i < 3; i++) {
    const utc = local - tzOffset(tz, local - tzOffset(tz, local));
    if (utc > from) return utc;
    local += DAY;
  }
  return from + DAY;
}
const validTz = tz => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false; // undefined だと「端末の時間帯」として通ってしまう
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

/* ---------- 入口 ---------- */
export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (!['/vapid', '/sync', '/unsub', '/test', '/snooze'].includes(url.pathname)) {
      return new Response('dojo-push', { status: url.pathname === '/' ? 200 : 404, headers: cors });
    }
    if (req.method === 'POST' && origin && !allowed.includes(origin)) return json({ error: 'origin' }, 403, cors);
    const stub = env.SCHED.get(env.SCHED.idFromName('main'));
    const res = await stub.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/* ---------- 予定を持つ Durable Object（1つだけ） ---------- */
export class Scheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs (
      id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      tz TEXT NOT NULL, time TEXT NOT NULL, day INTEGER, done INTEGER DEFAULT 0, quota INTEGER DEFAULT 5,
      free INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, trig TEXT DEFAULT '', next_at INTEGER NOT NULL,
      snooze_at INTEGER, fails INTEGER DEFAULT 0, updated INTEGER)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  }

  // VAPID の鍵は初回に作って保存する（ダッシュボードで秘密鍵を設定しなくて済む）
  async vapid() {
    const row = [...this.sql.exec("SELECT v FROM kv WHERE k = 'vapid'")][0];
    if (row) return JSON.parse(row.v);
    const keys = await generateVapidKeys();
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('vapid', ?)", JSON.stringify(keys));
    return keys;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/vapid') return json({ key: (await this.vapid()).publicKey });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    let b;
    try {
      const text = await req.text();
      if (text.length > 8000) return json({ error: 'too large' }, 413);
      b = JSON.parse(text);
    } catch { return json({ error: 'bad json' }, 400); }
    if (!ID_RE.test(b.id || '')) return json({ error: 'id' }, 400);
    const row = [...this.sql.exec('SELECT * FROM subs WHERE id = ?', b.id)][0];

    if (path === '/unsub') {
      this.sql.exec('DELETE FROM subs WHERE id = ?', b.id);
      await this.schedule();
      return json({ ok: true });
    }
    if (path === '/test') {
      if (!row) return json({ error: 'not found' }, 404);
      const status = await this.send(row, Date.now(), true);
      return json({ ok: status >= 200 && status < 300, status });
    }
    if (path === '/snooze') {
      if (!row) return json({ error: 'not found' }, 404);
      const min = Math.max(5, Math.min(180, +b.min || 30));
      this.sql.exec('UPDATE subs SET snooze_at = ? WHERE id = ?', Date.now() + min * 6e4, b.id);
      await this.schedule();
      return json({ ok: true, min });
    }

    // /sync：購読の登録・更新と、進み具合の報告をまとめて受ける
    const tz = validTz(b.tz) ? b.tz : row?.tz || 'Asia/Tokyo';
    const time = TIME_RE.test(b.time || '') ? b.time : row?.time || '20:00';
    const prog = {
      day: Number.isInteger(b.day) ? b.day : row?.day ?? null,
      done: Number.isInteger(b.done) ? Math.max(0, b.done) : row?.done ?? 0,
      quota: Number.isInteger(b.quota) ? Math.max(1, Math.min(20, b.quota)) : row?.quota ?? 5,
      free: b.free ? 1 : 0,
      streak: Number.isInteger(b.streak) ? Math.max(0, b.streak) : row?.streak ?? 0,
      trig: typeof b.trigger === 'string' ? b.trigger.slice(0, 40) : row?.trig ?? '',
    };
    const now = Date.now();
    if (b.sub) {
      const s = b.sub, keys = s.keys || {};
      let host = '';
      try { const u = new URL(s.endpoint); if (u.protocol === 'https:') host = u.hostname; } catch {}
      if (!PUSH_HOSTS.some(re => re.test(host)) || !keys.p256dh || !keys.auth) return json({ error: 'subscription' }, 400);
      if (!row && [...this.sql.exec('SELECT COUNT(*) AS n FROM subs')][0].n >= MAX_SUBS) return json({ error: 'full' }, 503);
      this.sql.exec(`INSERT INTO subs (id, endpoint, p256dh, auth, tz, time, day, done, quota, free, streak, trig, next_at, fails, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
          tz = excluded.tz, time = excluded.time, day = excluded.day, done = excluded.done, quota = excluded.quota,
          free = excluded.free, streak = excluded.streak, trig = excluded.trig, next_at = excluded.next_at, fails = 0, updated = excluded.updated`,
        b.id, s.endpoint, keys.p256dh, keys.auth, tz, time, prog.day, prog.done, prog.quota, prog.free, prog.streak, prog.trig, nextAt(tz, time, now), now);
    } else {
      if (!row) return json({ error: 'not found' }, 404);
      const na = row.time === time && row.tz === tz ? row.next_at : nextAt(tz, time, now);
      // 今日の分が終わったら、待っている「あとで」も取り消す
      const finished = prog.day === dayKey(tz, now) && prog.done >= prog.quota;
      this.sql.exec(`UPDATE subs SET tz = ?, time = ?, day = ?, done = ?, quota = ?, free = ?, streak = ?, trig = ?, next_at = ?,
        snooze_at = CASE WHEN ? THEN NULL ELSE snooze_at END, updated = ? WHERE id = ?`,
        tz, time, prog.day, prog.done, prog.quota, prog.free, prog.streak, prog.trig, na, finished ? 1 : 0, now, b.id);
    }
    await this.schedule();
    const r = [...this.sql.exec('SELECT next_at FROM subs WHERE id = ?', b.id)][0];
    return json({ ok: true, next: r?.next_at });
  }

  // 残りの本数（今日の報告がなければ、まだ0本とみなす）
  left(row, now) {
    const today = dayKey(row.tz, now);
    return row.day === today ? Math.max(0, row.quota - row.done) : row.quota;
  }

  message(row, now, test) {
    const left = this.left(row, now);
    let body;
    if (test) body = 'テスト通知です。この時刻に、今日の分がまだなら届きます。';
    else if (row.streak >= 3) body = `連続${row.streak}日。途切れる前に1本（残り${left}本）。`;
    else body = `今日の1本がまだです（残り${left}本）。`;
    if (!test && row.trig) body += `${row.trig}、1本。`;
    // Declarative Web Push の形（iOS 18.4 以降はサービスワーカーなしで表示できる）。
    // ほかのブラウザでは、サービスワーカーがこの JSON を読んで表示する
    return JSON.stringify({
      web_push: 8030,
      notification: {
        title: 'リーディング道場',
        body,
        navigate: (this.env.APP_URL || 'https://oniikazu0902-source.github.io/reading-dojo/') + '?from=push',
        lang: 'ja-JP',
        dir: 'ltr',
        tag: 'dojo-remind',
        silent: false,
      },
      app_badge: test ? undefined : left,
    });
  }

  async send(row, now, test = false) {
    let status = 0;
    try {
      status = await sendPush({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, this.message(row, now, test),
        await this.vapid(), this.env.VAPID_SUBJECT || 'https://github.com/oniikazu0902-source/reading-dojo', { topic: 'dojo-remind' });
    } catch { status = 0; }
    if (status === 404 || status === 410) this.sql.exec('DELETE FROM subs WHERE id = ?', row.id); // 購読が無効になった
    else if (status < 200 || status >= 300) {
      this.sql.exec('UPDATE subs SET fails = fails + 1 WHERE id = ?', row.id);
      this.sql.exec('DELETE FROM subs WHERE id = ? AND fails >= 10', row.id);
    } else this.sql.exec('UPDATE subs SET fails = 0 WHERE id = ?', row.id);
    return status;
  }

  async alarm() {
    const now = Date.now(), soon = now + 30e3;
    const rows = [...this.sql.exec('SELECT * FROM subs WHERE next_at <= ? OR (snooze_at IS NOT NULL AND snooze_at <= ?)', soon, soon)];
    for (const row of rows) {
      const due = row.next_at <= soon, snoozed = row.snooze_at != null && row.snooze_at <= soon;
      if ((due || snoozed) && this.left(row, now) > 0) await this.send(row, now);
      // 次の予定へ（送らなかった日も、次は翌日の同じ時刻）
      if (due) this.sql.exec('UPDATE subs SET next_at = ? WHERE id = ?', nextAt(row.tz, row.time, now + 60e3), row.id);
      if (snoozed) this.sql.exec('UPDATE subs SET snooze_at = NULL WHERE id = ?', row.id);
    }
    await this.schedule();
  }

  // いちばん早い予定に alarm を合わせる
  async schedule() {
    const r = [...this.sql.exec('SELECT MIN(next_at) AS a, MIN(snooze_at) AS b FROM subs')][0];
    const t = Math.min(r?.a ?? Infinity, r?.b ?? Infinity);
    if (Number.isFinite(t)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, t));
    else await this.ctx.storage.deleteAlarm();
  }
}
