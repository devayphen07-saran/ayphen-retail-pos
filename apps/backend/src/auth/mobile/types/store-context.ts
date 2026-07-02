export interface StoreContext {
  storeId:   string;
  accountId: string;
  isLocked:  boolean;
}

declare global {
  namespace Express {
    interface Request {
      storeContext?: StoreContext;
    }
  }
}
