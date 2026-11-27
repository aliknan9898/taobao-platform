# Taobao Global | مرجع تكامل KINAN.shop

تاريخ المراجعة 27 نوفمبر 2026. جُمعت المعلومات من واجهة البوابة ووثائق المطور العامة وقورنت بكود KINAN على `main`. هذا مرجع عربي للقدرات والإعدادات، مع روابط النصوص الأصلية. صلاحيات حساب KINAN الفعلية وحدود الاستدعاء وبيانات الربط والرسوم والأهلية لليبيا تحتاج إلى تحقق من لوحة الحساب أو دعم Taobao.

## الفهرس

1. اختيار البرنامج والتسجيل
2. التفويض والاتصال
3. جرد واجهات API
4. الإشعارات والتشغيل
5. الإعدادات الموجودة في KINAN
6. مسار الشراء والمخزن واختبارات القبول
7. المصادر والبيانات المطلوبة للتفعيل

## 1. اختيار البرنامج والتسجيل

تقدم البوابة ثلاثة مسارات. **Global Sellers** يناسب متجر KINAN الذي ينتقي البضائع ويعدّل مواد العرض والتسعير ويبيع عبر موقعه، ثم يجمع الشحنات عبر مستودعه. **Procuring Agents** موجه للشراء بالنيابة وعرض مواد المورد دون معالجة تجارية موسعة. **Service Partner** موجه لمن يقدم أنظمة إدارة المخزون أو اللوجستيات أو المتاجر لجهات أخرى. يُعاد تقييم المسار الأخير إذا أصبح KINAN مزودًا لتكامل Taobao لمتاجر خارجية. توجد منصة **TaoWorld** للتوريد والشراء بالجملة عبر API وتعرضها الصفحة بمسار تسجيل مستقل.

يتطلب مسار Global Sellers الانضمام إلى منصة التوزيع بصفة مشترٍ. البضائع المؤهلة تأتي من موردي Taobao المتعاقدين مع منصة التوزيع. يرسل المورد البضاعة داخل الصين عبر ناقل محلي، ويمكن للمشتري إدارة البيع والشحن الدولي لاحقًا. خدمات اللوجستيات الخارجية تغطي أسواقًا محددة، وعروضها تقديرية. يوثق دليل البائع أن السعر العادي قد يستبعد القسائم، وأن عرض المخزون يتوقف عند 200 في سيناريو ERP الموصوف.

خطوات التسجيل:

1. تسجّل حساب المطور وتتحقق من البريد، ثم تكمل بيانات الهوية والمستندات التي تطلبها المنصة.
2. من App Console اختر New، ثم App Type وقدّم وصف نشاط KINAN وسبب طلب نوع التطبيق. يمكن إرفاق خطة عمل أو تصميم.
3. بعد تحول الطلب من Pending إلى Valid أنشئ التطبيق بالاسم والشعار وCallback URL.
4. راجع App Overview للحصول على App Key وApp Secret، ثم اطلب مجموعات API اللازمة. مجموعات Valid متاحة للتطبيق، والمجموعات الأخرى تحتاج موافقة.
5. فوّض حساب المشتري واختبره. عند نجاح الاختبار استخدم Request to Publish في منصة Taobao. يذكر دليل البداية ثلاث أيام عمل لبعض مراجعات المطور ونوع التطبيق والصلاحيات. المدة الفعلية تعتمد على الطلب.

## 2. التفويض والاتصال

