// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/** Who gets which email. Every send has a key, so retries and re-syncs never email twice. */
const db = require('./db');
const { config } = require('./config');
const mailer = require('./mailer');

const base = () => config.publicBaseUrl;
const ref = (o) => o.id.slice(-8).toUpperCase();
const emailOf = (userId) => db.users.get(userId)?.email;
const sellerEmail = (sellerId) => emailOf(db.sellers.get(sellerId)?.user_id);
const fire = (p) => { Promise.resolve(p).catch(() => {}); };
const push = require('./push');
const sellerUser = (sellerId) => db.sellers.get(sellerId)?.user_id;
const money = (n, cur) => { try { return Number(n).toLocaleString('en-US', { style: 'currency', currency: String(cur || config.currency).toUpperCase() }); } catch { return `${n} ${cur}`; } };

function orderPaid(o) {
  const paid = require('./payments/stripe').chargeOf(o); const total = money(paid.amount, paid.currency);
  // The invoice (PDF with the Kinan logo) goes with the confirmation
  let attachments; try { const f = require('./services/ops').invoicePdf(o); attachments = [{ name: f.name, content: f.body.toString('base64') }]; } catch (e) { console.error('[invoice] pdf', e.message); }
  const items = `${o.lines.map((l) => l.title).slice(0, 4).join('، ')}${o.lines.length > 4 ? '…' : ''}`;
  fire(mailer.send({ to: emailOf(o.buyer_id), key: `paid:${o.id}`, kind: 'order', subject: `Order ${ref(o)} confirmed`, title: 'Thank you — your order is confirmed',
    ar: { subject: `تم تأكيد طلبك ${ref(o)} ✅`, title: 'شكراً لك، تم تأكيد طلبك', lines: [`استلمنا دفعتك بقيمة ${total}.`, `${o.lines.reduce((a, l) => a + l.qty, 0)} قطعة: ${items}.`, ...(attachments ? ['فاتورتك مرفقة بهذه الرسالة بصيغة PDF.'] : []), 'سنراسلك مجدداً عند شحن الطلب مع رقم التتبع.'], button: { text: 'عرض طلبك', url: `${base()}/#/orders/${o.id}` } },
    lines: [`We received your payment of ${total}.`, `${o.lines.reduce((a, l) => a + l.qty, 0)} item(s): ${o.lines.map((l) => l.title).slice(0, 4).join(', ')}${o.lines.length > 4 ? '…' : ''}.`, ...(attachments ? ['Your invoice is attached to this email as a PDF.'] : []), 'We will email you again when it ships, with a tracking number.'],
    button: { text: 'View your order', url: `${base()}/#/orders/${o.id}` }, attachments }));
  push.toUser(o.buyer_id, { title: 'Order confirmed', body: `Order ${ref(o)} — ${total}`, url: `/#/orders/${o.id}`, tag: `o-${o.id}`, ar: { title: 'تم تأكيد طلبك ✅', body: `الطلب ${ref(o)} — ${total}` } });
  push.telegram(`🛒 New paid order ${ref(o)} — ${money(o.total, o.currency)}${o.charge ? ` (paid ${total})` : ''}${o.payment?.provider === 'demo' || o.payment?.mode === 'test' ? ' (TEST)' : ''}\n${o.lines.map((l) => `${l.qty} × ${l.title}`).slice(0, 5).join('\n')}\nTo: ${o.shipping_address?.city || ''}, ${o.shipping_address?.country || ''}\n${base()}/admin`);
  for (const sellerId of new Set(o.lines.map((l) => l.seller_id))) {
    const lines = o.lines.filter((l) => l.seller_id === sellerId); const n = lines.reduce((a, l) => a + l.qty, 0);
    push.toUser(sellerUser(sellerId), { title: 'New order', body: `Order ${ref(o)}: ${n} item(s)`, url: '/seller#/orders', tag: `s-${o.id}`, ar: { title: 'طلب جديد 🛍️', body: `الطلب ${ref(o)}: ${n} قطعة` } });
    fire(mailer.send({ to: sellerEmail(sellerId), key: `sale:${o.id}:${sellerId}`, kind: 'sale', subject: `New order ${ref(o)} — ${lines.reduce((a, l) => a + l.qty, 0)} item(s)`, title: 'You have a new order',
      lines: [...lines.map((l) => `${l.qty} × ${l.title}`), `Sale value: ${money(lines.reduce((a, l) => a + l.price * l.qty, 0), o.currency)}.`],
      ar: { subject: `طلب جديد ${ref(o)} — ${n} قطعة`, title: 'لديك طلب جديد 🎉', lines: [...lines.map((l) => `${l.qty} × ${l.title}`), `قيمة البيع: ${money(lines.reduce((a, l) => a + l.price * l.qty, 0), o.currency)}.`], button: { text: 'افتح مركز البائعين', url: `${base()}/seller#/orders` } },
      button: { text: 'Open Seller Center', url: `${base()}/seller#/orders` } }));
  }
}

