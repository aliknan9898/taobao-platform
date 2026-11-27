'use strict';
const db = require('../db');
const {SUPPLIERS,DEFAULTS,review} = require('./smartImportPolicy');
function key(source) {
  if (!SUPPLIERS.includes(source)) throw Object.assign(new Error('Unknown supplier'),{status:404});
  return 'smart_import_v2_'+source;
}
function get(source) {
  const saved = db.settings.get(key(source))?.policy || {};
  return {...DEFAULTS,...saved,externalAI:false,autoPublish:false};
}
function save(source, input) {
  const id = key(source), policy = get(source);
  for (const [name,min,max] of [['minSales',0,100000000],['maxShippingDays',1,90],['minMargin',0,1]]) {
    if (input[name] === undefined) continue;
    if (typeof input[name] !== 'number' || !Number.isFinite(input[name]) || input[name]<min || input[name]>max) throw Object.assign(new Error('Invalid '+name),{status:400});
    policy[name]=input[name];
  }
  if (input.externalAI === true || input.autoPublish === true) throw Object.assign(new Error('Not enabled during staged integration'),{status:403});
  if (db.settings.get(id)) db.settings.update(id,{policy}); else db.settings.insert({id,policy});
  return policy;
}
function evaluate(source, product) { return review({...product,source},get(source)); }
module.exports = {get,save,evaluate,list:()=>SUPPLIERS.map(source=>({source,policy:get(source)}))};
