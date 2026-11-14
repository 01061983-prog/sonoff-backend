// Notifiche push (Web Push) quando una programmazione viene eseguita.
// Ogni dispositivo si iscrive da Impostazioni; l'iscrizione è legata all'account
// eWeLink (owner delle programmazioni). Le chiavi VAPID vengono da Render
// (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) oppure, se assenti, sono generate una
// volta e conservate in Firestore.
const crypto = require('crypto');
const webpush = require('web-push');

module.exports = function createPush({ db, identity, requireLogin, route, cloudError, accountLabel=()=>'' }) {
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

  const idFor = (endpoint,owner) => crypto.createHash('sha256').update(owner===undefined?endpoint:owner+':'+endpoint).digest('hex');
  const own = (snap,owner,endpoint) => snap?.exists && snap.data().owner===owner && snap.data().endpoint===endpoint;
  async function subscriptionFor(owner,endpoint){
    const [current,legacy]=await Promise.all([subs().doc(idFor(endpoint,owner)).get(),subs().doc(idFor(endpoint)).get()]);
    return own(current,owner,endpoint)?current:own(legacy,owner,endpoint)?legacy:null;
  }
  function endpointOf(req){const endpoint=req.body?.endpoint;if(typeof endpoint!=='string'||!/^https:\/\//.test(endpoint)||endpoint.length>=2000)throw cloudError(400,'invalid_subscription','Iscrizione alle notifiche non valida.');return endpoint;}
  function validSubscription(s) {
    return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 2000
      && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string'
      && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  }

  async function deliver(doc, payload) {
    const data = doc.data();
    try {
      const account=String(data.accountLabel||'').slice(0,80);
      const message=account?{...payload,title:account+' · '+payload.title}:payload;
      await webpush.sendNotification({ endpoint: data.endpoint, keys: data.keys }, JSON.stringify(message), { TTL: 3600, urgency: 'normal' });
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
      const unique=new Map();for(const doc of snap.docs){const d=doc.data(),previous=unique.get(d.endpoint);if(!previous||Number(d.updatedAt||0)>Number(previous.data().updatedAt||0))unique.set(d.endpoint,doc);}
      await Promise.all([...unique.values()].map(doc => deliver(doc, payload)));
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
      tag: 'schedule-' + idFor(String(s.owner)).slice(0,12) + '-' + (s.id || ''),
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
      await db().runTransaction(async t=>{
        const current=subs().doc(idFor(subscription.endpoint,owner)),legacy=subs().doc(idFor(subscription.endpoint));
        const old=await t.get(legacy);
        t.set(current,{owner,endpoint:subscription.endpoint,keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth},label,accountLabel:String(accountLabel(req)||'').slice(0,80),updatedAt:Date.now()});
        if(own(old,owner,subscription.endpoint))t.delete(legacy);
      });
      res.json({ ok: true });
    }));
    app.post('/api/push/status', requireLogin, route(async(req,res)=>{
      const endpoint=endpointOf(req),owner=await identity(req);
      res.json({ok:true,subscribed:Boolean(await subscriptionFor(owner,endpoint))});
    }));
    app.post('/api/push/unsubscribe', requireLogin, route(async (req, res) => {
      const endpoint=endpointOf(req),owner=await identity(req);
      await db().runTransaction(async t=>{
        const refs=[subs().doc(idFor(endpoint,owner)),subs().doc(idFor(endpoint))];
        const snapshots=await Promise.all(refs.map(ref=>t.get(ref)));
        snapshots.forEach((snap,i)=>{if(own(snap,owner,endpoint))t.delete(refs[i]);});
      });
      res.json({ok:true});
    }));
    app.post('/api/push/test', requireLogin, route(async (req, res) => {
      const endpoint=endpointOf(req),owner=await identity(req),snap=await subscriptionFor(owner,endpoint);
      if(!snap)throw cloudError(404,'not_subscribed','Attiva le notifiche per questo account eWeLink su questo dispositivo.');
      await keys();
      const sent = await deliver(snap, { title: '🔔 Notifiche attive', body: 'Riceverai un avviso quando una programmazione viene eseguita.', tag: 'push-test-'+idFor(owner).slice(0,12), url: './index.html' });
      if (!sent) throw cloudError(502, 'push_failed', 'Il servizio di notifiche del telefono non ha accettato il messaggio. Disattiva e riattiva le notifiche.');
      res.json({ ok: true });
    }));
  }

  return { install, notify, scheduleExecuted };
};
