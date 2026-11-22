// Responses captured from the real Shop API (local staging server, commit 4653259 + this branch),
// trimmed. Keep them in sync with test/mobile-pilot.test.js on the server side.
const catalogJson = '''
{"total":2,"items":[
 {"id":"lst_lamp","title":"Lamp","images":["/img/l/lst_lamp/0?v=1"],"description":"","title_ar":"مصباح","description_ar":"","currency":"usd","shop":{"id":"sel_a","name":"Atlas","logo":null},"listed_at":1795364639931,"fulfillment":"warehouse","category":"home","min_price":20,"rating":null,"reviews":0,"option_groups":[{"name":"Option","values":[{"value":"Red"},{"value":"Blue"}]}],"skus":[{"mp_sku_id":"v_red","props":"Red","pick":["Red"],"price":20,"in_stock":true,"stock":10},{"mp_sku_id":"v_blue","props":"Blue","pick":["Blue"],"price":22,"in_stock":false,"stock":0}],"ship_fee":12.5,"delivered_price":32.5},
 {"id":"lst_heater","title":"Heater","images":[],"currency":"usd","shop":{"id":"sel_a","name":"Atlas","logo":null},"min_price":30,"skus":[{"mp_sku_id":"v_one","props":"One","price":30,"in_stock":true,"stock":10}],"no_delivery":["MT"]}
]}''';

const orderPendingJson = '''
{"id":"ord_d14c6ba6c8e0af75","status":"pending_payment","status_label":"Awaiting payment","currency":"eur","subtotal":18.4,"shipping_fee":11.5,"total":29.9,"created_at":1795364640113,"discount":0,"lines":[{"line_no":"1","title":"Lamp","props":"Red","qty":1,"price":18.4,"image":"/img/l/lst_lamp/0?v=1","listing_id":"lst_lamp","direct":false}],"shipping_address":{"name":"C","phone":"+35679000000","country":"Malta","city":"V","line1":"St 1","postal_code":"","line2":"","state":"","country_code":"MT"},"payment":{"provider":"stripe","client_secret":"pi_1_secret_x"},"tracking":null,"direct":[],"all_direct":false,"timeline":[{"at":1795364640113,"event":"created"}]}''';

const orderShippedJson = '''
{"id":"ord_d14c6ba6c8e0af75","status":"shipped","status_label":"Shipped","currency":"usd","subtotal":20,"shipping_fee":12.5,"total":32.5,"created_at":1795364640113,"lines":[{"line_no":"1","title":"Lamp","props":"Red","qty":1,"price":20}],"payment":{"provider":"stripe"},"tracking":{"carrier":"DHL","number":"PILOT123456","shipped_at":1795364650000,"url":null},"direct":[],"timeline":[{"at":1795364640113,"event":"created"},{"at":1795364640119,"event":"paid"},{"at":1795364650000,"event":"shipped"}],"returns":[],"return_days":14}''';

const quoteJson = '{"fee":12.5,"weight_kg":1,"chargeable_kg":1,"zone":"europe","country_code":"MT","direct_items":0,"days":"8–14","mode":"weight","undeliverable":["lst_heater"]}';