| العنصر | القيمة أو السلوك |
|---|---|
| عنوان API | `https://api.taobao.global/rest` |
| صفحة التفويض OAuth 2.0 | `https://api.taobao.global/oauth/authorize` |
| معلمات التفويض | `response_type=code` و`client_id` و`redirect_uri`. يعرض الدليل `force_auth=true` ويدعم `state`. في KINAN يجب التحقق من state وربطه بطلب التفويض. |
| استبدال الكود | `/auth/token/create`. يذكر دليل التفويض أن الكود ينتهي خلال 30 دقيقة. |
| التجديد | `/auth/token/refresh`. احفظ زوج الرموز الجديد بعد نجاح التجديد. إذا كان `refresh_expires_in=0` أو انتهت صلاحيته اطلب إعادة التفويض. |
| وحدات الصلاحية | مرجع API للتجديد يصف القيم بالثواني. بعض جداول الدليل العام تتضمن أمثلة وصياغات مختلفة، لذلك تحقّق من الاستجابة الفعلية ولا تثبّت مدة بالأيام في التطبيق. |
| توقيع HTTP | معلمات مثل `app_key`, `timestamp`, `sign_method`, `sign` و`access_token` عند اشتراطه. يشرح الدليل ترتيب أسماء المعلمات وإضافة مسار العملية في مقدمة سلسلة التوقيع، ثم HMAC-SHA256 باستخدام App Secret وإخراج hex بأحرف كبيرة. راجع المثال الرسمي وحقق التطابق مع SDK لكل مسار. |
| SDK | يذكر الدليل Java وPHP وPython وRuby. يستخدم KINAN مسار HTTP في خادمه. يجب تحديد طريقة الطلب وشكل الحقول من مرجع العملية، لأن الدليل العام يذكر XML وتوجد أدلة أعمال تعرض أمثلة JSON. |
| بيئة الاختبار | يوثق دليل Test an App حساب اختبار يفوّضه ممثل Alibaba، ويمكن استخدامه في سيناريوهات الشراء والإرجاع للاختبار. عنوان API العام قد يؤثر في البيانات الحقيقية عند استخدام حساب إنتاج. |
| الأخطاء | سجّل `request_id` وكود الخطأ. SYSTEM يشمل التحقق أو التكرار أو المعلمات. ISV خطأ بيانات الأعمال. ISP خطأ في الخدمة الخلفية. افصل أخطاء الصلاحيات عن أخطاء الخدمة وحدد إعادة المحاولة لكل حالة. |

## 3. جرد واجهات API

المسارات أدناه ظهرت في فهرس الواجهات أو أدلة سير العمل. ظهور العملية في الدليل يثبت توثيقها العام. تشغيلها يتطلب مجموعة الصلاحيات المناسبة وتأكيد مخطط الطلب الحالي.

| المجموعة | الواجهات المشاهدة واستخدامها |
|---|---|
| Account token | `/auth/token/create`, `/auth/token/refresh` |
| Product Distribution | `/product/relation/build`, `/product/relation/cancel`, `/product/batchGetProductLogisticPrice`, `/product/logisticsProperties/get`, `/product/translate/get`, `/product/sensitiveword/identification`, `/product/details/query`, `/product/spus/get`, `/promotion/query`, `/product/similar/get` |
| Product Sourcing | `/batch/src/products/check`, `/product/get`, `/product/recommend`. أدلة السيناريو توثّق أيضًا `/product/same/query`, `/mpId/get` |
| Purchasing | `/purchase/order/render`, `/purchase/order/create`, `/purchase/orders/query`, `/purchase/order/batch/pay`, `/purchase/order/asyn/cancel`, `/purchase/order/confirm/receipt`, `/logistics/detail/get`, `/logistics/express/freight/estimate`, `/logistics/weight/write` |
| Refund | `/order/refund/cancel`, `/order/refund/modify`, `/order/refund/query/message`, `/order/refund/query`, `/order/refund/queryList`, `/order/refund/render/logistics`, `/order/refund/render`, `/order/refund/submit/logistics`, `/order/refund/submit/message`, `/order/refund/submit` |
| Bill | `/purchase/bills/query`, `/refund/bills/query` |
| Supply Chain Service | `/delivery/address/get`, `/purchase/supplychain/orders/query`, `/supplychain/price/get` |
| User Traffic Service | `/traffic/item/batchGetSourceItemLogisticPrice`, `/traffic/item/get`, `/traffic/item/logisticPrice/get`, `/traffic/theme/getThemeDetail`, `/traffic/theme/getThemeDimList`, `/upload/image` (POST), `/traffic/item/imgsearch`, `/traffic/item/search` |
| Tool Integration | `/page/link/get` |
| Taobao Global Affiliate | `/tbk/cpa/settle/order/batch/get`, `/tbk/cps/settle/order/batch/get`, `/tbk/favitem/get`, `/tbk/general/link/parse`, `/tbk/material/item/info/get`, `/tbk/material/item/link/convert`, `/tbk/material/item/optional`, `/tbk/material/item/recommend`, `/tbk/offlineshop/item/get`, `/tbk/offlineshop/item/operate`, `/tbk/order/details/batch/get`, `/tbk/settle/order/details/get`, `/tbk/shop/get` |
| Incentive / Account Information / CSA | `/product/rebate/general/query`, `/account/customer/function/switch`, `/account/subaccount/query`, `/supply/csa/wisers/v1/event/notify` |
| تحديث حالة عرض المنتج | دليل السيناريو يوثق `/product/on/off/shelve` للإبلاغ عن حالة عرض المنتج في قناة البيع الخارجية. يؤكد دعم Taobao قيمة اسم القناة المستقلة لـ KINAN قبل تفعيل الإرسال. |