function orderShipped(o, tracking = []) {
  const t = tracking.filter((x) => x && x.number);
  push.toUser(o.buyer_id, { title: 'Your order is on its way', body: `Order ${ref(o)}${t[0] ? ` · ${t[0].carrier || ''} ${t[0].number}` : ''}`, url: `/#/orders/${o.id}`, tag: `o-${o.id}`, ar: { title: 'طلبك في الطريق إليك 🚚', body: `الطلب ${ref(o)}${t[0] ? ` · ${t[0].carrier || ''} ${t[0].number}` : ''}` } });
  fire(mailer.send({ to: emailOf(o.buyer_id), key: `shipped:${o.id}:${t.map((x) => x.number).join(',')}`, kind: 'order', subject: `Order ${ref(o)} is on its way`, title: 'Your order has shipped',
    lines: [...t.map((x) => `Tracking: ${x.carrier ? `${x.carrier} ` : ''}${x.number} — ${require('./services/couriers').trackingUrl(x.carrier, x.number)}`), 'You can follow every step in your Kinan orders.'],
    ar: { subject: `طلبك ${ref(o)} في الطريق 🚚`, title: 'تم شحن طلبك', lines: [...t.map((x) => `رقم التتبع: ${x.carrier ? `${x.carrier} ` : ''}${x.number} — ${require('./services/couriers').trackingUrl(x.carrier, x.number)}`), 'يمكنك متابعة كل خطوة من صفحة طلباتك في كنان.'], button: { text: 'تتبّع طلبك', url: `${base()}/#/orders/${o.id}` } },
    button: { text: 'Track your order', url: `${base()}/#/orders/${o.id}` } }));
}

function orderDelivered(o) {
  push.toUser(o.buyer_id, { title: 'Delivered', body: `Order ${ref(o)} was delivered. Tell us what you think!`, url: `/#/orders/${o.id}`, tag: `o-${o.id}`, ar: { title: 'تم التسليم 📦', body: `وصل طلبك ${ref(o)}. أخبرنا برأيك!` } });
  fire(mailer.send({ to: emailOf(o.buyer_id), key: `delivered:${o.id}`, kind: 'order', subject: `Order ${ref(o)} delivered`, title: 'Your order was delivered',
    lines: ['We hope you love it. If something is wrong, you can request a return from your order page.'], button: { text: 'View order', url: `${base()}/#/orders/${o.id}` },
    ar: { subject: `تم تسليم طلبك ${ref(o)} 📦`, title: 'وصل طلبك', lines: ['نتمنى أن ينال إعجابك. إذا كانت هناك مشكلة يمكنك طلب إرجاع من صفحة الطلب.'], button: { text: 'عرض الطلب', url: `${base()}/#/orders/${o.id}` } } }));
}

