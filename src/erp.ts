import type Database from 'better-sqlite3';

export type Evidence={type:string;input:Record<string,unknown>;output:Record<string,unknown>;observedAt:string;sourceVersion:'demo-v1';toolCallId?:string};
export interface ErpReadContract{
  resolveCustomer(sender:string,text:string,accountId?:string,toolCallId?:string):Promise<Evidence>;
  searchProducts(customerId:string,query:string,toolCallId?:string):Promise<Evidence[]>;
  getProduct(productId:string,toolCallId?:string):Promise<Evidence>;
  getRecentOrders(customerId:string,limit:number,toolCallId?:string):Promise<Evidence[]>;
  resolveUom(productId:string,expression:string,toolCallId?:string):Promise<Evidence>;
  convertUom(productId:string,quantity:number,from:string,to:string,toolCallId?:string):Promise<Evidence>;
  getCustomerPrice(customerId:string,productId:string,quantity:number,uom:string,date:string,toolCallId?:string):Promise<Evidence>;
  checkStock(productId:string,warehouseId:string,quantity:number,uom:string,toolCallId?:string):Promise<Evidence>;
}
/**
 * PUBLIC_CATALOG_READ: the only ERP read surface an unverified prospect may reach.
 *
 * Deliberately separate from `ErpReadContract` so a prospect-facing runtime can
 * hold a value that structurally cannot resolve a customer, price a line, read
 * order history, or inspect warehouse stock. Backed by the same canonical
 * `products` rows as `searchProducts`/`getProduct` — no second ERP client.
 *
 * Only non-sensitive discovery fields are projected. Customer-scoped aliases are
 * excluded: only aliases with no customer (`customer_id IS NULL`) are public
 * catalog vocabulary. An empty result is returned as an empty array rather than
 * thrown, so an honest "nothing matches" answer is representable.
 */
export type PublicCatalogItem={productId:string;stockCode:string;description:string;baseUom:string};
export interface PublicCatalogReadContract{
  searchPublicCatalog(query:string,limit:number,toolCallId?:string):Promise<Evidence[]>;
  listPublicCatalog(limit:number,toolCallId?:string):Promise<Evidence[]>;
}
const observed=()=>new Date().toISOString();
const ev=(type:string,input:Record<string,unknown>,output:Record<string,unknown>,toolCallId?:string):Evidence=>({type,input,output,observedAt:observed(),sourceVersion:'demo-v1',...(toolCallId?{toolCallId}:{})});

