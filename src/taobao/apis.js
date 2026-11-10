'use strict';
/**
 * All API paths and request-parameter names in ONE place.
 *
 * The paths come from the Open Platform Development Manual §6.1.
 * Parameter names marked VERIFY are not spelled out in the guides you shared —
 * open App Console → API Test Tool, enter the path, click "get parameters",
 * and correct the name here if it differs. Nothing else in the code needs to change.
 */
module.exports = {
  // System
  TOKEN_CREATE: '/auth/token/create',          // param: code
  TOKEN_REFRESH: '/auth/token/refresh',        // param: refresh_token

  // Products (procurement / buy-by-link)
  PRODUCT_GET: '/product/get',                 // single Taobao ID → supply-platform model (mp_id / mp_sku_id)
  PRODUCT_GET_PARAM: 'item_id',                // VERIFY
  BATCH_CHECK: '/batch/src/products/check',    // several Taobao IDs at once
  BATCH_CHECK_PARAM: 'item_ids',               // VERIFY
  PRODUCT_RECOMMEND: '/product/recommend',     // similar items, low → high price
  PRODUCT_RECOMMEND_PARAM: 'item_id',          // VERIFY

  // Orders
  ORDER_RENDER: '/purchase/order/render',      // VERIFY path (purchaseOrderRender in the solution guide)
  ORDER_CREATE: '/purchase/order/create',      // param: purchase_request_param (VERIFY wrapper name)
  ORDER_CREATE_WRAPPER: 'purchase_request_param', // VERIFY — set to null to send fields flat
  ORDER_QUERY: '/purchase/orders/query',
  ORDER_QUERY_PARAM: 'purchase_order_ids',     // VERIFY
  ORDER_PAY: '/purchase/order/batch/pay',
  ORDER_PAY_PARAM: 'purchase_order_ids',       // VERIFY
  ORDER_CANCEL: '/purchase/order/asyn/cancel',
  ORDER_CANCEL_PARAM: 'purchase_order_id'      // VERIFY
};