// Tracking stages CJ reports (logistics webhook). 1 (shipped) and 12 (delivered) have their own notices.
const STAGES = {
  2: ['Your parcel reached the shipping partner', 'وصل طردك إلى شركة الشحن'],
  3: ['Your parcel is being sent back to the warehouse', 'يُعاد طردك إلى المستودع'],
  4: ['Your parcel left with the shipping partner', 'غادر طردك مع شركة الشحن'],
  5: ['Your parcel is flying to your country', 'طردك في الطريق الدولي إلى بلدك ✈️'],
  6: ['Your parcel arrived in your country', 'وصل طردك إلى بلدك 🛬'],
  7: ['Your parcel is at customs', 'طردك في الجمارك'],
  8: ['Your parcel cleared customs', 'اجتاز طردك الجمارك ✅'],
  9: ['Your local post office has your parcel', 'استلم البريد المحلي طردك'],
  10: ['Out for delivery today', 'طردك خارج للتوصيل اليوم 🚚'],
  11: ['Ready for you to pick up', 'طردك جاهز للاستلام 📍'],
  13: ['A delivery problem was reported', 'تم الإبلاغ عن مشكلة في التوصيل ⚠️'],
  14: ['Your parcel is being returned', 'طردك في طريق العودة']
};
const STAGE_EMAIL = new Set([6, 10, 11, 13, 14]); // the big moments also by email; the rest as a phone notification
/** A new tracking stage for a parcel: phone notification (and email for the big moments), never twice for one stage. */
function trackingStage(o, sub, code) {
  const st = STAGES[code]; if (!o || !st) return;
  const key = `trk:${o.id}:${sub.outer_purchase_id || ''}:${code}`;
  if ((o.notices || []).includes(key)) return;
  db.orders.update(o.id, (x) => ({ ...x, notices: [...(x.notices || []), key].slice(-60) }));
  const last = (sub.track?.events || [])[0];
  const where = last && last.place ? ` — ${last.place}` : '';
  push.toUser(o.buyer_id, { title: st[0], body: `Order ${ref(o)}${where}`, url: `/#/orders/${o.id}`, tag: `trk-${o.id}`, ar: { title: st[1], body: `الطلب ${ref(o)}${where}` } });
  if (!STAGE_EMAIL.has(code)) return;
  const tn = (sub.logistics || [])[0];
  fire(mailer.send({ to: emailOf(o.buyer_id), key, kind: 'order', subject: `${st[0]} — order ${ref(o)}`, title: st[0],
    lines: [...(last ? [`${last.text}${where}${last.at ? ` (${last.at})` : ''}`] : []), ...(code === 13 ? ['We are on it. If the carrier needs something from you, it will be on the tracking page.'] : []), ...(tn ? [`Tracking: ${tn.tracking}`] : [])],
    ar: { subject: `${st[1]} — الطلب ${ref(o)}`, title: st[1], lines: [...(last ? [`${last.text}${where}${last.at ? ` (${last.at})` : ''}`] : []), ...(code === 13 ? ['نتابع الأمر. إذا احتاجت شركة الشحن شيئاً منك سيظهر في صفحة التتبع.'] : []), ...(tn ? [`رقم التتبع: ${tn.tracking}`] : [])] },
    button: { text: 'Track your order', url: `${base()}/#/orders/${o.id}` } }));
}

function qcPhotos(o) {
  push.toUser(o.buyer_id, { title: 'Photos of your items are ready', body: `Order ${ref(o)} — check them before we ship`, url: `/#/orders/${o.id}`, tag: `qc-${o.id}`, ar: { title: 'صور منتجاتك جاهزة 📸', body: `الطلب ${ref(o)} — راجعها قبل أن نشحن` } });
  fire(mailer.send({ to: emailOf(o.buyer_id), key: `qc:${o.id}:${(o.qc_photos || []).length}`, kind: 'order', subject: `Photos of your order ${ref(o)} are ready`, title: 'Your items arrived at our warehouse',
    lines: ['We checked your items and took photos. Have a look and tell us if everything is right before we ship.'],
    ar: { subject: `صور طلبك ${ref(o)} جاهزة 📸`, title: 'وصلت منتجاتك إلى مستودعنا', lines: ['فحصنا منتجاتك والتقطنا لها صوراً. ألقِ نظرة وأخبرنا إن كان كل شيء صحيحاً قبل الشحن.'], button: { text: 'شاهد الصور', url: `${base()}/#/orders/${o.id}` } },
    button: { text: 'See the photos', url: `${base()}/#/orders/${o.id}` } }));
}

const firstName = (u) => String(u?.name || '').trim().split(/\s+/)[0] || '';

