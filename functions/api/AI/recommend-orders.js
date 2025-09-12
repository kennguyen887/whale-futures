/** Lấy mảng từ response MEXC mà không mất field
 * Hỗ trợ các dạng:
 *  - { success:true, data:[...] }
 *  - { code:0, data:{ positions:[...] } }
 *  - { positions:[...] }, { orders:[...] }, { list:[...] }, v.v.
 *  - hoặc trả về mảng trực tiếp
 */
function extractArray(resp) {
  // ưu tiên data/result
  const root = (resp && (resp.data ?? resp.result ?? resp)) ?? [];

  // nếu root là mảng
  if (Array.isArray(root)) return root;

  // nếu root là object, thử các key phổ biến
  if (root && typeof root === "object") {
    const candidates = ["positions", "orders", "list", "openOrders", "items", "records", "rows"];
    for (const k of candidates) {
      if (Array.isArray(root[k])) return root[k];
    }
    // fallback: tìm mảng đầu tiên trong values
    for (const v of Object.values(root)) {
      if (Array.isArray(v)) return v;
    }
  }

  return [];
}
