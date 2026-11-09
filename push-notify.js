// Notifiche push (Web Push) quando una programmazione viene eseguita.
// Ogni dispositivo si iscrive da Impostazioni; l'iscrizione è legata all'account
// eWeLink (owner delle programmazioni). Le chiavi VAPID vengono da Render
// (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) oppure, se assenti, sono generate una
// volta e conservate in Firestore.
const crypto = require('crypto');
const webpush = require('web-push');

module.exports = function createPush({ db, identity, requireLogin, route, cloudError }) {
  const subs = () => db().collection('pushSubscriptions');
  const configRef = () => db().collection('appConfig').doc('webPush');
  let keysPromise = null;

  function keys() {
    if (!keysPromise) keysPromise = (async () => {
      let publicKey = process.env.VAPID_PUBLIC_KEY, privateKey = process.env.VAPID_PRIVATE_KEY;
      if (!publicKey || !privateKey) {
        ({ publicKey, privateKey } = await db().runTransaction(async t => {
          const snap = await t.get(configRef());
          if (snap.exists && snap.data().publicKey && snap.data().privateKey) return snap.data();
          const generated = webpush.generateVAPIDKeys();
          t.set(configRef(), { ...generated, createdAt: Date.now() });
          return generated;
        }));
      }
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:noreply@oratoriosanluigi.it', publicKey, privateKey);
      return { publicKey };
    })().catch(error => { keysPromise = null; throw error; });
    return keysPromise;
  }

  const idFor = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex');
  function validSubscription(s) {
    return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 2000
      && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string'
      && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  }

  async function deliver(doc, payload) {
    const data = doc.data();
    try {
      await webpush.sendNotification({ endpoint: data.endpoint, keys: data.keys }, JSON.stringify(payload), { TTL: 3600, urgency: 'normal' });
      return true;
    } catch (error) {
      // Iscrizione scaduta o revocata dal dispositivo: la rimuoviamo.
      if (error.statusCode === 404 || error.statusCode === 410) await doc.ref.delete().catch(() => {});
      else console.error('Notifica push non inviata:', error.statusCode || error.message);
      return false;
    }
  }

  async function notify(owner, payload) {
    if (!owner) return;
    try {
      await keys();
      const snap = await subs().where('owner', '==', owner).get();
      await Promise.all(snap.docs.map(doc => deliver(doc, payload)));
    } catch (error) {
      console.error('Notifiche push non disponibili:', error.message);
    }
  }

  function scheduleExecuted(s, status, message) {
    if (status !== 'succeeded' && status !== 'unknown') return; // "saltato": nessun comando inviato, niente avviso
    const ok = status === 'succeeded';
    const time = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(new Date());
    void notify(s.owner, {
      title: (ok ? '✅ ' : '⚠️ ') + (s.name || 'Programmazione'),
      body: (ok ? 'Eseguito alle ' : 'Problema alle ') + time + ' · ' + String(message || '').slice(0, 160),
      tag: 'schedule-' + (s.id || ''),
      url: './index.html'
    });
  }

  function install(app) {
    app.get('/api/push/key', requireLogin, route(async (_req, res) => res.json({ ok: true, publicKey: (await keys()).publicKey })));
    app.post('/api/push/subscribe', requireLogin, route(async (req, res) => {
      const subscription = req.body?.subscription;
      if (!validSubscription(subscription)) throw cloudError(400, 'invalid_subscription', 'Iscrizione alle notifiche non valida.');
      const owner = await identity(req);
      const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 60) : '';
      await subs().doc(idFor(subscription.endpoint)).set({ owner, endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, label, updatedAt: Date.now() }, { merge: true });
      res.json({ ok: true });
    }));
    app.post('/api/push/unsubscribe', requireLogin, route(async (req, res) => {
      const endpoint = req.body?.endpoint;
      if (typeof endpoint !== 'string' || !endpoint) throw cloudError(400, 'invalid_subscription', 'Iscrizione alle notifiche non valida.');
      const owner = await identity(req), ref = subs().doc(idFor(endpoint)), snap = await ref.get();
      if (snap.exists && snap.data().owner === owner) await ref.delete();
      res.json({ ok: true });
    }));
    app.post('/api/push/test', requireLogin, route(async (req, res) => {
      const endpoint = req.body?.endpoint;
      const owner = await identity(req), snap = typeof endpoint === 'string' && endpoint ? await subs().doc(idFor(endpoint)).get() : null;
      if (!snap?.exists || snap.data().owner !== owner) throw cloudError(404, 'not_subscribed', 'Questo dispositivo non è iscritto alle notifiche.');
      await keys();
      const sent = await deliver(snap, { title: '🔔 Notifiche attive', body: 'Riceverai un avviso quando una programmazione viene eseguita.', tag: 'push-test', url: './index.html' });
      if (!sent) throw cloudError(502, 'push_failed', 'Il servizio di notifiche del telefono non ha accettato il messaggio. Disattiva e riattiva le notifiche.');
      res.json({ ok: true });
    }));
  }

  return { install, notify, scheduleExecuted };
};
