// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Arabic for the staff apps (admin dashboard and warehouse). Loaded after i18n.js on those pages only,
   so the shop and seller pages do not download it. Product titles, names and other records stay as written. */
'use strict';
(function () {
  if (!window.KinanLang) return;
  KinanLang.add({
    // ---- shared staff shell ----
    'Admin': 'الإدارة', 'Warehouse': 'المستودع', 'Warehouse · China': 'المستودع · الصين', 'Admin dashboard': 'لوحة الإدارة', 'Kinan Shop': 'متجر كنان', 'Seller Center': 'مركز البائعين',
    'Sections': 'الأقسام', 'Loading…': 'جارٍ التحميل…', 'Open': 'فتح', 'Close': 'إغلاق', 'Cancel': 'إلغاء', 'OK': 'حسناً', 'Link': 'ربط', 'Next': 'التالي', 'Steps': 'الخطوات',
    'Sign in to the admin dashboard': 'تسجيل الدخول إلى لوحة الإدارة', 'Sign in to the warehouse': 'تسجيل الدخول إلى المستودع',
    'Procurement': 'المشتريات', 'Finance': 'المالية', 'Support': 'الدعم',
    // ---- admin navigation ----
    'Partner orders': 'طلبات الشركاء', 'Partner orders (sandbox)': 'طلبات الشركاء (تجريبي)', 'Mark settled (test)': 'تأكيد الدفع (اختبار)', 'Settled (sandbox)': 'تم تأكيد الدفع (تجريبي)', 'No orders yet.': 'لا طلبات بعد.', 'Reference': 'المرجع', 'Payable': 'المستحق', 'Payment': 'الدفع', 'Fulfilment': 'التنفيذ', 'Created': 'تاريخ الإنشاء', 'Store': 'المتجر',
    'Quotes and orders are switched off. They start when the owner sets PARTNER_ORDERS_ENABLED=1 on the server (needs PostgreSQL).': 'عروض الأسعار والطلبات متوقفة. تبدأ عندما يضبط المالك PARTNER_ORDERS_ENABLED=1 على الخادم (تحتاج PostgreSQL).',
    'Partner API (B2B)': 'واجهة الشركاء (B2B)', 'Issue sandbox key': 'إصدار مفتاح تجريبي', 'Issue live key': 'إصدار مفتاح فعلي', 'Revoke': 'إلغاء', 'Revoked': 'ملغى', 'Pause API': 'إيقاف الواجهة', 'Resume API': 'تشغيل الواجهة',
    'Markets': 'الأسواق', 'Categories (empty = all)': 'الفئات (فارغ = الكل)', 'Locales': 'اللغات', 'Markup over the 30% floor (%)': 'زيادة فوق حد 30٪ (٪)', 'No keys yet.': 'لا مفاتيح بعد.', 'Live keys are off until production is approved.': 'المفاتيح الفعلية متوقفة حتى الموافقة على التشغيل الفعلي.',
    'New partner organisation': 'شريك جديد', 'Company name': 'اسم الشركة', 'Technical contact email': 'بريد المسؤول التقني', 'Create': 'إنشاء', 'Add store': 'إضافة متجر', 'New store name': 'اسم المتجر الجديد', 'No partners yet.': 'لا يوجد شركاء بعد.',
    'Sandbox simulator': 'محاكي البيئة التجريبية', 'Change a synthetic product so partners can test their sync. Never touches real products.': 'غيّر منتجاً تجريبياً ليختبر الشركاء المزامنة. لا يمس المنتجات الحقيقية.', 'Apply': 'تطبيق', 'Reset sandbox': 'إعادة ضبط البيئة التجريبية',
    'New key — copy it now, it is not shown again': 'مفتاح جديد — انسخه الآن، لن يظهر مرة أخرى', 'Done': 'تم', 'Copied': 'تم النسخ', 'Store saved': 'تم حفظ المتجر', 'Environment': 'البيئة', 'Scopes': 'الصلاحيات', 'Last used': 'آخر استخدام', 'Key': 'المفتاح', 'Stock': 'المخزون', 'Cost (cents)': 'التكلفة (سنت)', 'Availability': 'التوفر', 'unchanged': 'بدون تغيير', 'withdraw': 'سحب', 'restore': 'إرجاع', 'Product': 'المنتج', 'Active': 'نشط', 'Sandbox catalogue': 'كتالوج تجريبي', 'Live catalogue': 'الكتالوج الفعلي', 'OpenAPI contract': 'عقد OpenAPI',
    'Today': 'اليوم', 'Orders & delivery': 'الطلبات والتوصيل', 'Catalogue': 'الكتالوج', 'Suppliers & channels': 'الموردون والقنوات', 'People': 'الأشخاص', 'Money': 'المال', 'Growth': 'النمو', 'System': 'النظام', 'Apps': 'التطبيقات',
    'Control centre': 'مركز التحكم', 'Kinan Shop': 'متجر كنان', 'Maintenance': 'صيانة', 'Running': 'يعمل', 'On': 'يعمل', 'Paused': 'متوقف مؤقتاً', 'Reopen': 'إعادة الفتح', 'Turn back on': 'إعادة التشغيل', 'Start maintenance': 'بدء الصيانة', 'Pause': 'إيقاف مؤقت',
    'New orders and payments': 'الطلبات والمدفوعات الجديدة', 'New accounts': 'الحسابات الجديدة', 'Message on the maintenance page': 'الرسالة في صفحة الصيانة', 'English': 'الإنجليزية', 'Expected back (optional)': 'موعد العودة المتوقع (اختياري)',
    'Save message': 'حفظ الرسالة', 'Check the shop': 'معاينة المتجر', 'Check Seller Center': 'معاينة مركز البائعين', 'Message saved': 'تم حفظ الرسالة', 'No changes yet.': 'لا تغييرات بعد.', 'Every change is in the audit trail.': 'كل تغيير مسجّل في سجل التدقيق.',
    'The shop customers use (web and app). In maintenance, visitors see a “back soon” page; orders already paid keep being bought, tracked and delivered.': 'المتجر الذي يستخدمه الزبائن (الموقع والتطبيق). أثناء الصيانة يرى الزوار صفحة «سنعود قريباً»، والطلبات المدفوعة تستمر في الشراء والتتبع والتوصيل.',
    'Sellers’ app. In maintenance, sellers see a “back soon” page; their orders keep moving.': 'تطبيق البائعين. أثناء الصيانة يرى البائعون صفحة «سنعود قريباً»، وطلباتهم تستمر.',
    'Pause checkout only: people can still browse and fill their bag.': 'إيقاف الدفع فقط: يمكن للناس التصفح وإضافة المنتجات إلى السلة.',
    'Pause sign-ups for new customers and sellers. Existing accounts can still sign in.': 'إيقاف التسجيل للزبائن والبائعين الجدد. الحسابات الحالية تستطيع تسجيل الدخول.',
    'Switch parts of KINAN off for maintenance or updates and back on. The admin dashboard, the warehouse, sign-in, payments already made and supplier/carrier updates (webhooks) always keep working. While you are signed in here you still see the apps as normal, so you can check them before reopening.': 'أوقف أجزاء من كنان للصيانة أو التحديثات ثم أعد تشغيلها. لوحة الإدارة والمستودع وتسجيل الدخول والمدفوعات السابقة وتحديثات الموردين وشركات الشحن تبقى تعمل دائماً. وأثناء تسجيل دخولك هنا ترى التطبيقات بشكل طبيعي لتتأكد منها قبل إعادة الفتح.',
    'All open': 'الكل يعمل', 'Shop, Seller Center, checkout and sign-ups are on': 'المتجر ومركز البائعين والدفع والتسجيل كلها تعمل', 'Nothing went wrong': 'لا توجد مشاكل', 'Could not load': 'تعذّر التحميل', 'Products waiting for your approval': 'منتجات بانتظار موافقتك', 'Orders in the last 30 days': 'الطلبات في آخر 30 يوماً',
    'Shop in maintenance': 'المتجر في الصيانة', 'Seller Center in maintenance': 'مركز البائعين في الصيانة', 'Checkout paused': 'الدفع متوقف', 'Sign-ups paused': 'التسجيل متوقف', 'Shop': 'المتجر', 'Checkout': 'الدفع', 'Sign-ups': 'التسجيل',
    'Workspace': 'مساحة العمل', 'Products': 'المنتجات', 'Operations': 'العمليات', 'Suppliers & Channels': 'الموردون والقنوات', 'People & Trust': 'الأشخاص والثقة',
    'Overview': 'نظرة عامة', 'Live Imports': 'الاستيراد المباشر', 'AI & Product Research': 'الذكاء الاصطناعي وبحث المنتجات', 'Integrations': 'التكاملات', 'Admin Tools': 'أدوات الإدارة',
    'KINAN Business': 'أعمال كنان', 'Advertising': 'الإعلانات', 'KINAN Email': 'بريد كنان', 'Product Catalog': 'كتالوج المنتجات', 'Product Review': 'مراجعة المنتجات', 'CJdropshipping': 'CJdropshipping',
    'Exceptions': 'الاستثناءات', 'Shipping': 'الشحن', 'Item Requests': 'طلبات المنتجات', 'Sellers': 'البائعون', 'Users': 'المستخدمون', 'Reviews': 'التقييمات',
    'Reports & Analytics': 'التقارير والتحليلات', 'Withdrawals': 'السحوبات', 'Discount Codes': 'أكواد الخصم', 'Backup & Data': 'النسخ الاحتياطي والبيانات',
    // ---- admin overview ----
    'Live on Shop': 'الآن في المتجر', 'Live on Seller': 'الآن في مركز البائعين', 'Revenue (30 days)': 'الإيرادات (30 يوماً)', 'Orders (30 days)': 'الطلبات (30 يوماً)', 'Platform commission': 'عمولة المنصة',
    'Payable to sellers': 'مستحق للبائعين', 'Active sellers': 'البائعون النشطون', 'Live products': 'المنتجات المنشورة', 'Awaiting your approval': 'بانتظار موافقتك', 'Alerts': 'التنبيهات', 'No alerts.': 'لا توجد تنبيهات.',
    'Daily revenue (14 days)': 'الإيرادات اليومية (14 يوماً)', 'Orders by status': 'الطلبات حسب الحالة', 'View orders': 'عرض الطلبات', 'Monitor live imports': 'متابعة الاستيراد المباشر', 'Open AI tools': 'فتح أدوات الذكاء الاصطناعي',
    // ---- admin exceptions ----
    'Everything that went wrong across the shop, sellers, suppliers, carriers and the warehouse. Items close by themselves when the cause is fixed.': 'كل ما تعطّل في المتجر والبائعين والموردين وشركات الشحن والمستودع. يُغلق كل بند تلقائياً عند إصلاح سببه.',
    'Area': 'المجال', 'Provider': 'المزوّد', 'Result': 'النتيجة', 'Assigned': 'المسؤول', 'Everyone': 'الجميع', 'Assigned to me': 'المسندة إليّ', 'Unassigned': 'غير مسند', 'Assign to': 'إسناد إلى',
    'Note for the team': 'ملاحظة للفريق', 'Note': 'ملاحظة', 'Saved': 'تم الحفظ', 'Retry purchase': 'إعادة محاولة الشراء', 'Retrying…': 'جارٍ إعادة المحاولة…', 'Retry not available': 'إعادة المحاولة غير متاحة', 'Nothing is open. 🎉': 'لا يوجد شيء مفتوح. 🎉',
    'Supplier': 'المورد', 'Carrier': 'شركة الشحن', 'Product sync': 'مزامنة المنتجات', 'Failed': 'فشل', 'Stuck': 'متوقف', 'Action needed': 'يلزم إجراء', 'To review': 'للمراجعة',
    'Order is not waiting for a purchase': 'الطلب لا ينتظر عملية شراء', 'Creating the purchase order failed': 'فشل إنشاء أمر الشراء', 'No supplier order was placed yet': 'لم يُرسل طلب للمورد بعد', 'A supplier order already exists — fix it with the supplier': 'يوجد طلب لدى المورد — عالجه مع المورد',
    'This exception is no longer open': 'هذا الاستثناء لم يعد مفتوحاً', 'Choose a staff member': 'اختر موظفاً',
    // ---- warehouse ----
    'Receive parcel': 'استلام طرد', 'Scan or type tracking number': 'امسح رقم التتبع أو اكتبه', 'Scan with camera': 'المسح بالكاميرا', 'Scan barcode': 'مسح الباركود', 'Location (A-01)': 'الموقع (A-01)', 'Shelf location': 'موقع الرف',
    'Weight': 'الوزن', 'Weight (g)': 'الوزن (غ)', 'Weight in grams': 'الوزن بالغرام', 'Quality check': 'فحص الجودة', 'QC passed': 'نجح الفحص', 'QC failed': 'فشل الفحص', 'Receive': 'استلام',
    'Goods count as legally delivered once signed for here. After they leave this warehouse they can no longer be returned to the Taobao seller, so inspect them before packing.': 'تُعتبر البضاعة مُسلّمة قانونياً بمجرد التوقيع على استلامها هنا. بعد خروجها من المستودع لا يمكن إرجاعها لبائع تاوباو، فافحصها قبل التغليف.',
    'Expected parcels': 'الطرود المتوقعة', 'In stock': 'في المخزون', 'Orders ready to ship': 'طلبات جاهزة للشحن', 'Unmatched': 'غير مطابق', 'Shipments in transit': 'شحنات في الطريق', 'Shipments': 'الشحنات',
    'Tracking no.': 'رقم التتبع', 'Tracking number': 'رقم التتبع', 'Product': 'المنتج', 'Shop': 'المتجر', 'Location': 'الموقع', 'Received at': 'وقت الاستلام', 'Order ID': 'رقم الطلب', 'Recipient': 'المستلم', 'Destination': 'الوجهة', 'Items': 'المنتجات', 'Parcels': 'الطرود', 'International shipping': 'الشحن الدولي',
    'No expected parcels': 'لا توجد طرود متوقعة', 'Warehouse is empty': 'المستودع فارغ', 'No orders': 'لا توجد طلبات', 'No shipments': 'لا توجد شحنات', 'Awaiting parcels': 'بانتظار الطرود', 'Stored — wait for customer': 'مخزّن — بانتظار الزبون', 'customer problem': 'مشكلة لدى الزبون',
    'Photos': 'الصور', 'Ship…': 'شحن…', 'Ship order': 'شحن الطلب', 'Same customer and address — put in the same box?': 'نفس الزبون والعنوان — وضعها في الصندوق نفسه؟', 'One box costs less: the customer gets the shipping saving back automatically.': 'الصندوق الواحد أرخص: يسترد الزبون فرق الشحن تلقائياً.',
    'Box L×W×H (cm)': 'الصندوق ط×ع×ار (سم)', 'Get courier prices': 'عرض أسعار شركات الشحن', 'Ship by hand': 'شحن يدوي', 'Courier': 'شركة الشحن', 'for profit reports': 'لتقارير الأرباح', 'No prices returned.': 'لم تُرجَع أسعار.', 'Buy label': 'شراء بوليصة', 'Print label': 'طباعة البوليصة', 'Label': 'البوليصة',
    'The courier did not return a label — print it from their website.': 'لم تُرسل شركة الشحن البوليصة — اطبعها من موقعها.', 'Shipped at': 'وقت الشحن', 'Shipped ✓': 'تم الشحن ✓', 'Confirm delivery': 'تأكيد التسليم',
    'Point the camera at the barcode on the parcel.': 'وجّه الكاميرا إلى باركود الطرد.', 'Camera scanning isn’t available here': 'المسح بالكاميرا غير متاح هنا',
    'This browser can’t read barcodes with the camera (for example Safari on iPhone). Use Chrome on Android, a Bluetooth / USB barcode scanner (it types into the field), or type the number.': 'هذا المتصفح لا يقرأ الباركود بالكاميرا (مثل Safari على iPhone). استخدم Chrome على أندرويد، أو قارئ باركود بلوتوث / USB (يكتب في الحقل)، أو اكتب الرقم.',
    'Already received': 'تم استلامه مسبقاً', 'Update location / weight / QC': 'تحديث الموقع / الوزن / الفحص', 'Keep the first scan': 'الإبقاء على المسح الأول', 'Received': 'تم الاستلام', 'Updated': 'تم التحديث', 'Recorded with QC failure': 'سُجّل مع فشل الفحص',
    'Unknown parcel — recorded for manual matching': 'طرد غير معروف — سُجّل للمطابقة اليدوية', 'No order linked': 'غير مرتبط بطلب', 'parcels here': 'طرود هنا', 'location': 'الموقع', 'Order': 'الطلب',
    'Weight must be in grams, between 1 and 70000 g': 'يجب أن يكون الوزن بالغرام، بين 1 و70000 غ', 'is that right? Weights are in grams.': 'هل هذا صحيح؟ الأوزان بالغرام.',
    'Put it on the unmatched shelf and link it to an order': 'ضعه على رف غير المطابق واربطه بطلب', 'Keep it apart: quality check failed': 'اعزله: فشل فحص الجودة', 'All parcels are here: take QC photos, then pack the order': 'كل الطرود وصلت: التقط صور الفحص ثم غلّف الطلب',
    'Photos': 'الصور', 'Checked': 'تم التحقق', 'Pack & ship': 'تغليف وشحن', 'in': 'وصل', 'Parcel is already packed in a shipment': 'الطرد مغلّف بالفعل في شحنة', 'Tracking number is required': 'رقم التتبع مطلوب', 'Open order': 'فتح الطلب'
  }, [
    [/^Expected \((\d+)\)$/, 'المتوقع ($1)'], [/^In stock \((\d+)\)$/, 'في المخزون ($1)'], [/^Orders \((\d+)\)$/, 'الطلبات ($1)'],
    [/^(\d+) of (\d+) open$/, '$1 من $2 مفتوحة'], [/^Store it: (\d+) more parcel\(s\) for this order to come$/, 'خزّنه: باقي $1 طرد لهذا الطلب'],
    [/^(\d+) photo\(s\) · $/, '$1 صورة · '], [/^\+(\d+) more ready for this customer$/, '+$1 جاهزة أخرى لهذا الزبون'],
    [/^Order (\w+): (\w+) purchase problem$/, 'الطلب $1: مشكلة في الشراء من $2'], [/^Order (\w+) needs attention$/, 'الطلب $1 يحتاج متابعة'],
    [/^Order (\w+): supplier payment deadline is close$/, 'الطلب $1: اقترب موعد الدفع للمورد'], [/^Order (\w+): (\w+) item still to order$/, 'الطلب $1: منتج $2 لم يُطلب بعد'],
    [/^Order (\w+): delivery failed$/, 'الطلب $1: فشل التسليم'], [/^Order (\w+): parcel going back to sender$/, 'الطلب $1: الطرد عائد إلى المرسل'], [/^Order (\w+): no carrier updates yet$/, 'الطلب $1: لا تحديثات من شركة الشحن بعد'],
    [/^Order (\w+): customer reported a problem with the QC photos$/, 'الطلب $1: أبلغ الزبون عن مشكلة في صور الفحص'],
    [/^Parcel (\S+) received but not matched to an order$/, 'الطرد $1 استُلم ولم يُطابق بطلب'], [/^Parcel (\S+) failed quality check$/, 'الطرد $1 فشل في فحص الجودة'],
    [/^(\d+) (\w+) product\(s\): last price\/stock update failed$/, '$1 منتج من $2: فشل آخر تحديث للسعر أو المخزون'], [/^(\d+) product\(s\) cost more than their selling price$/, '$1 منتج تكلفته أعلى من سعر بيعه'],
    [/^(\d+) seller withdrawal\(s\) to pay$/, '$1 سحب للبائعين بانتظار الدفع'], [/^(\d+) return request\(s\) to review$/, '$1 طلب إرجاع للمراجعة'], [/^Location (\S+)$/, 'الموقع $1'],
    [/^(\d+) urgent · open the queue$/, '$1 عاجل · افتح القائمة'], [/^(.+): paused$/, '$1: متوقف'], [/^(.+): back on$/, '$1: يعمل من جديد'],
    [/^(\d+) h ago$/, 'منذ $1 ساعة'], [/^(\d+) days ago$/, 'منذ $1 يوم'], [/^less than an hour ago$/, 'منذ أقل من ساعة']
  ]);
})();
