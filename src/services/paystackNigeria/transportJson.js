'use strict';
// Bounded JSON decoder: duplicate keys are refused; uint64 IDs never pass
// through IEEE-754. Unsafe integer tokens become exact decimal strings.
function decode(raw){
 if(!Buffer.isBuffer(raw)||raw.length>262144)throw Error('PAYSTACK_INVALID_JSON');
 const text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))throw Error('PAYSTACK_INVALID_JSON');let i=0;
 const ws=()=>{while(/[\t\r\n ]/.test(text[i]||'!'))i++;};
 function string(){const start=i++;while(i<text.length){const c=text[i++];if(c==='"')return JSON.parse(text.slice(start,i));if(c==='\\')i++;}throw Error('PAYSTACK_INVALID_JSON');}
 function value(depth=0){ws();if(depth>32)throw Error('PAYSTACK_INVALID_JSON');const c=text[i];
  if(c==='"')return string();
  if(c==='{'||c==='['){i++;const object=c==='{',out=object?Object.create(null):[],keys=new Set(),end=object?'}':']';ws();if(text[i]===end){i++;return out;}
   for(let n=0;n<10000;n++){ws();let key;if(object){if(text[i]!=='"')throw Error('PAYSTACK_INVALID_JSON');key=string();if(keys.has(key)||['__proto__','constructor','prototype'].includes(key))throw Error('PAYSTACK_INVALID_JSON');keys.add(key);ws();if(text[i++]!==':')throw Error('PAYSTACK_INVALID_JSON');}
    const v=value(depth+1);if(object)out[key]=v;else out.push(v);ws();const sep=text[i++];if(sep===end)return out;if(sep!==',')throw Error('PAYSTACK_INVALID_JSON');
   }throw Error('PAYSTACK_INVALID_JSON');
  }
  for(const [word,v]of [['true',true],['false',false],['null',null]])if(text.startsWith(word,i)){i+=word.length;return v;}
  const m=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));if(!m)throw Error('PAYSTACK_INVALID_JSON');i+=m[0].length;
  const n=Number(m[0]);if(!Number.isFinite(n))throw Error('PAYSTACK_INVALID_JSON');return /^-?\d+$/.test(m[0])&&!Number.isSafeInteger(n)?m[0]:n;
 }
 const result=value();ws();if(i!==text.length)throw Error('PAYSTACK_INVALID_JSON');return result;
}
function transactionId(v){const s=typeof v==='string'?v:Number.isSafeInteger(v)?String(v):'';if(!/^[1-9]\d{0,19}$/.test(s)||BigInt(s)>18446744073709551615n)throw Error('PAYSTACK_INVALID_TRANSACTION_ID');return s;}
module.exports={decode,transactionId};
