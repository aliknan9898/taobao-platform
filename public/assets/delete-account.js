'use strict';

const translations = {
  title: ['Delete your account', 'حذف حسابك'],
  info: ['Deletion is permanent. Your profile and saved addresses are removed or anonymized. Order, invoice and payment records are retained for accounting and legal obligations.', 'حذف الحساب نهائي. تُحذف بيانات ملفك وعناوينك المحفوظة أو تزال هويتك منها. تُحفظ سجلات الطلبات والفواتير والمدفوعات للالتزامات المحاسبية والقانونية.'],
  privacy: ['Privacy policy', 'سياسة الخصوصية'],
  loading: ['Checking your account…', 'جارٍ التحقق من حسابك…'],
  signin: ['Open Shop to sign in or switch accounts', 'افتح Shop لتسجيل الدخول أو تبديل الحساب'],
  password: ['Current password', 'كلمة المرور الحالية'],
  forfeit: ['I agree to give up the remaining wallet balance.', 'أوافق على التنازل عن الرصيد المتبقي في المحفظة.'],
  confirm: ['I confirm that my account will be permanently deleted.', 'أؤكد أنني أريد حذف حسابي نهائيًا.'],
  submit: ['Permanently delete account', 'حذف الحساب نهائيًا'],
  blocked: ['Complete or cancel any open orders and resolve open returns before deleting your account.', 'أكمل أو ألغِ الطلبات المفتوحة وأنهِ طلبات الإرجاع قبل حذف الحساب.'],
  login: ['Sign in to your Shop customer account to continue. If you recently signed in with a social account or phone, sign out and sign back in to refresh your session.', 'سجّل الدخول إلى حساب العميل للمتابعة. إذا انتهت صلاحية التحقق، سجّل الخروج ثم أعد تسجيل الدخول.'],
  failed: ['We could not complete the request. Check your connection and try again.', 'تعذّر إكمال الطلب. تحقّق من الاتصال وحاول مرة أخرى.'],
  denied: ['This account cannot be deleted from this page.', 'لا يمكن حذف هذا الحساب من هذه الصفحة.'],
  bad_password: ['Your password is incorrect.', 'كلمة المرور غير صحيحة.'],
  done: ['Your account has been deleted.', 'تم حذف حسابك.'],
};
const arabic = /^ar(?:-|$)/i.test(navigator.language);
const label = (key) => translations[key][arabic ? 1 : 0];
document.documentElement.lang = arabic ? 'ar' : 'en';
document.documentElement.dir = arabic ? 'rtl' : 'ltr';
document.title = label('title') + ' | kinan Shop';
document.querySelectorAll('[data-label]').forEach((element) => {
  element.textContent = label(element.dataset.label);
});
const statusMessage = document.getElementById('status');
const signIn = document.getElementById('signin');
const form = document.getElementById('deletion');
const password = form.elements.password;
const forfeit = form.elements.forfeit;
const submit = form.querySelector('button');
const endpoint = '/api/buyer/account/delete';

function activateField(input, row, active) {
  document.getElementById(row).hidden = !active;
  input.disabled = !active;
  input.required = active;
}

async function checkAccount() {
  form.hidden = true;
  try {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) {
      statusMessage.textContent = label([401, 403].includes(response.status) ? 'login' : 'failed');
      return;
    }
    const result = await response.json();
    signIn.hidden = true;
    if (!result.can_delete) {
      statusMessage.textContent = label('blocked');
      return;
    }
    activateField(password, 'password-row', result.needs_password);
    activateField(forfeit, 'wallet-row', result.wallet_balance > 0);
    statusMessage.textContent = '';
    form.hidden = false;
  } catch {
    statusMessage.textContent = label('failed');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  try {
    const body = { confirm: 'DELETE' };
    if (!password.disabled) body.password = password.value;
    if (!forfeit.disabled) body.forfeit_wallet = forfeit.checked;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    password.value = '';
    if (response.ok) {
      form.reset();
      form.hidden = true;
      statusMessage.textContent = label('done');
    } else if (response.status === 409) {
      await checkAccount();
    } else if (response.status === 401) {
      const error = await response.json();
      statusMessage.textContent = label(error.code === 'bad_password' ? 'bad_password' : 'login');
      signIn.hidden = error.code === 'bad_password';
    } else {
      statusMessage.textContent = label(response.status === 403 ? 'denied' : 'failed');
    }
  } catch {
    statusMessage.textContent = label('failed');
  } finally {
    password.value = '';
    submit.disabled = false;
  }
});

checkAccount();
