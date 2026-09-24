import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8787;
app.use(cors());
app.use(express.json());

const STOP = new Set(["the","and","for","with","from","pack","set","of","new","india","online","women","men","black","white","blue","red","size","inch","inches","pcs","pc"]);
function normalize(s="") { return s.toLowerCase().replace(/[^a-z0-9]+/g," ").split(/\s+/).filter(x=>x && !STOP.has(x)).filter(x=>x.length>1); }
function scoreProduct(source,candidate){
  const a=new Set(normalize(source.title)); const b=new Set(normalize(candidate.title)); if(!a.size||!b.size)return 0;
  let common=0; for(const t of a)if(b.has(t))common++;
  let score=(common/a.size*0.7)+(common/b.size*0.3);
  const sourceIds=[source.gtin,source.mpn,source.sku,source.productId].filter(Boolean).map(String).map(x=>x.toLowerCase());
  const candidateIds=[candidate.gtin,candidate.mpn,candidate.sku,candidate.productId].filter(Boolean).map(String).map(x=>x.toLowerCase());
  if(sourceIds.some(x=>candidateIds.includes(x)))score=Math.min(1,score+0.45);
  if(source.brand&&candidate.brand&&source.brand.toLowerCase()===candidate.brand.toLowerCase())score=Math.min(1,score+0.15);
  return Math.min(1,score);
}
async function fetchJson(url,options={},timeoutMs=15000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:controller.signal});}
  finally{clearTimeout(timer);}
}
async function amazonToken(){
  if(!process.env.AMAZON_CLIENT_ID||!process.env.AMAZON_CLIENT_SECRET)return null;
  const r=await fetchJson("https://api.amazon.co.uk/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({grant_type:"client_credentials",client_id:process.env.AMAZON_CLIENT_ID,client_secret:process.env.AMAZON_CLIENT_SECRET,scope:"creatorsapi::default"}),},15000);
  if(!r.ok)throw new Error(`Amazon token HTTP ${r.status}`); return (await r.json()).access_token;
}
async function searchAmazon(product){
  const token=await amazonToken(); if(!token)return [];
  const marketplace=process.env.AMAZON_MARKETPLACE||"www.amazon.in";
  const payload={partnerTag:process.env.AMAZON_PARTNER_TAG,marketplace,keywords:product.title,searchIndex:"All",itemCount:10,resources:["images.primary.medium","itemInfo.title","itemInfo.byLineInfo","itemInfo.externalIds","offersV2.listings.price"]};
  const r=await fetchJson("https://creatorsapi.amazon/catalog/v1/searchItems",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","x-marketplace":marketplace},body:JSON.stringify(payload)});
  if(!r.ok)throw new Error(`Amazon SearchItems HTTP ${r.status}`);
  const data=await r.json();
  return (data?.searchResult?.items||[]).map(item=>{const title=item?.itemInfo?.title?.displayValue||"";const brand=item?.itemInfo?.byLineInfo?.brand?.displayValue||"";const external=item?.itemInfo?.externalIds?.displayValues||{};const listing=item?.offersV2?.listings?.[0];const price=listing?.price?.money?.amount??listing?.price?.amount??null;return {store:"Amazon",title,brand,gtin:(external?.EAN||external?.UPC||external?.GTIN)?.[0]||"",productId:item.asin||"",price:price==null?null:Number(price),url:item.detailPageURL||"",affiliateUrl:item.detailPageURL||"",image:item?.images?.primary?.medium?.url||""};});
}
async function searchFlipkart(product){
  const id=process.env.FLIPKART_AFFILIATE_ID, token=process.env.FLIPKART_AFFILIATE_TOKEN; if(!id||!token)return [];
  const url=`https://affiliate-api.flipkart.net/affiliate/1.0/search/json?query=${encodeURIComponent(product.title)}&resultCount=10`;
  const r=await fetchJson(url,{headers:{"Fk-Affiliate-Id":id,"Fk-Affiliate-Token":token}}); if(!r.ok)throw new Error(`Flipkart Search HTTP ${r.status}`);
  const data=await r.json(); return (data?.productInfoList||[]).map(x=>{const p=x.productBaseInfoV1||x.productBaseInfo||{};const price=p?.sellingPrice?.amount??null;const image=Object.values(p?.imageUrls||{})[0]||"";return {store:"Flipkart",title:p.title||"",brand:p.productBrand||"",productId:p.productId||"",price:price==null?null:Number(price),url:p.productUrl||"",affiliateUrl:p.productUrl||"",image};});
}
async function searchMyntra(product){
  const key=process.env.REEF_API_KEY;
  if(!key)return [];
  const query=(product.title||"").trim();
  if(!query)return [];
  const r=await fetchJson("https://api.reefapi.com/myntra/v1/search",{method:"POST",headers:{"x-api-key":key,"content-type":"application/json"},body:JSON.stringify({query,limit:20})},20000);
  if(!r.ok){const body=await r.text();throw new Error(`Myntra API HTTP ${r.status}: ${body.slice(0,180)}`);}
  const data=await r.json();
  if(data?.ok===false)throw new Error(`Myntra API ${data?.error?.code||"error"}: ${data?.error?.message||"request failed"}`);
  const rows=data?.data?.results||[];
  return rows.map(x=>({
    store:"Myntra",
    title:x.title||"",
    brand:x.brand||"",
    productId:x.product_id||"",
    price:x.price==null?null:Number(x.price),
    url:x.url||"",
    affiliateUrl:x.url||"",
    image:x.image||x.images?.[0]||"",
    mrp:x.mrp==null?null:Number(x.mrp)
  }));
}
async function savePriceHistory(product,offers,checkedAt){
  const supabaseUrl=process.env.SUPABASE_URL, supabaseKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!supabaseUrl||!supabaseKey)return {saved:false,reason:"Supabase environment variables are not configured."};
  const rows=offers.filter(x=>x.price!=null&&x.store).map(x=>({product_title:product.title||x.title||"",store:x.store,product_id:x.productId||null,price:Number(x.price),currency:"INR",product_url:x.url||null,affiliate_url:x.affiliateUrl||x.url||null,image_url:x.image||null,match_score:x.matchScore==null?null:Number(x.matchScore),checked_at:checkedAt,created_at:checkedAt}));
  if(!rows.length)return {saved:false,reason:"No price observations to save."};
  const r=await fetchJson(`${supabaseUrl.replace(/\/+$/i,"")}/rest/v1/price_history`,{method:"POST",headers:{apikey:supabaseKey,Authorization:`Bearer ${supabaseKey}`,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify(rows)});
  if(!r.ok){const body=await r.text();throw new Error(`Supabase HTTP ${r.status}: ${body.slice(0,300)}`);} return {saved:true,count:rows.length};
}
async function compare(product){
  const results=[],errors=[];
  const jobs=[
    ["Myntra",searchMyntra(product)],
    ["Amazon",searchAmazon(product)],
    ["Flipkart",searchFlipkart(product)]
  ];
  const settled=await Promise.allSettled(jobs.map(x=>x[1]));
  settled.forEach((s,i)=>s.status==="fulfilled"?results.push(...s.value):errors.push(`${jobs[i][0]}: ${s.reason?.message||"provider error"}`));
  const matched=results.map(candidate=>({...candidate,matchScore:scoreProduct(product,candidate)})).filter(x=>x.matchScore>=0.55).filter(x=>x.price!=null).sort((a,b)=>(a.price-b.price)||(b.matchScore-a.matchScore));
  if(product.price!=null)matched.push({store:product.store||"Current page",title:product.title,brand:product.brand||"",productId:product.productId||product.asin||"",price:Number(product.price),url:product.url||"",affiliateUrl:product.affiliateUrl||product.url||"",image:product.image||"",matchScore:1,note:"Current product page"});
  const unique=[],seen=new Set();
  for(const x of matched){const key=`${x.store}|${x.productId||x.url||x.title}`;if(!seen.has(key)){seen.add(key);unique.push(x);}}
  unique.sort((a,b)=>a.price-b.price);
  const offers=unique.slice(0,10),checkedAt=new Date().toISOString();
  let database={saved:false,reason:"Not attempted."};
  try{database=await savePriceHistory(product,offers,checkedAt);}catch(e){errors.push(`Supabase: ${e.message}`);database={saved:false,reason:e.message};}
  return {offers,checkedAt,errors,database,message:offers.length?`Found ${offers.length} verified matching offer(s)`:"No verified matching offers found."};
}
app.post("/api/compare",async(req,res)=>{try{if(!req.body?.title)return res.status(400).json({error:"Product title is required."});res.json(await compare(req.body));}catch(e){res.status(500).json({error:e.message||"Comparison failed."});}});
app.get("/health",(_,res)=>res.json({ok:true,service:"zipron-price-api",version:"3.1.0",myntra:!!process.env.REEF_API_KEY}));
app.listen(PORT,()=>console.log(`Zipron API running at http://localhost:${PORT}`));
