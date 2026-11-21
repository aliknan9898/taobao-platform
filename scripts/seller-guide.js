// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved. Proprietary — see LICENSE.
// Builds "How to use Kinan Seller" in English and Arabic, printed to PDF with Chromium (Playwright).
// Usage: node scripts/seller-guide.js [output dir, default public/assets]. Fonts and the seller logo come from public/assets.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const T = {
  en: {
    dir: 'ltr', lang: 'en', title: 'How to use Kinan Seller',
    sub: 'Your step-by-step guide to opening a shop, adding products, getting orders and getting paid.',
    keys: [['1', 'Open your shop', 'Sign up, accept the Seller Terms, verify your identity.'], ['2', 'Add products', 'Pick from the Kinan catalogue or add your own — AI helps you.'], ['3', 'Get paid', 'Kinan handles delivery. You withdraw your earnings.']],
    foot: 'Kinan Seller Center · kinan.shop/seller · November 2026',
    sections: [
      ['🏪', 'Open your shop', [
        'Go to <b>kinan.shop/seller</b> and tap <b>Open a shop</b>.',
        'Enter your shop name, your name, email and a password (8+ characters). You can also continue with Google or Facebook.',
        'Tick the box to accept the <b>Seller Terms</b> and Privacy Policy, then tap <b>Open shop</b>.',
        '<b>Verify your identity</b>: your details, a photo of your ID or passport and a live selfie. EU law requires this for every seller.',
        'Kinan reviews your shop, usually within 1–2 working days. You can prepare products while you wait.'
      ], 'Tip: add your shop logo, a short description and your return policy in <b>Account</b> — buyers trust shops with a full profile.'],
      ['➕', 'Add products', [
        'Open <b>Add product</b>.',
        '<b>From the Kinan catalogue:</b> tap <b>Browse the Kinan catalogue</b>, choose a product, set <b>Your price</b> above the <b>Kinan price</b> and tap <b>Add to my shop</b>. It goes live at once, with clear photos and delivery in 15 days or less.',
        '<b>Your own product:</b> tap <b>Add manually</b>, upload clear photos, write the title and add variants (size, colour) with price and stock.',
        'Set your price. Kinan shows your cost and margin; the default markup is 30 % and you can change it per product.',
        'Tap <b>Improve with AI</b> for a clear English title, description, keywords and translations. Always check the result.',
        'Optional: switch on <b>Sell on eBay</b> on the same page.',
        'Tap <b>Submit for review</b>. The product appears in the shop once Kinan approves it.'
      ], 'Good photos, a precise title (what it is + main feature + size/colour) and a fair price are what sell.'],
      ['✅', 'Product review and rules', [
        'Every new product, and every change to its title, description or photos, is reviewed before buyers see it. Price changes are instant.',
        'If a product is rejected you see the reason in <b>Products</b>. Fix it and publish again.',
        'Never list: counterfeits or brand copies, weapons, medicines, hazardous chemicals, adult items, or anything illegal or unsafe in the EU/UK.',
        'Products must meet EU/UK safety rules (CE/UKCA marks and warnings where required).'
      ], null],
      ['📦', 'Orders', [
        'When a buyer pays, the order appears in <b>Orders</b> and you get a notification.',
        '<b>Kinan catalogue products:</b> Kinan buys and ships straight to the buyer. You do not need to do anything.',
        '<b>Your own stock:</b> pack and ship within your handling time, then add the tracking number in the order.',
        'The buyer gets tracking updates automatically at every step (shipped, customs, out for delivery, delivered).',
        'Answer buyer messages in the order within 2 working days.'
      ], null],
      ['💶', 'Earnings and payouts', [
        'Your earning on each sale = <b>sale price − Kinan commission − Kinan price</b> (the Kinan price applies to Kinan catalogue products). Your commission rate is shown in the Seller Center (standard 10 %).',
        'Earnings are “On the way” until the buyer receives the order and the return period ends, then they become <b>Available</b>.',
        'Open <b>Earnings</b> and tap <b>Request withdrawal</b> to your bank (IBAN), Wise or PayPal.',
        'Tap <b>Download PDF</b> in Earnings for your monthly statement. You are responsible for your own taxes.'
      ], 'Refunds caused by a problem with your product (not as described, faulty) are deducted from your earnings — accurate listings protect your income.'],
      ['🏷️', 'Sell on eBay', [
        'Open <b>eBay</b> in the menu and switch on <b>Sell my products on eBay</b>:',
        '<b>On Kinan’s eBay account</b> — nothing to set up. Kinan lists, sells and handles the order, and keeps 10 % of the profit after all costs.',
        'Turn on <b>Sell on eBay</b> for your products, then tap <b>List … on eBay</b>. eBay orders appear in your eBay page with the full money breakdown.'
      ], null],
      ['🚀', 'Sell more', [
        'Add products in the departments buyers browse most: Home & Kitchen, Pets, Fashion, Electronics, Toys.',
        'Products from European warehouses arrive in days — buyers prefer them, especially before Christmas.',
        'Keep stock up to date and reply fast: both raise your products in search.',
        'Join Kinan’s sales (Black Friday, Christmas) — offers get a special place in the shop.'
      ], null],
      ['💬', 'Help', [
        'Read the full <b>Seller Terms</b> at kinan.shop/seller-terms.',
        'Questions? Write to Kinan from the contact details at kinan.shop/legal — we answer within 1–2 working days.'
      ], null]
    ]
  },
  ar: {
    dir: 'rtl', lang: 'ar', title: 'طريقة استخدام Kinan Seller',
    sub: 'دليلك خطوة بخطوة: فتح المتجر، إضافة المنتجات، استقبال الطلبات واستلام أرباحك.',
    keys: [['1', 'افتح متجرك', 'سجّل، وافق على شروط البائعين، وثّق هويتك.'], ['2', 'أضف منتجاتك', 'اختر من كتالوج كنان أو أضف منتجك — والذكاء الاصطناعي يساعدك.'], ['3', 'استلم أرباحك', 'كنان يتولى التوصيل، وأنت تسحب أرباحك.']],
    foot: 'Kinan Seller Center · kinan.shop/seller · نوفمبر 2026',
    sections: [
      ['🏪', 'افتح متجرك', [
        'ادخل إلى <b class="ltr">kinan.shop/seller</b> واضغط <b>Open a shop</b>.',
        'اكتب اسم متجرك واسمك وبريدك وكلمة مرور (8 أحرف أو أكثر). ويمكنك المتابعة بحساب Google أو Facebook.',
        'ضع علامة الموافقة على <b>شروط البائعين</b> وسياسة الخصوصية، ثم اضغط <b>Open shop</b>.',
        '<b>وثّق هويتك</b>: بياناتك، وصورة الهوية أو جواز السفر، وصورة سيلفي مباشرة. القانون الأوروبي يطلب ذلك من كل بائع.',
        'يراجع كنان متجرك عادة خلال يوم إلى يومي عمل، ويمكنك تجهيز منتجاتك أثناء الانتظار.'
      ], 'نصيحة: أضف شعار متجرك ووصفاً قصيراً وسياسة الإرجاع من صفحة <b>Account</b> — العملاء يثقون بالمتاجر المكتملة.'],
      ['➕', 'أضف منتجاتك', [
        'افتح <b>Add product</b>.',
        '<b>من كتالوج كنان:</b> اضغط <b>Browse the Kinan catalogue</b>، اختر منتجاً، وضع <b>Your price</b> أعلى من <b>Kinan price</b>، ثم اضغط <b>Add to my shop</b>. ينشر فوراً بصور واضحة وشحن خلال 15 يوماً أو أقل.',
        '<b>منتجك الخاص:</b> اضغط <b>Add manually</b>، وارفع صوراً واضحة، واكتب العنوان، وأضف الخيارات (المقاس، اللون) مع السعر والمخزون.',
        'حدّد سعرك. كنان يعرض لك التكلفة وهامش الربح؛ الزيادة الافتراضية 30% ويمكنك تغييرها لكل منتج.',
        'اضغط <b>Improve with AI</b> لعنوان ووصف وكلمات بحث وترجمات واضحة. راجع النتيجة دائماً.',
        'اختياري: فعّل <b>Sell on eBay</b> من نفس الصفحة.',
        'اضغط <b>Submit for review</b>. يظهر المنتج في المتجر بعد موافقة كنان.'
      ], 'الصور الجيدة، والعنوان الدقيق (ما هو + الميزة الأهم + المقاس/اللون)، والسعر العادل هي ما يبيع.'],
      ['✅', 'مراجعة المنتجات والقواعد', [
        'كل منتج جديد، وكل تعديل على عنوانه أو وصفه أو صوره، يُراجَع قبل أن يراه العملاء. تغيير السعر فوري.',
        'إذا رُفض منتج ترى السبب في <b>Products</b>. صحّحه وانشره مرة أخرى.',
        'ممنوع نهائياً: المنتجات المقلّدة ونسخ الماركات، الأسلحة، الأدوية، المواد الكيميائية الخطرة، منتجات البالغين، وأي شيء مخالف للقانون أو غير آمن في أوروبا أو بريطانيا.',
        'يجب أن تطابق المنتجات قواعد السلامة الأوروبية والبريطانية (علامة CE/UKCA والتحذيرات عند الحاجة).'
      ], null],
      ['📦', 'الطلبات', [
        'عندما يدفع العميل يظهر الطلب في <b>Orders</b> ويصلك إشعار.',
        '<b>منتجات كتالوج كنان:</b> كنان يشتري ويشحن مباشرة للعميل. لا تحتاج أن تفعل شيئاً.',
        '<b>مخزونك الخاص:</b> غلّف واشحن خلال مدة التجهيز، ثم أضف رقم التتبع في الطلب.',
        'العميل يستلم تحديثات التتبع تلقائياً في كل مرحلة (الشحن، الجمارك، خارج للتوصيل، التسليم).',
        'ردّ على رسائل العملاء داخل الطلب خلال يومي عمل.'
      ], null],
      ['💶', 'الأرباح وسحبها', [
        'ربحك من كل بيعة = <b>سعر البيع − عمولة كنان − سعر كنان</b> (لمنتجات كتالوج كنان). نسبة عمولتك ظاهرة في Seller Center (القياسية 10%).',
        'الأرباح تكون «On the way» حتى يستلم العميل الطلب وتنتهي مدة الإرجاع، ثم تصبح <b>Available</b>.',
        'افتح <b>Earnings</b> واضغط <b>Request withdrawal</b> للسحب إلى حسابك البنكي (IBAN) أو Wise أو PayPal.',
        'اضغط <b>Download PDF</b> في Earnings لكشف الحساب الشهري. ضرائبك الشخصية مسؤوليتك.'
      ], 'الاسترداد بسبب مشكلة في منتجك (غير مطابق للوصف أو معيب) يُخصم من أرباحك — الوصف الدقيق يحمي دخلك.'],
      ['🏷️', 'البيع على eBay', [
        'افتح <b>eBay</b> من القائمة وفعّل <b>Sell my products on eBay</b>:',
        '<b>على حساب كنان في eBay</b> — بدون أي إعداد. كنان ينشر ويبيع ويتولى الطلب، ويأخذ 10% من الربح بعد كل المصاريف.',
        'فعّل <b>Sell on eBay</b> لمنتجاتك، ثم اضغط <b>List … on eBay</b>. طلبات eBay تظهر في صفحة eBay مع تفاصيل المبالغ كاملة.'
      ], null],
      ['🚀', 'بِع أكثر', [
        'أضف منتجات في الأقسام الأكثر تصفحاً: المنزل والمطبخ، الحيوانات الأليفة، الأزياء، الإلكترونيات، الألعاب.',
        'المنتجات من المستودعات الأوروبية تصل خلال أيام — والعملاء يفضّلونها، خصوصاً قبل الكريسمس.',
        'حدّث المخزون وردّ بسرعة: الاثنان يرفعان منتجاتك في البحث.',
        'شارك في تخفيضات كنان (Black Friday، الكريسمس) — العروض تحصل على مكان مميز في المتجر.'
      ], null],
      ['💬', 'المساعدة', [
        'اقرأ <b>شروط البائعين</b> كاملة على <span class="ltr">kinan.shop/seller-terms</span>.',
        'عندك سؤال؟ راسل كنان من بيانات التواصل في <span class="ltr">kinan.shop/legal</span> — نرد خلال يوم إلى يومي عمل.'
      ], null]
    ]
  }
};