### البيانات التي تؤثر على تنفيذ KINAN

- `/product/spus/get` لقائمة المنتجات التي اختارها التاجر للتوزيع. يظهر في المثال `scroll_id`، ومعرّف المنتج، الصور، السعر والعملة، المخزون، التصنيف، الوزن والحالة. تُقرأ التفاصيل باستخدام `/product/details/query`. يجب الاحتفاظ بمعرّفات SPU وSKU كسلاسل نصية دون فقد الدقة في JavaScript.
- `/product/same/query` يأخذ دفعة `item_ids` مع `type=TAOBAO` في السيناريو الموثق. النتيجة تميز بين المنتجات المطابقة و`fail_items`؛ إنشاء علاقة التوزيع يتم عبر `/product/relation/build`.
- مسار مطابقة منتج قناة أخرى يمكن أن يعتمد على `/product/get` ثم `/mpId/get`، أو `/batch/src/products/check`. يوصي دليل المطابقة بفاصل 5 ثوانٍ قبل استدعاء `/mpId/get` في هذا التسلسل. يحدد `PANAMA_DG` في حقول قناة العلاقة والشراء للمعرّفات المكتسبة من المسار الموصوف.
- مثال إنشاء طلب يذكر `orderLineList`, `outerPurchaseId`, `orderSource`, `sellerOrderNumber`, `purchaseAmount`, `receiver`, `warehouseAddressInfo`. قد تقسم المنصة طلب الشراء تلقائيًا وتعيد `purchase_id` و`sub_purchase_order_id` و`payment_url`. يجب التحقق من غلاف الطلب في مرجع العملية، ومن الحقول الإلزامية لعنوان المستودع و`receiver` لطريقة شحن KINAN.
- يوجد مسار دفع عبر رابط منصة التوزيع ومسار API للدفع الجماعي. يبقى دفع العميل إلى KINAN منفصلًا محاسبيًا عن دفع KINAN للمورد. توثق الصفحات إغلاق الطلبات غير المدفوعة وفق قواعد المنصة. لم تتأكد مهلة الدفع لحساب KINAN.
- توصي الخطة بطلب صلاحيات القراءة أولًا: المنتج والأسعار والمخزون واللوجستيات. تضاف صلاحيات إنشاء الطلب والدفع والإلغاء والاسترداد حسب اختبار كل مسار.

## 4. الإشعارات والتشغيل

| النوع | الحدث الموثق |
|---|---|
| 18 | منتج أضيف إلى التوزيع |
| 11، 13، 15، 16 | حالة المنتج، معلوماته، السعر، المخزون |
| 14، 17 | حالة SKU أو معلوماته |
| 3، 8 | حالة الطلب أو تعديل سعره |
| 9 | رسالة جديدة في المرتجع أو الاسترداد |
| 23 | تحديث لوجستي عابر للحدود |