/** Seller sent their verification: "your account is under review". */
function sellerUnderReview(s) {
  const u = db.users.get(s.user_id); const n = firstName(u) || s.kyc?.details?.full_name?.split(' ')[0] || '';
  fire(mailer.send({ to: u?.email, key: `seller-review:${s.id}:${s.kyc?.submitted_at}`, kind: 'seller', app: 'seller',
    subject: 'Your Kinan seller account is under review',
    ar: { subject: 'حسابك في كنان قيد المراجعة ⏳', title: `أهلاً ${n}، استلمنا طلبك 👋`, lines: [`شكراً لاختيارك كنان لفتح متجرك «${s.shop_name}».`, 'وصلتنا بياناتك ووثيقة هويتك، وحسابك الآن قيد المراجعة. يراجع فريق كنان الطلبات عادةً خلال يوم إلى يومي عمل.', 'سنرسل لك رسالة وإشعاراً فور فتح حسابك، وبعدها تستطيع إضافة منتجاتك مباشرة.'], button: { text: 'افتح مركز البائعين', url: `${base()}/seller` } },
    title: `Hi ${n}, we received your application`,
    lines: [`Thank you for choosing Kinan for your shop “${s.shop_name}”.`, 'Your details and identity document arrived and your account is now under review. Kinan usually reviews applications within 1–2 working days.', 'We will email you and send a notification as soon as your account is open — then you can add your products right away.'],
    button: { text: 'Open Seller Center', url: `${base()}/seller` } }));
}

/** Seller approved: warm welcome by email + app notification. */
function sellerApproved(s) {
  const u = db.users.get(s.user_id); const n = firstName(u);
  push.toUser(s.user_id, { title: 'Your shop is open 🎉', body: `Welcome to Kinan! “${s.shop_name}” is ready — add your first product now.`, url: '/seller#/add', ar: { title: 'تم فتح حسابك بنجاح 🎉', body: `مرحباً بك في كنان! متجرك «${s.shop_name}» جاهز، أضف أول منتج الآن.` } });
  fire(mailer.send({ to: u?.email, key: `seller-approved:${s.id}`, kind: 'seller', app: 'seller',
    subject: '🎉 Your Kinan shop is open',
    ar: { subject: '🎉 تم فتح حسابك بنجاح', title: `مبروك ${n}! تم فتح حسابك بنجاح 🎉`, lines: [`يسعدنا أن نرحّب بك رسمياً في عائلة كنان. متجرك «${s.shop_name}» أصبح مفعّلاً.`, 'ابدأ الآن بإضافة منتجاتك من تاوباو أو علي إكسبرس أو CJ أو يدوياً. يراجع فريقنا كل منتج قبل ظهوره للعملاء.', 'نتمنى لك مبيعات كثيرة ونجاحاً كبيراً. نحن معك في كل خطوة، ويمكنك الرد على هذه الرسالة في أي وقت.'], button: { text: 'أضف أول منتج', url: `${base()}/seller#/add` } },
    title: `Congratulations ${n}! Your shop is open 🎉`,
    lines: [`We are delighted to welcome you to the Kinan family. Your shop “${s.shop_name}” is now active.`, 'Start adding products from Taobao, AliExpress, CJ or by hand. Our team reviews each product before customers see it.', 'We wish you many sales and great success. We are with you every step — just reply to this email any time.'],
    button: { text: 'Add your first product', url: `${base()}/seller#/add` } }));
}

/** New customer account in Kinan Shop: a warm welcome (with the welcome discount when there is one). */
function customerWelcome(u) {
  if (!u?.email) return;
  const n = firstName(u);
  const c = db.coupons.find((x) => x.code === 'WELCOME10' && x.active !== false && (!x.expires_at || x.expires_at > Date.now()));
  const highlight = c ? { label: 'كود الترحيب · Welcome code', value: c.code } : undefined;
  fire(mailer.send({ to: u.email, key: `welcome:${u.id}`, kind: 'account', app: 'shop', highlight,
    subject: 'Welcome to Kinan 🎁',
    ar: { subject: 'أهلاً بك في كنان 🎁', title: `أهلاً وسهلاً ${n}، يسعدنا انضمامك إلى كنان ✨`, lines: ['تم إنشاء حسابك بنجاح. صار بإمكانك الآن تسوّق آلاف المنتجات بأسعار ممتازة، مع شحن إلى باب بيتك وتتبّع لكل طلب.', ...(c ? [`هدية ترحيب منا: خصم ${c.value}% على طلبك الأول بكود ${c.code}.`] : []), 'نتمنى لك تجربة تسوّق رائعة، ولأي سؤال رد على هذه الرسالة وسنساعدك بكل سرور.'], button: { text: 'ابدأ التسوّق', url: `${base()}/` } },
    title: `Welcome to Kinan, ${n} ✨`,
    lines: ['Your account is ready. Shop thousands of products at great prices, delivered to your door with tracking for every order.', ...(c ? [`A welcome gift from us: ${c.value}% off your first order with the code ${c.code}.`] : []), 'Happy shopping! For any question, just reply to this email and we will gladly help.'],
    button: { text: 'Start shopping', url: `${base()}/` } }));
}