function html(L) {
  const t = T[L];
  return `<!doctype html><html lang="${t.lang}" dir="${t.dir}"><head><meta charset="utf-8"><title>${esc(t.title)}</title><style>
@font-face{font-family:Brico;src:url(bricolage-700.woff)}
@font-face{font-family:Inst;font-weight:400;src:url(instrument-400.woff)}
@font-face{font-family:Inst;font-weight:700;src:url(instrument-700.woff)}
@font-face{font-family:PlexAr;font-weight:400;src:url(plexar-regular.woff)}
@font-face{font-family:PlexAr;font-weight:500;src:url(plexar-regular.woff)}
@font-face{font-family:PlexAr;font-weight:600;src:url(plexar-semibold.woff)}
@font-face{font-family:PlexAr;font-weight:700;src:url(plexar-bold.woff)}

@page { size: A4; }
* { box-sizing: border-box; }
body { font-family: Inst, 'DejaVu Sans', sans-serif; color: #1f1a33; font-size: 10.6pt; line-height: 1.6; margin: 0; }
h1, h2 { font-family: Brico, 'DejaVu Sans', sans-serif; margin: 0; color: #2b2050; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; }
.brand { display: flex; align-items: center; gap: 10px; font-family: Brico; font-size: 22pt; color: #2b2050; direction: ltr; }
.logo { width: 52px; height: 52px; display: block; }
.cover h1 { font-size: 32pt; line-height: 1.2; }
.cover .lead { font-size: 13pt; color: #4f4868; max-width: 150mm; margin-top: 10px; }
.keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.key { border: 1.5px solid #e1dbf4; border-radius: 14px; padding: 14px; background: #f7f5fd; }
.key .n { width: 30px; height: 30px; border-radius: 50%; background: #4b319b; color: #fff; display: grid; place-items: center; font-weight: 700; margin-bottom: 8px; }
.key b { display: block; font-family: Brico, 'DejaVu Sans'; font-size: 13pt; color: #2b2050; margin-bottom: 3px; }
.small { font-size: 8.6pt; color: #6a6385; }
.sec { page-break-inside: avoid; border: 1px solid #e1dbf4; border-radius: 14px; padding: 14px 16px; margin: 0 0 12px; }
.sec h2 { font-size: 16pt; margin-bottom: 8px; display: flex; gap: 8px; align-items: center; }
ol { counter-reset: s; list-style: none; padding: 0; margin: 0; }
ol li { counter-increment: s; position: relative; padding-inline-start: 34px; margin: 0 0 7px; }
ol li::before { content: counter(s); position: absolute; inset-inline-start: 0; top: 1px; width: 22px; height: 22px; border-radius: 50%; background: #eee9fb; color: #4b319b; display: grid; place-items: center; font-weight: 700; font-size: 9pt; font-family: Inst; }
.tip { margin-top: 8px; border-inline-start: 4px solid #ffbd00; background: #fffaf0; padding: 7px 11px; border-radius: 6px; font-size: 9.4pt; }
b { color: #2b2050; }
.ltr { direction: ltr; unicode-bidi: embed; }
${t.lang === 'ar' ? `body{font-family:PlexAr,Inst,sans-serif;font-size:10.8pt;line-height:1.75}h1,h2,.key b,.brand{font-family:PlexAr,Brico,sans-serif;font-weight:700;letter-spacing:0}.cover h1{font-size:34pt;line-height:1.3}b{font-weight:600}.sec h2{font-size:17pt}` : ''}
</style></head><body>
<div class="cover">
  <div class="brand"><img class="logo" src="logo-seller.png" alt="">KINAN Seller</div>
  <div><h1>${esc(t.title)}</h1><p class="lead">${esc(t.sub)}</p></div>
  <div class="keys">${t.keys.map(([n, h, p]) => `<div class="key"><div class="n">${n}</div><b>${esc(h)}</b>${esc(p)}</div>`).join('')}</div>
  <div class="small">${esc(t.foot)}</div>
</div>
${t.sections.map(([ic, h, steps, tip]) => `<div class="sec"><h2><span>${ic}</span>${esc(h)}</h2><ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>${tip ? `<div class="tip">💡 ${tip}</div>` : ''}</div>`).join('')}
</body></html>`;
}

(async () => {
  // The HTML is written next to the fonts and logo so relative URLs resolve; it is removed afterwards.
  const dir = path.join(__dirname, '..', 'public', 'assets'); const out = process.argv[2] || dir;
  const b = await chromium.launch();
  for (const L of ['en', 'ar']) {
    const f = path.join(dir, `.seller-guide-${L}.html`); fs.writeFileSync(f, html(L));
    const p = await b.newPage(); await p.goto('file://' + f); await p.waitForTimeout(500);
    await p.pdf({ path: path.join(out, `kinan-seller-guide-${L}.pdf`), format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#7d7696;font-family:sans-serif">KINAN Seller · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    await p.close(); fs.unlinkSync(f);
  }
  await b.close(); console.log('ok');
})();