في KINAN توجد دالة استقبال Taobao في `src/webhooks.js` تتحقق من التوقيع باستخدام النص الخام. راجع اشتراكات الحساب ومخطط كل حدث واختبر التوقيع بطلب محاكى. خزّن حدثًا واحدًا لكل معرّف، وأعد المزامنة عبر الاستعلام الدوري عند تأخر الإشعارات. سجل معدل النجاح، زمن الاستجابة، الأخطاء وحدود الاستدعاء. لا تعتمد سعة المنصة المعلنة على أنها حصة حساب KINAN.

## 5. الإعدادات الموجودة في KINAN

| الإعداد | موقعه وما يلزم |
|---|---|
| حساب شراء KINAN المركزي | صفحة Admin تستخدم `GET /api/admin/taobao` و`POST /api/admin/taobao/connect`. تفويض الحساب من مشرف KINAN هو المسار الأساسي. راجع حالة الجلسة وإعادة التفويض من اللوحة. |
| الاعتماد | `TAOBAO_APP_KEY` و`TAOBAO_APP_SECRET` في متغيرات الخادم. APP Secret والرموز تحفظ في البيئة المحمية وتُحجب من الواجهة والسجلات. |
| عنوان خدمة Taobao | `TAOBAO_API_URL` و`TAOBAO_AUTH_URL` موجودان في `.env.example`، مع عناوين البوابة أعلاه. |
| Callback | `TAOBAO_REDIRECT_URI` مدعوم في `src/config.js`. القيمة الافتراضية مشتقة من عنوان KINAN العام مع `/oauth/callback`. ثبّت المطابقة الحرفية مع القيمة المسجلة في Taobao، خصوصًا إذا كان التطبيق قد سجّل عنوان استضافة سابقًا. |
| الدفع | زر `auto_pay` موجود في لوحة المسؤول. قيمة الحساب الفعلية غير متحققة في هذه المراجعة. في اختبار الربط ابدأ بالدفع اليدوي، ثم جرّب التلقائي بعد اختبار الرصيد والمبالغ ومنع التكرار. |
| الإعدادات المقترحة للقسم | اعرض حالة الصلاحيات لكل مجموعة، آخر نجاح للاتصال، {انتهاء الرمز، إعادة التفويض}، حالة الإشعارات، آخر خطأ ورقم الطلب التقني، اختيار مستودع الاستلام، ووضع الشراء. اربطها بمصادر الحالة الموجودة بدل إنشاء واجهة حساب ثانية. |
| مانع تغيير عقد الطلب | في `src/taobao/apis.js` عدة حقول تحمل `VERIFY`، منها غلاف إنشاء الطلب، وحقول الاستعلام والدفع والإلغاء. تأكد من مخططات العمليات المفعّلة وقارنها برد حقيقي قبل تعديلها. |

## 6. مسار KINAN المقترح واختبارات القبول

1. **الاستيراد** يبدأ بمعرّف Taobao ثم مطابقة معرّف منصة التوزيع وSKU، وجلب التفاصيل. يُحفظ المنتج كمسودة ويخضع لتوافر وجهة الشحن، والسعر والمخزون وصلاحية عرض المنتج. قواعد KINAN للمبيعات وجودة الصور والمدة تعتمد على البيانات التي يمكن التحقق منها، ويُعلَّم الحقل المفقود للمراجعة.
2. **شراء المورد** بعد تأكيد طلب العميل، تُراجع الكمية والسعر وتكلفة النقل الداخلي، ثم يُنشأ طلب مشتريات بمرجع خارجي ثابت. تحفظ سجلات الأب والبنود في KINAN. بعد انتهاء مهلة شبكة في عملية إنشاء أو دفع، افحص نتيجة المحاولة السابقة قبل إعادة إرسالها.
3. **استلام المستودع** اربط رقم تتبع المورد وطلب الشراء والبند برمز KINAN. إذا تضمن طرد واحد طلبات عدة أو وصل طلب في عدة طرود، تسجل المستودعات عناصر كل طرد وتربطها بالعميل قبل التجميع. سجل مسح الكود والوزن والصورة وحالات الاستلام الجزئي.
4. **معالجة شحنة ليبيا** يستلم مستودع KINAN في بلد المنشأ ثم تنتقل الشحنة إلى مستودع الوجهة ومنها إلى المندوب. تعرض واجهة العميل «استلم المستودع»، «في الطريق»، «وصل إلى مستودع الوجهة»، «خرج للتسليم»، ثم «تم التسليم» أو «تعذّر التسليم». أرسل إشعار التطبيق والبريد مرة واحدة لكل انتقال، واعرض أسماء المصدر والدول عند الحاجة التشغيلية في لوحات الموظفين فقط.
5. **اختبارات القبول** تحقّق من SKU طويل، منتج غير مصرح أو غير متوفر، تغيّر السعر قبل الطلب، تقسيم الشحنة، تكرار حدث التتبع، انتهاء رمز التجديد، مهلة شبكة أثناء الشراء، وإرجاع جزئي. اختبر أول طلب عبر الحساب التجريبي المعتمد وأكّد اتجاه الشحن والرسوم والصلاحيات قبل الإنتاج.