export class DemoErpAdapter implements ErpReadContract,PublicCatalogReadContract{
  constructor(private readonly db:Database.Database){}
  async searchPublicCatalog(query:string,limit:number,toolCallId?:string){const rows=this.db.prepare(`SELECT DISTINCT p.id,p.stock_code,p.description,p.base_uom FROM products p LEFT JOIN product_aliases pa ON pa.product_id=p.id AND pa.customer_id IS NULL WHERE p.active=1 AND (lower(p.stock_code)=lower(?) OR lower(p.description) LIKE lower(?) OR lower(pa.alias)=lower(?)) ORDER BY p.id LIMIT ?`).all(query,`%${query}%`,query,limit) as any[];return rows.map(r=>ev('public_catalog',{query,limit},{productId:r.id,stockCode:r.stock_code,description:r.description,baseUom:r.base_uom},toolCallId))}
  async listPublicCatalog(limit:number,toolCallId?:string){const rows=this.db.prepare('SELECT p.id,p.stock_code,p.description,p.base_uom FROM products p WHERE p.active=1 ORDER BY p.id LIMIT ?').all(limit) as any[];return rows.map(r=>ev('public_catalog',{limit},{productId:r.id,stockCode:r.stock_code,description:r.description,baseUom:r.base_uom},toolCallId))}
  async resolveCustomer(sender:string,text:string,accountId?:string,toolCallId?:string){const r=this.db.prepare(`SELECT c.id,c.code,c.name,c.currency,c.default_warehouse_id,i.channel_account_id,i.external_id FROM customers c JOIN customer_channel_identities i ON i.customer_id=c.id WHERE i.external_id=? AND (? IS NULL OR i.channel_account_id=?) LIMIT 1`).get(sender,accountId??null,accountId??null) as any;if(!r)throw Error('CUSTOMER_UNRESOLVED');return ev('customer',{sender,text,accountId:accountId??r.channel_account_id},{customerId:r.id,code:r.code,name:r.name,currency:r.currency,warehouseId:r.default_warehouse_id,externalId:r.external_id,accountId:r.channel_account_id},toolCallId)}
  async searchProducts(customerId:string,query:string,toolCallId?:string){const rows=this.db.prepare(`SELECT p.id,p.stock_code,p.description,p.base_uom,pa.alias FROM products p LEFT JOIN product_aliases pa ON pa.product_id=p.id AND pa.customer_id=? WHERE p.active=1 AND (lower(p.stock_code)=lower(?) OR lower(p.description) LIKE lower(?) OR lower(pa.alias)=lower(?)) ORDER BY p.id`).all(customerId,query,`%${query}%`,query) as any[];if(!rows.length)throw Error('PRODUCT_UNRESOLVED');return rows.map(r=>ev('product',{customerId,query},{productId:r.id,stockCode:r.stock_code,description:r.description,baseUom:r.base_uom,alias:r.alias??null},toolCallId))}
  async getProduct(productId:string,toolCallId?:string){const r=this.db.prepare('SELECT id,stock_code,description,base_uom FROM products WHERE id=? AND active=1').get(productId) as any;if(!r)throw Error('PRODUCT_UNRESOLVED');return ev('product',{productId},{productId:r.id,stockCode:r.stock_code,description:r.description,baseUom:r.base_uom},toolCallId)}
  async getRecentOrders(customerId:string,limit:number,toolCallId?:string){const rows=this.db.prepare('SELECT id,sales_order_no,delivery_date,grand_total_cents FROM sales_orders WHERE customer_id=? ORDER BY posted_at DESC,rowid DESC LIMIT ?').all(customerId,limit) as any[];return [ev('order_history',{customerId,limit},{orders:rows.map(r=>({id:r.id,salesOrderNo:r.sales_order_no,date:r.delivery_date,grandTotalCents:r.grand_total_cents}))},toolCallId)]}
  async resolveUom(productId:string,expression:string,toolCallId?:string){const p=this.db.prepare('SELECT base_uom FROM products WHERE id=?').get(productId) as any;const u=this.db.prepare('SELECT code FROM uoms WHERE code=?').get(expression) as any;if(!p||!u)throw Error('UOM_UNRESOLVED');return ev('uom',{productId,expression},{productId,fromUom:expression,toUom:p.base_uom,requestedUom:expression},toolCallId)}
  async convertUom(productId:string,quantity:number,from:string,to:string,toolCallId?:string){const r=this.db.prepare('SELECT factor FROM product_uom_conversions WHERE product_id=? AND from_uom=? AND to_uom=?').get(productId,from,to) as any;const factor=r?Number(r.factor):1;if(!r&&from!==to)throw Error('UOM_CONVERSION_UNRESOLVED');return ev('uom_conversion',{productId,quantity,fromUom:from,toUom:to},{productId,quantity,fromUom:from,toUom:to,factor,baseQuantity:quantity*factor},toolCallId)}
  async getCustomerPrice(customerId:string,productId:string,quantity:number,uom:string,date:string,toolCallId?:string){const r=this.db.prepare('SELECT unit_price_cents,currency,valid_from,valid_to FROM customer_prices WHERE customer_id=? AND product_id=? AND uom=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>=?) ORDER BY valid_from DESC LIMIT 1').get(customerId,productId,uom,date,date) as any;if(!r)throw Error('PRICE_UNRESOLVED');return ev('price',{customerId,productId,quantity,uom,date},{customerId,productId,uom,unitPriceCents:r.unit_price_cents,currency:r.currency,validFrom:r.valid_from,validTo:r.valid_to},toolCallId)}
  async checkStock(productId:string,warehouseId:string,quantity:number,uom:string,toolCallId?:string){const s=this.db.prepare('SELECT quantity_base FROM stock_balances WHERE product_id=? AND warehouse_id=?').get(productId,warehouseId) as any;const c=this.db.prepare('SELECT factor FROM product_uom_conversions WHERE product_id=? AND from_uom=?').get(productId,uom) as any;const factor=c?Number(c.factor):1;const requiredBase=quantity*factor;const availableBase=s?Number(s.quantity_base):0;return ev('stock',{productId,warehouseId,quantity,uom},{productId,warehouseId,quantity,uom,factor,requiredBase,availableBase,available:availableBase>=requiredBase},toolCallId)}
}