function sellerKycRejected(s, reason) {
  push.toUser(s.user_id, { title: 'Please correct your verification', body: reason, url: '/seller', ar: { title: 'يرجى تصحيح طلب التوثيق' } });
  fire(mailer.send({ to: emailOf(s.user_id), key: `seller-kyc-rejected:${s.id}:${s.kyc?.decided_at}`, kind: 'seller', subject: 'Your Kinan seller verification needs a correction', title: 'Please correct your verification',
    lines: ['Kinan could not approve your seller application yet.', `What to correct: ${reason}`, 'Open the Seller Center, fix it and send it again.'], button: { text: 'Open Seller Center', url: `${base()}/seller` },
    ar: { subject: 'طلب التوثيق في كنان يحتاج تصحيحاً', title: 'يرجى تصحيح طلبك', lines: ['لم نتمكن من الموافقة على طلبك بعد.', `المطلوب تصحيحه: ${reason}`, 'افتح مركز البائعين، صحّح البيانات وأرسلها من جديد.'], button: { text: 'افتح مركز البائعين', url: `${base()}/seller` } } }));
}

function listingDecision(l, approved, reason) {
  push.toUser(sellerUser(l.seller_id), { title: approved ? 'Product approved' : 'Product needs changes', body: l.title, url: '/seller#/products', ar: { title: approved ? 'تمت الموافقة على منتجك ✅' : 'منتجك يحتاج تعديلات' } });
  fire(mailer.send({ to: sellerEmail(l.seller_id), key: `listing:${l.id}:${l.review?.submitted_at || l.updated_at}:${approved ? 'ok' : 'no'}`, kind: 'seller',
    subject: approved ? `Approved: ${l.title}` : `Changes needed: ${l.title}`, title: approved ? 'Your product is live' : 'Your product needs changes',
    lines: approved ? [`“${l.title}” is now visible to customers in Kinan Shop.`] : [`“${l.title}” was not approved.`, `Kinan’s note: ${reason}`],
    ar: { subject: approved ? `تمت الموافقة: ${l.title}` : `مطلوب تعديل: ${l.title}`, title: approved ? 'منتجك أصبح ظاهراً للعملاء ✅' : 'منتجك يحتاج تعديلات', lines: approved ? [`«${l.title}» يظهر الآن للعملاء في متجر كنان.`] : [`لم تتم الموافقة على «${l.title}».`, `ملاحظة كنان: ${reason}`], button: { text: approved ? 'عرض منتجاتك' : 'تعديل المنتج', url: `${base()}/seller#/products` } },
    button: { text: approved ? 'See your products' : 'Edit product', url: `${base()}/seller#/products` } }));
}

function requestAnswered(r) {
  push.toUser(r.buyer_id, { title: 'Kinan answered your request', body: r.quote ? `Price: ${money(r.quote, config.currency)} per item` : (r.reply || 'See the answer'), url: '/#/request', tag: `r-${r.id}` });
  fire(mailer.send({ to: emailOf(r.buyer_id), key: `request:${r.id}:${r.status}:${r.quote}:${r.reply}`, kind: 'request', subject: 'Kinan replied to your item request', title: 'We have an answer about your item',
    lines: [r.quote ? `Price: ${money(r.quote, config.currency)} per item (shipping not included).` : '', r.reply ? `Kinan: ${r.reply}` : ''].filter(Boolean),
    button: { text: r.listing_id ? 'View the product' : 'See your request', url: r.listing_id ? `${base()}/#/p/${r.listing_id}` : `${base()}/#/request` } }));
}