## 7. المصادر والبيانات المطلوبة للتفعيل

- [بوابة Taobao Global](https://open.taobao.global/) و[TaoWorld](https://taoworld.taobao.global/apps/partnership?ch=openHome&lang=en_US).
- [البدء](https://open.taobao.global/doc/doc.htm#/?docId=9)، [التسجيل كمطور](https://open.taobao.global/doc/doc.htm#/?docId=10)، [إنشاء التطبيق](https://open.taobao.global/doc/doc.htm#/?docId=11)، [المفاتيح](https://open.taobao.global/doc/doc.htm#/?docId=12)، [الصلاحيات](https://open.taobao.global/doc/doc.htm#/?docId=13).
- [التفويض](https://open.taobao.global/doc/doc.htm#/?docId=15)، [أداة اختبار API](https://open.taobao.global/doc/doc.htm#/?docId=16)، [اختبار التطبيق](https://open.taobao.global/doc/doc.htm#/?docId=17)، [النشر](https://open.taobao.global/doc/doc.htm#/?docId=18)، [المراقبة](https://open.taobao.global/doc/doc.htm#/?docId=19)، [SDK](https://open.taobao.global/doc/doc.htm#/?docId=20)، [الأخطاء](https://open.taobao.global/doc/doc.htm#/?docId=30)، [HTTP](https://open.taobao.global/doc/doc.htm#/?docId=69).
- [قائمة المنتجات](https://open.taobao.global/doc/doc.htm#/?docId=31)، [الشراء](https://open.taobao.global/doc/doc.htm#/?docId=32)، [البحث والمطابقة](https://open.taobao.global/doc/doc.htm#/?docId=33)، [حالة العرض](https://open.taobao.global/doc/doc.htm#/?docId=34)، [مطابقة منتجات القنوات](https://open.taobao.global/doc/doc.htm#/?docId=35)، [دليل التطوير](https://open.taobao.global/doc/doc.htm#/?docId=38).
- [حل Global Sellers](https://open.taobao.global/doc/doc.htm#/?docId=90)، [قائمة API والإشعارات](https://open.taobao.global/doc/doc.htm#/?docId=104)، [مرجع العمليات](https://open.taobao.global/doc/api.htm)، [تسجيل منصة التوزيع](https://distributor.taobao.global/apps/register/registration).
- [اتفاقية المطور وسياسة البيانات](https://open.taobao.global/doc/doc.htm#/?docId=66)، [الإعلانات](https://open.taobao.global/announcement/index.htm)، [الدعم](https://open.taobao.global/support/index.htm).

لإكمال الإعداد تطلب مراجعة حساب المطور القيم التالية: نوع التطبيق وحالة الاعتماد، عنوان Callback المسجل، قائمة المجموعات Valid، بيانات مستودع الاستلام، قيم الحصص والرسوم، واسم قناة الطلب المقبول لموقع KINAN. وضّح مع الدعم هل يشمل الحساب الشراء بواسطة مستودع KINAN داخل الصين، وأي تغطية لوجستية دولية تخدم ليبيا. احتفظ بأسرار التطبيق خارج هذا الملف ومستودع GitHub.
