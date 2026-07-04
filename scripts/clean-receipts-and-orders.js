// Run with: mongosh "mongodb+srv://<user>:<pass>@<cluster>/<dbname>" clean-receipts-and-orders.js
// Or from mongosh shell: load("clean-receipts-and-orders.js")
//
// Deletes ALL documents from:
//   - receipts
//   - tradehours_orders

const receiptResult = db.receipts.deleteMany({});
print(`receipts deleted: ${receiptResult.deletedCount}`);

const ordersResult = db.tradehours_orders.deleteMany({});
print(`tradehours_orders deleted: ${ordersResult.deletedCount}`);
