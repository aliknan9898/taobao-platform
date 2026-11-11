// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Arabic / English for Kinan Shop, Kinan Seller and the public pages.
   Loaded in <head>: sets lang/dir before the first paint. The apps keep writing English;
   in Arabic mode every UI text node and placeholder is swapped for its Arabic version as it
   appears (exact phrases + a few patterns for text with numbers). Product titles and other
   user content are left as written. */
'use strict';
(function () {
  var KEY = 'kinan_lang';
  var root = document.documentElement;
  function pick() {
    try { var s = localStorage.getItem(KEY); if (s === 'ar' || s === 'en') return s; } catch (e) { /* private mode */ }
    return /^ar\b/i.test(navigator.language || '') ? 'ar' : 'en';
  }
  var lang = pick();
  root.setAttribute('lang', lang);
  root.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');

  var AR = {
    // ---- shell / common ----
    'Shop': 'المتجر', 'Cart': 'السلة', 'Orders': 'الطلبات', 'Account': 'حسابي', 'Search products': 'ابحث عن منتجات', 'Deliver to': 'التوصيل إلى', 'Show prices in': 'اعرض الأسعار بـ', 'Country': 'الدولة', 'Shipping included': 'الشحن مشمول', 'Import duties or VAT may be charged by your country’s customs on delivery.': 'قد تفرض جمارك بلدك رسوماً أو ضريبة عند الاستلام.', 'Exchange rate': 'سعر الصرف', 'Update now': 'تحديث الآن', 'Buy for me': 'اشترِ لي', 'Buy from any Taobao link': 'اشترِ من أي رابط تاوباو', 'Paste any Taobao, Tmall, 1688 or AliExpress link — we buy it, check it and ship it to you.': 'الصق أي رابط من تاوباو أو تيمول أو 1688 أو علي إكسبرس، ونشتريه ونفحصه ونشحنه إليك.', 'Paste any Taobao, 1688 or AliExpress link — we buy it for you': 'الصق أي رابط من تاوباو أو 1688 أو علي إكسبرس ونشتريه لك', 'Paste any product link from Taobao, Tmall, 1688, AliExpress or JD. We buy it, check it at our China warehouse and ship it to you.': 'الصق رابط أي منتج من تاوباو أو تيمول أو 1688 أو علي إكسبرس أو JD. نشتريه ونفحصه في مستودعنا في الصين ونشحنه إليك.', 'Product link': 'رابط المنتج', 'Paste the link, or the whole text the Taobao app copies when you tap Share': 'الصق الرابط، أو النص كاملاً الذي ينسخه تطبيق تاوباو عند الضغط على مشاركة', 'Product name': 'اسم المنتج', '(optional)': '(اختياري)', 'Price on the page (¥)': 'السعر في الصفحة (¥)', 'Size, colour or option': 'المقاس أو اللون أو الخيار', 'e.g. Black, XL': 'مثال: أسود، XL', 'Notes for Kinan': 'ملاحظات لكنان', 'Send to Kinan': 'أرسل إلى كنان', 'Kinan checks the item and confirms the final price, usually within a day. You pay only after you accept it.': 'تتحقق كنان من المنتج وتؤكد السعر النهائي، غالباً خلال يوم. لا تدفع إلا بعد موافقتك.', 'Waiting for Kinan’s price': 'بانتظار سعر كنان', 'Price ready': 'السعر جاهز', 'Added to your cart': 'أُضيف إلى سلتك', 'Delivery to our China warehouse': 'التوصيل إلى مستودعنا في الصين', 'International shipping (estimate)': 'الشحن الدولي (تقديري)', 'Estimated total': 'الإجمالي التقديري', 'per item · shipping added at checkout': 'للقطعة · يُضاف الشحن عند الدفع', 'Sent — Kinan will confirm the price soon': 'تم الإرسال، وستؤكد كنان السعر قريباً', 'Arabic title and description': 'العنوان والوصف بالعربية', 'Leave empty and Kinan translates your product into Arabic automatically. Write it yourself for the best result.': 'اتركه فارغاً وتترجم كنان منتجك إلى العربية تلقائياً، أو اكتبه بنفسك لأفضل نتيجة.', 'Arabic title': 'العنوان بالعربية', 'Arabic description': 'الوصف بالعربية', 'Automatic translation now:': 'الترجمة التلقائية الحالية:', 'Packing': 'التغليف', 'We pack your items safely.': 'نغلّف منتجاتك بأمان.', 'Free': 'مجاني', 'Remove product boxes': 'إزالة علب المنتجات', 'Lighter parcel — cheaper shipping, often refunded to your wallet.': 'طرد أخف وشحن أرخص، والفرق غالباً يعود إلى محفظتك.', 'Extra protection': 'حماية إضافية', 'Bubble wrap and a stronger box for fragile items.': 'تغليف فقاعي وصندوق أقوى للمنتجات القابلة للكسر.', 'Store in the warehouse': 'التخزين في المستودع', 'Stored in our warehouse': 'مخزّن في مستودعنا', 'Ship my stored orders now': 'اشحن طلباتي المخزّنة الآن', 'Stored': 'مخزّن', 'Photos from our warehouse': 'صور من مستودعنا', 'You approved': 'وافقت', 'Problem reported': 'تم الإبلاغ عن مشكلة', 'Resolved': 'تم الحل', 'Please check': 'يرجى المراجعة', 'Your items arrived and we checked them. Is everything right?': 'وصلت منتجاتك وفحصناها. هل كل شيء صحيح؟', 'Looks good — ship it': 'ممتاز، اشحنه', 'Something is wrong': 'هناك مشكلة', 'What is wrong?': 'ما المشكلة؟', 'Send to Kinan support': 'أرسل إلى دعم كنان', 'Thanks — Kinan support will contact you before we ship.': 'شكراً، سيتواصل معك دعم كنان قبل الشحن.', 'Thank you — we’ll ship it soon': 'شكراً، سنشحنه قريباً', 'Sent — we will contact you': 'تم الإرسال، وسنتواصل معك', 'Product boxes removed to save weight': 'أزيلت علب المنتجات لتخفيف الوزن', 'Saved items': 'المحفوظات', 'We email you when a price drops or an item is back': 'نراسلك عند انخفاض السعر أو عودة المنتج', 'Reviews': 'التقييمات', 'Discount': 'الخصم', 'Discount code': 'كود الخصم', 'Verified purchase': 'شراء مؤكد', 'Rate your items': 'قيّم منتجاتك', 'What did you think? (optional)': 'ما رأيك؟ (اختياري)', 'Post review': 'انشر التقييم', 'Thanks for your reviews!': 'شكراً على تقييماتك!', 'Thanks for your review!': 'شكراً على تقييمك!', 'Choose 1 to 5 stars': 'اختر من 1 إلى 5 نجوم', 'Nothing saved yet': 'لا توجد محفوظات بعد', 'Tap Save on any product to keep it here.': 'اضغط حفظ على أي منتج ليظهر هنا.', 'We email you when one of these gets cheaper or comes back in stock.': 'نراسلك عندما ينخفض سعر أحدها أو يعود للتوفر.', 'Removed from saved items': 'أُزيل من المحفوظات', 'Saved — we’ll tell you if the price drops': 'تم الحفظ، وسنخبرك إذا انخفض السعر', 'Notifications': 'الإشعارات', 'Turn on notifications': 'فعّل الإشعارات', 'Turn off': 'أوقف', 'On — you’ll get order updates and messages on this phone.': 'مفعّلة: ستصلك تحديثات الطلبات والرسائل على هذا الهاتف.', 'Get order updates and messages on this phone.': 'استقبل تحديثات الطلبات والرسائل على هذا الهاتف.', 'Blocked in your browser settings. Allow notifications for kinan.shop to turn them on.': 'محظورة في إعدادات المتصفح. اسمح بإشعارات kinan.shop لتفعيلها.', 'On iPhone, add Kinan to your home screen first, then turn notifications on from the app.': 'في آيفون أضف كنان إلى الشاشة الرئيسية أولاً، ثم فعّل الإشعارات من التطبيق.', 'This browser cannot show notifications.': 'هذا المتصفح لا يدعم الإشعارات.', 'How to add to home screen': 'كيف تضيفه إلى الشاشة الرئيسية', 'Notifications are on': 'تم تفعيل الإشعارات', 'Notifications are off': 'تم إيقاف الإشعارات', 'Messages': 'الرسائل', 'Kinan support': 'دعم كنان', 'You': 'أنت', 'Write a message': 'اكتب رسالة', 'Send': 'إرسال', 'Questions about this order? Write to Kinan support or the shop.': 'لديك سؤال عن هذا الطلب؟ اكتب لدعم كنان أو للمتجر.', 'Help on WhatsApp': 'المساعدة عبر واتساب', 'No messages yet. Customers can write to you about this order.': 'لا توجد رسائل بعد. يمكن للعملاء مراسلتك بخصوص هذا الطلب.', 'Write to the customer': 'اكتب للعميل', 'Invoice': 'الفاتورة', 'Upload a spreadsheet': 'رفع ملف جدول', 'Many products at once from Excel or Google Sheets (saved as CSV).': 'منتجات كثيرة دفعة واحدة من Excel أو Google Sheets (بصيغة CSV).', 'Download template': 'تحميل النموذج', 'Choose CSV file': 'اختر ملف CSV', 'Last 30 days': 'آخر 30 يوماً', 'Views': 'المشاهدات', 'Conversion': 'التحويل', 'Views of your products will appear here.': 'ستظهر هنا مشاهدات منتجاتك.', 'Product': 'المنتج', 'We use cookies to understand how Kinan is used and to improve it.': 'نستخدم ملفات تعريف الارتباط لفهم استخدام كنان وتحسينه.', 'Accept': 'موافق', 'Only necessary': 'الضرورية فقط', 'Download for': 'حمّل لـ', 'Open Kinan Shop in the browser': 'افتح متجر كنان في المتصفح', 'Open Kinan Seller in the browser': 'افتح كنان للبائعين في المتصفح', 'Install': 'تثبيت', 'Copy link': 'نسخ الرابط', 'Free for Android and iPhone. Tap Download for your phone — it installs in seconds and updates itself.': 'مجاني لأندرويد وآيفون. اضغط تحميل لهاتفك، ويتثبت خلال ثوانٍ ويتحدث تلقائياً.', 'Waiting for your phone to allow one-tap install…': 'بانتظار هاتفك للسماح بالتثبيت بضغطة واحدة…', 'On iPhone, apps are added from <b>Safari</b>. Copy the link and open it in Safari.': 'في آيفون تُضاف التطبيقات من Safari. انسخ الرابط وافتحه في Safari.', 'Link copied — paste it in Safari': 'تم نسخ الرابط، الصقه في Safari', 'kinan.shop · Free': 'kinan.shop · مجاني', 'Search products or shops': 'ابحث عن منتجات أو متاجر', 'Search': 'بحث', 'Recent searches': 'عمليات البحث الأخيرة', 'Clear': 'مسح', "Where should we deliver?": "إلى أين نوصل طلبك؟", "Choose your country to see the full price with shipping, in your currency.": "اختر بلدك لترى السعر الكامل مع الشحن بعملتك.", "Language": "اللغة", "The app and our emails use this language.": "يستخدم التطبيق ورسائلنا الإلكترونية هذه اللغة.", "The Seller Center and Kinan’s emails to you use this language.": "يستخدم مركز البائعين ورسائل كنان إليك هذه اللغة.", "Verify your identity": "وثّق هويتك", "To keep Kinan safe for customers, every seller confirms who they are before opening a shop. It takes about 3 minutes.": "للحفاظ على أمان كنان للعملاء، يؤكد كل بائع هويته قبل فتح متجره. يستغرق ذلك نحو 3 دقائق.", "1 · Your details": "1 · بياناتك", "2 · Your shop": "2 · متجرك", "3 · ID document": "3 · وثيقة الهوية", "4 · Live selfie": "4 · سيلفي مباشر", "Your details": "بياناتك", "Your shop": "متجرك", "Identity document": "وثيقة الهوية", "Live selfie": "سيلفي مباشر", "Full name (as on your document)": "الاسم الكامل (كما في الوثيقة)", "Date of birth": "تاريخ الميلاد", "Nationality": "الجنسية", "Phone number (with country code)": "رقم الهاتف (مع رمز الدولة)", "Country you live in": "بلد الإقامة", "Individual": "فرد", "Company": "شركة", "Company name": "اسم الشركة", "Registration number": "رقم السجل التجاري", "What will you sell?": "ماذا ستبيع؟", "Document type": "نوع الوثيقة", "Document number": "رقم الوثيقة", "Expiry date": "تاريخ الانتهاء", "Passport": "جواز سفر", "National ID card": "بطاقة هوية وطنية", "Residence permit": "إقامة", "Driving licence": "رخصة قيادة", "Take clear photos of the whole document: all 4 corners visible, no glare, text readable.": "التقط صوراً واضحة للوثيقة كاملة: الزوايا الأربع ظاهرة، بلا انعكاس، والنص مقروء.", "Photo page / front": "صفحة الصورة / الوجه الأمامي", "Photo page": "صفحة الصورة", "Front side": "الوجه الأمامي", "Back side": "الوجه الخلفي", "Take or choose photo": "التقط أو اختر صورة", "Take a selfie now with your camera so we can match your face to your document. Face the camera in good light, without glasses or a hat.": "التقط صورة سيلفي الآن بكاميرتك لنطابق وجهك مع الوثيقة. انظر إلى الكاميرا في إضاءة جيدة، بلا نظارة أو قبعة.", "Open camera": "افتح الكاميرا", "Take selfie": "التقط السيلفي", "Retake": "أعد الالتقاط", "Use phone camera": "استخدم كاميرا الهاتف", "Send for approval": "أرسل للموافقة", "Sending…": "جارٍ الإرسال…", "Sent to Kinan for approval": "أُرسل إلى كنان للموافقة", "Your application is being reviewed": "طلبك قيد المراجعة", "Check again": "تحقق مرة أخرى", "Please correct your application": "يرجى تصحيح طلبك", "Add a photo of your document.": "أضف صورة لوثيقتك.", "Add a photo of the back of your document.": "أضف صورة للوجه الخلفي من وثيقتك.", "Take your live selfie.": "التقط السيلفي المباشر.", "Please confirm that the information is true.": "يرجى تأكيد صحة المعلومات.", "Tap “Use phone camera” to take your selfie.": "اضغط «استخدم كاميرا الهاتف» لالتقاط السيلفي.", "Calculated for your country at checkout · ships directly with tracking": "يُحسب لبلدك عند الدفع · يُشحن مباشرة مع رقم تتبع", "From CJdropshipping": "من CJdropshipping", "Ships from CJ straight to the customer. Kinan orders and pays CJ for you; shipping is added at checkout.": "يُشحن من CJ مباشرة إلى العميل. كنان تطلب وتدفع لـ CJ عنك، ويُضاف الشحن عند الدفع.", "Search CJ, or paste a CJ link / SKU": "ابحث في CJ، أو الصق رابط منتج CJ أو رمزه", "Search CJ": "ابحث في CJ", "Searching CJ…": "جارٍ البحث في CJ…", "Loading from CJ…": "جارٍ التحميل من CJ…", "CJ cost": "تكلفة CJ", "Choose": "اختر", "Nothing found.": "لا توجد نتائج.", "Your price": "سعرك",
    'Dark mode': 'الوضع الليلي', 'Light mode': 'الوضع النهاري', 'Switch to dark mode': 'التبديل إلى الوضع الليلي', 'Switch to light mode': 'التبديل إلى الوضع النهاري',
    'Terms': 'الشروط', 'Seller Terms': 'شروط البائعين', 'Privacy': 'الخصوصية', 'Legal notice': 'إشعار قانوني', 'Legal': 'قانوني',
    'Something went wrong': 'حدث خطأ ما', 'Back to shop': 'العودة إلى المتجر', 'Back': 'رجوع', 'Try again': 'حاول مرة أخرى', 'Couldn’t load this page': 'تعذّر تحميل هذه الصفحة',
    'Save': 'حفظ', 'Edit': 'تعديل', 'Remove': 'إزالة', 'Cancel': 'إلغاء', 'Continue': 'متابعة', 'Open': 'فتح', 'Apply': 'تطبيق', 'Upload': 'رفع', 'Copy link': 'نسخ الرابط', 'Link copied': 'تم نسخ الرابط',
    'Status': 'الحالة', 'Date': 'التاريخ', 'Amount': 'المبلغ', 'Price': 'السعر', 'Prices': 'الأسعار', 'Stock': 'المخزون', 'Total': 'الإجمالي', 'Subtotal': 'المجموع الفرعي', 'Shipping': 'الشحن', 'Shipping:': 'الشحن:',
    'Name': 'الاسم', 'Email': 'البريد الإلكتروني', 'Password': 'كلمة المرور', 'Phone': 'الهاتف', 'Address': 'العنوان', 'City': 'المدينة', 'Country': 'الدولة', 'Postal code': 'الرمز البريدي',
    'Choose…': 'اختر…', 'Other': 'أخرى', 'All': 'الكل', 'Included': 'مشمول', 'Details': 'التفاصيل', 'Description': 'الوصف', 'Title': 'العنوان', 'Photos': 'الصور', 'Reason': 'السبب', 'Link': 'الرابط',
    'Sign in': 'تسجيل الدخول', 'Sign out': 'تسجيل الخروج', 'Signed out': 'تم تسجيل الخروج', 'Signed in': 'تم تسجيل الدخول', 'Create account': 'إنشاء حساب', 'Continue with Google': 'المتابعة باستخدام Google', 'or with email': 'أو بالبريد الإلكتروني',
    'Forgot your password?': 'نسيت كلمة المرور؟', 'Sign in to Kinan': 'تسجيل الدخول إلى كنان', 'Create your Kinan account': 'أنشئ حسابك في كنان', 'Welcome to Kinan': 'أهلاً بك في كنان',
    'At least 8 characters. By creating an account you agree to the': '8 أحرف على الأقل. بإنشاء الحساب فإنك توافق على', 'Terms of Service': 'شروط الخدمة', 'and': 'و', 'Privacy Policy': 'سياسة الخصوصية',
    'Install': 'تثبيت', 'Install app': 'تثبيت التطبيق', 'Add to Home Screen': 'إضافة إلى الشاشة الرئيسية', 'Add to Home screen': 'إضافة إلى الشاشة الرئيسية',
    // ---- shop: home & browse ----
    'Products from China’s biggest marketplace, shipped to your door.': 'منتجات من أكبر سوق في الصين، تصلك حتى باب بيتك.',
    'Shop many Kinan sellers in one cart. We buy every item on Taobao, check it at our warehouse in China, pack your order into one parcel and ship it with tracking.': 'تسوّق من عدة بائعين في كنان بسلة واحدة. نشتري كل منتج من تاوباو، ونفحصه في مستودعنا في الصين، ونجمع طلبك في طرد واحد ونشحنه مع رقم تتبع.',
    'You order': 'أنت تطلب', 'We buy on Taobao': 'نشتري من تاوباو', 'Checked in our China warehouse': 'نفحصه في مستودعنا في الصين', 'Delivered to you': 'يصلك إلى بابك',
    'Shops': 'المتاجر', 'See all': 'عرض الكل', 'All products': 'كل المنتجات', 'Products': 'المنتجات', 'Can’t find it? Request an item': 'لم تجد ما تريد؟ اطلب منتجاً',
    'Newest': 'الأحدث', 'Price: low to high': 'السعر: من الأقل للأعلى', 'Price: high to low': 'السعر: من الأعلى للأقل', 'Sort': 'الترتيب', 'Min $': 'أدنى $', 'Max $': 'أعلى $', 'Min €': 'أدنى €', 'Max €': 'أعلى €', 'Min £': 'أدنى £', 'Max £': 'أعلى £', 'Minimum price': 'أدنى سعر', 'Maximum price': 'أعلى سعر',
    'No products match': 'لا توجد منتجات مطابقة', 'Try a different word or price range — or ask us to find it for you.': 'جرّب كلمة أو نطاق سعر مختلف، أو اطلب منا أن نجده لك.',
    'New products are on the way': 'منتجات جديدة في الطريق', 'Sellers are adding their first items. Check back soon.': 'البائعون يضيفون منتجاتهم الأولى. عُد قريباً.', 'Request an item': 'اطلب منتجاً',
    'Independent Kinan sellers. Mix products from any of them in one cart.': 'بائعون مستقلون على كنان. اجمع منتجات من أيٍّ منهم في سلة واحدة.', 'No shops yet': 'لا توجد متاجر بعد', 'Sellers are setting up. Check back soon.': 'البائعون يجهّزون متاجرهم. عُد قريباً.',
    'Return policy': 'سياسة الإرجاع', 'Returns': 'الإرجاع', 'This shop has no products right now': 'لا توجد منتجات في هذا المتجر حالياً',
    // categories
    'Women’s fashion': 'أزياء نسائية', 'Men’s fashion': 'أزياء رجالية', 'Kids & baby': 'أطفال ورضّع', 'Shoes & bags': 'أحذية وحقائب', 'Beauty & care': 'جمال وعناية', 'Home & kitchen': 'المنزل والمطبخ',
    'Electronics': 'إلكترونيات', 'Phone accessories': 'إكسسوارات الهاتف', 'Sports & outdoors': 'رياضة وخارج المنزل', 'Toys & games': 'ألعاب', 'Car accessories': 'إكسسوارات السيارات', 'Category': 'القسم',
    // ---- product ----
    'Sold by': 'يبيعه', 'Option': 'الخيار', 'Quantity': 'الكمية', 'Less': 'أقل', 'More': 'أكثر', 'In stock': 'متوفر', 'Out of stock': 'غير متوفر', 'Add to cart': 'أضف إلى السلة', 'Buy now': 'اشترِ الآن', 'Added to cart': 'أُضيف إلى السلة',
    'Buying & checking in China': 'الشراء والفحص في الصين', 'International shipping': 'الشحن الدولي', '3–7 days': '3–7 أيام', '7–15 days': '7–15 يوماً',
    'Every item is inspected at our China warehouse before it ships to you. You get a tracking number as soon as your parcel leaves.': 'نفحص كل منتج في مستودعنا في الصين قبل شحنه إليك، وتحصل على رقم تتبع فور خروج الطرد.',
    'Ships directly from the supplier': 'يُشحن مباشرة من المورّد', 'Tracking': 'التتبع',
    'This item is sent straight from the supplier to your address in its own parcel, so it arrives separately from items checked at our warehouse.': 'يُرسل هذا المنتج مباشرة من المورّد إلى عنوانك في طرد مستقل، لذا يصل منفصلاً عن المنتجات التي نفحصها في مستودعنا.',
    'Priced by weight and country at checkout — items from several shops ship together': 'يُحسب حسب الوزن والدولة عند الدفع — منتجات المتاجر المختلفة تُشحن معاً',
    'About this product': 'عن هذا المنتج', 'All products ': 'كل المنتجات',
    // ---- cart & checkout ----
    'Your cart is empty': 'سلتك فارغة', 'Find something you like and add it here.': 'اعثر على شيء يعجبك وأضفه هنا.', 'Browse products': 'تصفّح المنتجات', 'Nothing left in your cart': 'لم يبقَ شيء في سلتك',
    'Check out': 'إتمام الشراء', 'Keep shopping': 'متابعة التسوق', 'At checkout': 'عند الدفع', 'Ships direct': 'شحن مباشر',
    'Items from different shops are packed together and arrive in one parcel.': 'منتجات المتاجر المختلفة تُجمع وتصلك في طرد واحد.',
    'Items marked “Ships direct” come straight from the supplier in a separate parcel. Everything else is packed together at our warehouse.': 'المنتجات المعلّمة بـ "شحن مباشر" تصل من المورّد في طرد مستقل، وباقي المنتجات تُجمع معاً في مستودعنا.',
    'Delivery address': 'عنوان التوصيل', 'Full name': 'الاسم الكامل', 'Street and number': 'الشارع والرقم', 'Apartment, building (optional)': 'الشقة أو المبنى (اختياري)', 'State / province (optional)': 'المنطقة / المحافظة (اختياري)',
    'Continue to payment': 'المتابعة إلى الدفع', 'Placing order…': 'جارٍ إنشاء الطلب…', 'Choose a country': 'اختر الدولة',
    'Your address is only shared with Kinan’s shipping team. Sellers and suppliers never see it. By placing your order you agree to the': 'لا يُشارك عنوانك إلا مع فريق الشحن في كنان، ولا يراه البائعون أو الموردون أبداً. بإتمام الطلب فإنك توافق على',
    '; import taxes may apply in your country.': '؛ وقد تُطبَّق ضرائب استيراد في بلدك.',
    // ---- payment ----
    'Payment': 'الدفع', 'Test mode': 'وضع التجربة', 'Card payments are not switched on yet. Use the test payment to try the full order flow — no money is charged.': 'الدفع بالبطاقة غير مفعّل بعد. استخدم الدفع التجريبي لتجربة الطلب كاملاً — دون خصم أي مبلغ.',
    'Pay later — the order stays in your orders': 'ادفع لاحقاً — يبقى الطلب في طلباتك', 'Payment received': 'تم استلام الدفعة', 'Pay with wallet': 'ادفع من المحفظة', 'Paid from your wallet': 'تم الدفع من محفظتك',
    'Wallet balance:': 'رصيد المحفظة:', 'Not enough for this order': 'الرصيد لا يكفي لهذا الطلب', 'Card payments are not configured yet. Please try again later.': 'الدفع بالبطاقة غير مُعدّ بعد. حاول لاحقاً.',
    'Could not load the payment form. Check your connection.': 'تعذّر تحميل نموذج الدفع. تحقق من اتصالك.',
    // ---- orders ----
    'Your orders': 'طلباتك', 'No orders yet': 'لا توجد طلبات بعد', 'When you place an order, you can follow it here.': 'عندما تطلب، يمكنك متابعة طلبك من هنا.', 'Start shopping': 'ابدأ التسوق',
    'Awaiting payment': 'بانتظار الدفع', 'Paid': 'مدفوع', 'Buying from supplier': 'جارٍ الشراء من المورّد', 'At our China warehouse soon': 'في الطريق إلى مستودعنا في الصين', 'Packed, ready to ship': 'مُغلّف وجاهز للشحن',
    'Shipped': 'تم الشحن', 'Delivered': 'تم التوصيل', 'Cancelled': 'ملغى', 'Refunded': 'تم الاسترداد', 'Being reviewed': 'قيد المراجعة',
    'This order is waiting for payment.': 'هذا الطلب بانتظار الدفع.', 'Pay now': 'ادفع الآن', 'Progress': 'مراحل الطلب', 'Cancel order': 'إلغاء الطلب', 'Order cancelled': 'تم إلغاء الطلب',
    'Order confirmed': 'تم تأكيد الطلب', 'Purchased from Taobao': 'تم الشراء من تاوباو', 'On its way to our China warehouse': 'في الطريق إلى مستودعنا في الصين', 'Arrived, checked and consolidated': 'وصل وتم فحصه وتجميعه',
    'Dispatched — in transit to you': 'تم الإرسال — في الطريق إليك', 'Ordered from the supplier': 'تم الطلب من المورّد', 'On its way to you': 'في الطريق إليك', 'Delivery': 'التوصيل',
    'Shipped directly from the supplier': 'يُشحن مباشرة من المورّد', 'Being ordered': 'جارٍ الطلب', 'Ordered — preparing': 'تم الطلب — قيد التجهيز', 'You’ll get a tracking number as soon as it ships.': 'ستحصل على رقم تتبع فور شحنه.',
    'Paid from your Kinan wallet': 'دُفع من محفظتك في كنان', 'Pay from wallet': 'ادفع من المحفظة',
    // returns
    'Request a return': 'طلب إرجاع', 'Arrived damaged': 'وصل تالفاً', 'Wrong item': 'منتج خاطئ', 'Not as described': 'لا يطابق الوصف', 'Missing parts': 'أجزاء ناقصة', 'Changed my mind': 'غيّرت رأيي',
    'Tell us what happened': 'أخبرنا بما حدث', 'Photos (optional, up to 3)': 'صور (اختياري، حتى 3)', 'Add photos': 'إضافة صور', 'Send request': 'إرسال الطلب', 'Return request sent': 'تم إرسال طلب الإرجاع',
    'Return requested': 'طُلب الإرجاع', 'Return approved': 'تمت الموافقة على الإرجاع', 'Return declined': 'رُفض الإرجاع', 'Kinan:': 'كنان:',
    // ---- account, wallet, requests ----
    'Kinan customer': 'عميل كنان', 'Wallet': 'المحفظة', 'Refunds and shipping differences': 'المبالغ المستردة وفروقات الشحن', 'Ask us for a Taobao product that isn’t in the shop': 'اطلب منا منتجاً من تاوباو غير موجود في المتجر',
    'Get the Kinan Shop app': 'حمّل تطبيق متجر كنان', 'Install Kinan Shop': 'ثبّت متجر كنان', 'Step-by-step guide for Android and iPhone': 'شرح خطوة بخطوة لأندرويد وآيفون',
    'Install Kinan Shop on your phone’s home screen. On iPhone: tap Share, then “Add to Home Screen”. On Android: tap the menu, then “Install app”.': 'ثبّت متجر كنان على الشاشة الرئيسية لهاتفك. في آيفون: اضغط مشاركة ثم "إضافة إلى الشاشة الرئيسية". في أندرويد: اضغط القائمة ثم "تثبيت التطبيق".',
    'Want to sell on Kinan?': 'تريد البيع على كنان؟', 'Open the Seller Center': 'افتح مركز البائعين', 'Available balance': 'الرصيد المتاح', 'History': 'السجل', 'No transactions yet.': 'لا توجد معاملات بعد.',
    'Refunds from cancelled orders and shipping differences after your parcel is weighed are added here. You can use the balance to pay for your next order.': 'تُضاف هنا المبالغ المستردة من الطلبات الملغاة وفروقات الشحن بعد وزن طردك. يمكنك استخدام الرصيد لدفع طلبك القادم.',
    'Found something on Taobao or Tmall that isn’t in Kinan Shop? Send us the link and we’ll get back to you with a price.': 'وجدت شيئاً على تاوباو أو تيمول غير موجود في متجر كنان؟ أرسل لنا الرابط وسنرد عليك بالسعر.',
    'Taobao or Tmall link': 'رابط تاوباو أو تيمول', 'Details (size, colour, anything we should know)': 'التفاصيل (المقاس، اللون، أي شيء يهمنا معرفته)', 'Your requests': 'طلباتك', 'No requests yet.': 'لا توجد طلبات بعد.', 'Request sent': 'تم إرسال الطلب',
    'Waiting for reply': 'بانتظار الرد', 'Price offered': 'تم تقديم سعر', 'Now in the shop': 'متوفر الآن في المتجر', 'Not available': 'غير متوفر', 'View product': 'عرض المنتج',
    // ---- reset page ----
    'Forgot your password? ': 'نسيت كلمة المرور؟', 'Enter the email of your Kinan account and we’ll send you a link to choose a new password.': 'أدخل بريد حسابك في كنان وسنرسل لك رابطاً لاختيار كلمة مرور جديدة.',
    'Send reset link': 'إرسال رابط إعادة التعيين', 'Back to sign in': 'العودة لتسجيل الدخول', 'Check your email': 'تحقق من بريدك', 'Choose a new password': 'اختر كلمة مرور جديدة', 'New password': 'كلمة المرور الجديدة', 'Repeat it': 'أعد كتابتها',
    'At least 8 characters. You’ll be signed out on other devices.': '8 أحرف على الأقل. سيتم تسجيل خروجك من الأجهزة الأخرى.', 'Save password': 'حفظ كلمة المرور', 'Password saved': 'تم حفظ كلمة المرور', 'You’re signed in.': 'تم تسجيل دخولك.',
    'Email isn’t switched on for Kinan yet — ask Kinan support for a reset link.': 'البريد غير مفعّل في كنان بعد — اطلب رابط إعادة التعيين من دعم كنان.', 'The two passwords don’t match': 'كلمتا المرور غير متطابقتين',
    // ---- download page ----
    'Get the Kinan apps': 'حمّل تطبيقات كنان', 'Free for Android and iPhone. No app store needed — install straight from your browser in a few seconds. Apps update themselves automatically.': 'مجانية لأندرويد وآيفون. لا حاجة لمتجر تطبيقات — ثبّتها من متصفحك في ثوانٍ، وتتحدث تلقائياً.',
    'Kinan Shop': 'متجر كنان', 'Kinan Seller': 'كنان للبائعين', 'For customers': 'للعملاء', 'For sellers': 'للبائعين', 'Shop many sellers in one cart': 'تسوّق من عدة بائعين بسلة واحدة', 'Pay by card or wallet': 'ادفع بالبطاقة أو المحفظة',
    'Track every step to your door': 'تابع كل خطوة حتى بابك', 'Import products from Taobao': 'استورد المنتجات من تاوباو', 'Track orders and earnings': 'تابع الطلبات والأرباح', 'Manage your shop from your phone': 'أدِر متجرك من هاتفك',
    'Open Kinan Shop': 'افتح متجر كنان', 'Open Kinan Seller': 'افتح كنان للبائعين', 'How to install': 'طريقة التثبيت', 'Full screen': 'ملء الشاشة', 'Opens like a normal app, without the browser bar.': 'يفتح كتطبيق عادي، بدون شريط المتصفح.',
    'Always up to date': 'محدّث دائماً', 'New features arrive by themselves.': 'الميزات الجديدة تصلك تلقائياً.', 'Light on storage': 'خفيف على الذاكرة', 'Takes almost no space on your phone.': 'لا يكاد يشغل مساحة على هاتفك.',
    'Chrome may also show an “Install” banner at the bottom — tapping it does the same.': 'قد يُظهر Chrome أيضاً شريط "تثبيت" في الأسفل — الضغط عليه يؤدي نفس الغرض.',
    // ---- seller center ----
    'Dashboard': 'الرئيسية', 'Add': 'إضافة', 'Add product': 'إضافة منتج', 'Earnings': 'الأرباح', 'Settings': 'الإعدادات', 'Kinan Seller Center': 'مركز بائعي كنان',
    'Here’s what needs your attention today.': 'إليك ما يحتاج انتباهك اليوم.', 'Recent orders': 'أحدث الطلبات', 'Live products': 'المنتجات المعروضة', 'Live': 'معروض', 'In review': 'قيد المراجعة', 'Needs changes': 'يحتاج تعديلات', 'Paused': 'متوقف',
    'Unavailable on Taobao': 'غير متوفر على تاوباو', 'Pause': 'إيقاف', 'Go live': 'اعرضه الآن', 'Refresh': 'تحديث', 'Refreshing…': 'جارٍ التحديث…', 'Cost and stock updated': 'تم تحديث التكلفة والمخزون', 'Added manually': 'أُضيف يدوياً',
    'AliExpress · ships direct': 'علي إكسبرس · شحن مباشر', 'No products yet': 'لا توجد منتجات بعد', 'Nothing in this list': 'لا شيء في هذه القائمة', 'Paste a Taobao link to import your first product.': 'الصق رابط تاوباو لاستيراد أول منتج.',
    'New products and changes to titles, descriptions or photos are reviewed by Kinan before buyers see them. Price changes go live right away.': 'تراجع كنان المنتجات الجديدة وأي تغيير في العناوين أو الأوصاف أو الصور قبل أن يراها المشترون. تغييرات الأسعار تظهر فوراً.',
    'Choose where your product comes from.': 'اختر مصدر منتجك.', 'From Taobao': 'من تاوباو', 'From AliExpress': 'من علي إكسبرس', 'Add manually': 'إضافة يدوية', 'Import product': 'استيراد المنتج', 'Import from AliExpress': 'استيراد من علي إكسبرس',
    'Ships to Kinan’s China warehouse, is checked, then sent with the customer’s other items.': 'يُشحن إلى مستودع كنان في الصين، ويُفحص، ثم يُرسل مع باقي منتجات العميل.',
    'Import by link needs a Taobao Distribution account. No account?': 'الاستيراد بالرابط يحتاج حساب توزيع في تاوباو. ليس لديك حساب؟', 'Add it manually': 'أضفه يدوياً', 'instead.': 'بدلاً من ذلك.', 'Connect Taobao': 'اربط تاوباو',
    'Add AliExpress product': 'إضافة منتج من علي إكسبرس', 'Any Taobao item — type it in yourself. Kinan buys it when it sells.': 'أي منتج من تاوباو — أدخله بنفسك، وتشتريه كنان عند بيعه.', 'No Taobao account needed.': 'لا يلزم حساب تاوباو.',
    'You can also paste just the product ID.': 'يمكنك أيضاً لصق رقم المنتج فقط.', 'Fetching from Taobao…': 'جارٍ الجلب من تاوباو…', 'Fetching from AliExpress…': 'جارٍ الجلب من علي إكسبرس…',
    'Add a product manually': 'إضافة منتج يدوياً', 'Edit product': 'تعديل المنتج', 'Where does it come from?': 'من أين يأتي المنتج؟', 'Taobao': 'تاوباو', 'AliExpress': 'علي إكسبرس', 'AliExpress link': 'رابط علي إكسبرس', 'Taobao / Tmall link': 'رابط تاوباو / تيمول',
    'Paste the product link or share text': 'الصق رابط المنتج أو نص المشاركة', 'Only Kinan sees this — we use it to buy the item when it sells.': 'لا يرى هذا إلا كنان — نستخدمه لشراء المنتج عند بيعه.', 'Title (shown to customers)': 'العنوان (يظهر للعملاء)',
    'Up to 6. Use your own photos or ones you have the right to use.': 'حتى 6 صور. استخدم صورك أو صوراً يحق لك استخدامها.', 'No photos yet': 'لا توجد صور بعد', 'Remove photo': 'حذف الصورة', 'Options and prices': 'الخيارات والأسعار',
    'One row per size or colour. Your cost is optional and private — it helps Kinan check your margin.': 'سطر لكل مقاس أو لون. التكلفة اختيارية وخاصة — تساعد كنان على مراجعة هامش ربحك.', 'Option (optional)': 'الخيار (اختياري)', '+ Add option': '+ إضافة خيار', 'Remove option': 'حذف الخيار',
    'Weight per item (kg)': 'وزن القطعة (كغ)', 'Used to price shipping. Leave empty to use 0.5 kg.': 'يُستخدم لحساب الشحن. اتركه فارغاً ليُحسب 0.5 كغ.', 'Submit for review': 'إرسال للمراجعة', 'Save changes': 'حفظ التغييرات', 'Saving…': 'جارٍ الحفظ…',
    'Kinan reviews new products before customers see them.': 'تراجع كنان المنتجات الجديدة قبل أن يراها العملاء.', 'Sent to Kinan for review': 'أُرسل إلى كنان للمراجعة', 'Saved': 'تم الحفظ', 'Choose a category': 'اختر القسم', 'Could not read that image': 'تعذّرت قراءة الصورة',
    'Title buyers will see': 'العنوان الذي يراه المشترون', 'Write a clear English title. Taobao titles are often in Chinese and full of keywords.': 'اكتب عنواناً واضحاً. عناوين تاوباو غالباً بالصينية ومليئة بالكلمات المفتاحية.', 'Material, size, what’s in the box…': 'الخامة، المقاس، محتويات العلبة…',
    'I own these photos or have permission to use them.': 'أملك هذه الصور أو لدي إذن باستخدامها.', 'Markup': 'نسبة الربح', 'Apply to all': 'تطبيق على الكل', 'Kinan asked for changes': 'طلبت كنان تعديلات', 'Kinan’s note:': 'ملاحظة كنان:',
    'Paid orders for your products appear here.': 'تظهر هنا الطلبات المدفوعة لمنتجاتك.', 'No orders yet. Once buyers order your products, they appear here.': 'لا توجد طلبات بعد. ستظهر هنا عندما يطلب المشترون منتجاتك.', 'Pay Taobao': 'ادفع لتاوباو', 'Payment sent to Taobao': 'تم إرسال الدفعة إلى تاوباو',
    'On the way (order not delivered yet)': 'في الطريق (الطلب لم يُسلَّم بعد)', 'Available to withdraw': 'متاح للسحب', 'Withdrawal in progress': 'سحب قيد التنفيذ', 'Withdrawn': 'تم سحبه', 'Withdraw': 'سحب الأرباح',
    'Bank (IBAN)': 'بنك (IBAN)', 'Wise': 'Wise', 'PayPal': 'PayPal', 'Account holder': 'صاحب الحساب', 'BIC / SWIFT (optional)': 'BIC / SWIFT (اختياري)', 'Account email': 'بريد الحساب', 'Request withdrawal': 'طلب سحب', 'Withdrawal requested': 'تم طلب السحب',
    'Requested': 'مطلوب', 'Sent': 'أُرسل', 'Declined': 'مرفوض', 'To': 'إلى', 'Order': 'الطلب', 'Sales': 'المبيعات', 'Kinan commission': 'عمولة كنان', 'Cost': 'التكلفة', 'You earn': 'ربحك', 'Refund': 'استرداد', 'No earnings yet.': 'لا توجد أرباح بعد.',
    'On the way': 'في الطريق', 'Available': 'متاح', 'Paid out': 'تم الدفع', 'Shop': 'المتجر', 'Shop name': 'اسم المتجر', 'Shop logo': 'شعار المتجر', 'Shop description': 'وصف المتجر',
    'Square PNG, JPEG or WebP. Shown to customers in Kinan Shop.': 'صورة مربعة PNG أو JPEG أو WebP، تظهر للعملاء في متجر كنان.', 'What you sell and why customers will love it': 'ماذا تبيع ولماذا سيحبه العملاء',
    'Shown on your shop page and on every product. Keep it clear — international returns are expensive.': 'تظهر في صفحة متجرك وفي كل منتج. اجعلها واضحة — الإرجاع الدولي مكلف.', 'Default markup on Taobao cost (%)': 'نسبة الربح الافتراضية على تكلفة تاوباو (%)',
    'Pay Taobao automatically': 'الدفع لتاوباو تلقائياً', 'Each purchase order is paid from your Distribution account balance as soon as it’s created, so you never miss a deadline.': 'يُدفع كل أمر شراء من رصيد حساب التوزيع فور إنشائه، فلا يفوتك أي موعد.',
    'Settings saved': 'تم حفظ الإعدادات', 'Your shop in Kinan Shop': 'متجرك في متجر كنان', 'See your store the way customers do.': 'شاهد متجرك كما يراه العملاء.', 'View shop': 'عرض المتجر', 'Install the app': 'ثبّت التطبيق', 'Install Seller Center': 'ثبّت مركز البائعين',
    'Add the Seller Center to your phone’s home screen. On iPhone: Share, then “Add to Home Screen”. On Android: menu, then “Install app”.': 'أضف مركز البائعين إلى الشاشة الرئيسية. في آيفون: مشاركة ثم "إضافة إلى الشاشة الرئيسية". في أندرويد: القائمة ثم "تثبيت التطبيق".',
    'Connect your Taobao account': 'اربط حساب تاوباو', 'Taobao account connected': 'تم ربط حساب تاوباو', 'Reconnect': 'إعادة الربط', 'Sign in to sell on Kinan': 'سجّل الدخول للبيع على كنان', 'Open your Kinan shop': 'افتح متجرك على كنان', 'Open a shop': 'افتح متجراً',
    'Tap': 'اضغط', '), then': ')، ثم', 'Kinan buys AliExpress and manually added products for you.': 'تشتري كنان منتجات علي إكسبرس والمنتجات المضافة يدوياً نيابةً عنك.', 'Standard': 'عادي',
    'For products imported from Taobao, Kinan creates a purchase order from your account.': 'للمنتجات المستوردة من تاوباو، تنشئ كنان أمر شراء من حسابك.', 'Pay each one before its deadline.': 'ادفع كلاً منها قبل موعده.', 'Automatic payment is on.': 'الدفع التلقائي مفعّل.',
    'To buy by hand on Taobao': 'ستشتريه كنان من تاوباو', 'Bought — waiting for Taobao to ship': 'تم الشراء — بانتظار شحن تاوباو', 'Shipped to warehouse': 'شُحن إلى المستودع',
    'Track parcel': 'تتبّع الطرد', 'Share': 'مشاركة', 'Link copied — paste it anywhere': 'تم نسخ الرابط — الصقه في أي مكان',
    'Your name': 'اسمك', 'Seller': 'البائع', 'Seller Center': 'مركز البائعين', 'Shop ': 'المتجر', 'Go to the Kinan store': 'اذهب إلى متجر كنان', 'Hello,': 'مرحباً،',
    // ---- more ----
    "Add the title, photos and price yourself; Kinan orders it on AliExpress when it sells.": "أدخل العنوان والصور والسعر بنفسك، وتطلبه كنان من علي إكسبرس عند بيعه.",
    "Add at least one photo of your own for this product.": "أضف صورة واحدة على الأقل من صورك لهذا المنتج.",
    "Authorization expires soon — reconnect to keep orders flowing.": "تنتهي صلاحية الربط قريباً — أعد الربط لتستمر الطلبات.",
    "Available to pay out": "متاح للصرف",
    "Buyer names and addresses stay private. Taobao ships to Kinan’s China warehouse, and we ship to the buyer.": "أسماء المشترين وعناوينهم تبقى سرية. تاوباو يشحن إلى مستودع كنان في الصين، ونحن نشحن إلى المشتري.",
    "Buyer preview": "معاينة المشتري",
    "Commission:": "العمولة:",
    "Confirm that you own the photos, or remove them.": "أكّد أنك تملك الصور، أو احذفها.",
    "Every option needs a price.": "كل خيار يحتاج سعراً.",
    "Kinan creates a Taobao purchase order from your account for every paid order.": "تنشئ كنان أمر شراء في تاوباو من حسابك لكل طلب مدفوع.",
    "Kinan reviews new sellers before they can publish. Meanwhile, connect your Taobao account and prepare products.": "تراجع كنان البائعين الجدد قبل أن يتمكنوا من النشر. في الأثناء، اربط حساب تاوباو وجهّز منتجاتك.",
    "Margin": "الهامش",
    "No photo": "لا توجد صورة",
    "Order updated": "تم تحديث الطلب",
    "Photo links must start with https://": "يجب أن تبدأ روابط الصور بـ https://",
    "Placed": "تاريخ الطلب",
    "Prices updated": "تم تحديث الأسعار",
    "Product not found": "المنتج غير موجود",
    "Refresh cost and stock from Taobao": "تحديث التكلفة والمخزون من تاوباو",
    "Reset password — Kinan": "إعادة تعيين كلمة المرور — كنان",
    "Kinan Shop — Shop from China": "متجر كنان — تسوّق من الصين",
    "Taobao cost": "تكلفة تاوباو",
    "Tap Share": "اضغط مشاركة",
    "Tap the menu": "اضغط القائمة",
    "This item comes from Taobao’s general catalog, so its Taobao photos can’t be used. Add your own photos — buyers won’t see the product without them.": "هذا المنتج من كتالوج تاوباو العام، فلا يمكن استخدام صوره. أضف صورك — لن يرى المشترون المنتج بدونها.",
    "Unpaid purchase orders are closed by Taobao at the deadline and the buyer is refunded.": "يغلق تاوباو أوامر الشراء غير المدفوعة عند انتهاء المهلة، ويُعاد المبلغ للمشتري.",
    "You already have this product — opening it": "لديك هذا المنتج مسبقاً — جارٍ فتحه",
    "You need a Taobao Distribution Platform account to import products. Kinan buys each order from your account and ships it to our China warehouse.": "تحتاج حساباً في منصة توزيع تاوباو لاستيراد المنتجات. تشتري كنان كل طلب من حسابك وتشحنه إلى مستودعنا في الصين.",
    "Your parcel weighed more than estimated. Extra shipping:": "وزن طردك أكثر من المتوقع. شحن إضافي:",
    "Your price": "سعرك",
    "Your products are hidden from buyers. Contact Kinan support for details.": "منتجاتك مخفية عن المشترين. تواصل مع دعم كنان للتفاصيل.",
    "Your shop is suspended": "متجرك موقوف",
    "Your shop is waiting for approval": "متجرك بانتظار الموافقة",
    "e.g. Black / XL": "مثال: أسود / XL",
    "e.g. Splash-proof fleece-lined tactical jacket": "مثال: جاكيت تكتيكي مبطّن مقاوم للماء",
    "opt.": "اختياري",
    "e.g. Returns accepted within 7 days of delivery only if the item arrives damaged or different from the listing.": "مثال: يُقبل الإرجاع خلال 7 أيام من التوصيل فقط إذا وصل المنتج تالفاً أو مختلفاً عن الوصف.",
    "per item, shipping not included": "للقطعة، دون الشحن",
    "← Add product": "← إضافة منتج",
    "Scroll down, tap": "انزل للأسفل، واضغط",
    "at the bottom of the screen.": "أسفل الشاشة.",
    "at the top right.": "في أعلى الشاشة.",
    "Open the app above in": "افتح التطبيق أعلاه في",
    "on the app above. Use": "على التطبيق أعلاه. استخدم",
    "If an account exists for": "إذا كان هناك حساب مسجّل بـ",
    "wallet": "المحفظة",
    "Android": "أندرويد",
    "iPhone": "آيفون",
    "At least 8 characters. Kinan reviews new shops before they can publish. By opening a shop you agree to the": "8 أحرف على الأقل. تراجع كنان المتاجر الجديدة قبل أن تتمكن من النشر. بفتح متجر فإنك توافق على",
    "Earnings become available when the buyer receives the order. Your earnings are your sale price minus Kinan’s": "تصبح الأرباح متاحة عندما يستلم المشتري طلبه. ربحك هو سعر البيع ناقص عمولة كنان",
    // ---- countries ----
    "Saudi Arabia": "السعودية",
    "United Arab Emirates": "الإمارات",
    "Kuwait": "الكويت",
    "Qatar": "قطر",
    "Bahrain": "البحرين",
    "Oman": "عُمان",
    "Jordan": "الأردن",
    "Iraq": "العراق",
    "Lebanon": "لبنان",
    "Palestine": "فلسطين",
    "Syria": "سوريا",
    "Yemen": "اليمن",
    "Egypt": "مصر",
    "Libya": "ليبيا",
    "Tunisia": "تونس",
    "Algeria": "الجزائر",
    "Morocco": "المغرب",
    "Sudan": "السودان",
    "Mauritania": "موريتانيا",
    "Turkey": "تركيا",
    "Malta": "مالطا",
    "United Kingdom": "المملكة المتحدة",
    "Germany": "ألمانيا",
    "France": "فرنسا",
    "Italy": "إيطاليا",
    "Spain": "إسبانيا",
    "Netherlands": "هولندا",
    "Belgium": "بلجيكا",
    "Sweden": "السويد",
    "Norway": "النرويج",
    "Denmark": "الدنمارك",
    "Austria": "النمسا",
    "Switzerland": "سويسرا",
    "Ireland": "أيرلندا",
    "Poland": "بولندا",
    "Greece": "اليونان",
    "Cyprus": "قبرص",
    "United States": "الولايات المتحدة",
    "Canada": "كندا",
    "Australia": "أستراليا",
    "Malaysia": "ماليزيا",
    "Indonesia": "إندونيسيا",
    "Pakistan": "باكستان",
    // ---- common API errors ----
    'Incorrect email or password': 'البريد أو كلمة المرور غير صحيحة', 'Email is already registered': 'هذا البريد مسجّل مسبقاً', 'Password must be at least 8 characters': 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل', 'Invalid email': 'بريد إلكتروني غير صالح',
    'Please sign in first': 'سجّل الدخول أولاً', 'Too many attempts, try again later': 'محاولات كثيرة، حاول لاحقاً', 'Cart is empty': 'السلة فارغة', 'An item in the cart is no longer available': 'أحد منتجات السلة لم يعد متوفراً', 'Product not available': 'المنتج غير متوفر',
    'Add at least one photo': 'أضف صورة واحدة على الأقل', 'Enter a product title': 'أدخل عنوان المنتج', 'Choose a reason': 'اختر السبب', 'Choose the item(s) you want to return': 'اختر المنتج أو المنتجات التي تريد إرجاعها',
    'This is not a customer account. Sellers sign in at the Seller Center.': 'هذا ليس حساب عميل. يسجّل البائعون الدخول من مركز البائعين.', 'This reset link has expired or was already used. Ask for a new one.': 'انتهت صلاحية رابط إعادة التعيين أو استُخدم مسبقاً. اطلب رابطاً جديداً.',
    'Your wallet balance is not enough for this order': 'رصيد محفظتك لا يكفي لهذا الطلب', 'Enter a valid IBAN': 'أدخل رقم IBAN صحيحاً', 'Enter the account holder name': 'أدخل اسم صاحب الحساب', 'That is more than your available earnings': 'المبلغ أكبر من أرباحك المتاحة',
    'You already have an open return for this order': 'لديك طلب إرجاع مفتوح لهذا الطلب', 'Paste a Taobao link or describe the item': 'الصق رابط تاوباو أو صف المنتج', 'That does not look like a Taobao or Tmall link': 'هذا لا يبدو رابط تاوباو أو تيمول'
  };

  // Text with numbers or names inside
  var PATTERNS = [
    [/^(\d+) products?$/, '$1 منتج'], [/^(\d+) items?$/, '$1 منتج'], [/^(\d+) item\(s\)$/, '$1 منتج'], [/^(\d+) options?$/, '$1 خيار'],
    [/^Only (\d+) left$/, 'بقي $1 فقط'], [/^Hello, (.+)$/, 'مرحباً، $1'], [/^Results for “(.+)”$/, 'نتائج البحث عن "$1"'], [/^Add (.+) to your phone\. It opens full screen like any other app and updates itself\.$/, 'أضف $1 إلى هاتفك. يفتح بملء الشاشة كأي تطبيق ويتحدث تلقائياً.'], [/^(.+) installed$/, 'تم تثبيت $1'], [/^(.+) is installed\. Open it from your home screen\.$/, '$1 مثبّت. افتحه من الشاشة الرئيسية.'], [/^You pay in ([A-Z]{3})\. Prices in other currencies are close estimates, updated daily\.$/, 'تدفع بعملة $1. الأسعار بالعملات الأخرى تقديرية وتُحدَّث يومياً.'], [/^Item (.+) \+ shipping about (.+)$/, 'المنتج $1 + الشحن حوالي $2'], [/^arrives in about$/, 'يصل خلال حوالي'], [/^(\d+)–(\d+) days$/, '$1–$2 يوماً'], [/^Kinan service \((\d+)%\)$/, 'خدمة كنان ($1%)'], [/^Items? × (\d+)$/, 'القطع × $1'], [/^Item$/, 'المنتج'], [/^Estimate: (.+) delivered$/, 'التقدير: $1 شاملاً التوصيل'], [/^Arrives in about (.+) days after we buy it\. Shipping is confirmed by the real weight\.$/, 'يصل خلال حوالي $1 يوماً بعد الشراء. يُثبَّت الشحن حسب الوزن الفعلي.'], [/^Item (\d+)$/, 'منتج $1'], [/^Keep this order up to (\d+) days and ship it in one box with your next orders\. Tap “Ship now” any time\.$/, 'نحتفظ بالطلب حتى $1 يوماً ونشحنه في صندوق واحد مع طلباتك القادمة. اضغط "اشحن الآن" متى شئت.'], [/^(\d+) order\(s\) will ship together$/, 'سيُشحن $1 طلب معاً'], [/^We keep it free until (.+) and ship it in one box with your other stored orders\.$/, 'نحتفظ به مجاناً حتى $1 ونشحنه في صندوق واحد مع طلباتك المخزّنة الأخرى.'], [/^We keep it and ship it in one box with your other stored orders\.$/, 'نحتفظ به ونشحنه في صندوق واحد مع طلباتك المخزّنة الأخرى.'], [/^Invite friends, earn (.+)$/, 'ادعُ أصدقاءك واربح $1'], [/^Share your link\. When a friend’s first order is delivered, we add (.+) to your wallet\. New customers get 10% off their first order with the code WELCOME10\.$/, 'شارك رابطك. عندما يصل أول طلب لصديقك نضيف $1 إلى محفظتك. ويحصل العملاء الجدد على خصم 10% على أول طلب بالكود WELCOME10.'], [/^(\d+) friend\(s\) joined · (.+) earned$/, 'انضم $1 من أصدقائك · ربحت $2'], [/^(.+) applied$/, 'تم تطبيق $1'], [/^(\d+)% off$/, 'خصم $1%'], [/^Price dropped from (.+)$/, 'انخفض السعر من $1'], [/^(\d+) views · (\d+) orders · (.+)$/, '$1 مشاهدة · $2 طلب · $3'], [/^Search for “(.+)”$/, 'ابحث عن "$1"'],
    [/^Prices and payment in US dollars \(USD\)\.$/, 'الأسعار والدفع بالدولار الأمريكي (USD).'], [/^Prices and payment in euros \(EUR\)\.$/, 'الأسعار والدفع باليورو (EUR).'], [/^Prices and payment in pounds sterling \(GBP\)\.$/, 'الأسعار والدفع بالجنيه الإسترليني (GBP).'],
    [/^Order ([A-Z0-9]{8})$/, 'الطلب $1'], [/^Placed (.+)$/, 'تاريخ الطلب $1'], [/^Qty (\d+)$/, 'الكمية $1'], [/^· Qty (\d+)$/, '· الكمية $1'],
    [/^Pay (.+) \(test\)$/, 'ادفع $1 (تجريبي)'], [/^Pay (\S+)$/, 'ادفع $1'], [/^Shipping to (.+)$/, 'الشحن إلى $1'],
    [/^(.+) · On Kinan since (.+)$/, '$1 · على كنان منذ $2'], [/^(\d+) products? · On Kinan since (.+)$/, '$1 منتج · على كنان منذ $2'],
    [/^Ships straight to the customer · about (.+) days\.$/, 'يُشحن مباشرة إلى العميل · خلال $1 يوماً تقريباً.'], [/^(.+) days$/, '$1 يوماً'],
    [/^Ships straight from AliExpress to the customer \(about (.+) days\)\. Cost is in (\w+)\.$/, 'يُشحن مباشرة من علي إكسبرس إلى العميل (خلال $1 يوماً تقريباً). التكلفة بـ $2.'],
    [/^Ships to Kinan’s China warehouse, is checked, then sent to the customer with their other items\. Cost is in CNY \(¥\)\.$/, 'يُشحن إلى مستودع كنان في الصين ويُفحص ثم يُرسل مع باقي منتجات العميل. التكلفة باليوان (¥).'],
    [/^Price (\w+)$/, 'السعر $1'], [/^Cost (\S+)$/, 'التكلفة $1'], [/^Amount \((\w+)\)$/, 'المبلغ ($1)'],
    [/^Within (\d+) days of delivery\. See each shop’s return policy\.$/, 'خلال $1 يوماً من التوصيل. راجع سياسة الإرجاع لكل متجر.'],
    [/^(.+) kg estimated · arrives in about (.+) days\. If your parcel weighs less, we refund the difference to your wallet\.$/, 'الوزن التقديري $1 كغ · يصل خلال $2 يوماً تقريباً. إذا كان وزن طردك أقل، نعيد الفرق إلى محفظتك.'],
    [/^You can withdraw once you have at least (.+) available\.$/, 'يمكنك السحب عندما يصبح لديك $1 على الأقل متاحاً.'],
    [/^Your request for$/, 'طلبك بقيمة'], [/^is waiting — Kinan pays withdrawals by hand, usually within a few working days\.$/, 'قيد الانتظار — تدفع كنان طلبات السحب يدوياً، عادةً خلال أيام عمل قليلة.'],
    [/^Earnings become available when the buyer receives the order\. Your earnings are your sale price minus Kinan’s (.+)% commission, and minus the purchase cost for items Kinan buys for you \(AliExpress and manually added products\)\.$/, 'تصبح الأرباح متاحة عندما يستلم المشتري طلبه. ربحك هو سعر البيع ناقص عمولة كنان $1%، وناقص تكلفة الشراء للمنتجات التي تشتريها كنان لك (علي إكسبرس والمنتجات المضافة يدوياً).'],
    [/^(.+) · (\d+) item\(s\)$/, '$1 · $2 منتج'], [/^Sold by (.+)$/, 'يبيعه $1'],
    [/^Your parcel weighed (.+) kg, less than estimated — we added (.+) to your$/, 'وزن طردك $1 كغ، أقل من المتوقع — أضفنا $2 إلى'],
    [/^You’re signed in as a (\w+)\. Sign in with a customer account to shop\.$/, 'أنت مسجّل كـ $1. سجّل الدخول بحساب عميل للتسوق.'],
        [/^(.+) \((\d+)\)$/, function (m, a, n) { return (AR[a] || a) + ' (' + n + ')'; }],
    [/^(.+) · (\d+) options?$/, function (m, a, n) { return a + ' · ' + n + (n === '1' ? ' خيار' : ' خيارات'); }],
    [/^cost ¥(.+)$/, 'التكلفة ¥$1'], [/^Shipped (.+)$/, 'شُحن في $1'],
    [/^Commission: (.+)% · Status: (\w+)$/, function (m, c, st) { return 'العمولة: ' + c + '% · الحالة: ' + ({ active: 'نشط', pending: 'بانتظار الموافقة', suspended: 'موقوف' }[st] || st); }],
    [/^(\d+) products · (.+)$/, '$1 منتج · $2'], [/^On Kinan since (.+)$/, 'على كنان منذ $1'], [/^· On Kinan since (.+)$/, '· على كنان منذ $1'],
    [/^© (\d{4}) (.+)\. All rights reserved\. Kinan is a trading name of (.+)\.$/, '© $1 $2. جميع الحقوق محفوظة. كنان اسم تجاري لـ $3.'],
    [/^(.+) · Qty (\d+)$/, '$1 · الكمية $2'],
    [/^(\d+) × (.+)$/, '$1 × $2']
  ];

  var WS = /^(\s*)([\s\S]*?)(\s*)$/;
  function tr(text) {
    if (lang !== 'ar' || !text) return text;
    var m = WS.exec(text); var core = m[2];
    if (!core || !/[A-Za-z]/.test(core)) return text;
    var out = AR[core];
    if (out === undefined) {
      for (var i = 0; i < PATTERNS.length; i++) if (PATTERNS[i][0].test(core)) { out = core.replace(PATTERNS[i][0], PATTERNS[i][1]); break; }
    }
    return out === undefined ? text : m[1] + out + m[3];
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, TEXTAREA: 1, svg: 1 };
  function walk(node) {
    if (lang !== 'ar' || !node) return;
    if (node.nodeType === 3) { var t = tr(node.nodeValue); if (t !== node.nodeValue) node.nodeValue = t; return; }
    if (node.nodeType !== 1 || (node.closest && node.closest('[data-no-tr]'))) return;
    if (node.nodeName === 'TEXTAREA') { var tp = node.getAttribute('placeholder'); if (tp) { var ntp = tr(tp); if (ntp !== tp) node.setAttribute('placeholder', ntp); } return; }
    if (SKIP[node.nodeName]) return;
    var attrs = ['placeholder', 'aria-label', 'title'];
    for (var a = 0; a < attrs.length; a++) { var v = node.getAttribute && node.getAttribute(attrs[a]); if (v) { var nv = tr(v); if (nv !== v) node.setAttribute(attrs[a], nv); } }
    if (node.nodeName === 'OPTION' || node.nodeName === 'INPUT' && (node.type === 'button' || node.type === 'submit')) { /* option text is a text node; buttons handled by value below */ }
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  function start() {
    if (lang !== 'ar') return;
    document.title = tr(document.title);
    walk(document.body);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var mu = muts[i];
        if (mu.type === 'characterData') { var t = tr(mu.target.nodeValue); if (t !== mu.target.nodeValue) mu.target.nodeValue = t; }
        else for (var j = 0; j < mu.addedNodes.length; j++) walk(mu.addedNodes[j]);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  /** 'auto' follows the phone's language; 'ar' / 'en' is the person's own choice. */
  function mode() { try { var s = localStorage.getItem(KEY); if (s === 'ar' || s === 'en') return s; } catch (e) { /* private mode */ } return 'auto'; }
  function set(l) { try { if (l === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, l); } catch (e) { /* ignore */ } location.reload(); }
  document.addEventListener('click', function (e) {
    var p = e.target.closest && e.target.closest('[data-lang-set]');
    if (p) { e.preventDefault(); if (p.getAttribute('data-lang-set') !== mode()) set(p.getAttribute('data-lang-set')); return; }
    var b = e.target.closest && e.target.closest('[data-lang-toggle]');
    if (!b) return; e.preventDefault(); set(lang === 'ar' ? 'en' : 'ar');
  });
  var phone = /^ar\b/i.test(navigator.language || '') ? 'العربية' : 'English';
  window.KinanLang = {
    lang: lang, t: tr, set: set,
    /** Button that switches language; shows the OTHER language's name. */
    mode: mode,
    /** Language setting for the settings page: phone language (automatic), العربية, English. */
    picker: function () {
      var m = mode();
      var opt = function (v, label, sub) { return '<button type="button" data-lang-set="' + v + '" data-no-tr class="langopt' + (m === v ? ' on' : '') + '">' + '<b>' + label + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</button>'; };
      return '<div class="langpick" role="radiogroup">' +
        opt('auto', lang === 'ar' ? 'لغة الهاتف' : 'Phone language', (lang === 'ar' ? 'تلقائي · ' : 'Automatic · ') + phone) +
        opt('ar', 'العربية', '') + opt('en', 'English', '') + '</div>';
    },
    button: function (cls) { return '<button type="button" class="' + (cls || '') + '" data-lang-toggle data-no-tr lang="' + (lang === 'ar' ? 'en' : 'ar') + '">' + (lang === 'ar' ? 'English' : 'العربية') + '</button>'; }
  };
})();
