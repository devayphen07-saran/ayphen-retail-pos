/** POST /stores response (layered-architecture §3.8). snake_case wire contract. */
export interface StoreResponse {
  id:   string;
  name: string;
}