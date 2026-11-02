// 일정 알림 보내기: GitHub Actions가 5분마다 실행한다.
// 서버 주소·가족 코드·비밀 키는 모두 저장소 Secrets에서 읽는다. (이 파일에는 비밀이 없다)
import webpush from 'web-push';

const { FB_URL, FAM_CODE, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT } = process.env;
if (!FB_URL || !FAM_CODE || !VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('Secrets(FB_URL, FAM_CODE, VAPID_PUBLIC, VAPID_PRIVATE)가 모두 필요해요');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:family@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

const base = `${FB_URL.replace(/\/+$/, '')}/rooms/${encodeURIComponent(FAM_CODE)}`;
const get = async p => {
  const r = await fetch(`${base}/${p}.json`);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};
const put = (p, v) => fetch(`${base}/${p}.json`, { method: 'PUT', body: JSON.stringify(v) });
const del = p => fetch(`${base}/${p}.json`, { method: 'DELETE' });

const DAY = 864e5, KST = 9 * 3600e3;      // 일정 시각은 한국 시간
const LATE_LIMIT = 60 * 60e3;             // 예정 시각이 1시간 넘게 지난 알림은 보내지 않는다
const now = Date.now();
const pad = n => String(n).padStart(2, '0');
const dn = s => { const [y, m, d] = s.split('-'); return Date.UTC(+y, m - 1, +d) / DAY; };
const ds = n => { const t = new Date(n * DAY); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const dd = s => +s.split('-')[2], mm = s => +s.split('-')[1];

// 그 날짜에 일정(또는 반복 일정의 한 회차)이 '시작'하는가
function startsOn(ev, D) {
  if (!ev.date) return false;
  const S = dn(ev.date);
  if (D < S) return false;
  if (ev.until && ds(D) > ev.until) return false;
  const day = ds(D);
  switch (ev.repeat || '') {
    case '': return D === S;
    case 'daily': return true;
    case 'weekly': return (D - S) % 7 === 0;
    case 'monthly': return dd(day) === dd(ev.date);
    case 'yearly': return dd(day) === dd(ev.date) && mm(day) === mm(ev.date);
    default: return false;
  }
}

const REMIND_TEXT = { 0: '지금 시작해요', 10: '10분 뒤 시작해요', 30: '30분 뒤 시작해요', 60: '1시간 뒤 시작해요', 1440: '내일이에요' };

const [eventsRaw, pushRaw, sentRaw, peopleRaw] = await Promise.all([get('events'), get('push'), get('pushSent'), get('people')]);
const events = Object.values(eventsRaw || {});
const subs = Object.entries(pushRaw || {});
const sent = sentRaw || {};
const nameOf = id => ((Array.isArray(peopleRaw) ? peopleRaw : Object.values(peopleRaw || {})).find(p => p.id === id) || {}).name || '';

const today = Math.floor((now + KST) / DAY);
let due = 0, delivered = 0, failed = 0;

for (let D = today - 1; D <= today + 2; D++) {
  for (const ev of events) {
    if (ev.remind === undefined || ev.remind === null || ev.remind === '') continue;
    if (!startsOn(ev, D)) continue;
    const remind = Number(ev.remind);
    const [h, m] = (ev.time || '09:00').split(':').map(Number);   // 시간을 안 정한 일정은 오전 9시 기준
    const fire = D * DAY + (h * 60 + m) * 60e3 - KST - remind * 60e3;
    if (now < fire || now >= fire + LATE_LIMIT) continue;
    const key = `${ev.id}_${ds(D)}_${remind}`;
    if (sent[key]) continue;

    due++;
    const targets = new Set(ev.notifyTo && ev.notifyTo.length ? ev.notifyTo : [ev.owner]);
    const payload = JSON.stringify({
      title: `🔔 ${ev.text}`,
      body: `${REMIND_TEXT[remind] || `${remind}분 전이에요`} · ${mm(ds(D))}/${dd(ds(D))} ${ev.time || '종일'}`,
      tag: key,
      url: './'
    });
    for (const [id, rec] of subs) {
      if (!targets.has(rec.person)) continue;
      try {
        await webpush.sendNotification(rec.sub, payload, { TTL: 3600 });
        delivered++;
      } catch (e) {
        failed++;
        if (e.statusCode === 404 || e.statusCode === 410) await del(`push/${id}`); // 해지된 기기 정리
      }
    }
    await put(`pushSent/${key}`, now);
    sent[key] = now;
  }
}

// 3일 지난 발송 기록 정리
for (const [k, t] of Object.entries(sent)) if (now - t > 3 * DAY) await del(`pushSent/${k}`);

// 일정 내용은 공개 로그에 남기지 않고 개수만 출력한다
console.log(`확인한 일정 ${events.length}개, 보낼 알림 ${due}건, 전송 ${delivered}건, 실패 ${failed}건, 등록된 기기 ${subs.length}대`);