function passwordReset(user, url) {
  // One email can have a Kinan Shop account and a Seller Center account: say which one this is
  const which = user.role === 'seller' ? 'Seller Center' : user.role === 'buyer' ? 'Kinan Shop' : 'Kinan';
  return mailer.send({ to: user.email, kind: 'reset', subject: `Reset your ${which} password`, title: `Reset your ${which} password`,
    ar: { subject: `إعادة تعيين كلمة مرور ${user.role === 'seller' ? 'مركز البائعين' : 'متجر كنان'}`, title: `إعادة تعيين كلمة مرور ${user.role === 'seller' ? 'مركز البائعين' : 'متجر كنان'}`, lines: ['طلب أحدهم إعادة تعيين كلمة مرور هذا الحساب في كنان. إذا كنت أنت فاستخدم الزر أدناه، والرابط صالح لمدة ساعة.', 'إذا لم تكن أنت فتجاهل هذه الرسالة، وستبقى كلمة مرورك كما هي.'], button: { text: 'اختر كلمة مرور جديدة', url } },
    lines: ['Someone asked to reset the password for this Kinan account. If it was you, use the button below — the link works for 1 hour.', 'If it wasn’t you, ignore this email; your password stays the same.'],
    button: { text: 'Choose a new password', url } });
}

function priceAlert(l, skus, paused) {
  const opts = skus.map((s) => `${s.props || 'Standard'}: your price ${money(s.price, config.currency)}, now costs ${money(s.cost, config.currency)}`);
  fire(mailer.send({ to: sellerEmail(l.seller_id), key: `price:${l.id}:${skus.map((s) => s.cost).join(',')}`, kind: 'seller', subject: `Price check: ${l.title}`, title: paused ? 'We paused a product that would sell at a loss' : 'A product now costs more than its price',
    lines: [`The supplier price of “${l.title}” went up:`, ...opts, paused ? 'It is paused so nobody can buy it at a loss. Raise the price, then put it live again.' : 'Raise the price in Seller Center so you don’t lose money on new orders.'],
    button: { text: 'Update the price', url: `${base()}/seller#/products` } }));
}

function payoutUpdate(p) {
  fire(mailer.send({ to: sellerEmail(p.seller_id), key: `payout:${p.id}:${p.status}`, kind: 'payout', subject: `Withdrawal ${p.status === 'paid' ? 'sent' : 'update'} — ${money(p.amount, p.currency)}`,
    title: p.status === 'paid' ? 'Your withdrawal was sent' : 'Your withdrawal request was declined',
    lines: [p.status === 'paid' ? `${money(p.amount, p.currency)} was sent to your account${p.reference ? ` (reference ${p.reference})` : ''}.` : `Reason: ${p.note || '—'}. The amount is back in your available earnings.`],
    button: { text: 'Open earnings', url: `${base()}/seller#/earnings` } }));
}

function returnUpdate(r) {
  const o = db.orders.get(r.order_id);
  push.toUser(r.buyer_id, { title: 'Return request update', body: `Order ${o ? ref(o) : ''}: ${r.status}`, url: `/#/orders/${r.order_id}` });
  fire(mailer.send({ to: emailOf(r.buyer_id), key: `return:${r.id}:${r.status}`, kind: 'return', subject: `Return request for order ${o ? ref(o) : ''}: ${r.status}`,
    title: { approved: 'Your return was approved', refunded: 'Your refund was issued', rejected: 'Your return request was declined' }[r.status] || 'Return request update',
    lines: [r.admin_note ? `Kinan: ${r.admin_note}` : '', r.refund_amount ? `Refund: ${money(r.refund_amount, config.currency)} ${r.refund_to === 'wallet' ? 'to your Kinan wallet' : 'to your card'}.` : ''].filter(Boolean),
    button: { text: 'View order', url: `${base()}/#/orders/${r.order_id}` } }));
}

module.exports = { trackingStage, STAGES, priceAlert, orderPaid, orderShipped, orderDelivered, sellerApproved, sellerUnderReview, customerWelcome, sellerKycRejected, listingDecision, requestAnswered, passwordReset, payoutUpdate, returnUpdate, qcPhotos };
